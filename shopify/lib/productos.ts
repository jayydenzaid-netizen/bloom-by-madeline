// Crear y actualizar productos en Shopify.
//
// Hay DOS caminos porque Shopify tiene dos modelos vivos a la vez:
//
//   · `productSet` — una sola llamada con opciones, variantes y fotos dentro.
//     Es el bueno: atómico, idempotente por handle y sin estados intermedios.
//   · `productCreate` + `productVariantsBulkCreate` + `productCreateMedia` —
//     tres llamadas. Es lo que había antes y sigue existiendo.
//
// Cuál se usa NO se decide aquí a ojo: lo dice `capacidades.ts`, que se lo
// pregunta al propio API. Si un día Shopify jubila `productSet`, el respaldo
// entra solo y nadie tiene que tocar este fichero.
//
// El respaldo no es adorno defensivo: `productSet` no existe antes de 2024-04, y
// una tienda puede quedarse fijada a una versión vieja con SHOPIFY_API_VERSION.

import {
  ClienteShopify,
  reventarSiHayErrores,
  type ErrorDeUsuario,
} from "./admin.js";
import type { Capacidades } from "./capacidades.js";

export type ProductoCreado = {
  id: string;
  handle: string;
  titulo: string;
  /** Enlace directo a la ficha en el panel, para poder decir "míralo aquí". */
  urlPanel: string;
  /** Cuántas variantes quedaron de verdad. Puede no coincidir con lo pedido. */
  variantes: number;
  /** Cuántas fotos aceptó Shopify. */
  fotos: number;
  /** true si ya existía y se actualizó en vez de crearse. */
  actualizado: boolean;
};

const CAMPOS_PRODUCTO = `
  id
  handle
  title
  variants(first: 100) { nodes { id } }
  media(first: 25) { nodes { id } }
`;

// ─────────────────────── ¿ya lo importamos antes? ───────────────────────

/**
 * Busca un producto que ya venga de este mismo enlace de proveedor.
 *
 * Se busca por ETIQUETA y no por metacampo porque la búsqueda por metacampo
 * exige tener definida la definición del metacampo en la tienda, y eso es un
 * paso de configuración más que puede no estar hecho. La etiqueta siempre está.
 */
export async function buscarImportadoAntes(
  cliente: ClienteShopify,
  proveedor: string,
  sourceProductId: string | null,
): Promise<{ id: string; handle: string; titulo: string; estado: string } | null> {
  if (!sourceProductId) return null;

  const consulta = `
    query YaImportado($busqueda: String!) {
      products(first: 5, query: $busqueda) {
        nodes { id handle title status }
      }
    }
  `;

  // Las comillas simples alrededor del valor son obligatorias: el valor lleva
  // dos puntos dentro y sin comillas Shopify lo interpretaría como otro campo.
  const busqueda = `tag:'origen-id:${String(sourceProductId).replace(/'/g, "")}'`;

  const datos = await cliente.pedir<{
    products: { nodes: { id: string; handle: string; title: string; status: string }[] };
  }>(consulta, { busqueda }, "búsqueda de producto ya importado");

  const encontrados = datos.products?.nodes || [];
  if (!encontrados.length) return null;

  // Puede haber varios si alguien duplicó a mano; se devuelve el primero, que es
  // el más antiguo y por tanto el "original".
  const p = encontrados[0];
  return { id: p.id, handle: p.handle, titulo: p.title, estado: p.status };
}

/** ¿Está libre este handle? Shopify falla si se repite, y falla tarde. */
export async function handleLibre(cliente: ClienteShopify, handle: string): Promise<boolean> {
  const consulta = `
    query HandleLibre($handle: String!) {
      productByHandle: products(first: 1, query: $handle) { nodes { handle } }
    }
  `;
  const datos = await cliente.pedir<{ productByHandle: { nodes: { handle: string }[] } }>(
    consulta,
    { handle: `handle:${handle}` },
    "comprobación de handle",
  );
  return !(datos.productByHandle?.nodes || []).some((n) => n.handle === handle);
}

/**
 * Devuelve un handle que no choque: "vestido-rosa", "vestido-rosa-2"...
 *
 * Se comprueba antes de escribir porque el error de handle duplicado llega
 * DESPUÉS de que Shopify haya aceptado el resto del producto, y deja la
 * importación a medias.
 */
export async function handleDisponible(
  cliente: ClienteShopify,
  base: string,
  intentos = 12,
): Promise<string> {
  if (await handleLibre(cliente, base)) return base;
  for (let i = 2; i <= intentos; i++) {
    const candidato = `${base}-${i}`.slice(0, 255);
    if (await handleLibre(cliente, candidato)) return candidato;
  }
  // Sufijo de tiempo: feo pero único, y mejor que abortar la importación.
  return `${base}-${Date.now().toString(36)}`.slice(0, 255);
}

// ─────────────────────────── camino principal ───────────────────────────

async function viaProductSet(
  cliente: ClienteShopify,
  entrada: Record<string, unknown>,
): Promise<ProductoCreado> {
  const mutacion = `
    mutation CrearProducto($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { ${CAMPOS_PRODUCTO} }
        userErrors { field message code }
      }
    }
  `;

  const datos = await cliente.pedir<{
    productSet: {
      product: {
        id: string;
        handle: string;
        title: string;
        variants: { nodes: { id: string }[] };
        media: { nodes: { id: string }[] };
      } | null;
      userErrors: ErrorDeUsuario[];
    };
  }>(mutacion, { input: entrada }, "creación del producto");

  reventarSiHayErrores(datos.productSet?.userErrors, "el alta del producto");

  const producto = datos.productSet?.product;
  if (!producto) {
    throw new Error("Shopify aceptó la mutación pero no devolvió el producto.");
  }

  return {
    id: producto.id,
    handle: producto.handle,
    titulo: producto.title,
    urlPanel: `${cliente.panel}/products/${producto.id.split("/").pop()}`,
    variantes: producto.variants?.nodes.length || 0,
    fotos: producto.media?.nodes.length || 0,
    actualizado: false,
  };
}

// ─────────────────────────── camino de respaldo ───────────────────────────

/**
 * Tres llamadas en vez de una. Importante: NO es atómico. Si la segunda falla,
 * queda un producto en borrador sin variantes — por eso el producto se crea
 * siempre en DRAFT y por eso se avisa al final con el enlace, para poder ir a
 * verlo.
 */
async function viaProductCreate(
  cliente: ClienteShopify,
  entrada: Record<string, unknown>,
  capacidades: Capacidades,
): Promise<ProductoCreado> {
  const variantes = (entrada.variants as Record<string, unknown>[]) || [];
  const ficheros = (entrada.files as Record<string, unknown>[]) || [];

  // ProductCreateInput no acepta ni variantes ni ficheros: se apartan.
  const entradaProducto: Record<string, unknown> = { ...entrada };
  delete entradaProducto.variants;
  delete entradaProducto.files;
  if (!capacidades.productCreateConOpciones) delete entradaProducto.productOptions;

  const mutacionCrear = `
    mutation CrearProductoBase($input: ProductCreateInput!) {
      productCreate(input: $input) {
        product { id handle title }
        userErrors { field message }
      }
    }
  `;

  const creado = await cliente.pedir<{
    productCreate: {
      product: { id: string; handle: string; title: string } | null;
      userErrors: ErrorDeUsuario[];
    };
  }>(mutacionCrear, { input: entradaProducto }, "creación del producto (respaldo)");

  reventarSiHayErrores(creado.productCreate?.userErrors, "el alta del producto");
  const producto = creado.productCreate?.product;
  if (!producto) throw new Error("Shopify no devolvió el producto recién creado.");

  let cuantasVariantes = 0;
  if (variantes.length && capacidades.variantesEnLote) {
    const mutacionVariantes = `
      mutation Variantes($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(
          productId: $productId
          variants: $variants
          strategy: REMOVE_STANDALONE_VARIANT
        ) {
          productVariants { id }
          userErrors { field message }
        }
      }
    `;
    const conVariantes = await cliente.pedir<{
      productVariantsBulkCreate: {
        productVariants: { id: string }[];
        userErrors: ErrorDeUsuario[];
      };
    }>(
      mutacionVariantes,
      { productId: producto.id, variants: variantes },
      "alta de variantes",
    );
    reventarSiHayErrores(conVariantes.productVariantsBulkCreate?.userErrors, "las variantes");
    cuantasVariantes = conVariantes.productVariantsBulkCreate?.productVariants.length || 0;
  }

  let cuantasFotos = 0;
  if (ficheros.length) {
    const mutacionMedia = `
      mutation Fotos($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id } }
          mediaUserErrors { field message }
        }
      }
    `;
    const media = ficheros.map((f) => ({
      originalSource: f.originalSource,
      alt: f.alt,
      mediaContentType: "IMAGE",
    }));
    const conFotos = await cliente.pedir<{
      productCreateMedia: { media: { id?: string }[]; mediaUserErrors: ErrorDeUsuario[] };
    }>(mutacionMedia, { productId: producto.id, media }, "subida de fotos");
    reventarSiHayErrores(conFotos.productCreateMedia?.mediaUserErrors, "las fotos");
    cuantasFotos = conFotos.productCreateMedia?.media.length || 0;
  }

  return {
    id: producto.id,
    handle: producto.handle,
    titulo: producto.title,
    urlPanel: `${cliente.panel}/products/${producto.id.split("/").pop()}`,
    variantes: cuantasVariantes,
    fotos: cuantasFotos,
    actualizado: false,
  };
}

// ─────────────────────────────── entrada única ───────────────────────────────

export async function crearProducto(
  cliente: ClienteShopify,
  capacidades: Capacidades,
  entrada: Record<string, unknown>,
): Promise<ProductoCreado> {
  if (capacidades.productSet) {
    return viaProductSet(cliente, entrada);
  }
  return viaProductCreate(cliente, entrada, capacidades);
}

/** Borra un producto. Solo lo usa `verificar.ts` para limpiar su prueba. */
export async function borrarProducto(cliente: ClienteShopify, id: string): Promise<void> {
  const mutacion = `
    mutation Borrar($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }
  `;
  const datos = await cliente.pedir<{
    productDelete: { deletedProductId: string | null; userErrors: ErrorDeUsuario[] };
  }>(mutacion, { input: { id } }, "borrado del producto de prueba");
  reventarSiHayErrores(datos.productDelete?.userErrors, "el borrado del producto de prueba");
}

// ─────────────────────────────── colecciones ───────────────────────────────

/** Busca una colección por handle; devuelve su id o null. */
export async function buscarColeccion(
  cliente: ClienteShopify,
  handle: string,
): Promise<string | null> {
  const consulta = `
    query Coleccion($busqueda: String!) {
      collections(first: 5, query: $busqueda) { nodes { id handle } }
    }
  `;
  const datos = await cliente.pedir<{ collections: { nodes: { id: string; handle: string }[] } }>(
    consulta,
    { busqueda: `handle:${handle}` },
    "búsqueda de colección",
  );
  const exacta = (datos.collections?.nodes || []).find((c) => c.handle === handle);
  return exacta?.id || null;
}

/**
 * Crea una colección manual (no automática): las piezas se meten a mano, que es
 * como funcionan las colecciones de la boutique — «Nuevas llegadas», «Vestidos».
 */
export async function crearColeccion(
  cliente: ClienteShopify,
  datosColeccion: { handle: string; titulo: string; descripcionHtml?: string; imagenUrl?: string },
): Promise<string> {
  const existente = await buscarColeccion(cliente, datosColeccion.handle);
  if (existente) return existente;

  const mutacion = `
    mutation CrearColeccion($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id handle }
        userErrors { field message }
      }
    }
  `;

  const input: Record<string, unknown> = {
    handle: datosColeccion.handle,
    title: datosColeccion.titulo,
    descriptionHtml: datosColeccion.descripcionHtml || "",
  };
  if (datosColeccion.imagenUrl && /^https?:\/\//i.test(datosColeccion.imagenUrl)) {
    input.image = { src: datosColeccion.imagenUrl };
  }

  const datos = await cliente.pedir<{
    collectionCreate: {
      collection: { id: string; handle: string } | null;
      userErrors: ErrorDeUsuario[];
    };
  }>(mutacion, { input }, "creación de colección");

  reventarSiHayErrores(datos.collectionCreate?.userErrors, "el alta de la colección");
  const id = datos.collectionCreate?.collection?.id;
  if (!id) throw new Error(`Shopify no devolvió la colección «${datosColeccion.titulo}».`);
  return id;
}

/** Mete productos en una colección manual. Shopify admite 250 por llamada. */
export async function anadirAColeccion(
  cliente: ClienteShopify,
  coleccionId: string,
  productIds: string[],
): Promise<void> {
  if (!productIds.length) return;

  const mutacion = `
    mutation AnadirAColeccion($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        userErrors { field message }
      }
    }
  `;

  for (let i = 0; i < productIds.length; i += 250) {
    const lote = productIds.slice(i, i + 250);
    const datos = await cliente.pedir<{
      collectionAddProducts: { userErrors: ErrorDeUsuario[] };
    }>(mutacion, { id: coleccionId, productIds: lote }, "añadir productos a la colección");
    reventarSiHayErrores(
      datos.collectionAddProducts?.userErrors,
      "meter los productos en la colección",
    );
  }
}
