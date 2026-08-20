// Adaptador de AliExpress.
//
// AliExpress no publica un HTML "limpio": la ficha se pinta en el cliente a partir
// de un estado JSON que el servidor deja incrustado en un <script>. Ese estado ha
// cambiado de nombre varias veces (runParams, _d_c_.DCData, __INIT_DATA__...) y de
// forma (módulos en la raíz, módulos anidados, nombres nuevos tipo *Component).
//
// Por eso aquí NADA se accede por una ruta fija. Se recogen todos los candidatos de
// estado que haya en la página, se puntúa cuál trae más módulos reconocibles, y la
// lectura de cada campo cae en cascada hasta una búsqueda en profundidad por nombre
// de clave. Si aun así falta algo, se anota en warnings[] y se sigue: media ficha
// revisable en el admin vale mucho más que un error.
//
// Ninguna función de este fichero lanza hacia arriba: todo error sale como
// ImportResult { ok:false, error, hint } con una pista accionable en español.

import { createHmac } from "node:crypto";
import { parseToCents } from "@/lib/money";
import {
  emptyProduct,
  type ImportMethod,
  type ImportResult,
  type NormalizedImage,
  type NormalizedProduct,
  type NormalizedVariant,
  type ProviderAdapter,
} from "@/lib/importers/types";

// ───────────────────────────── utilidades de tipo ─────────────────────────────
//
// El JSON del proveedor es `unknown` de verdad: cualquier acceso puede no existir
// o venir con otro tipo. Estos accesores devuelven null en vez de reventar.

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Devuelve string útil (recortado y no vacío). Los números también valen: los ids llegan como number. */
function str(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "boolean") return null;
  return null;
}

/** pick(obj, "a.b.c") sin explotar a mitad de camino. */
function pick(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split(".")) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

/**
 * Busca en anchura la primera clave con uno de estos nombres. Es la red de seguridad
 * ante los cambios de estructura de AliExpress: da igual que `skuModule` cuelgue de
 * `data`, de `data.pageModule` o de `DCData.data`, aquí aparece igual.
 * Va con presupuesto de nodos porque el estado de una ficha puede tener decenas de miles.
 */
function deepFind(root: unknown, keys: string[], maxDepth = 8, budget = 30000): unknown {
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  const seen = new Set<object>();
  let head = 0;
  let visited = 0;

  while (head < queue.length) {
    const entry = queue[head++];
    if (!entry) break;
    if (++visited > budget) return undefined;
    if (entry.depth > maxDepth) continue;

    const record = asRecord(entry.node);
    if (record) {
      for (const key of keys) {
        const value = record[key];
        if (value !== undefined && value !== null) return value;
      }
      for (const value of Object.values(record)) {
        if (value && typeof value === "object" && !seen.has(value)) {
          seen.add(value);
          queue.push({ node: value, depth: entry.depth + 1 });
        }
      }
      continue;
    }

    for (const value of asArray(entry.node)) {
      if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        queue.push({ node: value, depth: entry.depth + 1 });
      }
    }
  }
  return undefined;
}

function deepFindRecord(root: unknown, keys: string[], maxDepth = 8): Record<string, unknown> | null {
  return asRecord(deepFind(root, keys, maxDepth));
}

function deepFindArray(root: unknown, keys: string[], maxDepth = 8): unknown[] {
  return asArray(deepFind(root, keys, maxDepth));
}

// ─────────────────────────────── URLs e ids ───────────────────────────────

const HOST_PATTERNS: RegExp[] = [
  /(^|\.)aliexpress\.com$/i, // incluye es./m./www./a./s.click.
  /(^|\.)aliexpress\.us$/i,
  /(^|\.)aliexpress\.ru$/i,
  /(^|\.)aliexpress\.com\.br$/i,
];

/** Acepta URLs sin esquema ("aliexpress.com/item/1.html"), que es como se pegan a mano. */
function toUrl(raw: string): URL | null {
  const value = (raw || "").trim();
  if (!value) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}

function matchesUrl(raw: string): boolean {
  const url = toUrl(raw);
  if (url) return HOST_PATTERNS.some((pattern) => pattern.test(url.hostname));
  // Si ni siquiera parsea, al menos que se vea que es de AliExpress.
  return /(^|[./])aliexpress\.(com|us|ru)([./]|$)/i.test(raw || "");
}

// Los ids de producto de AliExpress son numéricos y largos (hoy 1005…, 16 dígitos).
const PATH_ID_PATTERNS: RegExp[] = [
  /\/item\/(?:[a-z0-9-]+\/)?(\d{6,})\.html/i, // /item/1005006543210987.html y /item/es/1005….html
  /\/i\/(\d{6,})\.html/i, // formato corto de móvil
  /\/item\/(\d{6,})(?:[/?#]|$)/i,
  /\/product\/(\d{6,})(?:[/?#.]|$)/i,
  /\/(\d{9,})\.html/i, // último recurso: cualquier "<numerote>.html"
];

const QUERY_ID_KEYS = ["productId", "product_id", "productid", "itemId", "item_id", "itemid", "objectId"];

function extractIdFrom(raw: string): string | null {
  const url = toUrl(raw);
  // La ruta manda sobre el querystring: los enlaces de tracking traen ids ajenos
  // (del anuncio, de la tienda) en la query.
  const pathname = url ? decodeURIComponent(url.pathname) : (raw || "");
  for (const pattern of PATH_ID_PATTERNS) {
    const match = pattern.exec(pathname);
    if (match?.[1]) return match[1];
  }

  if (url) {
    for (const key of QUERY_ID_KEYS) {
      const value = url.searchParams.get(key);
      const digits = value ? value.replace(/\D/g, "") : "";
      if (digits.length >= 6) return digits;
    }
  } else {
    for (const key of QUERY_ID_KEYS) {
      const match = new RegExp(`[?&]${key}=(\\d{6,})`, "i").exec(raw || "");
      if (match?.[1]) return match[1];
    }
  }

  // Acortadores (a.aliexpress.com/_mNxxxxx, s.click.…) no llevan el id dentro.
  const loose = /(?:^|[/=_-])(\d{12,19})(?:[/?#.]|$)/.exec(pathname);
  return loose?.[1] ?? null;
}

// ─────────────────────────────── imágenes ───────────────────────────────

// Iconos, espaciadores y placeholders que alicdn sirve mezclados con la galería.
const IMAGE_JUNK = /(placeholder|blank\.gif|transparent|spacer|\/icon\/|sprite|loading\.gif|1x1\.(gif|png))/i;

/**
 * `//ae01.alicdn.com/kf/Sxx.jpg_220x220.jpg` → `https://ae01.alicdn.com/kf/Sxx.jpg`
 * AliExpress sirve la miniatura añadiendo un sufijo de tamaño al nombre; quitándolo
 * sale el original a resolución completa, que es lo que queremos guardar.
 */
export function normalizeImageUrl(raw: unknown): string | null {
  const value = str(raw);
  if (!value) return null;
  if (value.startsWith("data:")) return null;

  let url = value;
  if (url.startsWith("//")) url = `https:${url}`;
  else if (url.startsWith("/")) return null; // ruta relativa del sitio: fuera de AliExpress no resuelve
  else if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/^http:\/\//i, "https://");

  url = url.split(/[?#]/)[0] ?? url;
  // ".jpg_640x640q90.jpg", ".jpg_220x220.jpg_.webp", ".png_.webp"
  url = url.replace(/\.(jpg|jpeg|png|webp|gif)_.*$/i, ".$1");
  // "Sxx_220x220.jpg", "Sxx_640x640q90.png"
  url = url.replace(/_\d+x\d+[a-z0-9]*(\.(?:jpg|jpeg|png|webp|gif))$/i, "$1");

  if (IMAGE_JUNK.test(url)) return null;
  if (!/^https:\/\/[^/]+\/.+/.test(url)) return null;
  return url;
}

function pushImage(images: NormalizedImage[], seen: Set<string>, raw: unknown, alt?: string): void {
  // Las entradas de galería a veces son strings y a veces objetos {imageUrl}.
  const candidate =
    typeof raw === "string" || typeof raw === "number"
      ? raw
      : (pick(raw, "imageUrl") ?? pick(raw, "url") ?? pick(raw, "image") ?? pick(raw, "src"));
  const url = normalizeImageUrl(candidate);
  if (!url || seen.has(url)) return;
  seen.add(url);
  images.push(alt ? { url, alt } : { url });
}

// ─────────────────────────────── dinero ───────────────────────────────

const CURRENCY_SIGNS: Array<[RegExp, string]> = [
  [/US\s*\$|USD|^\$/i, "USD"],
  [/€|EUR/i, "EUR"],
  [/£|GBP/i, "GBP"],
  [/R\$|BRL/i, "BRL"],
  [/₽|RUB/i, "RUB"],
  [/MX\$|MXN/i, "MXN"],
];

function detectCurrency(text: unknown): string | null {
  const value = str(text);
  if (!value) return null;
  for (const [pattern, code] of CURRENCY_SIGNS) {
    if (pattern.test(value)) return code;
  }
  return null;
}

/** Los importes de AliExpress son {value:number, currency, formatedAmount} o un string suelto. */
function amountToCents(value: unknown): number | null {
  const record = asRecord(value);
  if (record) {
    const direct = record.value ?? record.amount ?? record.price;
    if (typeof direct === "number") return parseToCents(direct);
    const fromString = parseToCents(str(direct));
    if (fromString !== null) return fromString;
    return parseToCents(str(record.formatedAmount) ?? str(record.formattedAmount));
  }
  if (typeof value === "number") return parseToCents(value);
  return parseToCents(str(value));
}

function amountCurrency(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return detectCurrency(value);
  return str(record.currency) ?? detectCurrency(record.formatedAmount ?? record.formattedAmount);
}

/** "US $12.34 - US $18.90" → { min: 1234, max: 1890 } */
function parseMoneyRange(input: unknown): { min: number | null; max: number | null } {
  const value = str(input);
  if (!value) return { min: null, max: null };
  const parts = value.split(/\s*[-–—~]\s*/).filter((part) => /\d/.test(part));
  if (!parts.length) return { min: null, max: null };
  const min = parseToCents(parts[0] ?? null);
  const max = parts.length > 1 ? parseToCents(parts[parts.length - 1] ?? null) : min;
  return { min, max };
}

// ─────────────────────── extracción del estado del HTML ───────────────────────

/**
 * Recorta el objeto que empieza en `start` contando llaves, pero respetando las
 * comillas: el JSON de una ficha trae descripciones con `{` y `}` dentro.
 */
function sliceBalancedObject(source: string, start: number): string | null {
  if (source[start] !== "{") return null;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

/** JSON.parse a secas y, si falla, un intento de reparación (el estado es JS, no JSON estricto). */
function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // sigue
  }
  const repaired = text
    .replace(/,\s*([}\]])/g, "$1") // comas colgando
    .replace(/:\s*undefined\b/g, ": null")
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'); // claves sin comillas
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

/** Contenido de los <script> cuyos atributos casan con `attrPattern`. */
function scriptContents(html: string, attrPattern: RegExp): string[] {
  const found: string[] = [];
  const tagPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    if (attrPattern.test(match[1] ?? "")) found.push(match[2] ?? "");
  }
  return found;
}

type StateCandidate = { source: string; data: unknown; score: number };

// Nombres de módulo conocidos, en las dos generaciones de la ficha (…Module y …Component).
const MODULE_KEYS = [
  "titleModule",
  "imageModule",
  "priceModule",
  "skuModule",
  "specsModule",
  "descriptionModule",
  "storeModule",
  "productInfoComponent",
  "priceComponent",
  "skuComponent",
  "imageComponent",
];

function scoreState(data: unknown): number {
  let score = 0;
  for (const key of MODULE_KEYS) {
    if (deepFind(data, [key], 5, 8000) !== undefined) score++;
  }
  if (deepFind(data, ["imagePathList"], 6, 8000) !== undefined) score++;
  if (deepFind(data, ["subject"], 5, 8000) !== undefined) score++;
  if (deepFind(data, ["skuPriceList"], 6, 8000) !== undefined) score += 2;
  if (deepFind(data, ["productSKUPropertyList"], 6, 8000) !== undefined) score += 2;
  return score;
}

// Asignaciones a buscar, EN ORDEN DE PREFERENCIA (el orden del contrato).
const STATE_ASSIGNMENTS: Array<{ source: string; pattern: RegExp }> = [
  { source: "runParams", pattern: /window\s*\.\s*runParams\s*(?:\.\s*data\s*)?=\s*/g },
  { source: "runParams", pattern: /\brunParams\s*(?:\.\s*data\s*)?=\s*/g },
  { source: "DCData", pattern: /_d_c_\s*\.\s*DCData\s*=\s*/g },
  { source: "__INIT_DATA__", pattern: /window\s*\.\s*__INIT_DATA__\s*=\s*/g },
  { source: "__STORE_DATA__", pattern: /window\s*\.\s*__STORE_DATA__\s*=\s*/g },
  { source: "__NEXT_DATA__", pattern: /window\s*\.\s*__NEXT_DATA__\s*=\s*/g },
];

/**
 * Una ficha real trae VARIOS `window.runParams = {…}` (uno por bloque de la página),
 * así que no vale con quedarse con el primero: se recogen todos y gana el que traiga
 * más módulos útiles.
 */
function collectStateCandidates(html: string): StateCandidate[] {
  const candidates: StateCandidate[] = [];

  for (const assignment of STATE_ASSIGNMENTS) {
    const pattern = new RegExp(assignment.pattern.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      const start = match.index + match[0].length;
      if (html[start] !== "{") continue;
      const slice = sliceBalancedObject(html, start);
      if (!slice) continue;
      const parsed = parseLoose(slice);
      if (parsed === undefined) continue;
      // `window.runParams = { data: {...} }` vs `window.runParams.data = {...}`.
      const inner = asRecord(pick(parsed, "data")) ?? asRecord(pick(parsed, "props.pageProps"));
      const data = inner ?? parsed;
      const score = scoreState(data);
      if (score > 0) candidates.push({ source: assignment.source, data, score });
      pattern.lastIndex = start + slice.length;
    }
  }

  // <script id="__NEXT_DATA__" type="application/json">
  for (const block of scriptContents(html, /__NEXT_DATA__|application\/json/i)) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("{")) continue;
    const parsed = parseLoose(trimmed);
    if (parsed === undefined) continue;
    const inner = asRecord(pick(parsed, "props.pageProps")) ?? asRecord(pick(parsed, "data"));
    const data = inner ?? parsed;
    const score = scoreState(data);
    if (score > 0) candidates.push({ source: "__NEXT_DATA__", data, score });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

// ─────────────────── fallbacks pobres: ld+json y meta tags ───────────────────

function ldJsonProduct(html: string): Record<string, unknown> | null {
  for (const block of scriptContents(html, /ld\+json/i)) {
    const parsed = parseLoose(block.trim());
    if (parsed === undefined) continue;
    // Puede venir suelto, en array o dentro de @graph.
    const pool: unknown[] = [parsed, ...asArray(parsed), ...asArray(pick(parsed, "@graph"))];
    for (const entry of pool) {
      const record = asRecord(entry);
      if (!record) continue;
      const type = record["@type"];
      const types = Array.isArray(type) ? type.map((t) => str(t)) : [str(type)];
      if (types.some((t) => t?.toLowerCase() === "product")) return record;
    }
  }
  return null;
}

function metaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {};
  const pattern = /<meta\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attrs = match[1] ?? "";
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (key && content && !(key in tags)) tags[key.toLowerCase()] = decodeEntities(content);
  }
  return tags;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function stripHtml(text: unknown): string {
  const value = str(text);
  if (!value) return "";
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────── construcción del producto ───────────────────────────

// AliExpress devuelve los nombres de opción en el idioma de la sesión, casi siempre
// inglés. Se traducen SOLO los nombres (no los valores) para que el admin no tenga
// que renombrarlos a mano en cada importación.
const OPTION_NAME_ES: Record<string, string> = {
  color: "Color",
  colour: "Color",
  size: "Talla",
  "shoe size": "Talla de calzado",
  "ships from": "Envía desde",
  "ship from": "Envía desde",
  style: "Estilo",
  material: "Material",
  length: "Largo",
  quantity: "Cantidad",
  model: "Modelo",
};

function localizeOptionName(name: string): string {
  return OPTION_NAME_ES[name.trim().toLowerCase()] ?? name.trim();
}

type Warner = (message: string) => void;

function makeWarner(target: string[]): Warner {
  return (message: string) => {
    if (!target.includes(message)) target.push(message);
  };
}

type PropertyValue = {
  optionIndex: number;
  label: string;
  image: string | null;
};

/** Construye el NormalizedProduct a partir del estado JSON de la ficha. */
function buildFromState(
  state: { source: string; data: unknown },
  method: ImportMethod,
  sourceUrl: string | null,
): NormalizedProduct {
  const data = state.data;
  const product = emptyProduct("aliexpress", method);
  const warn = makeWarner(product.warnings);

  product.sourceUrl = sourceUrl;
  product.raw = { source: state.source, data };

  // ── título
  const titleModule = deepFindRecord(data, ["titleModule", "productInfoComponent"]);
  product.title =
    str(pick(titleModule, "subject")) ??
    str(pick(titleModule, "productTitle")) ??
    str(deepFind(data, ["subject", "productTitle"], 6)) ??
    "";
  if (!product.title) warn("No encontré el título en el estado de la ficha.");

  // ── id de producto
  product.sourceProductId =
    (sourceUrl ? extractIdFrom(sourceUrl) : null) ??
    str(deepFind(data, ["productId", "productIdStr", "itemId"], 6));

  // ── tienda
  const storeName = str(deepFind(data, ["storeName", "companyName"], 6));
  if (storeName) product.vendor = storeName;

  // ── imágenes
  const seenImages = new Set<string>();
  const imageModule = deepFindRecord(data, ["imageModule", "imageComponent"]);
  let gallery = asArray(pick(imageModule, "imagePathList"));
  if (!gallery.length) gallery = deepFindArray(data, ["imagePathList", "imageList", "imageUrls"], 7);
  for (const entry of gallery) pushImage(product.images, seenImages, entry, product.title || undefined);
  if (!product.images.length) warn("No encontré la galería de imágenes en el estado de la ficha.");

  // ── precio de referencia (rango)
  const priceModule = deepFindRecord(data, ["priceModule", "priceComponent"]);
  // El importe "activity" es el promocional, que es lo que se paga de verdad.
  const minAmount = pick(priceModule, "minActivityAmount") ?? pick(priceModule, "minAmount");
  const maxAmount = pick(priceModule, "maxActivityAmount") ?? pick(priceModule, "maxAmount");
  let costMin = amountToCents(minAmount);
  let costMax = amountToCents(maxAmount);
  const formatted =
    str(pick(priceModule, "formatedActivityPrice")) ??
    str(pick(priceModule, "formatedPrice")) ??
    str(deepFind(data, ["formatedPrice", "formatedActivityPrice"], 6));
  if (costMin === null || costMax === null) {
    const range = parseMoneyRange(formatted);
    costMin = costMin ?? range.min;
    costMax = costMax ?? range.max ?? range.min;
  }

  // ── moneda
  const currency =
    amountCurrency(minAmount) ??
    amountCurrency(maxAmount) ??
    str(deepFind(data, ["currencyCode", "currency"], 6)) ??
    detectCurrency(formatted);
  if (currency) product.currency = currency.toUpperCase();
  if (product.currency !== "USD") {
    // Convertir "a ojo" falsearía el margen; que lo decida Madeline con el cambio del día.
    warn(
      `El proveedor da los precios en ${product.currency}, no en USD. Los costes están SIN convertir: ` +
        "revisa la ficha antes de publicar o vuelve a copiar la página con la moneda puesta en USD.",
    );
  }

  // ── opciones y variantes
  const skuModule = deepFindRecord(data, ["skuModule", "skuComponent"]);
  const propertyList = (() => {
    const direct = asArray(pick(skuModule, "productSKUPropertyList"));
    return direct.length ? direct : deepFindArray(data, ["productSKUPropertyList", "skuProductPropertyList"], 7);
  })();
  const priceList = (() => {
    const direct = asArray(pick(skuModule, "skuPriceList"));
    return direct.length ? direct : deepFindArray(data, ["skuPriceList"], 7);
  })();

  // Índice propertyValueId → { qué opción es, cómo se llama, qué imagen tiene }.
  // Emparejar por este id es lo único que convierte "350852,361386" en "Rojo / S".
  const valueById = new Map<string, PropertyValue>();
  const valuesByOrder: PropertyValue[][] = [];

  for (const rawProperty of propertyList) {
    const property = asRecord(rawProperty);
    if (!property) continue;
    const name = str(property.skuPropertyName) ?? str(property.name) ?? `Opción ${product.optionNames.length + 1}`;
    product.optionNames.push(localizeOptionName(name));
    const optionIndex = product.optionNames.length - 1;
    const bucket: PropertyValue[] = [];
    valuesByOrder.push(bucket);

    for (const rawValue of asArray(property.skuPropertyValues)) {
      const value = asRecord(rawValue);
      if (!value) continue;
      const id = str(value.propertyValueId) ?? str(value.propertyValueIdLong) ?? str(value.id);
      const label =
        str(value.propertyValueDisplayName) ?? str(value.propertyValueName) ?? str(value.name) ?? id ?? "";
      const entry: PropertyValue = {
        optionIndex,
        label,
        image: normalizeImageUrl(value.skuPropertyImagePath ?? value.imagePath ?? value.image),
      };
      bucket.push(entry);
      if (id) valueById.set(id, entry);
    }
  }

  let pairedByIds = 0;
  let pairedByAttr = 0;

  for (const rawSku of priceList) {
    const sku = asRecord(rawSku);
    if (!sku) continue;

    const optionValues: string[] = new Array(product.optionNames.length).fill("");
    let variantImage: string | null = null;
    let matched = 0;

    const propIds = (str(sku.skuPropIds) ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const id of propIds) {
      const value = valueById.get(id);
      if (!value) continue;
      matched++;
      optionValues[value.optionIndex] = value.label;
      if (!variantImage && value.image) variantImage = value.image;
    }
    if (matched) pairedByIds++;

    // Plan B: el propio skuAttr trae "14:350852#Red;5:361386" con el nombre visible.
    if (!matched) {
      const segments = (str(sku.skuAttr) ?? "").split(";").filter(Boolean);
      segments.forEach((segment, index) => {
        const [ids, display] = segment.split("#");
        const valueId = (ids ?? "").split(":")[1]?.trim();
        const known = valueId ? valueById.get(valueId) : undefined;
        const label = known?.label ?? str(display) ?? "";
        if (!label) return;
        const optionIndex = known ? known.optionIndex : index;
        if (optionIndex < optionValues.length) {
          optionValues[optionIndex] = label;
          matched++;
          if (!variantImage && known?.image) variantImage = known.image;
        }
      });
      if (matched) pairedByAttr++;
    }

    const skuVal = asRecord(sku.skuVal);
    const cost =
      amountToCents(skuVal?.skuActivityAmount) ??
      amountToCents(skuVal?.skuAmount) ??
      parseToCents(str(skuVal?.actSkuCalPrice)) ??
      parseToCents(str(skuVal?.skuCalPrice)) ??
      amountToCents(sku.salePrice ?? sku.price);

    const stock = num(skuVal?.availQuantity) ?? num(skuVal?.inventory) ?? num(sku.availQuantity);

    const variant: NormalizedVariant = {
      title: optionValues.filter(Boolean).join(" / ") || "Único",
      optionValues,
      costCents: cost,
      // El precio de venta NO se calcula aquí: lo pone applyPricing() con la regla
      // que Madeline tenga en Ajustes cuando confirme la importación.
      priceCents: null,
      compareAtCents: null,
      stock: stock === null ? null : Math.max(0, Math.round(stock)),
      imageUrl: variantImage,
    };
    const skuId = str(sku.skuId) ?? str(sku.skuIdStr);
    if (skuId) variant.sku = skuId;

    product.variants.push(variant);
  }

  if (priceList.length && !pairedByIds && !pairedByAttr && product.optionNames.length) {
    warn(
      "No pude emparejar las variantes con sus opciones (el proveedor no mandó skuPropIds legibles): " +
        "las variantes salen sin nombre de talla/color. Revísalas a mano antes de publicar.",
    );
  } else if (priceList.length && !pairedByIds && pairedByAttr) {
    warn("Emparejé las variantes por skuAttr en vez de por skuPropIds: comprueba que talla y color no salgan cruzados.");
  }

  // Sin variantes utilizables, un producto de una sola variante sigue siendo importable.
  if (!product.variants.length) {
    if (propertyList.length || priceList.length) {
      warn("El bloque de variantes venía vacío o ilegible: creé una sola variante con el precio de la ficha.");
    }
    product.optionNames = [];
    product.variants.push({
      title: "Único",
      optionValues: [],
      costCents: costMin,
      priceCents: null,
      compareAtCents: null,
      stock: null,
      imageUrl: null,
    });
    if (costMin === null) warn("No encontré ningún precio en la ficha: hay que ponerle el coste a mano.");
  }

  // Las fotos de color de las variantes también sirven de galería, y a menudo son
  // las únicas que enseñan la prenda en cada color.
  for (const variant of product.variants) {
    if (variant.imageUrl) pushImage(product.images, seenImages, variant.imageUrl, variant.title);
  }

  // ── rango de coste: si las variantes traen precio propio, mandan ellas
  const variantCosts = product.variants
    .map((variant) => variant.costCents)
    .filter((value): value is number => typeof value === "number");
  product.costCentsMin = variantCosts.length ? Math.min(...variantCosts) : costMin;
  product.costCentsMax = variantCosts.length ? Math.max(...variantCosts) : costMax ?? costMin;

  // ── ficha técnica
  // "props" a secas es un nombre demasiado común (lo usa hasta __NEXT_DATA__ en su raíz),
  // así que primero se busca el módulo y solo después se rasca en profundidad.
  const specsModule = deepFindRecord(data, ["specsModule"]);
  const specs = (() => {
    const direct = asArray(pick(specsModule, "props"));
    return direct.length ? direct : deepFindArray(data, ["productProperty", "productPropList"], 7);
  })();
  for (const rawSpec of specs) {
    const spec = asRecord(rawSpec);
    if (!spec) continue;
    const name = str(spec.attrName) ?? str(spec.name) ?? str(spec.propertyName);
    const value = str(spec.attrValue) ?? str(spec.value) ?? str(spec.propertyValue);
    if (name && value) product.attributes[name] = value;
  }
  if (!Object.keys(product.attributes).length) warn("La ficha técnica (specsModule) no venía en el HTML.");

  // ── descripción
  const descriptionModule = deepFindRecord(data, ["descriptionModule"]);
  const inlineDescription = stripHtml(pick(descriptionModule, "description") ?? pick(descriptionModule, "detail"));
  if (inlineDescription) product.description = inlineDescription;

  const descriptionUrl = str(pick(descriptionModule, "descriptionUrl")) ?? str(deepFind(data, ["descriptionUrl"], 7));
  if (descriptionUrl) {
    // Vive en otro dominio (aeproductsourcesite.alicdn.com) y pedirla desde el servidor
    // es justo lo que dispara el anti-bot: se guarda la URL y decide la usuaria.
    product.attributes["Descripción larga (URL del proveedor)"] = descriptionUrl;
    if (!product.description) {
      warn(
        "La descripción larga está en otra URL del proveedor y no se descarga automáticamente. " +
          "La tienes en los atributos; ábrela en tu navegador y copia lo que quieras usar.",
      );
    }
  } else if (!product.description) {
    warn("No venía descripción en el estado de la ficha.");
  }

  return product;
}

/** Rellena huecos con ld+json y og: — sirve tanto de fallback como de parche del estado. */
function fillGapsFromHtml(product: NormalizedProduct, html: string): void {
  const warn = makeWarner(product.warnings);
  const ld = ldJsonProduct(html);
  const meta = metaTags(html);
  const seenImages = new Set(product.images.map((image) => image.url));

  if (!product.title) {
    product.title = str(pick(ld, "name")) ?? str(meta["og:title"]) ?? str(meta["twitter:title"]) ?? "";
  }
  if (!product.description) {
    product.description =
      stripHtml(pick(ld, "description")) ||
      stripHtml(meta["og:description"]) ||
      stripHtml(meta["description"]) ||
      "";
  }
  if (!product.images.length) {
    const ldImages = ld ? (Array.isArray(ld.image) ? ld.image : [ld.image]) : [];
    for (const image of ldImages) pushImage(product.images, seenImages, image, product.title || undefined);
    pushImage(product.images, seenImages, meta["og:image"], product.title || undefined);
    pushImage(product.images, seenImages, meta["twitter:image"], product.title || undefined);
  }
  if (!product.sourceProductId) {
    product.sourceProductId = str(pick(ld, "sku")) ?? str(pick(ld, "productID")) ?? str(meta["product:retailer_item_id"]);
  }
  if (!product.vendor) {
    const brand = str(pick(ld, "brand.name")) ?? str(pick(ld, "brand"));
    if (brand) product.vendor = brand;
  }

  // Precio: solo si no lo teníamos ya.
  if (product.costCentsMin === null) {
    const offers = asRecord(ld?.offers) ?? asRecord(asArray(ld?.offers)[0]);
    const currency = str(pick(offers, "priceCurrency")) ?? str(meta["og:price:currency"]) ?? str(meta["product:price:currency"]);
    const low = parseToCents(str(pick(offers, "lowPrice")) ?? str(pick(offers, "price")));
    const high = parseToCents(str(pick(offers, "highPrice"))) ?? low;
    const metaPrice = parseToCents(str(meta["og:price:amount"]) ?? str(meta["product:price:amount"]));
    product.costCentsMin = low ?? metaPrice;
    product.costCentsMax = high ?? metaPrice;
    if (currency) product.currency = currency.toUpperCase();

    const cost = product.costCentsMin;
    if (cost !== null) {
      for (const variant of product.variants) {
        if (variant.costCents === null) variant.costCents = cost;
      }
    }
  }

  if (!product.variants.length) {
    product.variants.push({
      title: "Único",
      optionValues: [],
      costCents: product.costCentsMin,
      priceCents: null,
      compareAtCents: null,
      stock: null,
      imageUrl: null,
    });
    warn(
      "Solo pude leer los datos básicos de la página (título, foto y precio): no hay tallas ni colores. " +
        "Usa el bookmarklet en la ficha del proveedor para traer las variantes completas.",
    );
  }
}

/** Producto mínimo cuando no hay estado JSON: ld+json o meta tags. */
function buildFromPoorHtml(html: string, method: ImportMethod, sourceUrl: string | null): NormalizedProduct {
  const product = emptyProduct("aliexpress", method);
  product.sourceUrl = sourceUrl;
  product.sourceProductId = sourceUrl ? extractIdFrom(sourceUrl) : null;
  product.raw = { source: "ld+json/meta" };
  fillGapsFromHtml(product, html);
  return product;
}

function hasUsefulData(product: NormalizedProduct): boolean {
  return Boolean(product.title) || product.images.length > 0 || product.costCentsMin !== null;
}

// ─────────────────────────────── vías de entrada ───────────────────────────────

const PASTE_HINT =
  "Abre el producto en tu navegador, pulsa Ctrl+U (o clic derecho → Ver código fuente), " +
  "copia todo y pégalo en la pestaña «Pegar HTML». Si te resulta más cómodo, usa el bookmarklet: " +
  "con un clic manda la ficha desde tu propia sesión y nunca lo bloquean.";

function parseHtml(html: string, sourceUrl: string | undefined, method: ImportMethod): ImportResult {
  try {
    const source = typeof html === "string" ? html : "";
    if (source.trim().length < 200) {
      return {
        ok: false,
        error: "El HTML recibido está vacío o es demasiado corto para ser una ficha de AliExpress.",
        hint: PASTE_HINT,
      };
    }

    const url = sourceUrl ? (toUrl(sourceUrl)?.toString() ?? sourceUrl) : null;
    const candidates = collectStateCandidates(source);
    const best = candidates[0];

    let product: NormalizedProduct;
    if (best) {
      product = buildFromState(best, method, url);
      fillGapsFromHtml(product, source);
    } else {
      product = buildFromPoorHtml(source, method, url);
      product.warnings.unshift(
        "No encontré el estado JSON de la ficha (runParams / DCData): tiré de los datos sueltos de la página, " +
          "que traen mucho menos. Si faltan variantes, prueba con el bookmarklet.",
      );
    }

    if (!hasUsefulData(product)) {
      return {
        ok: false,
        error: blockReason(source) ?? "No reconocí ninguna ficha de producto dentro de ese HTML.",
        hint: PASTE_HINT,
        raw: { length: source.length },
      };
    }

    if (!product.title) product.title = `Producto de AliExpress ${product.sourceProductId ?? ""}`.trim();

    return { ok: true, product };
  } catch (error) {
    // Nunca dejamos salir una excepción: el importador tiene que poder decir qué pasó.
    return {
      ok: false,
      error: `Fallo inesperado leyendo el HTML: ${errorMessage(error)}`,
      hint: PASTE_HINT,
    };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// Huellas de las páginas que AliExpress devuelve en vez de la ficha cuando huele a bot.
const BLOCK_MARKERS: Array<[RegExp, string]> = [
  [/_____tmd_____|x5secdata|punish\?|nocaptcha|baxia/i, "AliExpress devolvió su página de verificación anti-bot (captcha)."],
  [/login\.aliexpress\.com|passport\.aliexpress/i, "AliExpress redirigió al inicio de sesión en vez de mostrar la ficha."],
  [/unusual traffic|access denied|forbidden/i, "AliExpress bloqueó la petición por tráfico sospechoso."],
];

function blockReason(html: string): string | null {
  // Solo se mira en la cabecera del documento: la palabra "captcha" puede aparecer
  // suelta en cualquier ficha larga y no queremos falsos positivos.
  const head = html.slice(0, 20000);
  for (const [pattern, message] of BLOCK_MARKERS) {
    if (pattern.test(head)) return message;
  }
  return null;
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  // Cookie de preferencias de AliExpress: fuerza dólares y región US, así los costes
  // llegan ya en USD y no hay que convertir nada.
  Cookie: "aep_usuc_f=site=glo&c_tp=USD&region=US&b_locale=es_ES",
};

const FETCH_TIMEOUT_MS = 15_000;

async function fetchHtml(url: string): Promise<ImportResult | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      const byStatus: Record<number, string> = {
        403: "AliExpress rechazó la petición (403): reconoce que no viene de un navegador.",
        429: "AliExpress cortó por exceso de peticiones (429).",
        503: "AliExpress respondió 503 (protección anti-bot).",
        404: "Ese producto ya no existe en AliExpress (404).",
      };
      return {
        ok: false,
        error: byStatus[response.status] ?? `AliExpress respondió ${response.status}.`,
        hint: response.status === 404 ? "Comprueba el enlace: puede que la tienda lo haya retirado." : PASTE_HINT,
      };
    }

    const html = await response.text();
    if (html.trim().length < 1500) {
      return {
        ok: false,
        error: "AliExpress devolvió una página casi vacía: es su respuesta típica a un servidor, no a un navegador.",
        hint: PASTE_HINT,
        raw: { length: html.length },
      };
    }
    return html;
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? "AliExpress tardó más de 15 segundos en responder."
        : `No pude conectar con AliExpress: ${errorMessage(error)}`,
      hint: PASTE_HINT,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fromUrl(rawUrl: string): Promise<ImportResult> {
  const url = toUrl(rawUrl);
  if (!url) {
    return { ok: false, error: "Eso no parece una dirección web.", hint: "Pega el enlace completo de la ficha del producto." };
  }
  if (!matchesUrl(url.toString())) {
    return {
      ok: false,
      error: "Ese enlace no es de AliExpress.",
      hint: "Copia el enlace desde la página del producto en aliexpress.com.",
    };
  }

  const fetched = await fetchHtml(url.toString());
  if (typeof fetched !== "string") return fetched;

  const blocked = blockReason(fetched);
  if (blocked) return { ok: false, error: blocked, hint: PASTE_HINT };

  const result = parseHtml(fetched, url.toString(), "url");
  if (!result.ok) {
    // El fallo casi siempre es anti-bot disfrazado de HTML válido: se dice claro.
    return {
      ok: false,
      error: `${result.error} Es lo que suele pasar cuando AliExpress detecta que la petición sale de un servidor.`,
      hint: PASTE_HINT,
      raw: result.raw,
    };
  }
  return result;
}

/**
 * Payload del bookmarklet: { runParams?, dcData?, html?, url }.
 * Se acepta también el objeto de estado pelado o un string JSON, porque el
 * bookmarklet vive en el navegador de la usuaria y no siempre manda lo mismo.
 */
function fromPayload(payload: unknown, sourceUrl?: string): ImportResult {
  try {
    let data: unknown = payload;
    if (typeof payload === "string") {
      data = parseLoose(payload) ?? payload;
    }

    const record = asRecord(data);
    if (!record) {
      return { ok: false, error: "El bookmarklet no mandó nada legible.", hint: PASTE_HINT };
    }

    const url = str(record.url) ?? sourceUrl ?? null;

    const html = str(record.html);
    if (html && html.length > 200) {
      const result = parseHtml(html, url ?? undefined, "bookmarklet");
      if (result.ok) return result;
      // Si el HTML no dio nada, todavía queda el estado JSON de abajo.
    }

    const raw = record.runParams ?? record.dcData ?? record.DCData ?? record.state ?? record.data;
    const state = raw ?? record;
    // `window.runParams` tal cual trae los módulos dentro de `.data`.
    const inner = asRecord(pick(state, "data"));
    const chosen = inner ?? state;
    const score = scoreState(chosen);
    if (score <= 0) {
      return {
        ok: false,
        error: "El bookmarklet mandó datos, pero no reconocí ningún módulo de ficha de AliExpress dentro.",
        hint: "Asegúrate de pulsarlo estando en la página del producto (no en la búsqueda ni en el carrito). " + PASTE_HINT,
        raw: { keys: Object.keys(record).slice(0, 20) },
      };
    }

    const source = record.dcData || record.DCData ? "DCData" : "runParams";
    const product = buildFromState({ source, data: chosen }, "bookmarklet", url);
    if (!hasUsefulData(product)) {
      return {
        ok: false,
        error: "Los datos del bookmarklet no traían ni título ni precio.",
        hint: PASTE_HINT,
      };
    }
    if (!product.title) product.title = `Producto de AliExpress ${product.sourceProductId ?? ""}`.trim();
    return { ok: true, product };
  } catch (error) {
    return { ok: false, error: `Fallo leyendo el envío del bookmarklet: ${errorMessage(error)}`, hint: PASTE_HINT };
  }
}

// ─────────────────────────────── API oficial ───────────────────────────────

const API_ENDPOINT = "https://api-sg.aliexpress.com/sync";
const API_METHOD = "aliexpress.ds.product.get";

export type AliexpressApiOptions = {
  appKey?: string;
  appSecret?: string;
  /** Moneda en la que queremos los precios. USD para no tener que convertir. */
  targetCurrency?: string;
  targetLanguage?: string;
  shipToCountry?: string;
  timeoutMs?: number;
};

/**
 * Firma estilo TOP: se ordenan los parámetros por clave, se concatena clave+valor
 * sin separadores y se hace HMAC-SHA256 con el secreto. El resultado va en hex
 * MAYÚSCULAS en el parámetro `sign`. Exportada porque es la parte que más se rompe
 * y conviene poder probarla suelta.
 */
export function signTopParams(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== undefined)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  return createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
}

const API_CREDENTIALS_HINT =
  "Pon ALIEXPRESS_APP_KEY y ALIEXPRESS_APP_SECRET en el entorno (se piden en portals.aliexpress.com, " +
  "programa Dropshipper/Affiliate). Mientras tanto, importa pegando el HTML o con el bookmarklet: dan los mismos datos.";

/** Vía 1 del contrato: API oficial. Solo funciona si hay credenciales aprobadas. */
export async function fromApi(productId: string, options: AliexpressApiOptions = {}): Promise<ImportResult> {
  const appKey = options.appKey ?? process.env.ALIEXPRESS_APP_KEY ?? "";
  const appSecret = options.appSecret ?? process.env.ALIEXPRESS_APP_SECRET ?? "";

  if (!appKey || !appSecret) {
    return {
      ok: false,
      error: "No hay credenciales de la API de AliExpress configuradas.",
      hint: API_CREDENTIALS_HINT,
    };
  }
  const id = str(productId) ? extractIdFrom(String(productId)) ?? String(productId).replace(/\D/g, "") : "";
  if (!id) {
    return { ok: false, error: "Falta el id del producto de AliExpress.", hint: "Pega el enlace de la ficha y lo saco de ahí." };
  }

  const params: Record<string, string> = {
    app_key: appKey,
    method: API_METHOD,
    format: "json",
    v: "2.0",
    sign_method: "hmac-sha256",
    // La pasarela nueva (api-sg) espera milisegundos desde epoch, no fecha formateada.
    timestamp: String(Date.now()),
    product_id: id,
    target_currency: (options.targetCurrency ?? "USD").toUpperCase(),
    target_language: (options.targetLanguage ?? "ES").toUpperCase(),
    ship_to_country: (options.shipToCountry ?? "US").toUpperCase(),
  };
  params.sign = signTopParams(params, appSecret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });

    const text = await response.text();
    const parsed = parseLoose(text);
    if (parsed === undefined) {
      return {
        ok: false,
        error: `La API de AliExpress respondió algo que no es JSON (HTTP ${response.status}).`,
        hint: API_CREDENTIALS_HINT,
        raw: text.slice(0, 500),
      };
    }

    // Error de la pasarela: viene en error_response, no en el status HTTP.
    const apiError = asRecord(pick(parsed, "error_response"));
    if (apiError) {
      const message = str(apiError.sub_msg) ?? str(apiError.msg) ?? "error desconocido";
      const code = str(apiError.sub_code) ?? str(apiError.code) ?? "";
      return {
        ok: false,
        error: `La API de AliExpress devolvió un error${code ? ` (${code})` : ""}: ${message}`,
        hint:
          /sign|signature/i.test(`${code} ${message}`)
            ? "La firma no cuadra: comprueba que ALIEXPRESS_APP_SECRET es el bueno y que la hora del servidor está sincronizada."
            : API_CREDENTIALS_HINT,
        raw: apiError,
      };
    }

    const result =
      deepFindRecord(parsed, ["result"], 6) ?? asRecord(pick(parsed, `${API_METHOD.replace(/\./g, "_")}_response`));
    if (!result) {
      return {
        ok: false,
        error: "La API respondió, pero sin datos de producto dentro.",
        hint: API_CREDENTIALS_HINT,
        raw: parsed,
      };
    }

    const product = buildFromApiResult(result, id);
    if (!hasUsefulData(product)) {
      return { ok: false, error: "La API devolvió un producto vacío.", hint: API_CREDENTIALS_HINT, raw: parsed };
    }
    return { ok: true, product };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "La API de AliExpress tardó demasiado en responder." : `No pude llamar a la API: ${errorMessage(error)}`,
      hint: API_CREDENTIALS_HINT,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** La API usa nombres snake_case propios; el mapeo va por deepFind para aguantar cambios de versión. */
function buildFromApiResult(result: unknown, productId: string): NormalizedProduct {
  const product = emptyProduct("aliexpress", "api");
  const warn = makeWarner(product.warnings);
  product.raw = result;
  product.sourceProductId = productId;
  product.sourceUrl = `https://www.aliexpress.com/item/${productId}.html`;

  const base = deepFindRecord(result, ["ae_item_base_info_dto"], 6);
  product.title = str(pick(base, "subject")) ?? str(deepFind(result, ["subject", "product_title"], 6)) ?? "";
  product.description = stripHtml(pick(base, "detail") ?? pick(base, "mobile_detail"));
  product.currency = (str(deepFind(result, ["currency_code", "target_currency"], 6)) ?? "USD").toUpperCase();
  if (product.currency !== "USD") {
    warn(`La API devolvió los precios en ${product.currency}: los costes están sin convertir a dólares.`);
  }

  const storeName = str(deepFind(result, ["store_name"], 6));
  if (storeName) product.vendor = storeName;

  const seenImages = new Set<string>();
  const imageUrls = str(deepFind(result, ["image_urls"], 6));
  if (imageUrls) {
    for (const url of imageUrls.split(/[;,]/)) pushImage(product.images, seenImages, url, product.title || undefined);
  }
  if (!product.images.length) warn("La API no devolvió imágenes de galería.");

  for (const rawProperty of deepFindArray(result, ["ae_item_property"], 7)) {
    const property = asRecord(rawProperty);
    const name = str(property?.attr_name);
    const value = str(property?.attr_value);
    if (name && value) product.attributes[name] = value;
  }

  const skus = deepFindArray(result, ["ae_item_sku_info_d_t_o"], 7);
  for (const rawSku of skus) {
    const sku = asRecord(rawSku);
    if (!sku) continue;

    const optionValues: string[] = [];
    let variantImage: string | null = null;
    for (const rawProperty of deepFindArray(sku, ["ae_sku_property_d_t_o"], 4)) {
      const property = asRecord(rawProperty);
      if (!property) continue;
      const name = localizeOptionName(str(property.sku_property_name) ?? "Opción");
      const value = str(property.sku_property_value) ?? str(property.property_value_definition_name) ?? "";
      let index = product.optionNames.indexOf(name);
      if (index === -1) {
        product.optionNames.push(name);
        index = product.optionNames.length - 1;
      }
      optionValues[index] = value;
      if (!variantImage) variantImage = normalizeImageUrl(property.sku_image);
    }
    for (let i = 0; i < product.optionNames.length; i++) {
      if (optionValues[i] === undefined) optionValues[i] = "";
    }

    const cost = parseToCents(str(sku.offer_sale_price) ?? str(sku.sku_price));
    const stock = num(sku.sku_available_stock) ?? num(sku.ipm_sku_stock);
    const variant: NormalizedVariant = {
      title: optionValues.filter(Boolean).join(" / ") || "Único",
      optionValues,
      costCents: cost,
      priceCents: null,
      compareAtCents: null,
      stock: stock === null ? null : Math.max(0, Math.round(stock)),
      imageUrl: variantImage,
    };
    const skuId = str(sku.sku_id) ?? str(sku.id);
    if (skuId) variant.sku = skuId;
    product.variants.push(variant);
  }

  if (!product.variants.length) {
    const cost = parseToCents(str(deepFind(result, ["target_sale_price", "sale_price"], 6)));
    product.variants.push({
      title: "Único",
      optionValues: [],
      costCents: cost,
      priceCents: null,
      compareAtCents: null,
      stock: null,
      imageUrl: null,
    });
    warn("La API no devolvió variantes: se creó una sola.");
  }

  for (const variant of product.variants) {
    if (variant.imageUrl) pushImage(product.images, seenImages, variant.imageUrl, variant.title);
  }

  const costs = product.variants
    .map((variant) => variant.costCents)
    .filter((value): value is number => typeof value === "number");
  product.costCentsMin = costs.length ? Math.min(...costs) : null;
  product.costCentsMax = costs.length ? Math.max(...costs) : null;

  return product;
}

// ─────────────────────────────── el adaptador ───────────────────────────────

export const aliexpressAdapter: ProviderAdapter = {
  id: "aliexpress",
  label: "AliExpress",
  hostPatterns: HOST_PATTERNS,
  matches: matchesUrl,
  extractId: extractIdFrom,
  fromUrl,
  fromHtml: (html: string, sourceUrl?: string) => parseHtml(html, sourceUrl, "html"),
  fromPayload,
};

export default aliexpressAdapter;
