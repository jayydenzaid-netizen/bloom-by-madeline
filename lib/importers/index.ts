// Registro de adaptadores y enrutado.
//
// El resto de la aplicación no importa `aliexpress.ts` ni `alibaba.ts`: importa
// esto. Así, el día que se añada un tercer proveedor (Temu, 1688, un mayorista
// local) basta con meterlo en `adapters` y ni el panel ni la API se enteran.
//
// Nada de este fichero lanza excepciones hacia arriba: todo sale como ImportResult.

import aliexpressAdapter from "@/lib/importers/aliexpress";
import alibabaAdapter from "@/lib/importers/alibaba";
import type { ImportResult, ProviderAdapter, ProviderId } from "@/lib/importers/types";
import { HINT_USE_BOOKMARKLET, toUrl } from "@/lib/importers/fetcher";

/**
 * Los adaptadores disponibles, en el orden en que se ofrecen en el panel.
 *
 * OJO: los métodos de estos objetos usan `this` (el de Alibaba se llama a sí mismo
 * para encadenar vías). Hay que invocarlos SIEMPRE como `adapter.fromUrl(...)`,
 * nunca desestructurando (`const { fromUrl } = adapter`), o `this` se pierde.
 */
export const adapters: ProviderAdapter[] = [aliexpressAdapter, alibabaAdapter];

/** Lo justo para pintar el selector de proveedor sin arrastrar los adaptadores al cliente. */
export type ProviderInfo = { id: ProviderId; label: string };

export const providerInfos: ProviderInfo[] = adapters.map((adapter) => ({
  id: adapter.id,
  label: adapter.label,
}));

export function getAdapter(id: string | null | undefined): ProviderAdapter | null {
  if (!id) return null;
  return adapters.find((adapter) => adapter.id === id) ?? null;
}

/** Devuelve el adaptador que reconoce esa URL, o null si no es de ningún proveedor. */
export function detectByUrl(url: string): ProviderAdapter | null {
  if (typeof url !== "string" || !url.trim()) return null;
  for (const adapter of adapters) {
    try {
      if (adapter.matches(url)) return adapter;
    } catch {
      // Un adaptador roto no puede tumbar la detección de los demás.
    }
  }
  return null;
}

const UNKNOWN_HOST: ImportResult = {
  ok: false,
  error: "Ese enlace no es de un proveedor que reconozca.",
  hint: "Ahora mismo se importa de AliExpress y de Alibaba.com. Pega el enlace de la ficha del producto tal cual sale en la barra del navegador.",
};

// ─────────────────────────────── vías de entrada ───────────────────────────────

/** Vía 2 del contrato: bajar la ficha por URL. Puede morir por anti-bot; se dice claro. */
export async function importFromUrl(url: string): Promise<ImportResult> {
  const parsed = toUrl(url);
  if (!parsed) {
    return {
      ok: false,
      error: "Eso no parece una dirección web.",
      hint: "Copia el enlace completo desde la barra del navegador, con https:// incluido.",
    };
  }

  const adapter = detectByUrl(parsed.toString());
  if (!adapter) return UNKNOWN_HOST;

  try {
    return await adapter.fromUrl(parsed.toString());
  } catch (error) {
    return {
      ok: false,
      error: `El importador de ${adapter.label} falló al descargar: ${message(error)}`,
      hint: HINT_USE_BOOKMARKLET,
    };
  }
}

/**
 * Vía 3: HTML pegado. Si viene la URL se enruta por ella; si no, se olfatea el
 * propio HTML. El olfateo no es cosmético: la usuaria copia el HTML con Ctrl+U y
 * ahí no hay ninguna URL que valga, así que sin esto habría que preguntarle el
 * proveedor a mano cada vez.
 */
export function importFromHtml(html: string, url?: string): ImportResult {
  if (typeof html !== "string" || html.trim().length < 200) {
    return {
      ok: false,
      error: "El HTML pegado está vacío o es demasiado corto para ser una ficha.",
      hint: "En la página del producto pulsa Ctrl+U, luego Ctrl+A y Ctrl+C, y pega aquí todo.",
    };
  }

  const byUrl = url ? detectByUrl(url) : null;
  const ordered = byUrl ? [byUrl, ...adapters.filter((a) => a !== byUrl)] : sniffOrder(html);

  let firstFailure: ImportResult | null = null;
  for (const adapter of ordered) {
    try {
      const result = adapter.fromHtml(html, url);
      if (result.ok) return result;
      if (!firstFailure) firstFailure = result;
    } catch (error) {
      if (!firstFailure) {
        firstFailure = { ok: false, error: `El parser de ${adapter.label} falló: ${message(error)}`, hint: HINT_USE_BOOKMARKLET };
      }
    }
  }

  return (
    firstFailure ?? {
      ok: false,
      error: "No reconocí ninguna ficha de producto dentro de ese HTML.",
      hint: HINT_USE_BOOKMARKLET,
    }
  );
}

/**
 * Vía 4: lo que manda el bookmarklet desde la pestaña del proveedor.
 * El payload trae `provider` porque el bookmarklet ya sabe en qué dominio está;
 * si por lo que sea no llega, se cae a la URL y luego al olfateo del HTML.
 */
export function importFromPayload(payload: unknown): ImportResult {
  const record = asRecord(payload);
  if (!record) {
    return {
      ok: false,
      error: "El bookmarklet no envió nada legible.",
      hint: "Recárgalo desde Ajustes → Importador y vuelve a arrastrarlo a la barra de marcadores.",
    };
  }

  const url = typeof record.url === "string" ? record.url : undefined;
  const adapter =
    getAdapter(typeof record.provider === "string" ? record.provider : null) ??
    (url ? detectByUrl(url) : null) ??
    (typeof record.html === "string" ? sniffOrder(record.html)[0] ?? null : null);

  if (!adapter) return UNKNOWN_HOST;

  try {
    if (typeof adapter.fromPayload === "function") {
      const result = adapter.fromPayload(record, url);
      if (result.ok) return result;
      // El estado JSON no cuajó, pero el bookmarklet casi siempre manda además el
      // HTML entero: aún queda esa bala antes de rendirse.
      if (typeof record.html === "string" && record.html.length > 200) {
        const viaHtml = adapter.fromHtml(record.html, url);
        if (viaHtml.ok) {
          viaHtml.product.method = "bookmarklet";
          return viaHtml;
        }
      }
      return result;
    }

    if (typeof record.html === "string") {
      const viaHtml = adapter.fromHtml(record.html, url);
      if (viaHtml.ok) viaHtml.product.method = "bookmarklet";
      return viaHtml;
    }

    return {
      ok: false,
      error: `El adaptador de ${adapter.label} no sabe leer envíos del bookmarklet.`,
      hint: "Usa la pestaña «HTML pegado».",
    };
  } catch (error) {
    return {
      ok: false,
      error: `No se pudo interpretar el envío del bookmarklet: ${message(error)}`,
      hint: HINT_USE_BOOKMARKLET,
    };
  }
}

// ─────────────────────────────── olfateo de HTML ───────────────────────────────

/**
 * Ordena los adaptadores por probabilidad para un HTML sin URL.
 *
 * No vale con buscar "alibaba": AliExpress ES de Alibaba Group y su HTML menciona
 * el nombre por todas partes. Lo que sí distingue es el *estado embebido* de cada
 * uno (runParams/_d_c_ frente a detailData) y el vocabulario B2B (MOQ, escalera de
 * precios) que jamás aparece en una ficha de AliExpress.
 */
function sniffOrder(html: string): ProviderAdapter[] {
  const head = html.slice(0, 200_000);

  let aliexpress = 0;
  let alibaba = 0;

  if (/window\.runParams/i.test(head)) aliexpress += 5;
  if (/_d_c_|DCData/.test(head)) aliexpress += 5;
  if (/aliexpress\.com\/item|\/item\/\d{6,}\.html/i.test(head)) aliexpress += 4;
  if (/skuModule|priceModule|titleModule/i.test(head)) aliexpress += 4;
  if (/ae_object_value|aeg_/i.test(head)) aliexpress += 2;

  if (/window\.detailData|__INIT_DATA__|__ssrData/i.test(head)) alibaba += 5;
  if (/minOrderQuantity|ladderPrices|productLadderPrices/i.test(head)) alibaba += 5;
  if (/alibaba\.com\/product-detail/i.test(head)) alibaba += 4;
  if (/\bMOQ\b|Min\.? Order/i.test(head)) alibaba += 2;

  const ordered = [...adapters];
  ordered.sort((a, b) => score(b) - score(a));
  return ordered;

  function score(adapter: ProviderAdapter): number {
    if (adapter.id === "aliexpress") return aliexpress;
    if (adapter.id === "alibaba") return alibaba;
    return 0;
  }
}

// ──────────────────────────────── utilidades ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { ImportResult, ProviderAdapter, ProviderId };
