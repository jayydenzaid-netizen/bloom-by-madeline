// Adaptador de Alibaba.com para el importador.
//
// Alibaba NO es AliExpress. Es un mercado B2B y su modelo de datos lo refleja:
// un producto no tiene "un precio", tiene una ESCALERA por cantidad (1-49 a $X,
// 50-99 a $Y, 100+ a $Z) y un pedido mínimo (MOQ). Forzar ese modelo dentro del
// de AliExpress daría números bonitos pero falsos, así que aquí se respeta:
//
//  - el coste que se usa es el del PRIMER tramo, porque es el único que una
//    boutique pequeña puede comprar de verdad;
//  - la escalera entera se guarda en `attributes["Precio por cantidad"]` y en
//    `raw`, para que Madeline vea el cuadro completo antes de decidir;
//  - un MOQ alto es un motivo real para NO importar el producto, así que sube
//    a `warnings` en vez de quedarse escondido en la ficha técnica.
//
// Igual que el resto de adaptadores: el parseo nunca lanza. Lo que no se entiende
// se acumula en `warnings` y, si no se reconoce nada, se devuelve un error con una
// pista accionable en vez de un stack trace.

import { applyPricing, DEFAULT_PRICING, formatCents, parseToCents } from "@/lib/money";
import {
  emptyProduct,
  type ImportMethod,
  type ImportResult,
  type NormalizedImage,
  type NormalizedProduct,
  type NormalizedVariant,
  type ProviderAdapter,
} from "@/lib/importers/types";

// ──────────────────────────────── límites ────────────────────────────────
// El HTML de Alibaba trae megas de JSON. Sin topes, un producto con 8 colores x
// 6 tallas x 5 largos genera cientos de variantes que nadie va a revisar.
const MAX_IMAGES = 12;
const MAX_VARIANTS = 100;
const MAX_ATTRIBUTES = 40;
const MAX_DESCRIPTION = 3000;
const WALK_MAX_NODES = 40_000;
// 20 niveles: el estado de Alibaba anida el SKU unas 12 capas dentro de globalData,
// y cada array cuenta como una. El tope real de coste lo pone WALK_MAX_NODES.
const WALK_MAX_DEPTH = 20;

/** Un tramo de la escalera de precios B2B. */
export type PriceTier = {
  minQuantity: number;
  /** null = "de esta cantidad en adelante". */
  maxQuantity: number | null;
  priceCents: number;
};

// ───────────────────────────── utilidades base ─────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRe(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Entidades HTML mínimas: las que aparecen en títulos y meta tags de Alibaba. */
function decodeEntities(input: string): string {
  return input
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** Quita marcas y colapsa espacios: las descripciones vienen como HTML entero. */
function stripHtml(input: string): string {
  return decodeEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const digits = value.replace(/[^\d.-]/g, "");
    if (!digits) return null;
    const parsed = Number.parseFloat(digits);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Recorre cualquier estructura JSON llamando a `visit` en cada objeto.
 * Con tope de nodos y profundidad, y con marca de visitados: el estado de una
 * ficha de Alibaba tiene referencias circulares y sin esto se cuelga el server.
 */
function walkObjects(root: unknown, visit: (node: Record<string, unknown>, depth: number) => void): void {
  const seen = new Set<unknown>();
  let budget = WALK_MAX_NODES;
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];

  while (stack.length > 0 && budget > 0) {
    const current = stack.pop();
    if (!current) break;
    const { node, depth } = current;
    if (depth > WALK_MAX_DEPTH) continue;
    if (typeof node !== "object" || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    budget--;

    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    const record = node as Record<string, unknown>;
    visit(record, depth);
    for (const value of Object.values(record)) stack.push({ node: value, depth: depth + 1 });
  }
}

/**
 * Busca por anchura el primer valor de alguna de estas claves. Anchura y no
 * profundidad porque el dato bueno (el título del producto) está arriba y el
 * ruido (títulos de "productos relacionados") está enterrado.
 */
function findByKeys(root: unknown, keys: string[], accept: (value: unknown) => boolean): unknown {
  const wanted = keys.map((key) => key.toLowerCase());
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  let budget = WALK_MAX_NODES;

  while (queue.length > 0 && budget > 0) {
    const node = queue.shift();
    if (typeof node !== "object" || node === null) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    budget--;

    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (wanted.includes(key.toLowerCase()) && accept(record[key])) return record[key];
    }
    for (const value of Object.values(record)) queue.push(value);
  }
  return undefined;
}

function findString(root: unknown, keys: string[], minLength = 2): string | null {
  const value = findByKeys(root, keys, (candidate) => typeof candidate === "string" && candidate.trim().length >= minLength);
  return typeof value === "string" ? decodeEntities(value.trim()) : null;
}

function findNumber(root: unknown, keys: string[]): number | null {
  const value = findByKeys(root, keys, (candidate) => {
    const parsed = toFiniteNumber(candidate);
    return parsed !== null && parsed > 0;
  });
  return toFiniteNumber(value);
}

// ───────────────────────────── imágenes ─────────────────────────────

const ALICDN_HOST = /(^|\.)alicdn\.com$/i;

/**
 * Alibaba sirve miniaturas mediante sufijos en el propio nombre del fichero
 * (`.jpg_720x720q50.jpg`, `_640x640.jpg`, `.jpg_.webp`). Importar la miniatura
 * significa publicar una foto borrosa en la tienda, así que se quitan.
 * El recorte solo se aplica a alicdn: en otro CDN ese sufijo puede ser el nombre real.
 */
export function normalizeAlibabaImageUrl(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let url = decodeEntities(input.trim());
  if (!url) return null;
  if (url.startsWith("//")) url = `https:${url}`;
  else if (url.startsWith("http://")) url = `https://${url.slice(7)}`;
  if (!/^https:\/\//i.test(url)) return null;

  url = url.split("?")[0].split("#")[0];
  if (!/\.(jpe?g|png|webp|gif)/i.test(url)) return null;

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  if (ALICDN_HOST.test(host)) {
    url = url.replace(/\.(jpe?g|png|webp|gif)_[^/]*$/i, ".$1");
    url = url.replace(/_\d+x\d+(q\d+)?\.(jpe?g|png|webp|gif)$/i, ".$2");
  }
  return url;
}

const IMAGE_CONTAINER_KEY = /(image|gallery|photo|pic|media)/i;
const IMAGE_VALUE_KEY = /(imageurl|fullpathimageuri|imageuri|originalimageurl|bigimage|mainimage|url|src|big|origin|full)/i;

function collectImages(root: unknown): string[] {
  const found: string[] = [];
  const push = (candidate: unknown) => {
    const url = normalizeAlibabaImageUrl(candidate);
    if (url && !found.includes(url)) found.push(url);
  };

  walkObjects(root, (node) => {
    for (const [key, value] of Object.entries(node)) {
      if (!IMAGE_CONTAINER_KEY.test(key) && !IMAGE_VALUE_KEY.test(key)) continue;
      if (typeof value === "string") {
        push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") push(item);
          else if (isRecord(item)) {
            for (const [innerKey, innerValue] of Object.entries(item)) {
              if (IMAGE_VALUE_KEY.test(innerKey)) push(innerValue);
            }
          }
        }
      } else if (isRecord(value)) {
        for (const [innerKey, innerValue] of Object.entries(value)) {
          if (IMAGE_VALUE_KEY.test(innerKey)) push(innerValue);
        }
      }
    }
  });

  return found.slice(0, MAX_IMAGES);
}

// ───────────────────────────── escalera de precios ─────────────────────────────

const PRICE_KEYS = [
  "price",
  "pricevalue",
  "unitprice",
  "promotionprice",
  "dollarprice",
  "saleprice",
  "amount",
  "value",
  "formatprice",
];
const MIN_KEYS = [
  "min",
  "minquantity",
  "minorderquantity",
  "startquantity",
  "beginamount",
  "from",
  "minqty",
  "quantityfrom",
  "start",
];
const MAX_KEYS = ["max", "maxquantity", "endquantity", "endamount", "to", "maxqty", "quantityto", "end"];
const QTY_TEXT_KEYS = ["quantity", "quantityrange", "range", "qty", "ladder", "amountrange", "quantityscale"];

function pick(node: Record<string, unknown>, keys: string[]): unknown {
  for (const key of Object.keys(node)) {
    if (keys.includes(key.toLowerCase())) {
      const value = node[key];
      if (value !== null && value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

/** Precio que a veces viene anidado: `{ price: { value: "12.50", currency: "USD" } }`. */
function priceToCents(value: unknown): number | null {
  if (isRecord(value)) {
    const inner = pick(value, ["value", "amount", "formatedamount", "price", "text"]);
    return inner === undefined ? null : parseToCents(String(inner));
  }
  if (typeof value === "number" || typeof value === "string") return parseToCents(value);
  return null;
}

/** "1 - 49", "50-99 pieces", "100+", ">=200" -> {min, max}. */
function parseQuantityRange(text: string): { min: number | null; max: number | null } {
  const cleaned = text.replace(/[–—]/g, "-");
  const both = cleaned.match(/(\d[\d.,]*)\s*-\s*(\d[\d.,]*)/);
  if (both) return { min: toFiniteNumber(both[1]), max: toFiniteNumber(both[2]) };
  const open = cleaned.match(/(\d[\d.,]*)/);
  if (open) return { min: toFiniteNumber(open[1]), max: null };
  return { min: null, max: null };
}

function tierFromNode(node: Record<string, unknown>): PriceTier | null {
  const priceCents = priceToCents(pick(node, PRICE_KEYS));
  if (priceCents === null || priceCents < 0) return null;

  let min = toFiniteNumber(pick(node, MIN_KEYS));
  let max = toFiniteNumber(pick(node, MAX_KEYS));

  if (min === null) {
    const text = pick(node, QTY_TEXT_KEYS);
    if (typeof text === "string" || typeof text === "number") {
      const parsed = parseQuantityRange(String(text));
      min = parsed.min;
      if (max === null) max = parsed.max;
    }
  }
  // Sin señal de cantidad no es un tramo, es cualquier objeto con un número dentro.
  if (min === null || min < 1) return null;

  return {
    minQuantity: Math.round(min),
    maxQuantity: max !== null && max > 0 && max < 1_000_000 ? Math.round(max) : null,
    priceCents,
  };
}

function sortAndDedupeTiers(tiers: PriceTier[]): PriceTier[] {
  const byMin = new Map<number, PriceTier>();
  for (const tier of tiers) {
    if (!byMin.has(tier.minQuantity)) byMin.set(tier.minQuantity, tier);
  }
  return [...byMin.values()].sort((a, b) => a.minQuantity - b.minQuantity);
}

const LADDER_KEY_HINT = /(ladder|tier|quantit|range|price|scale)/i;

/**
 * Encuentra la escalera dentro de cualquier forma del JSON de Alibaba
 * (`productLadderPrices`, `ladderPrices`, `priceRanges`, `quantityPrices`...).
 * Se exige que TODOS los elementos del array sean tramos válidos: pedirlo entero
 * evita confundir la escalera con la lista de productos relacionados.
 */
export function extractPriceLadder(root: unknown): PriceTier[] {
  const candidates: { score: number; tiers: PriceTier[] }[] = [];

  walkObjects(root, (node) => {
    for (const [key, value] of Object.entries(node)) {
      // Forma A: array de tramos.
      if (Array.isArray(value) && value.length > 0) {
        const parsed: PriceTier[] = [];
        let allValid = true;
        for (const item of value) {
          if (!isRecord(item)) {
            allValid = false;
            break;
          }
          const tier = tierFromNode(item);
          if (!tier) {
            allValid = false;
            break;
          }
          parsed.push(tier);
        }
        if (allValid && parsed.length > 0) {
          candidates.push({ score: (LADDER_KEY_HINT.test(key) ? 100 : 0) + parsed.length, tiers: parsed });
        }
        continue;
      }
      // Forma B: mapa { "1-49": "12.50", "50-99": "11.20", "100+": "9.90" }.
      if (isRecord(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0 || entries.length > 20) continue;
        const parsed: PriceTier[] = [];
        let allValid = true;
        for (const [rangeKey, rangeValue] of entries) {
          if (!/^\s*\d[\d.,]*\s*(-\s*\d[\d.,]*|\+)?\s*$/.test(rangeKey)) {
            allValid = false;
            break;
          }
          const cents = priceToCents(rangeValue);
          const range = parseQuantityRange(rangeKey);
          if (cents === null || range.min === null) {
            allValid = false;
            break;
          }
          parsed.push({ minQuantity: Math.round(range.min), maxQuantity: range.max, priceCents: cents });
        }
        if (allValid && parsed.length > 0) {
          candidates.push({ score: (LADDER_KEY_HINT.test(key) ? 100 : 0) + parsed.length, tiers: parsed });
        }
      }
    }
  });

  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.score - a.score);
  return sortAndDedupeTiers(candidates[0].tiers);
}

/** "1–49 uds: $12.50 · 50–99 uds: $11.20 · 100+ uds: $9.90" */
export function formatLadder(tiers: PriceTier[], unit = "uds"): string {
  return tiers
    .map((tier) => {
      const range = tier.maxQuantity ? `${tier.minQuantity}–${tier.maxQuantity}` : `${tier.minQuantity}+`;
      return `${range} ${unit}: ${formatCents(tier.priceCents)}`;
    })
    .join(" · ");
}

// ───────────────────────────── MOQ y unidad ─────────────────────────────

const MOQ_KEYS = [
  "minorderquantity",
  "minimumorderquantity",
  "minorderquantitynum",
  "minordernum",
  "minimumorder",
  "minorder",
  "moq",
];

const MOQ_TEXT_PATTERNS = [
  /min(?:imum)?\.?\s*order(?:\s*quantity)?\s*[:：]?\s*([\d][\d.,]*)/i,
  /pedido\s+m[ií]nimo\s*[:：]?\s*([\d][\d.,]*)/i,
  /cantidad\s+m[ií]nima(?:\s+de\s+pedido)?\s*[:：]?\s*([\d][\d.,]*)/i,
];

/** El MOQ suele estar solo en el texto visible ("Min. Order: 100 pieces"). */
export function findMoqInText(text: string): number | null {
  for (const pattern of MOQ_TEXT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // "1,000" es mil, no uno: se quitan los separadores de millar antes de leerlo.
      const value = toFiniteNumber(match[1].replace(/[.,](?=\d{3}(\D|$))/g, ""));
      if (value !== null && value >= 1) return Math.round(value);
    }
  }
  return null;
}

const UNIT_KEYS = ["unit", "productunit", "saleunit", "unitname", "unittype", "minorderunit"];

function findUnit(root: unknown): string | null {
  const raw = findString(root, UNIT_KEYS, 1);
  if (!raw) return null;
  const cleaned = raw.replace(/[^\p{L}\s/]/gu, "").trim();
  if (!cleaned || cleaned.length > 24) return null;
  return cleaned;
}

// ───────────────────────────── ficha técnica ─────────────────────────────

const ATTR_CONTAINER_KEY = /(attribute|attrs?|props?|spec|parameter|feature|param)/i;
const ATTR_NAME_KEYS = ["attrname", "name", "key", "label", "attributename", "title", "propertyname"];
const ATTR_VALUE_KEYS = ["attrvalue", "value", "values", "attributevalue", "attrvalues", "propertyvalue", "text"];

function attrValueToString(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return decodeEntities(String(value)).trim() || null;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === "string" || typeof item === "number") return String(item);
        if (isRecord(item)) {
          const inner = pick(item, ["name", "value", "attrvalue", "text"]);
          return inner === undefined ? null : String(inner);
        }
        return null;
      })
      .filter((part): part is string => Boolean(part && part.trim()));
    return parts.length > 0 ? decodeEntities(parts.join(" / ")) : null;
  }
  return null;
}

function collectAttributes(root: unknown): Record<string, string> {
  const attributes: Record<string, string> = {};

  walkObjects(root, (node) => {
    for (const [key, value] of Object.entries(node)) {
      if (!ATTR_CONTAINER_KEY.test(key) || !Array.isArray(value)) continue;
      for (const item of value) {
        if (!isRecord(item)) continue;
        const name = pick(item, ATTR_NAME_KEYS);
        const rawValue = pick(item, ATTR_VALUE_KEYS);
        if (typeof name !== "string") continue;
        const label = decodeEntities(name).trim();
        const text = attrValueToString(rawValue);
        if (!label || !text || label.length > 60) continue;
        if (Object.keys(attributes).length >= MAX_ATTRIBUTES) return;
        if (!attributes[label]) attributes[label] = text.slice(0, 200);
      }
    }
  });

  return attributes;
}

// ───────────────────────────── opciones y variantes ─────────────────────────────

const OPTION_VALUES_KEYS = ["values", "attrvalues", "valuelist", "skuvalues", "options", "attributevalues", "propvalues"];

type OptionGroup = { name: string; values: string[] };

function collectOptionGroups(root: unknown): OptionGroup[] {
  const groups: OptionGroup[] = [];

  walkObjects(root, (node) => {
    if (groups.length > 0) return;
    for (const value of Object.values(node)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      const parsed: OptionGroup[] = [];
      let allValid = true;
      for (const item of value) {
        if (!isRecord(item)) {
          allValid = false;
          break;
        }
        const name = pick(item, ATTR_NAME_KEYS);
        const rawValues = pick(item, OPTION_VALUES_KEYS);
        if (typeof name !== "string" || !Array.isArray(rawValues) || rawValues.length === 0) {
          allValid = false;
          break;
        }
        const values = rawValues
          .map((entry) => {
            if (typeof entry === "string" || typeof entry === "number") return String(entry);
            if (isRecord(entry)) {
              const inner = pick(entry, ["name", "value", "attrvalue", "text", "label"]);
              return inner === undefined ? null : String(inner);
            }
            return null;
          })
          .filter((entry): entry is string => Boolean(entry && entry.trim()))
          .map((entry) => decodeEntities(entry.trim()));
        if (values.length === 0) {
          allValid = false;
          break;
        }
        parsed.push({ name: decodeEntities(name.trim()), values: [...new Set(values)] });
      }
      if (allValid && parsed.length > 0) {
        groups.push(...parsed.slice(0, 3));
        return;
      }
    }
  });

  return groups;
}

/**
 * Mapa de SKU al estilo `{"Color:Rojo;Talla:M": {price: "12.50", quantity: 30}}`.
 * Cuando existe es la mejor fuente: trae precio y stock por combinación real,
 * no el producto cartesiano teórico.
 */
function collectSkuMapVariants(root: unknown): { optionNames: string[]; variants: NormalizedVariant[] } | null {
  // Se acumulan candidatos y se elige al final: reasignar dentro del callback y
  // volver a leerlo ahí mismo confunde al análisis de flujo de TypeScript.
  const candidates: { optionNames: string[]; variants: NormalizedVariant[] }[] = [];

  walkObjects(root, (node) => {
    for (const value of Object.values(node)) {
      if (!isRecord(value)) continue;
      const entries = Object.entries(value);
      if (entries.length === 0 || entries.length > MAX_VARIANTS * 3) continue;
      // "Color:Rojo;Talla:M": pares cortos, sin barras. Sin este filtro cualquier
      // mapa con URLs por clave ("https://...") pasaría por catálogo de SKU.
      const looksLikeSkuMap = entries.every(
        ([key, entryValue]) => /^[^:;/]{1,40}:[^:;/]{1,40}(;[^:;/]{1,40}:[^:;/]{1,40})*$/.test(key) && isRecord(entryValue),
      );
      if (!looksLikeSkuMap) continue;

      const names: string[] = [];
      const variants: NormalizedVariant[] = [];
      for (const [key, entryValue] of entries) {
        const optionValues: string[] = [];
        for (const pair of key.split(";")) {
          const [name, rawValue] = pair.split(":");
          const label = decodeEntities((name ?? "").trim());
          if (label && !names.includes(label)) names.push(label);
          optionValues.push(decodeEntities((rawValue ?? "").trim()));
        }
        const record = entryValue as Record<string, unknown>;
        const costCents = priceToCents(pick(record, PRICE_KEYS));
        const stock = toFiniteNumber(pick(record, ["quantity", "stock", "canbooktotal", "availquantity", "inventory"]));
        const sku = pick(record, ["skuid", "sku", "skucode"]);
        variants.push({
          title: optionValues.join(" / "),
          optionValues,
          sku: sku === undefined ? undefined : String(sku),
          costCents,
          priceCents: costCents === null ? null : applyPricing(costCents, DEFAULT_PRICING),
          stock: stock === null ? null : Math.round(stock),
          imageUrl: normalizeAlibabaImageUrl(pick(record, ["imageurl", "image", "skuimage"])),
        });
      }
      if (variants.length > 0) {
        candidates.push({ optionNames: names, variants: variants.slice(0, MAX_VARIANTS) });
      }
    }
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.variants.length - a.variants.length);
  return candidates[0];
}

/** Producto cartesiano de las opciones, con tope duro. */
function cartesianVariants(groups: OptionGroup[], costCents: number | null): NormalizedVariant[] {
  let combos: string[][] = [[]];
  for (const group of groups) {
    const next: string[][] = [];
    for (const combo of combos) {
      for (const value of group.values) {
        if (next.length >= MAX_VARIANTS) break;
        next.push([...combo, value]);
      }
    }
    combos = next;
  }
  return combos.map((optionValues) => ({
    title: optionValues.join(" / "),
    optionValues,
    costCents,
    priceCents: costCents === null ? null : applyPricing(costCents, DEFAULT_PRICING),
    stock: null,
  }));
}

/** Variante suelta para productos sin opciones: la ficha necesita algo que vender. */
function singleVariant(costCents: number | null): NormalizedVariant {
  return {
    title: "Único",
    optionValues: [],
    costCents,
    priceCents: costCents === null ? null : applyPricing(costCents, DEFAULT_PRICING),
    stock: null,
  };
}

// ───────────────────────────── extracción del HTML ─────────────────────────────

/** Recorta el JSON balanceado que empieza en `start`, respetando comillas y escapes. */
function sliceBalancedJson(text: string, start: number): string | null {
  const opener = text[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : null;
  if (!closer) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Vía 1: `window.detailData = {...}` y compañía. */
function findAssignedJson(html: string, names: string[]): unknown | null {
  for (const name of names) {
    const pattern = new RegExp(`${escapeRe(name)}\\s*=\\s*`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const from = match.index + match[0].length;
      const char = html[from];
      if (char !== "{" && char !== "[") continue;
      const slice = sliceBalancedJson(html, from);
      if (!slice) continue;
      try {
        return JSON.parse(slice) as unknown;
      } catch {
        // JSON roto o literal JS con funciones dentro: se prueba la siguiente aparición.
      }
    }
  }
  return null;
}

/** Vía 2: `<script id="__NEXT_DATA__">` / `<script id="detailData">`. */
function findScriptJson(html: string, ids: string[]): unknown | null {
  for (const id of ids) {
    const pattern = new RegExp(`<script[^>]*id=["']${escapeRe(id)}["'][^>]*>([\\s\\S]*?)</script>`, "i");
    const match = html.match(pattern);
    if (!match) continue;
    const body = match[1]
      .trim()
      .replace(/^window\.[\w.$]+\s*=\s*/, "")
      .replace(/;$/, "");
    try {
      return JSON.parse(body) as unknown;
    } catch {
      // ignorado a propósito: quedan más vías detrás
    }
  }
  return null;
}

/** Vía 3: JSON-LD con @type Product (incluye @graph). */
function findJsonLdProduct(html: string): Record<string, unknown> | null {
  const pattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  const queue: unknown[] = [];

  while ((match = pattern.exec(html)) !== null) {
    try {
      queue.push(JSON.parse(match[1].trim()) as unknown);
    } catch {
      // un bloque de JSON-LD roto no invalida los demás
    }
  }

  while (queue.length > 0) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (!isRecord(node)) continue;
    const type = node["@type"];
    const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
    if (types.some((entry) => entry.toLowerCase() === "product")) return node;
    if (Array.isArray(node["@graph"])) queue.push(...(node["@graph"] as unknown[]));
  }
  return null;
}

/** Vía 4: meta tags. Lo mínimo para no volver con las manos vacías. */
function metaContent(html: string, property: string): string | null {
  const escaped = escapeRe(property);
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1].trim()) return decodeEntities(match[1].trim());
  }
  return null;
}

// ───────────────────────────── construcción del producto ─────────────────────────────

const TITLE_KEYS = ["subject", "producttitle", "productname", "displayname", "title", "name"];
const DESCRIPTION_KEYS = ["description", "productdescription", "detaildescription", "detail", "content"];
const VENDOR_KEYS = ["companyname", "suppliername", "vendor", "seller", "shopname", "brand"];
const CURRENCY_KEYS = ["currency", "currencycode", "pricecurrency"];

type BuildInput = {
  data: unknown;
  method: ImportMethod;
  sourceUrl?: string;
  /** HTML original, solo como pista de texto (MOQ) cuando el JSON no lo trae. */
  html?: string;
};

/**
 * Convierte cualquier volcado de datos de Alibaba en NormalizedProduct.
 * Devuelve null si ni siquiera hay título: eso significa que la vía no sirvió y
 * toca probar la siguiente, no publicar un producto vacío.
 */
function buildProduct(input: BuildInput): NormalizedProduct | null {
  const { data, method, sourceUrl, html } = input;
  const product = emptyProduct("alibaba", method);
  const warnings: string[] = [];

  const title = findString(data, TITLE_KEYS, 3);
  if (!title) return null;
  product.title = title.slice(0, 300);
  product.sourceUrl = sourceUrl ?? null;
  product.sourceProductId = sourceUrl ? adapter.extractId(sourceUrl) : null;
  if (!product.sourceProductId) {
    const found = findByKeys(data, ["productid", "product_id", "offerid", "id"], (value) => {
      const parsed = toFiniteNumber(value);
      return parsed !== null && parsed > 100_000;
    });
    const parsed = toFiniteNumber(found);
    product.sourceProductId = parsed === null ? null : String(Math.round(parsed));
  }

  const rawDescription = findString(data, DESCRIPTION_KEYS, 10);
  product.description = rawDescription ? stripHtml(rawDescription).slice(0, MAX_DESCRIPTION) : "";

  const vendor = findString(data, VENDOR_KEYS, 2);
  if (vendor) product.vendor = vendor.slice(0, 120);

  const currency = findString(data, CURRENCY_KEYS, 3);
  product.currency = currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "USD";
  if (product.currency !== "USD") {
    warnings.push(`El proveedor cotiza en ${product.currency}: los importes NO están convertidos a dólares.`);
  }

  product.images = collectImages(data).map((url): NormalizedImage => ({ url, alt: product.title }));
  if (product.images.length === 0) warnings.push("No se encontró ninguna foto; hay que subirlas a mano.");

  // ── escalera B2B ──
  const tiers = extractPriceLadder(data);
  const unit = findUnit(data) ?? "uds";
  const firstTier = tiers.length > 0 ? tiers[0] : null;
  const costCents = firstTier ? firstTier.priceCents : null;

  const attributes: Record<string, string> = {};
  if (tiers.length > 0) attributes["Precio por cantidad"] = formatLadder(tiers, unit);

  // ── pedido mínimo ──
  let moq = findNumber(data, MOQ_KEYS);
  if (moq === null && html) moq = findMoqInText(stripHtml(html.slice(0, 200_000)));
  if (moq === null && firstTier) moq = firstTier.minQuantity;

  if (moq !== null && moq >= 1) {
    const rounded = Math.round(moq);
    attributes["Pedido mínimo"] = `${rounded} ${unit}`;
    if (rounded > 10) {
      warnings.push(
        `Pedido mínimo alto: ${rounded} ${unit} del mismo modelo. Para la boutique eso es inmovilizar inventario; ` +
          "conviene preguntar al proveedor si acepta una cantidad menor o una muestra antes de importarlo.",
      );
    }
  } else {
    warnings.push("No se pudo leer el pedido mínimo (MOQ): confírmalo con el proveedor antes de comprar.");
  }

  Object.assign(attributes, collectAttributes(data));
  product.attributes = attributes;

  if (tiers.length > 1 && costCents !== null) {
    warnings.push(
      `Precio por tramos (B2B). Se usa el primero (${tiers[0].minQuantity}+ ${unit} a ${formatCents(costCents)}); ` +
        `comprando más baja hasta ${formatCents(tiers[tiers.length - 1].priceCents)}. Escalera completa en la ficha técnica.`,
    );
  }
  if (costCents === null) {
    warnings.push("No se pudo leer ningún precio: hay que ponerlo a mano antes de publicar.");
  }

  // ── variantes ──
  const skuMap = collectSkuMapVariants(data);
  if (skuMap && skuMap.variants.length > 0) {
    product.optionNames = skuMap.optionNames;
    // Un SKU sin precio propio hereda el del primer tramo: en Alibaba lo normal es
    // que el precio sea del producto y las variantes solo cambien el aspecto.
    product.variants = skuMap.variants.map((variant) =>
      variant.costCents !== null
        ? variant
        : { ...variant, costCents, priceCents: costCents === null ? null : applyPricing(costCents, DEFAULT_PRICING) },
    );
  } else {
    const groups = collectOptionGroups(data);
    if (groups.length > 0) {
      product.optionNames = groups.map((group) => group.name);
      product.variants = cartesianVariants(groups, costCents);
      const total = groups.reduce((acc, group) => acc * group.values.length, 1);
      if (total > MAX_VARIANTS) {
        warnings.push(`El producto declara ${total} combinaciones; se importaron las primeras ${MAX_VARIANTS}.`);
      }
    } else {
      product.optionNames = [];
      product.variants = [singleVariant(costCents)];
    }
  }

  // El rango de coste es el del PRIMER tramo, no el de toda la escalera: enseñar
  // "desde $9.90" cuando ese precio exige comprar 500 piezas sería mentirle a Madeline.
  product.costCentsMin = costCents;
  product.costCentsMax = costCents;

  product.raw = { data, tiers, moq, unit };
  product.warnings = warnings;
  return product;
}

/** Producto a partir de JSON-LD: pobre pero honesto, y casi siempre presente. */
function buildFromJsonLd(node: Record<string, unknown>, method: ImportMethod, sourceUrl?: string): NormalizedProduct | null {
  const name = typeof node.name === "string" ? decodeEntities(node.name.trim()) : "";
  if (!name) return null;

  const product = emptyProduct("alibaba", method);
  product.title = name.slice(0, 300);
  product.sourceUrl = sourceUrl ?? null;
  product.sourceProductId = sourceUrl ? adapter.extractId(sourceUrl) : null;
  product.description = typeof node.description === "string" ? stripHtml(node.description).slice(0, MAX_DESCRIPTION) : "";

  const rawImages = Array.isArray(node.image) ? node.image : [node.image];
  product.images = rawImages
    .map((image) => normalizeAlibabaImageUrl(isRecord(image) ? image.url : image))
    .filter((url): url is string => Boolean(url))
    .slice(0, MAX_IMAGES)
    .map((url): NormalizedImage => ({ url, alt: product.title }));

  const brand = node.brand;
  if (typeof brand === "string") product.vendor = brand;
  else if (isRecord(brand) && typeof brand.name === "string") product.vendor = brand.name;

  const offersRaw = node.offers;
  const offer = Array.isArray(offersRaw) ? offersRaw.find(isRecord) : offersRaw;
  let costCents: number | null = null;
  let costMax: number | null = null;
  if (isRecord(offer)) {
    const low = offer.lowPrice === undefined ? null : parseToCents(String(offer.lowPrice));
    const high = offer.highPrice === undefined ? null : parseToCents(String(offer.highPrice));
    const single = offer.price === undefined ? null : parseToCents(String(offer.price));
    costCents = low ?? single;
    costMax = high ?? single ?? low;
    const currency = offer.priceCurrency;
    if (typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)) product.currency = currency.toUpperCase();
  }

  const warnings = [
    "Datos leídos del JSON-LD de la página: no trae escalera de precios ni pedido mínimo. Confírmalos en Alibaba antes de comprar.",
  ];
  if (costCents === null) warnings.push("No se pudo leer ningún precio: hay que ponerlo a mano antes de publicar.");

  product.attributes = {};
  product.variants = [singleVariant(costCents)];
  product.costCentsMin = costCents;
  product.costCentsMax = costMax ?? costCents;
  product.raw = node;
  product.warnings = warnings;
  return product;
}

/** Último recurso: og: meta tags. Sirve para no perder el trabajo de la usuaria. */
function buildFromMeta(html: string, method: ImportMethod, sourceUrl?: string): NormalizedProduct | null {
  const title = metaContent(html, "og:title") ?? metaContent(html, "twitter:title");
  if (!title) return null;

  const product = emptyProduct("alibaba", method);
  product.title = title.slice(0, 300);
  product.sourceUrl = sourceUrl ?? null;
  product.sourceProductId = sourceUrl ? adapter.extractId(sourceUrl) : null;
  product.description = stripHtml(metaContent(html, "og:description") ?? "").slice(0, MAX_DESCRIPTION);

  const image = normalizeAlibabaImageUrl(metaContent(html, "og:image"));
  product.images = image ? [{ url: image, alt: product.title }] : [];

  const priceMeta = metaContent(html, "product:price:amount") ?? metaContent(html, "og:price:amount");
  const costCents = priceMeta ? parseToCents(priceMeta) : null;

  const moq = findMoqInText(stripHtml(html.slice(0, 200_000)));
  const attributes: Record<string, string> = {};
  if (moq !== null) attributes["Pedido mínimo"] = `${moq} uds`;
  product.attributes = attributes;

  product.variants = [singleVariant(costCents)];
  product.costCentsMin = costCents;
  product.costCentsMax = costCents;
  product.raw = { source: "meta-tags" };
  product.warnings = [
    "Solo se pudieron leer las meta etiquetas de la página: falta la escalera de precios y la ficha técnica.",
    "Para traer los datos completos usa el bookmarklet estando en la ficha del proveedor.",
  ];
  if (moq !== null && moq > 10) {
    product.warnings.push(`Pedido mínimo alto: ${moq} unidades del mismo modelo.`);
  }
  if (costCents === null) {
    product.warnings.push("No se pudo leer ningún precio: hay que ponerlo a mano antes de publicar.");
  }
  return product;
}

// ───────────────────────────── detección de bloqueo ─────────────────────────────

const BLOCK_MARKERS = [
  "_____tmd_____",
  "punish?",
  "captcha",
  "nocaptcha",
  "slide to verify",
  "unusual traffic",
  "x5secdata",
  "login.alibaba.com/newlogin",
  "verify your identity",
];

function looksBlocked(html: string): boolean {
  const head = html.slice(0, 60_000).toLowerCase();
  return BLOCK_MARKERS.some((marker) => head.includes(marker));
}

/** Cabeceras de navegador real: sin esto Alibaba devuelve la verificación casi siempre. */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-US,es;q=0.9,en;q=0.8",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

const HINT_PASTE =
  "Abre el producto en tu navegador, pulsa Ctrl+U, copia todo el HTML y pégalo en la pestaña «HTML pegado». Con el bookmarklet es un solo clic.";

// ───────────────────────────── API oficial ─────────────────────────────

/**
 * Firma estilo TOP (la pasarela que usan Alibaba y Taobao): se ordenan las claves,
 * se concatena clave+valor sin separadores y se firma con HMAC-SHA256 en mayúsculas.
 */
export async function signTop(params: Record<string, string>, secret: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const base = Object.keys(params)
    .sort()
    .map((key) => key + params[key])
    .join("");
  return createHmac("sha256", secret).update(base, "utf8").digest("hex").toUpperCase();
}

/** TOP exige la marca de tiempo en hora de Pekín (GMT+8), formato "yyyy-MM-dd HH:mm:ss". */
export function beijingTimestamp(now = new Date()): string {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ` +
    `${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`
  );
}

const API_GATEWAY = "https://gw.api.taobao.com/router/rest";

function hasApiCredentials(): boolean {
  return Boolean(process.env.ALIBABA_APP_KEY && process.env.ALIBABA_APP_SECRET);
}

/** Vía 1 del contrato: API oficial `alibaba.icbu.product.get`. */
async function fromApi(productId: string, sourceUrl?: string): Promise<ImportResult> {
  const appKey = process.env.ALIBABA_APP_KEY;
  const appSecret = process.env.ALIBABA_APP_SECRET;
  if (!appKey || !appSecret) {
    return {
      ok: false,
      error: "No hay credenciales de la API de Alibaba configuradas.",
      hint: "Define ALIBABA_APP_KEY y ALIBABA_APP_SECRET, o importa el producto pegando el HTML.",
    };
  }
  if (!/^\d+$/.test(productId)) {
    return {
      ok: false,
      error: `Id de producto no válido: «${productId}».`,
      hint: "Pega la URL completa de la ficha de Alibaba.",
    };
  }

  const params: Record<string, string> = {
    method: "alibaba.icbu.product.get",
    app_key: appKey,
    timestamp: beijingTimestamp(),
    format: "json",
    v: "2.0",
    sign_method: "hmac-sha256",
    product_id: productId,
  };

  try {
    params.sign = await signTop(params, appSecret);
    const response = await fetch(API_GATEWAY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams(params).toString(),
    });
    const payload = (await response.json()) as unknown;

    // TOP responde 200 incluso cuando falla: el error va dentro del cuerpo.
    if (isRecord(payload) && isRecord(payload.error_response)) {
      const error = payload.error_response;
      const message = [error.msg, error.sub_msg].filter(Boolean).join(" — ") || "La API de Alibaba devolvió un error.";
      return { ok: false, error: String(message), hint: HINT_PASTE, raw: payload };
    }

    const product = buildProduct({ data: payload, method: "api", sourceUrl });
    if (!product) {
      return {
        ok: false,
        error: "La API respondió pero no se reconoció ningún producto dentro.",
        hint: HINT_PASTE,
        raw: payload,
      };
    }
    product.sourceProductId = product.sourceProductId ?? productId;
    return { ok: true, product };
  } catch (error) {
    return {
      ok: false,
      error: `No se pudo llamar a la API de Alibaba: ${error instanceof Error ? error.message : String(error)}`,
      hint: HINT_PASTE,
    };
  }
}

// ───────────────────────────── el adaptador ─────────────────────────────

export type AlibabaAdapter = ProviderAdapter & {
  fromApi(productId: string, sourceUrl?: string): Promise<ImportResult>;
  hasApiCredentials(): boolean;
};

// spanish.alibaba.com, m.alibaba.com, offer.alibaba.com... todos son *.alibaba.com.
const HOST_PATTERNS = [/(^|\.)alibaba\.com$/i, /(^|\.)alibaba\.co\.uk$/i];

function safeUrl(input: string): URL | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const candidate = /^https?:\/\//i.test(input) ? input.trim() : `https://${input.trim()}`;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

export const adapter: AlibabaAdapter = {
  id: "alibaba",
  label: "Alibaba.com",
  hostPatterns: HOST_PATTERNS,

  matches(url: string): boolean {
    const parsed = safeUrl(url);
    if (!parsed) return false;
    return HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname));
  },

  /**
   * El id es el número largo del final del nombre de fichero:
   * `/product-detail/Vestido-Floral_1600891234567.html`. También aparece como
   * `productId=` en las URLs cortas y en los subdominios de idioma (spanish., es.).
   */
  extractId(url: string): string | null {
    const parsed = safeUrl(url);
    if (!parsed || !HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) return null;

    for (const key of ["productId", "product_id", "offerId", "offer_id", "id"]) {
      const value = parsed.searchParams.get(key);
      if (value && /^\d{6,}$/.test(value)) return value;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const withoutExtension = decodeURIComponent(last).replace(/\.(html?|htm)$/i, "");

    // El id va detrás del último guion bajo; si no hay, el segmento entero puede serlo.
    const afterUnderscore = withoutExtension.split("_").pop() ?? "";
    if (/^\d{6,}$/.test(afterUnderscore)) return afterUnderscore;

    const numeric = withoutExtension.match(/(\d{6,})(?![\s\S]*\d{6,})/);
    if (numeric) return numeric[1];

    const anywhere = parsed.pathname.match(/(\d{9,})/);
    return anywhere ? anywhere[1] : null;
  },

  async fromUrl(url: string): Promise<ImportResult> {
    if (!this.matches(url)) {
      return {
        ok: false,
        error: "Esa URL no es de Alibaba.com.",
        hint: "Pega el enlace de la ficha del producto en alibaba.com.",
      };
    }

    // Vía 1 antes que la 2: si hay llaves, la API es más limpia que raspar HTML.
    const productId = this.extractId(url);
    if (hasApiCredentials() && productId) {
      const viaApi = await fromApi(productId, url);
      if (viaApi.ok) return viaApi;
    }

    let html = "";
    try {
      const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
      if (!response.ok) {
        return {
          ok: false,
          error: `Alibaba respondió ${response.status} al pedir la ficha: es su anti-bot bloqueando al servidor, no un fallo del producto.`,
          hint: HINT_PASTE,
        };
      }
      html = await response.text();
    } catch (error) {
      return {
        ok: false,
        error: `No se pudo descargar la ficha: ${error instanceof Error ? error.message : String(error)}`,
        hint: HINT_PASTE,
      };
    }

    if (looksBlocked(html) || html.length < 2000) {
      return {
        ok: false,
        error: "Alibaba devolvió su página de verificación en vez del producto: está bloqueando al servidor.",
        hint: HINT_PASTE,
      };
    }

    const result = this.fromHtml(html, url);
    if (result.ok) result.product.method = "url";
    return result;
  },

  fromHtml(html: string, sourceUrl?: string): ImportResult {
    if (typeof html !== "string" || html.trim().length === 0) {
      return { ok: false, error: "No llegó ningún HTML que parsear.", hint: HINT_PASTE };
    }

    try {
      if (looksBlocked(html)) {
        return {
          ok: false,
          error: "Ese HTML es la página de verificación de Alibaba, no la ficha del producto.",
          hint: "Vuelve a la pestaña del producto, comprueba que se ven la foto y el precio, y copia el HTML otra vez.",
        };
      }

      // Vías 1 y 2: el estado embebido, lo único que trae la escalera completa.
      const embedded =
        findAssignedJson(html, ["window.detailData", "window.__INIT_DATA__", "window.__ssrData", "window.runParams"]) ??
        findScriptJson(html, ["__NEXT_DATA__", "detailData", "__INIT_DATA__"]);

      if (embedded) {
        const product = buildProduct({ data: embedded, method: "html", sourceUrl, html });
        if (product) return { ok: true, product };
      }

      // Vía 3: JSON-LD.
      const jsonLd = findJsonLdProduct(html);
      if (jsonLd) {
        const product = buildFromJsonLd(jsonLd, "html", sourceUrl);
        if (product) return { ok: true, product };
      }

      // Vía 4: meta tags.
      const fromMeta = buildFromMeta(html, "html", sourceUrl);
      if (fromMeta) return { ok: true, product: fromMeta };

      return {
        ok: false,
        error: "No se reconoció ninguna ficha de producto de Alibaba dentro de ese HTML.",
        hint:
          "Comprueba que copiaste la página del producto (no la de resultados de búsqueda) y con la ficha ya cargada. " +
          "Si se repite, usa el bookmarklet: extrae los datos desde tu propio navegador.",
      };
    } catch (error) {
      // El parseo no puede tumbar el importador: si algo revienta, se informa y ya.
      return {
        ok: false,
        error: `El HTML no se pudo interpretar: ${error instanceof Error ? error.message : String(error)}`,
        hint: HINT_PASTE,
      };
    }
  },

  /**
   * Vía 4 del contrato: el bookmarklet manda lo que encontró en la propia página.
   * Puede llegar como `{ html }`, como `{ data }` o como el objeto de estado pelado.
   */
  fromPayload(payload: unknown, sourceUrl?: string): ImportResult {
    try {
      if (typeof payload === "string") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload) as unknown;
        } catch {
          // No era JSON: entonces el bookmarklet mandó el HTML en crudo.
          return this.fromHtml(payload, sourceUrl);
        }
        return this.fromPayload ? this.fromPayload(parsed, sourceUrl) : { ok: false, error: "Payload no soportado." };
      }
      if (!isRecord(payload)) {
        return { ok: false, error: "El bookmarklet no envió datos utilizables.", hint: HINT_PASTE };
      }

      const url = typeof payload.url === "string" ? payload.url : sourceUrl;

      if (typeof payload.html === "string" && payload.html.length > 0) {
        const viaHtml = this.fromHtml(payload.html, url);
        if (viaHtml.ok) {
          viaHtml.product.method = "bookmarklet";
          return viaHtml;
        }
      }

      const data = payload.data ?? payload.detailData ?? payload.initData ?? payload;
      const product = buildProduct({ data, method: "bookmarklet", sourceUrl: url });
      if (product) return { ok: true, product };

      return {
        ok: false,
        error: "El bookmarklet envió datos pero no se reconoció ningún producto dentro.",
        hint: "Asegúrate de pulsarlo estando en la ficha del producto, con la página ya cargada del todo.",
        raw: payload,
      };
    } catch (error) {
      return {
        ok: false,
        error: `No se pudo interpretar lo que envió el bookmarklet: ${error instanceof Error ? error.message : String(error)}`,
        hint: HINT_PASTE,
      };
    }
  },

  fromApi,
  hasApiCredentials,
};

export default adapter;
