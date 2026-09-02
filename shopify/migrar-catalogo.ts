// Mudanza del catálogo de Bloom a Shopify.
//
// Lo que se lleva y en qué orden (el orden importa: las colecciones tienen que
// existir antes de meterles productos, y los productos antes de redirigir a sus
// direcciones nuevas):
//
//   1. Colecciones      Collection        → Collection
//   2. Productos        Product+Variant   → Product+ProductVariant  (con fotos y coste)
//   3. Páginas          Page              → Page
//   4. Descuentos       Discount          → DiscountCodeBasic
//   5. Redirecciones    —                 → UrlRedirect  (301 de las direcciones viejas)
//   6. Reseñas          Review            → fichero JSON (Shopify no tiene reseñas nativas)
//
// EL PASO 5 NO ES OPCIONAL. La tienda lleva meses en producción y sus enlaces
// están compartidos en Instagram e indexados en Google. Sin las 301, el día que
// se apague el sitio viejo cada uno de esos enlaces se convierte en un 404: se
// pierde el posicionamiento ganado y, peor, la clienta que pincha se queda sin
// nada. Las redirecciones son la diferencia entre mudarse y desaparecer.
//
// POR DEFECTO NO ESCRIBE NADA. Enseña lo que haría. Para escribir de verdad hay
// que pasar --aplicar, a conciencia.
//
//   npx tsx shopify/migrar-catalogo.ts                 ← simulación
//   npx tsx shopify/migrar-catalogo.ts --aplicar       ← escribe en Shopify
//   npx tsx shopify/migrar-catalogo.ts --aplicar --solo productos,redirecciones

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";

import { ClienteShopify, ErrorShopify, mensajeDe, reventarSiHayErrores, type ErrorDeUsuario } from "./lib/admin.js";
import { detectarCapacidades, type Capacidades } from "./lib/capacidades.js";
import { aEntradaProductSet, centavosADecimal } from "./lib/mapear.js";
import { crearProducto, crearColeccion, anadirAColeccion, handleDisponible } from "./lib/productos.js";
import { bien, mal, ojo, nota, titulo, regla, progreso, negrita, verde, rojo, gris, cian } from "./lib/consola.js";
import type { NormalizedProduct, NormalizedVariant } from "@/lib/importers/types";

/* ─────────────────────────── argumentos ─────────────────────────── */

const PASOS = ["colecciones", "productos", "paginas", "descuentos", "redirecciones", "resenas"] as const;
type Paso = (typeof PASOS)[number];

const argv = process.argv.slice(2);
const APLICAR = argv.includes("--aplicar");
const INCLUIR_BORRADORES = argv.includes("--con-borradores");

const soloIdx = argv.indexOf("--solo");
const SOLO: Set<Paso> =
  soloIdx >= 0 && argv[soloIdx + 1]
    ? new Set(
        argv[soloIdx + 1]
          .split(",")
          .map((p) => p.trim() as Paso)
          .filter((p) => (PASOS as readonly string[]).includes(p)),
      )
    : new Set(PASOS);

const hacer = (paso: Paso): boolean => SOLO.has(paso);

/** Cuenta de lo hecho, para el resumen final. */
const cuenta = {
  colecciones: 0,
  productos: 0,
  paginas: 0,
  descuentos: 0,
  redirecciones: 0,
  resenas: 0,
  fallos: [] as string[],
};

function fallo(que: string, error: unknown): void {
  const texto = `${que}: ${mensajeDe(error)}`;
  cuenta.fallos.push(texto);
  mal(texto);
  if (error instanceof ErrorShopify) nota(error.pista);
}

/* ─────────────────────────── utilidades ─────────────────────────── */

function leerLista(json: string | null | undefined): string[] {
  try {
    const datos: unknown = JSON.parse(json || "[]");
    return Array.isArray(datos) ? datos.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Markdown ligero → HTML.
 *
 * Las páginas de la tienda (Devoluciones, Envíos) se escribieron en el markdown
 * de andar por casa que acepta el panel. Shopify guarda HTML. Se convierte lo
 * que de verdad se usó —títulos, listas, negrita, cursiva, enlaces y párrafos—
 * y nada más: un conversor completo aquí sería código muerto.
 */
function markdownAHtml(texto: string): string {
  const escapar = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const enLinea = (t: string) =>
    escapar(t)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  const salida: string[] = [];
  let enLista = false;

  const cerrarLista = () => {
    if (enLista) {
      salida.push("</ul>");
      enLista = false;
    }
  };

  for (const cruda of (texto || "").split(/\r?\n/)) {
    const linea = cruda.trim();

    if (!linea) {
      cerrarLista();
      continue;
    }

    const titular = /^(#{1,4})\s+(.*)$/.exec(linea);
    if (titular) {
      cerrarLista();
      const nivel = Math.min(6, titular[1].length + 1); // # → h2: el h1 es el título de la página
      salida.push(`<h${nivel}>${enLinea(titular[2])}</h${nivel}>`);
      continue;
    }

    const punto = /^[-*+]\s+(.*)$/.exec(linea);
    if (punto) {
      if (!enLista) {
        salida.push("<ul>");
        enLista = true;
      }
      salida.push(`  <li>${enLinea(punto[1])}</li>`);
      continue;
    }

    cerrarLista();
    salida.push(`<p>${enLinea(linea)}</p>`);
  }
  cerrarLista();

  return salida.join("\n");
}

/* ─────────────── producto de Prisma → ficha normalizada ─────────────── */

type ProductoPrisma = {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  vendor: string;
  productType: string;
  tagsJson: string;
  optionNamesJson: string;
  priceCents: number;
  compareAtCents: number | null;
  costCents: number | null;
  sourceProvider: string | null;
  sourceUrl: string | null;
  sourceProductId: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  images: { url: string; alt: string; position: number }[];
  variants: {
    title: string;
    sku: string;
    option1: string | null;
    option2: string | null;
    option3: string | null;
    priceCents: number;
    compareAtCents: number | null;
    costCents: number | null;
    stock: number;
    trackStock: boolean;
    imageUrl: string | null;
  }[];
};

/**
 * El puente entre los dos modelos.
 *
 * Se pasa por `NormalizedProduct` en vez de escribir un mapeo Prisma→Shopify
 * aparte: así la migración y el importador comparten EXACTAMENTE las mismas
 * reglas de precio, de troceado de variantes y de descripción. Dos caminos
 * distintos hacia el mismo sitio acabarían divergiendo, y el día que divergen la
 * tienda tiene productos con dos formatos distintos.
 */
function aFichaNormalizada(p: ProductoPrisma): NormalizedProduct {
  const optionNames = leerLista(p.optionNamesJson);

  const variantes: NormalizedVariant[] = p.variants.map((v) => ({
    title: v.title,
    optionValues: [v.option1, v.option2, v.option3]
      .slice(0, Math.max(1, optionNames.length))
      .map((x) => x || ""),
    sku: v.sku || undefined,
    costCents: v.costCents,
    // El precio ya está decidido en la tienda actual: NO se recalcula con la
    // regla de margen. Recalcularlo cambiaría los precios de un catálogo vivo.
    priceCents: v.priceCents,
    compareAtCents: v.compareAtCents,
    stock: v.stock,
    imageUrl: v.imageUrl,
  }));

  return {
    provider: (p.sourceProvider as NormalizedProduct["provider"]) || "manual",
    // «migracion» le dice al resto del sistema que los precios de esta ficha ya
    // son definitivos y NO hay que volver a pasarles la regla de margen: vienen
    // de un catálogo vivo donde alguien los decidió a mano.
    method: "migracion",
    sourceProductId: p.sourceProductId,
    sourceUrl: p.sourceUrl,
    title: p.title,
    description: p.description,
    attributes: {},
    images: p.images
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((i) => ({ url: i.url, alt: i.alt || p.title })),
    optionNames,
    variants: variantes,
    costCentsMin: p.costCents,
    costCentsMax: p.costCents,
    currency: "USD",
    vendor: p.vendor,
    warnings: [],
  };
}

/**
 * Las fotos que viven en /public no las puede descargar Shopify: son rutas
 * relativas. Se convierten a la dirección pública del sitio actual, que sigue
 * en pie mientras dure la mudanza, y Shopify las baja de ahí.
 */
function absolutizarFotos(ficha: NormalizedProduct, sitio: string): number {
  let convertidas = 0;
  ficha.images = ficha.images
    .map((img) => {
      if (/^https?:\/\//i.test(img.url)) return img;
      if (img.url.startsWith("/")) {
        convertidas++;
        return { ...img, url: `${sitio.replace(/\/$/, "")}${img.url}` };
      }
      return img;
    })
    .filter((img) => /^https?:\/\//i.test(img.url));

  for (const v of ficha.variants) {
    if (v.imageUrl && v.imageUrl.startsWith("/")) {
      v.imageUrl = `${sitio.replace(/\/$/, "")}${v.imageUrl}`;
    }
  }
  return convertidas;
}

/* ─────────────────────────── pasos ─────────────────────────── */

async function migrarColecciones(
  cliente: ClienteShopify,
  sitio: string,
): Promise<Map<string, string>> {
  titulo("1 · Colecciones");
  const mapa = new Map<string, string>();

  const colecciones = await db.collection.findMany({ orderBy: { position: "asc" } });
  if (!colecciones.length) {
    nota("No hay ninguna colección que migrar.");
    return mapa;
  }

  for (const c of colecciones) {
    if (!APLICAR) {
      nota(`(simulado) «${c.title}» → /collections/${c.slug}`);
      cuenta.colecciones++;
      continue;
    }
    try {
      const imagen =
        c.imageUrl && c.imageUrl.startsWith("/")
          ? `${sitio.replace(/\/$/, "")}${c.imageUrl}`
          : c.imageUrl || undefined;

      const id = await crearColeccion(cliente, {
        handle: c.slug,
        titulo: c.title,
        descripcionHtml: c.description ? markdownAHtml(c.description) : "",
        imagenUrl: imagen || undefined,
      });
      mapa.set(c.id, id);
      cuenta.colecciones++;
      bien(`«${c.title}» → /collections/${c.slug}`);
    } catch (error) {
      fallo(`colección «${c.title}»`, error);
    }
  }

  return mapa;
}

async function migrarProductos(
  cliente: ClienteShopify,
  capacidades: Capacidades,
  mapaColecciones: Map<string, string>,
  sitio: string,
): Promise<void> {
  titulo("2 · Productos");

  const estados = INCLUIR_BORRADORES ? ["active", "draft"] : ["active"];
  const productos = (await db.product.findMany({
    where: { status: { in: estados } },
    orderBy: { createdAt: "asc" },
    include: {
      images: { orderBy: { position: "asc" } },
      variants: { orderBy: { position: "asc" } },
      collections: true,
    },
  })) as unknown as (ProductoPrisma & { collections: { collectionId: string }[] })[];

  if (!productos.length) {
    ojo(`No hay productos con estado ${estados.join(" ni ")}.`);
    if (!INCLUIR_BORRADORES) nota("Añade --con-borradores si también quieres llevarte los borradores.");
    return;
  }

  nota(`${productos.length} productos (${estados.join(" + ")})`);
  let fotosConvertidas = 0;

  for (let i = 0; i < productos.length; i++) {
    const p = productos[i];
    const ficha = aFichaNormalizada(p);
    fotosConvertidas += absolutizarFotos(ficha, sitio);

    const colecciones = p.collections
      .map((cp) => mapaColecciones.get(cp.collectionId))
      .filter((x): x is string => !!x);

    if (!APLICAR) {
      const precio = p.priceCents > 0 ? formatCents(p.priceCents) : "sin precio";
      nota(
        `(simulado) «${p.title}» · ${precio} · ${ficha.variants.length} variantes · ${ficha.images.length} fotos → /products/${p.slug}`,
      );
      cuenta.productos++;
      continue;
    }

    try {
      // Se conserva el slug de siempre: es lo que hace que la redirección 301
      // sea uno-a-uno y que los enlaces compartidos sigan llevando a la pieza.
      const handle = await handleDisponible(cliente, p.slug).catch(() => p.slug);

      const { entrada } = aEntradaProductSet(ficha, capacidades, {
        handle,
        estado: p.status === "active" ? "ACTIVE" : "DRAFT",
        etiquetas: leerLista(p.tagsJson),
      });

      // El productType y el SEO de la tienda actual mandan sobre lo calculado.
      if (p.productType) entrada.productType = p.productType;
      if ((p.seoTitle || p.seoDescription) && entrada.seo) {
        entrada.seo = {
          title: p.seoTitle || (entrada.seo as { title: string }).title,
          description: p.seoDescription || (entrada.seo as { description: string }).description,
        };
      }
      if (colecciones.length && capacidades.camposProductSet.includes("collections")) {
        entrada.collections = colecciones;
      }

      const creado = await crearProducto(cliente, capacidades, entrada);

      // Si productSet no aceptó colecciones, se meten en una segunda llamada.
      if (colecciones.length && !capacidades.camposProductSet.includes("collections")) {
        for (const coleccionId of colecciones) {
          await anadirAColeccion(cliente, coleccionId, [creado.id]).catch(() => {});
        }
      }

      cuenta.productos++;
      progreso(i + 1, productos.length, creado.titulo.slice(0, 34));
    } catch (error) {
      fallo(`producto «${p.title}»`, error);
    }
  }

  if (fotosConvertidas) {
    console.log("");
    nota(`${fotosConvertidas} fotos locales se sirvieron desde ${sitio} para que Shopify las bajara.`);
    ojo("No apagues el sitio actual hasta comprobar que las fotos están en Shopify.");
  }
}

async function migrarPaginas(cliente: ClienteShopify): Promise<void> {
  titulo("3 · Páginas");

  const paginas = await db.page.findMany({
    where: { status: "published" },
    orderBy: { position: "asc" },
  });

  if (!paginas.length) {
    nota("No hay páginas publicadas.");
    return;
  }

  const mutacion = `
    mutation CrearPagina($page: PageCreateInput!) {
      pageCreate(page: $page) {
        page { id handle }
        userErrors { field message }
      }
    }
  `;

  for (const p of paginas) {
    if (!APLICAR) {
      nota(`(simulado) «${p.title}» → /pages/${p.slug}`);
      cuenta.paginas++;
      continue;
    }
    try {
      const datos = await cliente.pedir<{
        pageCreate: { page: { id: string; handle: string } | null; userErrors: ErrorDeUsuario[] };
      }>(
        mutacion,
        {
          page: {
            title: p.title,
            handle: p.slug,
            body: markdownAHtml(p.content),
            isPublished: true,
            ...(p.seoTitle || p.seoDescription
              ? { templateSuffix: null, metafields: [] }
              : {}),
          },
        },
        `página «${p.title}»`,
      );
      reventarSiHayErrores(datos.pageCreate?.userErrors, `la página «${p.title}»`);
      cuenta.paginas++;
      bien(`«${p.title}» → /pages/${p.slug}`);
    } catch (error) {
      fallo(`página «${p.title}»`, error);
    }
  }
}

async function migrarDescuentos(cliente: ClienteShopify): Promise<void> {
  titulo("4 · Descuentos");

  const descuentos = await db.discount.findMany({ where: { isActive: true } });
  if (!descuentos.length) {
    nota("No hay descuentos activos.");
    return;
  }

  const mutacion = `
    mutation CrearDescuento($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }
  `;

  for (const d of descuentos) {
    // El envío gratis es otro tipo de descuento en Shopify (discountCodeFreeShippingCreate),
    // con su propio formulario. Se avisa en vez de convertirlo en un porcentaje falso.
    if (d.type === "free_shipping") {
      ojo(`«${d.code}» es de envío gratis: en Shopify es otro tipo. Créalo a mano.`);
      continue;
    }

    if (!APLICAR) {
      const valor = d.type === "percentage" ? `${d.value}%` : formatCents(d.value);
      nota(`(simulado) ${d.code} · ${valor}`);
      cuenta.descuentos++;
      continue;
    }

    try {
      const customerGets =
        d.type === "percentage"
          ? { value: { percentage: d.value / 100 }, items: { all: true } }
          : { value: { discountAmount: { amount: centavosADecimal(d.value), appliesOnEachItem: false } }, items: { all: true } };

      const entrada: Record<string, unknown> = {
        title: d.title || d.code,
        code: d.code,
        startsAt: (d.startsAt || d.createdAt).toISOString(),
        ...(d.endsAt ? { endsAt: d.endsAt.toISOString() } : {}),
        customerSelection: { all: true },
        customerGets,
        appliesOncePerCustomer: d.oncePerCustomer,
        ...(d.usageLimit > 0 ? { usageLimit: d.usageLimit } : {}),
        ...(d.minSubtotalCents > 0
          ? {
              minimumRequirement: {
                subtotal: { greaterThanOrEqualToSubtotal: centavosADecimal(d.minSubtotalCents) },
              },
            }
          : {}),
      };

      const datos = await cliente.pedir<{
        discountCodeBasicCreate: {
          codeDiscountNode: { id: string } | null;
          userErrors: ErrorDeUsuario[];
        };
      }>(mutacion, { basicCodeDiscount: entrada }, `descuento ${d.code}`);

      reventarSiHayErrores(datos.discountCodeBasicCreate?.userErrors, `el descuento ${d.code}`);
      cuenta.descuentos++;
      bien(`${d.code}`);
    } catch (error) {
      fallo(`descuento ${d.code}`, error);
    }
  }
}

/**
 * Las 301. Cada dirección del sitio actual apunta a su equivalente en Shopify.
 *
 * Se generan a partir del catálogo real y no de una lista escrita a mano: si
 * mañana hay veinte productos más, este paso los cubre solo.
 */
async function migrarRedirecciones(cliente: ClienteShopify): Promise<void> {
  titulo("5 · Redirecciones 301");

  const [productos, colecciones, paginas] = await Promise.all([
    db.product.findMany({ where: { status: "active" }, select: { slug: true } }),
    db.collection.findMany({ select: { slug: true } }),
    db.page.findMany({ where: { status: "published" }, select: { slug: true } }),
  ]);

  const pares: { de: string; a: string }[] = [
    // Las rutas fijas del sitio actual.
    { de: "/tienda", a: "/collections/all" },
    { de: "/carrito", a: "/cart" },
    { de: "/checkout", a: "/cart" },
    ...productos.map((p) => ({ de: `/producto/${p.slug}`, a: `/products/${p.slug}` })),
    ...colecciones.map((c) => ({ de: `/coleccion/${c.slug}`, a: `/collections/${c.slug}` })),
    ...paginas.map((p) => ({ de: `/pagina/${p.slug}`, a: `/pages/${p.slug}` })),
  ];

  // Las redirecciones que ya existían en la tabla Redirect del sitio actual: se
  // arrastran también, porque a su vez venían de enlaces viejos compartidos.
  try {
    const heredadas = await db.redirect.findMany({ select: { fromPath: true, toPath: true } });
    for (const r of heredadas) {
      const destino = r.toPath.startsWith("/producto/")
        ? r.toPath.replace("/producto/", "/products/")
        : r.toPath.startsWith("/coleccion/")
          ? r.toPath.replace("/coleccion/", "/collections/")
          : r.toPath.startsWith("/pagina/")
            ? r.toPath.replace("/pagina/", "/pages/")
            : r.toPath;
      pares.push({ de: r.fromPath, a: destino });
    }
  } catch {
    // La tabla puede no existir en una base vieja: no es motivo para parar.
  }

  // Sin duplicados: Shopify rechaza dos redirecciones con el mismo origen.
  const vistas = new Set<string>();
  const unicas = pares.filter((p) => {
    if (vistas.has(p.de)) return false;
    vistas.add(p.de);
    return true;
  });

  nota(`${unicas.length} redirecciones`);

  if (!APLICAR) {
    for (const p of unicas.slice(0, 6)) nota(`(simulado) ${p.de} → ${p.a}`);
    if (unicas.length > 6) nota(`… y ${unicas.length - 6} más`);
    cuenta.redirecciones = unicas.length;
    return;
  }

  const mutacion = `
    mutation Redirigir($redirect: UrlRedirectInput!) {
      urlRedirectCreate(urlRedirect: $redirect) {
        urlRedirect { id }
        userErrors { field message }
      }
    }
  `;

  for (let i = 0; i < unicas.length; i++) {
    const par = unicas[i];
    try {
      const datos = await cliente.pedir<{
        urlRedirectCreate: { urlRedirect: { id: string } | null; userErrors: ErrorDeUsuario[] };
      }>(mutacion, { redirect: { path: par.de, target: par.a } }, `redirección ${par.de}`);

      const errores = datos.urlRedirectCreate?.userErrors || [];
      // "ya existe" no es un fallo cuando se relanza la migración.
      const soloDuplicado =
        errores.length > 0 && errores.every((e) => /already|ya existe|taken/i.test(e.message));
      if (!soloDuplicado) reventarSiHayErrores(errores, `la redirección ${par.de}`);

      cuenta.redirecciones++;
      progreso(i + 1, unicas.length, par.de.slice(0, 34));
    } catch (error) {
      fallo(`redirección ${par.de}`, error);
    }
  }
}

/**
 * Shopify no tiene reseñas nativas: las pone una app (Judge.me, Loox, Shopify
 * Product Reviews...). Como no se puede saber cuál se instalará, se exportan a
 * un CSV con las columnas que TODAS aceptan al importar. Perderlas sería perder
 * prueba social real de clientas reales.
 */
async function exportarResenas(): Promise<void> {
  titulo("6 · Reseñas");

  const resenas = await db.review.findMany({
    where: { status: "approved" },
    orderBy: { createdAt: "asc" },
  });

  if (!resenas.length) {
    nota("No hay reseñas aprobadas.");
    return;
  }

  const productos = await db.product.findMany({ select: { id: true, slug: true, title: true } });
  const porId = new Map(productos.map((p) => [p.id, p]));

  const escaparCsv = (v: string) => `"${String(v || "").replace(/"/g, '""')}"`;
  const filas = [
    "product_handle,product_title,rating,author,email,title,body,created_at,verified",
    ...resenas.map((r) => {
      const p = r.productId ? porId.get(r.productId) : null;
      return [
        escaparCsv(p?.slug || ""),
        escaparCsv(p?.title || ""),
        String(r.rating),
        escaparCsv(r.authorName),
        escaparCsv(""),
        escaparCsv(r.title),
        escaparCsv(r.body),
        escaparCsv(r.createdAt.toISOString().slice(0, 10)),
        r.isVerified ? "true" : "false",
      ].join(",");
    }),
  ];

  const destino = path.join(process.cwd(), "shopify", "resenas-para-importar.csv");
  await writeFile(destino, filas.join("\n"), "utf8");
  cuenta.resenas = resenas.length;

  bien(`${resenas.length} reseñas exportadas`);
  nota(destino);
  nota("Súbelo desde la app de reseñas que instales (Judge.me y Loox aceptan este formato).");
}

/* ─────────────────────────── principal ─────────────────────────── */

async function principal(): Promise<void> {
  console.log(negrita("\nMudanza del catálogo de Bloom a Shopify"));
  regla();

  const sitio =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://bloom-by-madeline.vercel.app";

  if (!APLICAR) {
    console.log("");
    ojo("MODO SIMULACIÓN: no se escribe nada en Shopify.");
    nota("Cuando el resumen te cuadre, repite el comando con --aplicar.");
  } else {
    console.log("");
    ojo("MODO REAL: esto SÍ escribe en la tienda.");
  }

  // De qué base se está leyendo: importa mucho y es invisible si no se dice.
  const bd = process.env.DATABASE_URL || "(sin DATABASE_URL)";
  const bdCorta = bd.startsWith("file:")
    ? bd
    : bd.replace(/\/\/[^@]*@/, "//<credenciales>@").split("?")[0];
  nota(`Base de datos de origen: ${bdCorta}`);
  nota(`Fotos locales se servirán desde: ${sitio}`);
  if (SOLO.size < PASOS.length) nota(`Solo estos pasos: ${[...SOLO].join(", ")}`);

  let cliente: ClienteShopify;
  try {
    cliente = await ClienteShopify.crear();
    bien(`Destino: ${cliente.tienda} · API ${cliente.versionApi}`);
  } catch (error) {
    mal(mensajeDe(error));
    if (error instanceof ErrorShopify) nota(error.pista);
    nota("Ejecuta primero: npx tsx shopify/verificar.ts");
    process.exitCode = 1;
    return;
  }

  const capacidades = await detectarCapacidades(cliente);

  let mapaColecciones = new Map<string, string>();
  if (hacer("colecciones")) mapaColecciones = await migrarColecciones(cliente, sitio);
  if (hacer("productos")) await migrarProductos(cliente, capacidades, mapaColecciones, sitio);
  if (hacer("paginas")) await migrarPaginas(cliente);
  if (hacer("descuentos")) await migrarDescuentos(cliente);
  if (hacer("redirecciones")) await migrarRedirecciones(cliente);
  if (hacer("resenas")) await exportarResenas();

  /* resumen */
  console.log("");
  regla();
  console.log(negrita(APLICAR ? "Migrado" : "Simulación — nada se escribió"));
  console.log(`  colecciones   ${cuenta.colecciones}`);
  console.log(`  productos     ${cuenta.productos}`);
  console.log(`  páginas       ${cuenta.paginas}`);
  console.log(`  descuentos    ${cuenta.descuentos}`);
  console.log(`  redirecciones ${cuenta.redirecciones}`);
  console.log(`  reseñas       ${cuenta.resenas} (a CSV)`);

  if (cuenta.fallos.length) {
    console.log("");
    console.log(rojo(`  ${cuenta.fallos.length} fallos:`));
    for (const f of cuenta.fallos.slice(0, 20)) console.log(gris(`   · ${f}`));
    if (cuenta.fallos.length > 20) console.log(gris(`   … y ${cuenta.fallos.length - 20} más`));
    process.exitCode = 1;
  }

  console.log("");
  if (APLICAR && !cuenta.fallos.length) {
    console.log(`${verde("Listo.")} Míralo en ${cian(cliente.panel)}\n`);
  } else if (!APLICAR) {
    console.log(`${gris("Para hacerlo de verdad:")} npx tsx shopify/migrar-catalogo.ts --aplicar\n`);
  }

  await db.$disconnect();
}

principal().catch(async (error) => {
  console.error(`${rojo("\nError inesperado:")} ${mensajeDe(error)}`);
  if (error instanceof ErrorShopify) console.error(gris(error.pista));
  process.exitCode = 1;
  await db.$disconnect().catch(() => {});
});
