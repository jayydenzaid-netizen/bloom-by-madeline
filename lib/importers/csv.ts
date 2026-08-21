// Importación y exportación por CSV. Sin dependencias: un CSV es texto y las
// librerías de parseo pesan más que el problema.
//
// ── POR QUÉ HAY EXPORTACIÓN ──────────────────────────────────────────────────
// La exportación sale con las columnas EXACTAS de la plantilla de productos de
// Shopify. No es capricho técnico: es para que Madeline no se sienta atrapada.
// Si algún día quiere irse a Shopify, se descarga el CSV, lo sube allí y su
// catálogo entero viaja con ella. Una tienda de la que no puedes salir es una
// tienda en la que no confías.
//
// ── CABECERAS QUE SE ACEPTAN AL IMPORTAR ────────────────────────────────────
// Se normaliza cada cabecera (minúsculas, sin espacios ni signos), así que da
// igual "Variant Price", "variant_price" o "PRECIO". Columnas reconocidas:
//
//   handle              agrupa las filas de un mismo producto (Shopify: "Handle")
//   title               título                     ("Title")
//   description         descripción HTML o texto   ("Body (HTML)")
//   status              draft | active | archived  ("Status", "Published")
//                       Se lee, pero NO publica solo: deja preseleccionado el
//                       estado en la revisión y lo confirma una persona.
//   vendor              proveedor visible          ("Vendor")
//   type                tipo de producto           ("Type", "Product Category")
//   tags                etiquetas separadas por coma o por | ("Tags")
//   option1_name/value  nombre y valor de la 1ª opción ("Option1 Name"/"Option1 Value")
//   option2_name/value  ídem 2ª
//   option3_name/value  ídem 3ª
//   sku                 código de variante         ("Variant SKU")
//   price               precio de venta            ("Variant Price")
//   compare_at_price    precio tachado             ("Variant Compare At Price")
//   cost                lo que cuesta al comprarlo ("Cost per item")
//   stock               unidades                   ("Variant Inventory Qty")
//   track_stock         true/false                 ("Variant Inventory Tracker")
//   weight_grams        peso en gramos             ("Variant Grams")
//   image_url           foto                       ("Image Src")
//   image_alt           texto alternativo          ("Image Alt Text")
//   variant_image       foto propia de la variante ("Variant Image")
//   source_url / source_provider / source_product_id   trazabilidad del origen
//
// Solo `title` (o `handle`) es obligatorio. Al estilo Shopify, una fila que solo
// trae handle + image_url añade una foto más al producto anterior.

import { parseToCents, formatCents } from "@/lib/money";
import { slugify } from "@/lib/slug";
import { emptyProduct, type NormalizedProduct, type NormalizedVariant } from "@/lib/importers/types";

// ─────────────────────────────── parser genérico ───────────────────────────────

/**
 * CSV → matriz de celdas. Tolera comillas, comas y saltos de línea dentro de los
 * campos, comillas escapadas ("") y finales de línea de Windows.
 *
 * Se escribe a mano porque el caso que rompe a los parsers ingenuos (partir por
 * comas) es justo el habitual aquí: descripciones de producto con comas dentro.
 */
export function parseCsv(text: string): string[][] {
  // El BOM que mete Excel al guardar en UTF-8 se pega a la primera cabecera y la
  // deja irreconocible ("﻿Handle"). Fuera.
  const src = typeof text === "string" ? (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) : "";

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Las líneas en blanco del final no son productos vacíos, son line endings.
  return rows.filter((cells) => !(cells.length === 1 && cells[0].trim() === ""));
}

/** Una celda es segura si no lleva nada que rompa la siguiente lectura. */
export function csvEscape(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  // CRLF porque es lo que espera Excel, que es lo que Madeline va a abrir.
  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

// ───────────────────────────── importación de CSV ─────────────────────────────

/** "Body (HTML)" → "bodyhtml". Así una sola tabla cubre todos los alias. */
function normalizeHeader(header: string): string {
  return (header || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Alias normalizado → campo interno. */
const HEADER_MAP: Record<string, string> = {
  handle: "handle",
  slug: "handle",
  identificador: "handle",

  title: "title",
  titulo: "title",
  nombre: "title",
  producto: "title",

  description: "description",
  descripcion: "description",
  bodyhtml: "description",
  body: "description",

  status: "status",
  estado: "status",
  published: "published",
  publicado: "published",

  vendor: "vendor",
  proveedor: "vendor",
  marca: "vendor",

  type: "type",
  producttype: "type",
  productcategory: "type",
  tipo: "type",
  categoria: "type",

  tags: "tags",
  etiquetas: "tags",

  option1name: "option1_name",
  option1value: "option1_value",
  option2name: "option2_name",
  option2value: "option2_value",
  option3name: "option3_name",
  option3value: "option3_value",
  opcion1nombre: "option1_name",
  opcion1valor: "option1_value",
  opcion2nombre: "option2_name",
  opcion2valor: "option2_value",
  opcion3nombre: "option3_name",
  opcion3valor: "option3_value",
  talla: "option1_value",
  color: "option2_value",

  sku: "sku",
  variantsku: "sku",

  price: "price",
  precio: "price",
  variantprice: "price",

  compareatprice: "compare_at_price",
  variantcompareatprice: "compare_at_price",
  preciotachado: "compare_at_price",
  precioanterior: "compare_at_price",

  cost: "cost",
  costo: "cost",
  coste: "cost",
  costperitem: "cost",

  stock: "stock",
  inventario: "stock",
  variantinventoryqty: "stock",
  cantidad: "stock",

  trackstock: "track_stock",
  variantinventorytracker: "track_stock",
  controlarstock: "track_stock",

  weightgrams: "weight_grams",
  variantgrams: "weight_grams",
  pesogramos: "weight_grams",
  gramos: "weight_grams",

  imageurl: "image_url",
  imagesrc: "image_url",
  imagen: "image_url",
  foto: "image_url",

  imagealt: "image_alt",
  imagealttext: "image_alt",
  textoalternativo: "image_alt",

  variantimage: "variant_image",
  imagenvariante: "variant_image",

  sourceurl: "source_url",
  urlorigen: "source_url",
  enlace: "source_url",
  sourceprovider: "source_provider",
  sourceproductid: "source_product_id",
};

export type CsvImportResult = {
  products: NormalizedProduct[];
  /** Fallos que impidieron leer filas. */
  errors: string[];
  /** Cosas raras que sí se pudieron salvar. */
  warnings: string[];
};

/* ───────────── campos de producto que el CSV trae y el contrato no ───────────── */

/**
 * `status`, `tags` y `type` son de PRODUCTO, no de variante, y `NormalizedProduct`
 * —el contrato común de todos los proveedores, en `lib/importers/types.ts`— todavía
 * no tiene dónde ponerlos. Se cuelgan del producto normalizado como campos extra:
 * el borrador se guarda con `JSON.stringify`, así que viajan enteros hasta la
 * publicación, que los recoge con `leerExtrasDeProducto()`.
 *
 * Antes de esto el parser ni siquiera los leía: la plantilla de ejemplo ofrecía las
 * tres columnas, quien las rellenaba creía que servían, y el producto acababa
 * publicado con `tagsJson = "[]"` y sin tipo. Ofrecer una columna y tirarla en
 * silencio es peor que no ofrecerla.
 */
export type ExtrasDeProducto = {
  /** Etiquetas del fichero, ya partidas por coma o por «|». */
  tags: string[];
  /** Tipo/categoría de producto ("Vestidos"). */
  productType: string;
  /** Lo que el fichero pide, o null si no dijo nada. NO se aplica solo: ver abajo. */
  status: "draft" | "active" | "archived" | null;
};

/** Un producto de CSV es un `NormalizedProduct` con esos tres campos de más. */
export type CsvProduct = NormalizedProduct & ExtrasDeProducto;

const EXTRAS_VACIOS: ExtrasDeProducto = { tags: [], productType: "", status: null };

/**
 * Lee los extras de un borrador guardado. Tolerante a propósito: los borradores
 * anteriores a este cambio no los llevan, y un borrador manipulado podría traer
 * cualquier cosa en esos campos.
 */
export function leerExtrasDeProducto(product: NormalizedProduct | null | undefined): ExtrasDeProducto {
  if (!product) return { ...EXTRAS_VACIOS };
  const bruto = product as Partial<ExtrasDeProducto>;
  const tags = Array.isArray(bruto.tags)
    ? bruto.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "").map((tag) => tag.trim())
    : [];
  const productType = typeof bruto.productType === "string" ? bruto.productType.trim() : "";
  const status =
    bruto.status === "draft" || bruto.status === "active" || bruto.status === "archived" ? bruto.status : null;
  return { tags, productType, status };
}

/**
 * `status` / `published` → estado del catálogo.
 *
 * Se lee, pero **no activa nada solo**: el contrato dice que nada se publica sin
 * revisión, y un fichero de Excel con `status=active` no es una persona decidiendo
 * poner una pieza en el escaparate. Lo que hace es quedar en el borrador para que
 * la pantalla de revisión preseleccione «a la venta» y Madeline lo confirme con un
 * clic (ese cableado vive en el editor de borradores, ver el informe).
 */
function parseStatus(status: string | undefined, published: string | undefined): ExtrasDeProducto["status"] {
  const texto = (status ?? "").trim().toLowerCase();
  if (texto) {
    if (["draft", "borrador", "sin publicar"].includes(texto)) return "draft";
    if (["active", "activo", "activa", "publicado", "publicada", "published"].includes(texto)) return "active";
    if (["archived", "archivado", "archivada"].includes(texto)) return "archived";
  }
  const publicado = parseBoolean(published);
  if (publicado === true) return "active";
  if (publicado === false) return "draft";
  return null;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (["true", "1", "si", "sí", "yes", "y", "shopify", "activo"].includes(text)) return true;
  if (["false", "0", "no", "n", "", "manual"].includes(text)) return false;
  return null;
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const cleaned = value.replace(/[^\d-]/g, "");
  if (!cleaned) return null;
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function splitTags(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[|,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * CSV → productos normalizados, listos para pasar por el mismo pipeline que
 * AliExpress. Que la vía CSV desemboque en `NormalizedProduct` es lo que permite
 * que la revisión previa a publicar sea idéntica venga de donde venga.
 */
export function parseProductCsv(text: string): CsvImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const rows = parseCsv(text);
  if (rows.length === 0) return { products: [], errors: ["El fichero está vacío."], warnings };

  const headerRow = rows[0].map(normalizeHeader);
  const columns = headerRow.map((header) => HEADER_MAP[header] ?? null);

  if (!columns.includes("title") && !columns.includes("handle")) {
    return {
      products: [],
      errors: [
        "No encontré ninguna columna de título ni de identificador. La primera fila del CSV tiene que ser la de cabeceras (por ejemplo: handle,title,price,image_url).",
      ],
      warnings,
    };
  }

  const desconocidas = headerRow.filter((header, index) => header && !columns[index]);
  if (desconocidas.length > 0) {
    warnings.push(`Columnas ignoradas por no reconocerlas: ${desconocidas.join(", ")}.`);
  }

  const porHandle = new Map<string, CsvProduct>();
  const orden: string[] = [];
  const nombresOpcion = new Map<string, string[]>();
  let ultimoHandle = "";

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const get = (field: string): string | undefined => {
      const index = columns.indexOf(field);
      if (index < 0) return undefined;
      const value = cells[index];
      return value === undefined ? undefined : value.trim();
    };

    const title = get("title") ?? "";
    const handleRaw = get("handle") ?? "";
    const handle = slugify(handleRaw || title) || ultimoHandle;

    if (!handle) {
      errors.push(`Fila ${r + 1}: sin título ni identificador, no se puede saber a qué producto pertenece.`);
      continue;
    }
    ultimoHandle = handle;

    let product = porHandle.get(handle);
    if (!product) {
      if (!title && !handleRaw) {
        errors.push(`Fila ${r + 1}: no hay ningún producto anterior al que añadir esta fila.`);
        continue;
      }
      product = { ...emptyProduct("csv", "csv"), ...EXTRAS_VACIOS };
      product.title = title || handleRaw;
      product.vendor = get("vendor") || undefined;
      product.description = get("description") ?? "";
      product.sourceUrl = get("source_url") ?? null;
      product.sourceProductId = get("source_product_id") ?? handle;
      product.tags = splitTags(get("tags"));
      product.productType = get("type") ?? "";
      product.status = parseStatus(get("status"), get("published"));
      const provider = get("source_provider");
      if (provider === "aliexpress" || provider === "alibaba" || provider === "manual") {
        product.provider = provider;
      }
      porHandle.set(handle, product);
      orden.push(handle);
      nombresOpcion.set(handle, []);
    } else {
      if (title && !product.title) product.title = title;
      // Shopify escribe estos tres solo en la primera fila del producto, pero un
      // fichero hecho a mano puede traerlos en cualquiera. Se queda el primero que
      // llegue: exigir un orden concreto sería tirar el dato otra vez.
      if (product.tags.length === 0) product.tags = splitTags(get("tags"));
      if (!product.productType) product.productType = get("type") ?? "";
      if (!product.status) product.status = parseStatus(get("status"), get("published"));
    }

    // Nombres de opción: en Shopify solo vienen en la primera fila del producto.
    const nombres = nombresOpcion.get(handle) ?? [];
    (["option1_name", "option2_name", "option3_name"] as const).forEach((field, index) => {
      const value = get(field);
      if (value && !nombres[index]) nombres[index] = value;
    });
    nombresOpcion.set(handle, nombres);

    // Foto de la fila (Shopify reparte las fotos en filas propias).
    const imageUrl = get("image_url");
    if (imageUrl) {
      if (!product.images.some((image) => image.url === imageUrl)) {
        product.images.push({ url: imageUrl, alt: get("image_alt") || product.title });
      }
    }

    const optionValues = [get("option1_value"), get("option2_value"), get("option3_value")]
      .map((value) => value ?? "")
      .filter((value, index, all) => value !== "" || all.slice(index + 1).some(Boolean));

    const price = parseToCents(get("price") ?? "");
    const cost = parseToCents(get("cost") ?? "");
    const compareAt = parseToCents(get("compare_at_price") ?? "");
    const stock = parseInteger(get("stock"));
    const sku = get("sku") ?? "";

    // Una fila sin precio, sin sku y sin opciones es una fila de foto: no variante.
    const esFilaDeVariante = price !== null || cost !== null || Boolean(sku) || optionValues.some(Boolean);
    if (!esFilaDeVariante) continue;

    const variant: NormalizedVariant = {
      title: optionValues.filter(Boolean).join(" / ") || "Único",
      optionValues,
      sku,
      costCents: cost,
      priceCents: price,
      compareAtCents: compareAt,
      stock,
      imageUrl: get("variant_image") || null,
    };
    product.variants.push(variant);

    if (stock !== null && parseBoolean(get("track_stock")) === null) {
      // Si trajo unidades pero no dijo si contarlas, se anota: en dropshipping la
      // respuesta normal es "no", pero suponerlo callando sería inventar.
      if (!product.warnings.includes("Hay unidades en el CSV pero no se indicó si controlar el stock.")) {
        product.warnings.push("Hay unidades en el CSV pero no se indicó si controlar el stock.");
      }
    }
  }

  const products: NormalizedProduct[] = [];
  for (const handle of orden) {
    const product = porHandle.get(handle);
    if (!product) continue;

    product.optionNames = (nombresOpcion.get(handle) ?? []).filter(Boolean);

    const costs = product.variants
      .map((variant) => variant.costCents)
      .filter((value): value is number => typeof value === "number");
    product.costCentsMin = costs.length ? Math.min(...costs) : null;
    product.costCentsMax = costs.length ? Math.max(...costs) : null;

    if (product.status === "active") {
      // Se dice en voz alta: el fichero pide venderlo ya, pero activar una pieza
      // sigue siendo una decisión de una persona, no de una columna de Excel.
      product.warnings.push(
        "El fichero pide publicarlo como «a la venta»: elígelo en «Cómo se publica» antes de publicar, la tienda no activa nada sola.",
      );
    }
    if (product.status === "archived") {
      product.warnings.push("El fichero lo trae como archivado: se importará como borrador y podrás archivarlo después.");
    }
    if (product.variants.length === 0) {
      product.warnings.push("Este producto llegó sin ninguna fila de variante: se creará una única sin precio.");
    }
    if (product.images.length === 0) {
      product.warnings.push("Sin fotos: habrá que subirlas a mano.");
    }
    products.push(product);
  }

  if (products.length === 0 && errors.length === 0) {
    errors.push("No se reconoció ningún producto dentro del fichero.");
  }

  return { products, errors, warnings };
}

// ───────────────────────────── exportación a CSV ─────────────────────────────

/**
 * Columnas de la plantilla de productos de Shopify, en su orden oficial.
 * El orden importa: Shopify acepta el fichero por nombre de columna, pero las
 * herramientas de terceros que Madeline pueda usar suelen asumir este orden.
 */
export const SHOPIFY_COLUMNS = [
  "Handle",
  "Title",
  "Body (HTML)",
  "Vendor",
  "Product Category",
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
  "Variant Barcode",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Gift Card",
  "SEO Title",
  "SEO Description",
  "Variant Image",
  "Variant Weight Unit",
  "Variant Tax Code",
  "Cost per item",
  "Status",
] as const;

/** Forma mínima que necesita la exportación. Estructural para poder probarla sin BD. */
export type ExportableProduct = {
  slug: string;
  title: string;
  description: string;
  status: string;
  vendor: string;
  productType: string;
  tagsJson: string;
  optionNamesJson: string;
  seoTitle: string | null;
  seoDescription: string | null;
  images: { url: string; alt: string; position: number; localPath: string | null }[];
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
    weightGrams: number;
    imageUrl: string | null;
    position: number;
  }[];
};

/** Shopify escribe el dinero en dólares con punto, no en centavos. */
function centsToPlain(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Catálogo → CSV de Shopify.
 *
 * Estructura del fichero, que es la parte que se equivoca todo el mundo: la
 * PRIMERA fila de un producto lleva todos sus datos y su primera variante; las
 * siguientes repiten solo el handle y traen una variante o una foto más. Por eso
 * las filas 2..n van casi todas vacías.
 */
export function productsToShopifyCsv(products: ExportableProduct[]): string {
  const rows: (string | number)[][] = [[...SHOPIFY_COLUMNS]];

  for (const product of products) {
    const optionNames = parseJsonArray(product.optionNamesJson);
    const tags = parseJsonArray(product.tagsJson).join(", ");
    const published = product.status === "active" ? "TRUE" : "FALSE";
    const images = [...product.images].sort((a, b) => a.position - b.position);
    const variants = [...product.variants].sort((a, b) => a.position - b.position);

    const maxRows = Math.max(variants.length, images.length, 1);

    for (let i = 0; i < maxRows; i++) {
      const variant = variants[i];
      const image = images[i];
      const primera = i === 0;

      rows.push([
        product.slug,
        primera ? product.title : "",
        primera ? product.description : "",
        primera ? product.vendor : "",
        "",
        primera ? product.productType : "",
        primera ? tags : "",
        primera ? published : "",
        primera ? optionNames[0] ?? (variants.length > 0 ? "Title" : "") : "",
        variant ? variant.option1 ?? (i === 0 ? "Default Title" : "") : "",
        primera ? optionNames[1] ?? "" : "",
        variant ? variant.option2 ?? "" : "",
        primera ? optionNames[2] ?? "" : "",
        variant ? variant.option3 ?? "" : "",
        variant ? variant.sku : "",
        variant ? variant.weightGrams : "",
        variant ? (variant.trackStock ? "shopify" : "") : "",
        variant ? variant.stock : "",
        // "continue" = se sigue vendiendo sin stock, que es el caso del dropshipping.
        variant ? (variant.trackStock ? "deny" : "continue") : "",
        variant ? "manual" : "",
        variant ? centsToPlain(variant.priceCents) : "",
        variant ? centsToPlain(variant.compareAtCents) : "",
        variant ? "TRUE" : "",
        variant ? "TRUE" : "",
        "",
        image ? image.url : "",
        image ? String(i + 1) : "",
        image ? image.alt : "",
        primera ? "FALSE" : "",
        primera ? product.seoTitle ?? "" : "",
        primera ? product.seoDescription ?? "" : "",
        variant ? variant.imageUrl ?? "" : "",
        variant ? "g" : "",
        "",
        variant ? centsToPlain(variant.costCents) : "",
        primera ? (product.status === "archived" ? "archived" : product.status === "active" ? "active" : "draft") : "",
      ]);
    }
  }

  return toCsv(rows);
}

/**
 * Exportación en el formato interno de Bloom: una fila por variante, dinero en
 * dólares legibles. Es la que sirve para revisar precios en Excel y volver a
 * subirla, porque sus cabeceras son justo las que entiende `parseProductCsv`.
 */
export function productsToBloomCsv(products: ExportableProduct[]): string {
  const rows: (string | number)[][] = [
    [
      "handle",
      "title",
      "description",
      "status",
      "vendor",
      "type",
      "tags",
      "option1_name",
      "option1_value",
      "option2_name",
      "option2_value",
      "option3_name",
      "option3_value",
      "sku",
      "price",
      "compare_at_price",
      "cost",
      "stock",
      "track_stock",
      "weight_grams",
      "image_url",
      "image_alt",
    ],
  ];

  for (const product of products) {
    const optionNames = parseJsonArray(product.optionNamesJson);
    const tags = parseJsonArray(product.tagsJson).join("|");
    const images = [...product.images].sort((a, b) => a.position - b.position);
    const variants = [...product.variants].sort((a, b) => a.position - b.position);
    const maxRows = Math.max(variants.length, images.length, 1);

    for (let i = 0; i < maxRows; i++) {
      const variant = variants[i];
      const image = images[i];
      const primera = i === 0;
      rows.push([
        product.slug,
        primera ? product.title : "",
        primera ? product.description : "",
        primera ? product.status : "",
        primera ? product.vendor : "",
        primera ? product.productType : "",
        primera ? tags : "",
        primera ? optionNames[0] ?? "" : "",
        variant?.option1 ?? "",
        primera ? optionNames[1] ?? "" : "",
        variant?.option2 ?? "",
        primera ? optionNames[2] ?? "" : "",
        variant?.option3 ?? "",
        variant?.sku ?? "",
        variant ? centsToPlain(variant.priceCents) : "",
        variant ? centsToPlain(variant.compareAtCents) : "",
        variant ? centsToPlain(variant.costCents) : "",
        variant ? variant.stock : "",
        variant ? (variant.trackStock ? "true" : "false") : "",
        variant ? variant.weightGrams : "",
        image?.url ?? "",
        image?.alt ?? "",
      ]);
    }
  }

  return toCsv(rows);
}

/** Nombre de fichero con fecha: dos exportaciones del mismo día no se pisan. */
export function exportFileName(prefix = "bloom-catalogo"): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  return `${prefix}-${stamp}.csv`;
}

/**
 * Lee el catálogo de la BD y lo devuelve ya en CSV.
 *
 * El `import()` es dinámico a propósito: así este módulo no arrastra Prisma al
 * cargarse y las pruebas del parser corren sin base de datos ni cliente generado.
 */
export async function exportCatalogCsv(
  format: "shopify" | "bloom" = "shopify",
  options: { status?: string } = {},
): Promise<string> {
  const { db } = await import("@/lib/db");

  const products = await db.product.findMany({
    where: options.status ? { status: options.status } : undefined,
    orderBy: { createdAt: "asc" },
    select: {
      slug: true,
      title: true,
      description: true,
      status: true,
      vendor: true,
      productType: true,
      tagsJson: true,
      optionNamesJson: true,
      seoTitle: true,
      seoDescription: true,
      images: {
        orderBy: { position: "asc" },
        select: { url: true, alt: true, position: true, localPath: true },
      },
      variants: {
        orderBy: { position: "asc" },
        select: {
          title: true,
          sku: true,
          option1: true,
          option2: true,
          option3: true,
          priceCents: true,
          compareAtCents: true,
          costCents: true,
          stock: true,
          trackStock: true,
          weightGrams: true,
          imageUrl: true,
          position: true,
        },
      },
    },
  });

  return format === "bloom" ? productsToBloomCsv(products) : productsToShopifyCsv(products);
}

/**
 * Resumen humano de lo que trae un CSV antes de importarlo. Enseñar "12 productos,
 * 34 variantes, desde $8.99" evita el susto de descubrirlo cuando ya está dentro.
 */
export function summarizeCsvImport(result: CsvImportResult): string {
  const productos = result.products.length;
  const variantes = result.products.reduce((total, product) => total + product.variants.length, 0);
  const precios = result.products
    .flatMap((product) => product.variants.map((variant) => variant.priceCents))
    .filter((value): value is number => typeof value === "number" && value > 0);

  const rango = precios.length
    ? ` · precios de ${formatCents(Math.min(...precios))} a ${formatCents(Math.max(...precios))}`
    : " · sin precios";

  return `${productos} ${productos === 1 ? "producto" : "productos"}, ${variantes} ${variantes === 1 ? "variante" : "variantes"}${rango}`;
}
