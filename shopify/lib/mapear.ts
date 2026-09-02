// De la ficha normalizada del importador a la entrada que espera Shopify.
//
// Este fichero es la frontera. A la izquierda, `NormalizedProduct`: lo que
// devuelven los adaptadores de AliExpress y Alibaba, y que ya existía. A la
// derecha, `ProductSetInput`: el modelo de Shopify, con sus reglas propias
// (3 opciones como mucho, combinaciones únicas, dinero en decimal y no en
// centavos, HTML en la descripción).
//
// Tres decisiones que no son obvias y que conviene no revertir sin pensarlo:
//
//  1. **Todo entra como BORRADOR.** Un producto recién traído de AliExpress
//     tiene el título en chino-inglés de máquina, fotos con marca de agua y un
//     precio sin margen. Publicarlo automáticamente es publicar basura en la
//     tienda de una clienta real.
//  2. **El inventario NO se sigue** (`tracked: false`). En dropshipping el stock
//     lo tiene el proveedor; si Shopify lo sigue, todo nace en 0 y la tienda
//     enseña "Agotado" en cada pieza que se importe.
//  3. **El coste se guarda en `inventoryItem.cost`**, que es el campo nativo de
//     Shopify para eso. Así el margen sale en los informes de Shopify sin que
//     haya que calcularlo por fuera.

import { applyPricing, DEFAULT_PRICING, type PricingRule } from "@/lib/money";
import type { NormalizedProduct, NormalizedVariant } from "@/lib/importers/types";

import { aceptaCampo, type Capacidades } from "./capacidades.js";

/** Límites duros de Shopify. Pasarse de aquí es un error, no un aviso. */
const MAX_OPCIONES = 3;
const MAX_VARIANTES = 100;
const MAX_ETIQUETAS = 250;
const MAX_TITULO = 255;
const MAX_IMAGENES = 20;

/**
 * El nombre EXACTO que Shopify le da a la opción de un producto sin variantes.
 * Si se escribe cualquier otra cosa (por ejemplo "Título"), deja de reconocerla
 * como la opción por defecto y la enseña en la ficha como un desplegable con una
 * sola entrada. Tiene que ir en inglés aunque el resto de la tienda esté en español.
 */
const OPCION_UNICA = "Title";
const VALOR_UNICO = "Default Title";

export type OpcionesDeMapeo = {
  /** Regla de margen: convierte el coste del proveedor en precio de venta. */
  pricing?: PricingRule;
  /** Marca que se pone cuando el proveedor no da ninguna. */
  vendorPorDefecto?: string;
  /** Handle a forzar. Si no se da, se calcula del título. */
  handle?: string;
  /** ACTIVE solo cuando quien llama sabe muy bien lo que hace. */
  estado?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  /** Etiquetas extra además de las de trazabilidad. */
  etiquetas?: string[];
  /** Colecciones (ids gid://) a las que añadirlo. */
  colecciones?: string[];
};

export type ResultadoMapeo = {
  entrada: Record<string, unknown>;
  /** Cosas que hubo que recortar o inventar. Se enseñan al final del import. */
  avisos: string[];
};

// ─────────────────────────────── texto ───────────────────────────────

/** Escapa lo mínimo para meter texto plano dentro de HTML sin abrir un agujero. */
function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Handle de Shopify: minúsculas, guiones, sin acentos ni signos.
 *
 * Los títulos de AliExpress vienen con emojis, corchetes y a menudo caracteres
 * CJK. `normalize("NFD")` separa la tilde de la letra para poder quitarla, y lo
 * que quede fuera de a-z0-9 se convierte en guión.
 */
export function aHandle(titulo: string): string {
  const base = titulo
    .normalize("NFD")
    // Los diacríticos que NFD acaba de separar de su letra (U+0300–U+036F):
    // "vestido rosé" → "vestido-rose", no "vestido-ros".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");

  // Un título entero en chino se queda en cadena vacía: Shopify rechazaría el
  // handle. Mejor uno genérico que un error a mitad de importación.
  return base || `pieza-${Date.now().toString(36)}`;
}

/**
 * Descripción en HTML: el texto del proveedor y, debajo, su ficha técnica.
 *
 * La ficha técnica se pinta como lista de definición y no como tabla porque en
 * móvil una tabla de dos columnas con "Composición: 95% poliéster 5% elastano"
 * se sale de la pantalla en todos los temas.
 */
export function aDescripcionHtml(producto: NormalizedProduct): string {
  const partes: string[] = [];

  const texto = (producto.description || "").trim();
  if (texto) {
    for (const parrafo of texto.split(/\n{2,}/)) {
      const limpio = parrafo.trim();
      if (limpio) partes.push(`<p>${escaparHtml(limpio).replace(/\n/g, "<br>")}</p>`);
    }
  }

  const atributos = Object.entries(producto.attributes || {}).filter(
    ([clave, valor]) => clave.trim() && String(valor).trim(),
  );
  if (atributos.length) {
    const filas = atributos
      .map(
        ([clave, valor]) =>
          `<dt>${escaparHtml(clave.trim())}</dt><dd>${escaparHtml(String(valor).trim())}</dd>`,
      )
      .join("\n    ");
    partes.push(`<h3>Detalles</h3>\n  <dl class="ficha-proveedor">\n    ${filas}\n  </dl>`);
  }

  return partes.join("\n  ");
}

// ─────────────────────────────── dinero ───────────────────────────────

/** Shopify quiere "24.99", no 2499. Nunca un float redondeado a ojo. */
export function centavosADecimal(centavos: number): string {
  return (Math.max(0, Math.round(centavos)) / 100).toFixed(2);
}

/**
 * Precio de venta de una variante.
 *
 * Si el adaptador ya calculó uno, manda ese. Si solo hay coste, se aplica la
 * regla de margen de la tienda. Si no hay ni coste, se deja en 0 y se avisa:
 * inventarse un precio en la tienda de otra persona no es una opción.
 */
function precioDeVenta(variante: NormalizedVariant, regla: PricingRule): number {
  if (typeof variante.priceCents === "number" && variante.priceCents > 0) {
    return variante.priceCents;
  }
  if (typeof variante.costCents === "number" && variante.costCents > 0) {
    return applyPricing(variante.costCents, regla);
  }
  return 0;
}

// ─────────────────────────── opciones y variantes ───────────────────────────

type OpcionPreparada = { name: string; values: { name: string }[] };

/**
 * Arma las opciones y las variantes respetando las reglas de Shopify:
 * como mucho 3 opciones, combinaciones únicas y ningún valor vacío.
 *
 * Cuando el proveedor trae más de 3 ejes (talla + color + largo + estilo, algo
 * normal en Alibaba) los sobrantes NO se tiran: se pegan al SKU y al título de
 * la variante, para que la información siga estando y Madeline pueda decidir.
 */
function prepararVariantes(
  producto: NormalizedProduct,
  regla: PricingRule,
  avisos: string[],
): { opciones: OpcionPreparada[]; variantes: Record<string, unknown>[] } {
  const nombres = (producto.optionNames || []).map((n) => String(n).trim()).filter(Boolean);
  const usados = nombres.slice(0, MAX_OPCIONES);
  const sobrantes = nombres.slice(MAX_OPCIONES);

  if (sobrantes.length) {
    avisos.push(
      `El proveedor da ${nombres.length} ejes de variante (${nombres.join(", ")}) y Shopify admite ${MAX_OPCIONES}. Se conservan «${usados.join("», «")}»; el resto queda dentro del nombre de cada variante.`,
    );
  }

  const entradas = (producto.variants || []).filter(Boolean);

  // Sin variantes reconocibles: producto de una sola línea con el precio base.
  if (!entradas.length || !usados.length) {
    const costeBase =
      typeof producto.costCentsMin === "number" && producto.costCentsMin > 0
        ? producto.costCentsMin
        : null;
    const precio = costeBase ? applyPricing(costeBase, regla) : 0;
    if (!precio) {
      avisos.push("No se pudo deducir ningún precio: la pieza entra a 0,00 y hay que ponérselo a mano antes de publicarla.");
    }

    return {
      opciones: [{ name: OPCION_UNICA, values: [{ name: VALOR_UNICO }] }],
      variantes: [
        {
          optionValues: [{ optionName: OPCION_UNICA, name: VALOR_UNICO }],
          price: centavosADecimal(precio),
          ...(costeBase ? { inventoryItem: { cost: centavosADecimal(costeBase), tracked: false } } : { inventoryItem: { tracked: false } }),
        },
      ],
    };
  }

  // Valores por eje, en orden de aparición y sin repetir.
  const valoresPorEje: string[][] = usados.map(() => []);
  const vistos: Set<string>[] = usados.map(() => new Set<string>());

  const variantes: Record<string, unknown>[] = [];
  const combinacionesVistas = new Set<string>();
  let descartadasPorDuplicado = 0;
  let sinPrecio = 0;

  for (const variante of entradas) {
    if (variantes.length >= MAX_VARIANTES) break;

    const valores = usados.map((_, i) => {
      const bruto = variante.optionValues?.[i];
      const limpio = typeof bruto === "string" ? bruto.trim() : "";
      // Shopify no acepta un valor de opción vacío, y una variante sin talla
      // declarada sigue siendo una variante que existe.
      return limpio || "Único";
    });

    const clave = valores.join(" / ").toLowerCase();
    if (combinacionesVistas.has(clave)) {
      descartadasPorDuplicado++;
      continue;
    }
    combinacionesVistas.add(clave);

    valores.forEach((valor, i) => {
      if (!vistos[i].has(valor)) {
        vistos[i].add(valor);
        valoresPorEje[i].push(valor);
      }
    });

    const precio = precioDeVenta(variante, regla);
    if (!precio) sinPrecio++;

    const extra = (variante.optionValues || []).slice(MAX_OPCIONES).filter(Boolean).join(" / ");
    const sku = [variante.sku, extra].filter(Boolean).join(" · ").slice(0, 255);

    const fila: Record<string, unknown> = {
      optionValues: usados.map((nombre, i) => ({ optionName: nombre, name: valores[i] })),
      price: centavosADecimal(precio),
      inventoryItem: {
        tracked: false,
        ...(typeof variante.costCents === "number" && variante.costCents > 0
          ? { cost: centavosADecimal(variante.costCents) }
          : {}),
        ...(sku ? { sku } : {}),
      },
    };

    if (
      typeof variante.compareAtCents === "number" &&
      variante.compareAtCents > precio &&
      precio > 0
    ) {
      fila.compareAtPrice = centavosADecimal(variante.compareAtCents);
    }

    if (variante.imageUrl) {
      fila.file = { originalSource: variante.imageUrl, contentType: "IMAGE" };
    }

    variantes.push(fila);
  }

  if (entradas.length > MAX_VARIANTES) {
    avisos.push(
      `El proveedor trae ${entradas.length} combinaciones y Shopify admite ${MAX_VARIANTES}: se importan las ${MAX_VARIANTES} primeras.`,
    );
  }
  if (descartadasPorDuplicado) {
    avisos.push(`${descartadasPorDuplicado} combinaciones venían repetidas y se descartaron.`);
  }
  if (sinPrecio) {
    avisos.push(
      `${sinPrecio} variantes entran a 0,00 porque el proveedor no dio ni precio ni coste para ellas.`,
    );
  }

  return {
    opciones: usados.map((nombre, i) => ({
      name: nombre,
      values: valoresPorEje[i].map((valor) => ({ name: valor })),
    })),
    variantes,
  };
}

// ─────────────────────────────── etiquetas ───────────────────────────────

/**
 * Etiquetas de trazabilidad. No son decoración: son lo que permite encontrar en
 * el panel de Shopify "todo lo que entró de AliExpress y sigue en borrador", que
 * es exactamente la cola de trabajo de quien revisa las importaciones.
 */
function etiquetasDe(producto: NormalizedProduct, extra: string[]): string[] {
  const etiquetas = new Set<string>(["importado", `origen:${producto.provider}`]);
  if (producto.sourceProductId) {
    etiquetas.add(`origen-id:${producto.sourceProductId}`.slice(0, 255));
  }
  for (const e of extra) {
    const limpia = String(e || "").trim();
    if (limpia) etiquetas.add(limpia.slice(0, 255));
  }
  return [...etiquetas].slice(0, MAX_ETIQUETAS);
}

/**
 * Metacampos con el origen. Duplican en parte a las etiquetas a propósito: las
 * etiquetas son para buscar a ojo en el panel, los metacampos son para que el
 * importador sepa, la próxima vez, que ESTE producto ya vino de ESE enlace y no
 * lo cree dos veces.
 */
function metacamposDe(producto: NormalizedProduct): Record<string, unknown>[] {
  const campos: Record<string, unknown>[] = [
    { namespace: "bloom", key: "origen_proveedor", type: "single_line_text_field", value: producto.provider },
  ];
  if (producto.sourceUrl) {
    campos.push({ namespace: "bloom", key: "origen_url", type: "url", value: producto.sourceUrl });
  }
  if (producto.sourceProductId) {
    campos.push({
      namespace: "bloom",
      key: "origen_id",
      type: "single_line_text_field",
      value: String(producto.sourceProductId),
    });
  }
  campos.push({
    namespace: "bloom",
    key: "importado_en",
    type: "date_time",
    value: new Date().toISOString(),
  });
  return campos;
}

// ─────────────────────────────── mapeo ───────────────────────────────

export function aEntradaProductSet(
  producto: NormalizedProduct,
  capacidades: Capacidades,
  opciones: OpcionesDeMapeo = {},
): ResultadoMapeo {
  const avisos: string[] = [...(producto.warnings || [])];
  const regla = opciones.pricing || DEFAULT_PRICING;

  const titulo = (producto.title || "").trim().slice(0, MAX_TITULO) || "Pieza sin título";
  if (!producto.title) {
    avisos.push("El proveedor no dio título: entra como «Pieza sin título» y hay que ponérselo.");
  }

  const { opciones: opcionesProducto, variantes } = prepararVariantes(producto, regla, avisos);

  const entrada: Record<string, unknown> = {
    title: titulo,
    handle: opciones.handle || aHandle(titulo),
    status: opciones.estado || "DRAFT",
    vendor: (producto.vendor || opciones.vendorPorDefecto || "Bloom by Madeline").slice(0, 255),
    descriptionHtml: aDescripcionHtml(producto),
    tags: etiquetasDe(producto, opciones.etiquetas || []),
    productOptions: opcionesProducto,
    variants: variantes,
  };

  // Las fotos se mandan como "fuentes": Shopify las descarga del CDN del
  // proveedor. Es lo que evita tener que bajarlas aquí y volver a subirlas.
  const imagenes = (producto.images || [])
    .map((img) => (img && typeof img.url === "string" ? img : null))
    .filter((img): img is { url: string; alt?: string } => !!img && /^https?:\/\//i.test(img.url))
    .slice(0, MAX_IMAGENES);

  if (imagenes.length) {
    if (aceptaCampo(capacidades, "files")) {
      entrada.files = imagenes.map((img) => ({
        originalSource: img.url,
        contentType: "IMAGE",
        alt: (img.alt || titulo).slice(0, 512),
      }));
    } else {
      avisos.push(
        "Esta versión del API no acepta fotos dentro de productSet: se suben en una segunda llamada.",
      );
    }
  } else if ((producto.images || []).length) {
    avisos.push(
      "Las fotos del proveedor no son direcciones http públicas, así que Shopify no puede descargarlas. Hay que subirlas a mano.",
    );
  } else {
    avisos.push("La ficha llegó sin ninguna foto.");
  }

  if (aceptaCampo(capacidades, "metafields")) {
    entrada.metafields = metacamposDe(producto);
  }

  if (opciones.colecciones?.length && aceptaCampo(capacidades, "collections")) {
    entrada.collections = opciones.colecciones;
  }

  if (aceptaCampo(capacidades, "seo")) {
    entrada.seo = {
      title: titulo.slice(0, 70),
      description: (producto.description || titulo).replace(/\s+/g, " ").trim().slice(0, 160),
    };
  }

  return { entrada, avisos };
}

/** Las fotos sueltas, para la segunda llamada cuando productSet no las acepta. */
export function fuentesDeImagen(producto: NormalizedProduct): { originalSource: string; alt: string; mediaContentType: string }[] {
  const titulo = (producto.title || "Pieza").trim();
  return (producto.images || [])
    .filter((img) => img && typeof img.url === "string" && /^https?:\/\//i.test(img.url))
    .slice(0, MAX_IMAGENES)
    .map((img) => ({
      originalSource: img.url,
      alt: (img.alt || titulo).slice(0, 512),
      mediaContentType: "IMAGE",
    }));
}
