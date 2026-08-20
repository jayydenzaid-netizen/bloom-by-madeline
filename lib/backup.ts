import { z } from "zod";
import { db } from "@/lib/db";

/**
 * Copias de seguridad de la tienda.
 *
 * Esto es el seguro de Madeline contra un desastre (un `db push --force-reset`
 * mal dado, un disco muerto, un despliegue con la base vacía) y, a la vez, su
 * llave para irse: el volcado lleva TODO su catálogo y sus pedidos en un JSON
 * legible, y el CSV sale en el formato de la plantilla de productos de Shopify.
 * Si algún día decide mudarse, no tiene que teclear nada otra vez.
 *
 * Qué NO se exporta, a propósito:
 *  - `AdminUser` y `Session`: llevan hashes de contraseña y tokens de sesión.
 *    Un fichero que se descarga a un móvil y se manda por WhatsApp no puede
 *    contener credenciales. Restaurar tampoco toca las cuentas: si se pudiera,
 *    una copia vieja devolvería la vida a un acceso ya revocado.
 *  - `Cart`/`CartItem`: son el carrito a medio llenar de un visitante anónimo.
 *    No es dato de negocio y caduca solo.
 *  - `ActivityLog`, `StockMovement`, `ImportJob`, `DiscountUsage`: historiales.
 *    Restaurarlos falsearía la auditoría ("quién hizo qué" tiene que ser lo que
 *    de verdad pasó en ESTA instalación, no lo que pasó en otra).
 */

/* ═══════════════════════════ formato del fichero ═══════════════════════════ */

/** Marca del formato. Si el fichero no la trae, no es una copia de Bloom. */
export const BACKUP_FORMATO = "bloom-by-madeline/backup";

/**
 * Versión del volcado. Se sube cuando cambia la FORMA de los datos.
 * Un fichero de otra versión no se aplica a medias: se avisa y se para. Medio
 * catálogo restaurado es peor que ninguno, porque parece que funcionó.
 */
export const BACKUP_VERSION = 1;

export type ResumenCopia = Record<string, number>;

export type FicheroCopia = {
  formato: string;
  version: number;
  generadoEl: string;
  tienda: { nombre: string; url: string };
  /** Cuántos registros lleva cada tabla: se enseña antes de restaurar. */
  resumen: ResumenCopia;
  /** Lo que esta copia NO incluye, escrito dentro del propio fichero. */
  excluidos: string[];
  datos: DatosCopia;
};

export type DatosCopia = {
  settings: unknown[];
  products: unknown[];
  productImages: unknown[];
  productVariants: unknown[];
  collections: unknown[];
  collectionProducts: unknown[];
  pages: unknown[];
  menuItems: unknown[];
  homeBlocks: unknown[];
  mediaAssets: unknown[];
  reviews: unknown[];
  discounts: unknown[];
  shippingZones: unknown[];
  shippingRates: unknown[];
  customers: unknown[];
  orders: unknown[];
  orderItems: unknown[];
  redirects: unknown[];
  emailTemplates: unknown[];
};

const EXCLUIDOS = [
  "Cuentas de acceso y sesiones (llevan contraseñas: nunca viajan en un fichero descargable)",
  "Carritos abiertos de visitantes (caducan solos)",
  "Historial de actividad, movimientos de stock, importaciones y usos de descuento",
];

/** Nombre de fichero con la fecha delante: ordenan solos en la carpeta. */
export function nombreArchivoCopia(fecha = new Date()): string {
  const iso = fecha.toISOString().slice(0, 10);
  const hora = fecha.toISOString().slice(11, 16).replace(":", "");
  return `bloom-copia-${iso}-${hora}.json`;
}

export function nombreArchivoCsv(fecha = new Date()): string {
  return `bloom-productos-shopify-${fecha.toISOString().slice(0, 10)}.csv`;
}

/* ══════════════════════════════ exportar ══════════════════════════════ */

/**
 * Vuelca la tienda entera a un objeto serializable.
 *
 * Se leen las tablas en paralelo porque en SQLite son lecturas y no hay riesgo
 * de bloqueo; con el catálogo de una boutique esto tarda milisegundos.
 */
export async function exportAll(): Promise<FicheroCopia> {
  const [
    settings,
    products,
    productImages,
    productVariants,
    collections,
    collectionProducts,
    pages,
    menuItems,
    homeBlocks,
    mediaAssets,
    reviews,
    discounts,
    shippingZones,
    shippingRates,
    customers,
    orders,
    orderItems,
    redirects,
    emailTemplates,
  ] = await Promise.all([
    db.setting.findMany({ orderBy: { key: "asc" } }),
    db.product.findMany({ orderBy: { createdAt: "asc" } }),
    db.productImage.findMany({ orderBy: [{ productId: "asc" }, { position: "asc" }] }),
    db.productVariant.findMany({ orderBy: [{ productId: "asc" }, { position: "asc" }] }),
    db.collection.findMany({ orderBy: { position: "asc" } }),
    db.collectionProduct.findMany(),
    db.page.findMany({ orderBy: { position: "asc" } }),
    db.menuItem.findMany({ orderBy: [{ menu: "asc" }, { position: "asc" }] }),
    db.homeBlock.findMany({ orderBy: { position: "asc" } }),
    db.mediaAsset.findMany({ orderBy: { createdAt: "asc" } }),
    db.review.findMany({ orderBy: { createdAt: "asc" } }),
    db.discount.findMany({ orderBy: { createdAt: "asc" } }),
    db.shippingZone.findMany({ orderBy: { position: "asc" } }),
    db.shippingRate.findMany({ orderBy: [{ zoneId: "asc" }, { position: "asc" }] }),
    db.customer.findMany({ orderBy: { createdAt: "asc" } }),
    db.order.findMany({ orderBy: { createdAt: "asc" } }),
    db.orderItem.findMany(),
    db.redirect.findMany({ orderBy: { createdAt: "asc" } }),
    db.emailTemplate.findMany({ orderBy: { key: "asc" } }),
  ]);

  const datos: DatosCopia = {
    settings,
    products,
    productImages,
    productVariants,
    collections,
    collectionProducts,
    pages,
    menuItems,
    homeBlocks,
    mediaAssets,
    reviews,
    discounts,
    shippingZones,
    shippingRates,
    customers,
    orders,
    orderItems,
    redirects,
    emailTemplates,
  };

  const resumen: ResumenCopia = {};
  for (const [tabla, filas] of Object.entries(datos)) resumen[tabla] = (filas as unknown[]).length;

  return {
    formato: BACKUP_FORMATO,
    version: BACKUP_VERSION,
    generadoEl: new Date().toISOString(),
    tienda: {
      nombre: "Bloom by Madeline",
      url: process.env.NEXT_PUBLIC_SITE_URL || "",
    },
    resumen,
    excluidos: EXCLUIDOS,
    datos,
  };
}

/** El JSON ya en texto, indentado: se abre con cualquier editor y se entiende. */
export async function exportAllJson(): Promise<string> {
  return JSON.stringify(await exportAll(), null, 2);
}

/* ════════════════════════════ CSV de Shopify ════════════════════════════ */

/**
 * Centavos → "45.99".
 *
 * Ojo: aquí NO se usa `formatCents()` a propósito, y no es un despiste. El CSV
 * lo lee una máquina (el importador de Shopify), no una persona: si le llega
 * "$45.99" con símbolo de moneda, Shopify rechaza la fila entera. `formatCents`
 * sigue siendo la única forma de pintar dinero EN PANTALLA.
 */
function dolares(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

/** Escapa una celda de CSV: comillas dobles solo cuando hacen falta. */
function celda(valor: string | number | null | undefined): string {
  const texto = valor === null || valor === undefined ? "" : String(valor);
  if (/[",\n\r]/.test(texto)) return `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

/** Cabeceras de la plantilla oficial de productos de Shopify, en su orden. */
const COLUMNAS_SHOPIFY = [
  "Handle",
  "Title",
  "Body (HTML)",
  "Vendor",
  "Type",
  "Tags",
  "Published",
  "Option1 Name",
  "Option1 Value",
  "Option2 Name",
  "Option2 Value",
  "Option3 Name",
  "Option3 Value",
  "Variant SKU",
  "Variant Grams",
  "Variant Inventory Tracker",
  "Variant Inventory Qty",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Requires Shipping",
  "Variant Taxable",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Gift Card",
  "SEO Title",
  "SEO Description",
  "Status",
  "Cost per item",
];

function leerJsonArray(texto: string | null | undefined): string[] {
  if (!texto) return [];
  try {
    const valor = JSON.parse(texto);
    return Array.isArray(valor) ? valor.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

/**
 * El catálogo en el CSV de Shopify.
 *
 * Estructura del formato (es rara, pero es la suya): la PRIMERA fila de cada
 * producto lleva los datos del producto + su primera variante + su primera
 * imagen. Las siguientes variantes van en filas con el mismo `Handle` y el
 * resto de columnas de producto vacías. Las imágenes sobrantes van en filas
 * que solo llevan `Handle`, `Image Src` e `Image Position`.
 */
export async function exportShopifyCsv(): Promise<string> {
  const productos = await db.product.findMany({
    where: { status: { not: "archived" } },
    orderBy: { createdAt: "asc" },
    include: {
      images: { orderBy: { position: "asc" } },
      variants: { orderBy: { position: "asc" } },
    },
  });

  const lineas: string[] = [COLUMNAS_SHOPIFY.join(",")];

  for (const p of productos) {
    const nombresOpcion = leerJsonArray(p.optionNamesJson);
    const etiquetas = leerJsonArray(p.tagsJson).join(", ");
    const publicado = p.status === "active" ? "TRUE" : "FALSE";

    // Un producto sin variantes igual tiene que salir: se le inventa una fila
    // única con el precio de referencia del producto. Si no, se perdería.
    const variantes =
      p.variants.length > 0
        ? p.variants
        : [
            {
              title: "Default Title",
              sku: "",
              option1: "Default Title",
              option2: null,
              option3: null,
              priceCents: p.priceCents,
              compareAtCents: p.compareAtCents,
              costCents: p.costCents,
              stock: 0,
              trackStock: false,
              weightGrams: 0,
              imageUrl: null,
            },
          ];

    variantes.forEach((v, i) => {
      const primera = i === 0;
      const imagen = primera ? p.images[0] : undefined;

      lineas.push(
        [
          celda(p.slug),
          celda(primera ? p.title : ""),
          celda(primera ? p.description : ""),
          celda(primera ? p.vendor : ""),
          celda(primera ? p.productType : ""),
          celda(primera ? etiquetas : ""),
          celda(primera ? publicado : ""),
          celda(primera ? nombresOpcion[0] || "Title" : ""),
          celda(v.option1 || (v.title || "Default Title")),
          celda(primera ? nombresOpcion[1] || "" : ""),
          celda(v.option2 || ""),
          celda(primera ? nombresOpcion[2] || "" : ""),
          celda(v.option3 || ""),
          celda(v.sku),
          celda(v.weightGrams),
          // "shopify" = Shopify lleva el inventario; vacío = venta sin control,
          // que es el caso normal en dropshipping.
          celda(v.trackStock ? "shopify" : ""),
          celda(v.trackStock ? v.stock : ""),
          celda(v.trackStock ? "deny" : "continue"),
          celda("manual"),
          celda(dolares(v.priceCents)),
          celda(dolares(v.compareAtCents)),
          celda("TRUE"),
          celda("TRUE"),
          celda(imagen?.url ?? ""),
          celda(imagen ? 1 : ""),
          celda(imagen?.alt ?? ""),
          celda(primera ? "FALSE" : ""),
          celda(primera ? p.seoTitle ?? "" : ""),
          celda(primera ? p.seoDescription ?? "" : ""),
          celda(primera ? (p.status === "active" ? "active" : "draft") : ""),
          celda(dolares(v.costCents)),
        ].join(","),
      );
    });

    // Imágenes de la 2ª en adelante: filas solo de imagen.
    p.images.slice(1).forEach((img, i) => {
      const fila = new Array(COLUMNAS_SHOPIFY.length).fill("");
      fila[0] = celda(p.slug);
      fila[COLUMNAS_SHOPIFY.indexOf("Image Src")] = celda(img.url);
      fila[COLUMNAS_SHOPIFY.indexOf("Image Position")] = celda(i + 2);
      fila[COLUMNAS_SHOPIFY.indexOf("Image Alt Text")] = celda(img.alt);
      lineas.push(fila.join(","));
    });
  }

  // CRLF y BOM: Excel en Windows es lo que abre Madeline, y sin BOM se come los
  // acentos ("Camisó n"). Shopify acepta el BOM sin rechistar.
  return `﻿${lineas.join("\r\n")}\r\n`;
}

/* ══════════════════════════════ importar ══════════════════════════════ */

export type ModoImportacion = "anadir" | "reemplazar";

/** Palabra exacta que hay que teclear para reemplazar. Sin ella no se borra nada. */
export const PALABRA_REEMPLAZAR = "REEMPLAZAR";

export type ResultadoImportacion =
  | {
      ok: true;
      modo: ModoImportacion;
      creados: ResumenCopia;
      omitidos: ResumenCopia;
      mensaje: string;
    }
  | { ok: false; error: string; pista?: string };

/* Esquemas: se validan ANTES de tocar la base. Zod ignora las claves de más,
   así que una copia de una versión futura con campos nuevos no revienta el
   parseo — para eso está el control de versión, que sí para. */

const fechaOpcional = z.coerce.date().nullable().optional();

const eProducto = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string(),
  description: z.string().default(""),
  status: z.string().default("draft"),
  vendor: z.string().default("Bloom by Madeline"),
  productType: z.string().default(""),
  tagsJson: z.string().default("[]"),
  optionNamesJson: z.string().default("[]"),
  priceCents: z.number().int().default(0),
  compareAtCents: z.number().int().nullable().optional(),
  costCents: z.number().int().nullable().optional(),
  sourceProvider: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
  sourceProductId: z.string().nullable().optional(),
  sourceDataJson: z.string().nullable().optional(),
  seoTitle: z.string().nullable().optional(),
  seoDescription: z.string().nullable().optional(),
  publishedAt: fechaOpcional,
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

const eImagen = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  url: z.string(),
  alt: z.string().default(""),
  position: z.number().int().default(0),
  localPath: z.string().nullable().optional(),
});

const eVariante = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  title: z.string(),
  sku: z.string().default(""),
  option1: z.string().nullable().optional(),
  option2: z.string().nullable().optional(),
  option3: z.string().nullable().optional(),
  priceCents: z.number().int(),
  compareAtCents: z.number().int().nullable().optional(),
  costCents: z.number().int().nullable().optional(),
  stock: z.number().int().default(0),
  trackStock: z.boolean().default(true),
  weightGrams: z.number().int().default(0),
  imageUrl: z.string().nullable().optional(),
  position: z.number().int().default(0),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

const eColeccion = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string(),
  description: z.string().default(""),
  imageUrl: z.string().nullable().optional(),
  position: z.number().int().default(0),
  isVisible: z.boolean().default(true),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

const eColeccionProducto = z.object({
  collectionId: z.string().min(1),
  productId: z.string().min(1),
  position: z.number().int().default(0),
});

const ePagina = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string(),
  content: z.string().default(""),
  status: z.string().default("draft"),
  seoTitle: z.string().nullable().optional(),
  seoDescription: z.string().nullable().optional(),
  showInFooter: z.boolean().default(true),
  position: z.number().int().default(0),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

const eMenu = z.object({
  id: z.string().min(1),
  menu: z.string().default("main"),
  label: z.string(),
  url: z.string(),
  position: z.number().int().default(0),
  parentId: z.string().nullable().optional(),
  isVisible: z.boolean().default(true),
});

const eBloque = z.object({
  id: z.string().min(1),
  kind: z.string(),
  title: z.string().default(""),
  subtitle: z.string().default(""),
  body: z.string().default(""),
  imageUrl: z.string().nullable().optional(),
  linkUrl: z.string().nullable().optional(),
  linkLabel: z.string().default(""),
  dataJson: z.string().default("{}"),
  position: z.number().int().default(0),
  isVisible: z.boolean().default(true),
});

const eMedia = z.object({
  id: z.string().min(1),
  url: z.string(),
  filename: z.string(),
  mimeType: z.string().default("image/jpeg"),
  bytes: z.number().int().default(0),
  width: z.number().int().default(0),
  height: z.number().int().default(0),
  alt: z.string().default(""),
  folder: z.string().default(""),
  createdAt: z.coerce.date().optional(),
});

const eResena = z.object({
  id: z.string().min(1),
  productId: z.string().nullable().optional(),
  authorName: z.string(),
  rating: z.number().int().default(5),
  title: z.string().default(""),
  body: z.string().default(""),
  status: z.string().default("pending"),
  isVerified: z.boolean().default(false),
  source: z.string().default("manual"),
  createdAt: z.coerce.date().optional(),
});

const eDescuento = z.object({
  id: z.string().min(1),
  code: z.string(),
  title: z.string().default(""),
  type: z.string().default("percentage"),
  value: z.number().int().default(0),
  minSubtotalCents: z.number().int().default(0),
  appliesTo: z.string().default("all"),
  appliesToIdsJson: z.string().default("[]"),
  oncePerCustomer: z.boolean().default(false),
  usageLimit: z.number().int().default(0),
  usageCount: z.number().int().default(0),
  startsAt: fechaOpcional,
  endsAt: fechaOpcional,
  isActive: z.boolean().default(true),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});

const eZona = z.object({
  id: z.string().min(1),
  name: z.string(),
  regionsJson: z.string().default("[]"),
  position: z.number().int().default(0),
});

const eTarifa = z.object({
  id: z.string().min(1),
  zoneId: z.string().min(1),
  name: z.string(),
  priceCents: z.number().int().default(0),
  minSubtotalCents: z.number().int().default(0),
  maxSubtotalCents: z.number().int().default(0),
  etaLabel: z.string().default(""),
  position: z.number().int().default(0),
});

const eCliente = z.object({
  id: z.string().min(1),
  email: z.string(),
  name: z.string().default(""),
  phone: z.string().default(""),
  note: z.string().default(""),
  createdAt: z.coerce.date().optional(),
});

const ePedido = z.object({
  id: z.string().min(1),
  number: z.string(),
  customerId: z.string().nullable().optional(),
  email: z.string(),
  phone: z.string().default(""),
  name: z.string(),
  paymentStatus: z.string().default("pending"),
  fulfillStatus: z.string().default("unfulfilled"),
  paymentMethod: z.string().default("dm"),
  subtotalCents: z.number().int().default(0),
  shippingCents: z.number().int().default(0),
  taxCents: z.number().int().default(0),
  discountCents: z.number().int().default(0),
  totalCents: z.number().int().default(0),
  shipName: z.string().default(""),
  shipLine1: z.string().default(""),
  shipLine2: z.string().default(""),
  shipCity: z.string().default(""),
  shipState: z.string().default(""),
  shipZip: z.string().default(""),
  shipCountry: z.string().default("US"),
  note: z.string().default(""),
  trackingNumber: z.string().nullable().optional(),
  trackingCarrier: z.string().nullable().optional(),
  stripeSessionId: z.string().nullable().optional(),
  channel: z.string().default("online"),
  discountCode: z.string().nullable().optional(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
  paidAt: fechaOpcional,
});

const eLineaPedido = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  productId: z.string().nullable().optional(),
  variantId: z.string().nullable().optional(),
  title: z.string(),
  variantTitle: z.string().default(""),
  sku: z.string().default(""),
  imageUrl: z.string().nullable().optional(),
  priceCents: z.number().int(),
  costCents: z.number().int().nullable().optional(),
  quantity: z.number().int().default(1),
});

const eRedireccion = z.object({
  id: z.string().min(1),
  fromPath: z.string(),
  toPath: z.string(),
  hits: z.number().int().default(0),
  createdAt: z.coerce.date().optional(),
});

const ePlantilla = z.object({
  id: z.string().min(1),
  key: z.string(),
  subject: z.string(),
  body: z.string().default(""),
  isActive: z.boolean().default(true),
  updatedAt: z.coerce.date().optional(),
});

const eAjuste = z.object({ key: z.string().min(1), value: z.string() });

const EsquemaFichero = z.object({
  formato: z.string(),
  version: z.number().int(),
  generadoEl: z.string().optional(),
  datos: z.object({
    settings: z.array(eAjuste).default([]),
    products: z.array(eProducto).default([]),
    productImages: z.array(eImagen).default([]),
    productVariants: z.array(eVariante).default([]),
    collections: z.array(eColeccion).default([]),
    collectionProducts: z.array(eColeccionProducto).default([]),
    pages: z.array(ePagina).default([]),
    menuItems: z.array(eMenu).default([]),
    homeBlocks: z.array(eBloque).default([]),
    mediaAssets: z.array(eMedia).default([]),
    reviews: z.array(eResena).default([]),
    discounts: z.array(eDescuento).default([]),
    shippingZones: z.array(eZona).default([]),
    shippingRates: z.array(eTarifa).default([]),
    customers: z.array(eCliente).default([]),
    orders: z.array(ePedido).default([]),
    orderItems: z.array(eLineaPedido).default([]),
    redirects: z.array(eRedireccion).default([]),
    emailTemplates: z.array(ePlantilla).default([]),
  }),
});

export type CopiaValidada = z.infer<typeof EsquemaFichero>;

/**
 * Lee y valida un fichero de copia SIN tocar la base de datos.
 * Se expone aparte para poder enseñar "esto es lo que trae" antes de aplicar.
 */
export function leerCopia(json: string): { ok: true; copia: CopiaValidada } | { ok: false; error: string; pista?: string } {
  let crudo: unknown;
  try {
    crudo = JSON.parse(json);
  } catch {
    return {
      ok: false,
      error: "Ese fichero no es un JSON válido.",
      pista: "Sube el fichero .json tal cual te lo descargaste, sin abrirlo ni editarlo.",
    };
  }

  const objeto = crudo as { formato?: unknown; version?: unknown };

  if (objeto?.formato !== BACKUP_FORMATO) {
    return {
      ok: false,
      error: "Ese fichero no es una copia de seguridad de Bloom.",
      pista: "Las copias de esta tienda empiezan por «formato: bloom-by-madeline/backup».",
    };
  }

  if (objeto?.version !== BACKUP_VERSION) {
    return {
      ok: false,
      error: `La copia es de la versión ${String(objeto?.version)} y esta tienda usa la ${BACKUP_VERSION}. No se ha tocado nada.`,
      pista:
        "Restaurar a medias es peor que no restaurar. Guarda el fichero y pide ayuda antes de seguir: hace falta convertirlo.",
    };
  }

  const validado = EsquemaFichero.safeParse(crudo);
  if (!validado.success) {
    const primero = validado.error.issues[0];
    const donde = primero?.path.join(" → ") || "el fichero";
    return {
      ok: false,
      error: `La copia tiene datos que no cuadran (${donde}). No se ha tocado nada.`,
      pista: primero?.message,
    };
  }

  return { ok: true, copia: validado.data };
}

/**
 * Restaura desde un volcado.
 *
 * - `anadir`: mete lo que falta y respeta lo que ya hay. Nada se pisa ni se
 *   borra; lo que ya existe (por id, o por slug/código/número) se cuenta como
 *   omitido y se dice cuánto.
 * - `reemplazar`: vacía las tablas del volcado y las deja como el fichero.
 *   Exige teclear la palabra exacta, porque esto borra pedidos reales.
 *
 * Todo va dentro de UNA transacción: si algo falla a mitad, la base se queda
 * como estaba. Nunca medio catálogo.
 */
export async function importAll(
  json: string,
  opciones: { modo: ModoImportacion; confirmacion?: string },
): Promise<ResultadoImportacion> {
  const lectura = leerCopia(json);
  if (!lectura.ok) return lectura;

  const { modo } = opciones;

  // Se compara en mayúsculas a propósito: el teclado del móvil autocorrige y
  // Madeline no puede quedarse sin poder restaurar por una minúscula. La
  // barrera es haber TECLEADO la palabra, no la forma de las letras.
  if (modo === "reemplazar" && (opciones.confirmacion ?? "").trim().toUpperCase() !== PALABRA_REEMPLAZAR) {
    return {
      ok: false,
      error: `Para reemplazar hay que escribir ${PALABRA_REEMPLAZAR} en el recuadro de confirmación.`,
      pista: "Reemplazar borra los pedidos y el catálogo de ahora. No se ha tocado nada.",
    };
  }

  const d = lectura.copia.datos;
  const creados: ResumenCopia = {};
  const omitidos: ResumenCopia = {};
  const suma = (mapa: ResumenCopia, clave: string) => {
    mapa[clave] = (mapa[clave] ?? 0) + 1;
  };

  try {
    await db.$transaction(
      async (tx) => {
        if (modo === "reemplazar") {
          // Orden de borrado = de hijo a padre. Las relaciones con onDelete
          // Cascade se llevan por delante imágenes, variantes y líneas, pero se
          // borra explícito lo que no cuelga de nadie.
          await tx.orderItem.deleteMany({});
          await tx.order.deleteMany({});
          await tx.customer.deleteMany({});
          await tx.review.deleteMany({});
          await tx.discountUsage.deleteMany({});
          await tx.discount.deleteMany({});
          await tx.shippingRate.deleteMany({});
          await tx.shippingZone.deleteMany({});
          // Los carritos abiertos apuntan a productos que van a desaparecer:
          // dejarlos sería dejar carritos rotos en el navegador de la gente.
          await tx.cartItem.deleteMany({});
          await tx.cart.deleteMany({});
          await tx.collectionProduct.deleteMany({});
          await tx.collection.deleteMany({});
          await tx.productImage.deleteMany({});
          await tx.productVariant.deleteMany({});
          await tx.product.deleteMany({});
          await tx.page.deleteMany({});
          await tx.menuItem.deleteMany({});
          await tx.homeBlock.deleteMany({});
          await tx.mediaAsset.deleteMany({});
          await tx.redirect.deleteMany({});
          await tx.emailTemplate.deleteMany({});
          await tx.setting.deleteMany({});
        }

        /* ── catálogo ── */
        for (const p of d.products) {
          const choca = await tx.product.findFirst({
            where: { OR: [{ id: p.id }, { slug: p.slug }] },
            select: { id: true },
          });
          if (choca) {
            suma(omitidos, "productos");
            continue;
          }
          await tx.product.create({ data: p });
          suma(creados, "productos");
        }

        for (const img of d.productImages) {
          const padre = await tx.product.findUnique({ where: { id: img.productId }, select: { id: true } });
          const existe = await tx.productImage.findUnique({ where: { id: img.id }, select: { id: true } });
          if (!padre || existe) {
            suma(omitidos, "imágenes");
            continue;
          }
          await tx.productImage.create({ data: img });
          suma(creados, "imágenes");
        }

        for (const v of d.productVariants) {
          const padre = await tx.product.findUnique({ where: { id: v.productId }, select: { id: true } });
          const existe = await tx.productVariant.findUnique({ where: { id: v.id }, select: { id: true } });
          if (!padre || existe) {
            suma(omitidos, "variantes");
            continue;
          }
          await tx.productVariant.create({ data: v });
          suma(creados, "variantes");
        }

        for (const c of d.collections) {
          const choca = await tx.collection.findFirst({
            where: { OR: [{ id: c.id }, { slug: c.slug }] },
            select: { id: true },
          });
          if (choca) {
            suma(omitidos, "colecciones");
            continue;
          }
          await tx.collection.create({ data: c });
          suma(creados, "colecciones");
        }

        for (const cp of d.collectionProducts) {
          const [col, prod] = await Promise.all([
            tx.collection.findUnique({ where: { id: cp.collectionId }, select: { id: true } }),
            tx.product.findUnique({ where: { id: cp.productId }, select: { id: true } }),
          ]);
          if (!col || !prod) {
            suma(omitidos, "productos en colección");
            continue;
          }
          const existe = await tx.collectionProduct.findUnique({
            where: { collectionId_productId: { collectionId: cp.collectionId, productId: cp.productId } },
            select: { productId: true },
          });
          if (existe) {
            suma(omitidos, "productos en colección");
            continue;
          }
          await tx.collectionProduct.create({ data: cp });
          suma(creados, "productos en colección");
        }

        /* ── contenido ── */
        for (const pg of d.pages) {
          const choca = await tx.page.findFirst({ where: { OR: [{ id: pg.id }, { slug: pg.slug }] }, select: { id: true } });
          if (choca) {
            suma(omitidos, "páginas");
            continue;
          }
          await tx.page.create({ data: pg });
          suma(creados, "páginas");
        }

        for (const m of d.menuItems) {
          const existe = await tx.menuItem.findUnique({ where: { id: m.id }, select: { id: true } });
          if (existe) {
            suma(omitidos, "enlaces de menú");
            continue;
          }
          await tx.menuItem.create({ data: m });
          suma(creados, "enlaces de menú");
        }

        for (const b of d.homeBlocks) {
          const existe = await tx.homeBlock.findUnique({ where: { id: b.id }, select: { id: true } });
          if (existe) {
            suma(omitidos, "bloques de portada");
            continue;
          }
          await tx.homeBlock.create({ data: b });
          suma(creados, "bloques de portada");
        }

        for (const a of d.mediaAssets) {
          const existe = await tx.mediaAsset.findUnique({ where: { id: a.id }, select: { id: true } });
          if (existe) {
            suma(omitidos, "imágenes de la biblioteca");
            continue;
          }
          await tx.mediaAsset.create({ data: a });
          suma(creados, "imágenes de la biblioteca");
        }

        for (const r of d.reviews) {
          const existe = await tx.review.findUnique({ where: { id: r.id }, select: { id: true } });
          if (existe) {
            suma(omitidos, "reseñas");
            continue;
          }
          // Una reseña de un producto que ya no está se guarda suelta antes que
          // perderse: la relación es opcional a propósito.
          const producto = r.productId
            ? await tx.product.findUnique({ where: { id: r.productId }, select: { id: true } })
            : null;
          await tx.review.create({ data: { ...r, productId: producto?.id ?? null } });
          suma(creados, "reseñas");
        }

        /* ── promociones y envíos ── */
        for (const dsc of d.discounts) {
          const choca = await tx.discount.findFirst({ where: { OR: [{ id: dsc.id }, { code: dsc.code }] }, select: { id: true } });
          if (choca) {
            suma(omitidos, "descuentos");
            continue;
          }
          await tx.discount.create({ data: dsc });
          suma(creados, "descuentos");
        }

        for (const z of d.shippingZones) {
          const existe = await tx.shippingZone.findUnique({ where: { id: z.id }, select: { id: true } });
          if (existe) {
            suma(omitidos, "zonas de envío");
            continue;
          }
          await tx.shippingZone.create({ data: z });
          suma(creados, "zonas de envío");
        }

        for (const t of d.shippingRates) {
          const zona = await tx.shippingZone.findUnique({ where: { id: t.zoneId }, select: { id: true } });
          const existe = await tx.shippingRate.findUnique({ where: { id: t.id }, select: { id: true } });
          if (!zona || existe) {
            suma(omitidos, "tarifas de envío");
            continue;
          }
          await tx.shippingRate.create({ data: t });
          suma(creados, "tarifas de envío");
        }

        /* ── clientas y pedidos ── */
        for (const c of d.customers) {
          const choca = await tx.customer.findFirst({ where: { OR: [{ id: c.id }, { email: c.email }] }, select: { id: true } });
          if (choca) {
            suma(omitidos, "clientas");
            continue;
          }
          await tx.customer.create({ data: c });
          suma(creados, "clientas");
        }

        for (const o of d.orders) {
          const choca = await tx.order.findFirst({ where: { OR: [{ id: o.id }, { number: o.number }] }, select: { id: true } });
          if (choca) {
            suma(omitidos, "pedidos");
            continue;
          }
          const cliente = o.customerId
            ? await tx.customer.findUnique({ where: { id: o.customerId }, select: { id: true } })
            : null;
          await tx.order.create({ data: { ...o, customerId: cliente?.id ?? null } });
          suma(creados, "pedidos");
        }

        for (const li of d.orderItems) {
          const pedido = await tx.order.findUnique({ where: { id: li.orderId }, select: { id: true } });
          const existe = await tx.orderItem.findUnique({ where: { id: li.id }, select: { id: true } });
          if (!pedido || existe) {
            suma(omitidos, "líneas de pedido");
            continue;
          }
          // El producto y la variante pueden no existir ya: la línea guarda una
          // copia congelada del título y el precio, así que el pedido se lee
          // igual. Se enlaza solo si de verdad está.
          const [prod, vari] = await Promise.all([
            li.productId ? tx.product.findUnique({ where: { id: li.productId }, select: { id: true } }) : null,
            li.variantId ? tx.productVariant.findUnique({ where: { id: li.variantId }, select: { id: true } }) : null,
          ]);
          await tx.orderItem.create({
            data: { ...li, productId: prod?.id ?? null, variantId: vari?.id ?? null },
          });
          suma(creados, "líneas de pedido");
        }

        /* ── SEO, plantillas y ajustes ── */
        for (const r of d.redirects) {
          const choca = await tx.redirect.findFirst({
            where: { OR: [{ id: r.id }, { fromPath: r.fromPath }] },
            select: { id: true },
          });
          if (choca) {
            suma(omitidos, "redirecciones");
            continue;
          }
          await tx.redirect.create({ data: r });
          suma(creados, "redirecciones");
        }

        for (const p of d.emailTemplates) {
          const choca = await tx.emailTemplate.findFirst({ where: { OR: [{ id: p.id }, { key: p.key }] }, select: { id: true } });
          if (choca) {
            suma(omitidos, "plantillas");
            continue;
          }
          await tx.emailTemplate.create({ data: p });
          suma(creados, "plantillas");
        }

        for (const s of d.settings) {
          const existe = await tx.setting.findUnique({ where: { key: s.key }, select: { key: true } });
          if (existe) {
            // En modo añadir un ajuste existente MANDA sobre el del fichero: es
            // la configuración viva de la tienda de hoy.
            suma(omitidos, "ajustes");
            continue;
          }
          await tx.setting.create({ data: { key: s.key, value: s.value } });
          suma(creados, "ajustes");
        }
      },
      // Una restauración completa hace muchas consultas pequeñas; el límite por
      // defecto de 5 s se queda corto con un catálogo grande.
      { maxWait: 15_000, timeout: 120_000 },
    );
  } catch (e) {
    return {
      ok: false,
      error: "La restauración falló y se deshizo entera: tu tienda sigue como estaba.",
      pista: e instanceof Error ? e.message : String(e),
    };
  }

  const totalCreados = Object.values(creados).reduce((a, b) => a + b, 0);
  const totalOmitidos = Object.values(omitidos).reduce((a, b) => a + b, 0);

  return {
    ok: true,
    modo,
    creados,
    omitidos,
    mensaje:
      modo === "reemplazar"
        ? `Tienda reemplazada por la copia: ${totalCreados} registros restaurados.`
        : `Añadidos ${totalCreados} registros nuevos. ${totalOmitidos} ya estaban y se respetaron.`,
  };
}

/* ═══════════════════════════ limpieza de datos ═══════════════════════════ */

/** Días que tiene que llevar parado un carrito para considerarlo abandonado. */
export const DIAS_CARRITO_VIEJO = 30;

export type Limpiables = {
  carritos: number;
  carritosDesde: Date;
  importacionesFallidas: number;
};

/**
 * Qué se puede tirar sin perder nada de valor. Se calcula en un sitio único
 * para que el número que se enseña en el aviso y el que se borra sean el mismo.
 */
export async function contarLimpiables(dias = DIAS_CARRITO_VIEJO): Promise<Limpiables> {
  const corte = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  const [carritos, importacionesFallidas] = await Promise.all([
    db.cart.count({ where: { updatedAt: { lt: corte } } }),
    db.importJob.count({ where: { status: "failed" } }),
  ]);
  return { carritos, carritosDesde: corte, importacionesFallidas };
}

/** Borra los carritos parados. Devuelve cuántos se fueron de verdad. */
export async function limpiarCarritos(dias = DIAS_CARRITO_VIEJO): Promise<number> {
  const corte = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  // Las líneas caen solas por el onDelete: Cascade de CartItem.
  const { count } = await db.cart.deleteMany({ where: { updatedAt: { lt: corte } } });
  return count;
}

/** Borra los intentos de importación que fallaron. */
export async function limpiarImportacionesFallidas(): Promise<number> {
  const { count } = await db.importJob.deleteMany({ where: { status: "failed" } });
  return count;
}
