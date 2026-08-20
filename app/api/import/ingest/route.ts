// Endpoint que recibe lo que manda el bookmarklet desde la página del proveedor.
//
// Es el único punto de la aplicación al que se llama desde OTRO dominio, y eso
// dicta todo su diseño:
//
//  · No puede usar la cookie de sesión del panel (no viaja entre orígenes), así
//    que se autentica con un token propio guardado en Setting['importToken'].
//    Sin él, cualquiera que descubriese la URL podría meter productos en la tienda.
//  · Tiene que responder CORS, y acotado: solo los dominios de AliExpress y
//    Alibaba, que son los únicos sitios donde el bookmarklet tiene sentido.
//  · El cuerpo puede ser enorme (el HTML de una ficha ronda los 2 MB), así que se
//    mide antes de parsear y se rechaza con un mensaje que diga qué hacer.
//
// Responde SIEMPRE JSON con la misma forma, incluso en los errores: el bookmarklet
// pinta el aviso flotante a partir de `error`/`hint` y no sabe leer HTML.

import { NextResponse } from "next/server";

import { importFromPayload } from "@/lib/importers";
import {
  createFailedImportJob,
  createImportJob,
  findProductBySource,
  getOrCreateImportToken,
} from "@/lib/importers/pipeline";
import type { ImportMethod, ProviderId } from "@/lib/importers/types";

// Prisma y node:crypto: runtime de Node, no edge. Y nada de caché: cada envío es
// un producto distinto.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 4 MB. Por encima, Vercel corta la petición antes de que llegue aquí. */
const MAX_BODY_BYTES = 4_000_000;

export type IngestResponse =
  | {
      ok: true;
      jobId: string;
      provider: string;
      method: string;
      title: string;
      images: number;
      variants: number;
      warnings: string[];
      reviewUrl: string;
      /** Si ya existe en el catálogo, para avisar antes de que lo publique dos veces. */
      duplicate?: { productId: string; slug: string; title: string };
    }
  | { ok: false; error: string; hint?: string };

// ─────────────────────────────────── CORS ───────────────────────────────────

/**
 * Orígenes desde los que se acepta el bookmarklet. Acotado a propósito: abrirlo a
 * `*` convertiría el endpoint en un buzón abierto para cualquier web que la
 * usuaria visitase mientras tiene el token en su navegador.
 */
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^https:\/\/([a-z0-9-]+\.)*aliexpress\.(com|us|ru|es|it|fr|nl|pl|co\.kr|br)$/i,
  /^https:\/\/([a-z0-9-]+\.)*aliexpress\.com\.br$/i,
  /^https:\/\/([a-z0-9-]+\.)*alibaba\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)*alibaba\.co\.uk$/i,
  /^https:\/\/([a-z0-9-]+\.)*1688\.com$/i,
];

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // Sin Origin: misma pestaña, curl o el propio panel.
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    // La respuesta cambia según el origen: sin esto una caché intermedia podría
    // servirle a un dominio la cabecera permisiva emitida para otro.
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, X-Bloom-Import-Token";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(body: IngestResponse, status: number, origin: string | null): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

export async function OPTIONS(request: Request): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return new NextResponse(null, { status: 403, headers: { Vary: "Origin" } });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function GET(request: Request): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  return json(
    { ok: false, error: "Este endpoint solo acepta envíos del bookmarklet (POST).", hint: "Instálalo desde el panel, en Importar." },
    405,
    origin,
  );
}

// ─────────────────────────────── autenticación ───────────────────────────────

/** Comparación en tiempo constante: comparar tokens con === filtra su longitud. */
async function tokenIsValid(candidate: string | null): Promise<boolean> {
  if (!candidate) return false;
  const expected = await getOrCreateImportToken();
  const { timingSafeEqual } = await import("node:crypto");
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ──────────────────────────────── utilidades ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Origen público de la tienda. Detrás de un proxy (Vercel) la URL de la petición
 * apunta al host interno, así que mandan las cabeceras reenviadas: si no, el
 * enlace "revisarlo en el panel" del aviso llevaría a una dirección que no existe.
 */
function publicOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  if (host) return `${proto}://${host}`;
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

// ──────────────────────────────── el envío ────────────────────────────────

export async function POST(request: Request): Promise<NextResponse> {
  const origin = request.headers.get("origin");

  if (!isAllowedOrigin(origin)) {
    return json(
      {
        ok: false,
        error: "Este importador solo acepta envíos desde AliExpress y Alibaba.",
        hint: "Pulsa el marcador estando en la ficha del producto del proveedor.",
      },
      403,
      origin,
    );
  }

  // Tamaño: primero lo que declara la petición, y luego lo que de verdad llegó,
  // porque el content-length se puede mentir o faltar.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json(
      {
        ok: false,
        error: `La ficha pesa ${(declared / 1_000_000).toFixed(1)} MB y el límite son ${MAX_BODY_BYTES / 1_000_000} MB.`,
        hint: "Copia el HTML de la ficha y pégalo en el panel, en la pestaña «HTML pegado».",
      },
      413,
      origin,
    );
  }

  let text: string;
  try {
    text = await request.text();
  } catch (error) {
    return json({ ok: false, error: `No se pudo leer el envío: ${message(error)}` }, 400, origin);
  }

  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return json(
      {
        ok: false,
        error: "El envío supera el tamaño máximo aceptado.",
        hint: "Copia el HTML de la ficha y pégalo en el panel, en la pestaña «HTML pegado».",
      },
      413,
      origin,
    );
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = asRecord(JSON.parse(text) as unknown);
  } catch {
    payload = null;
  }
  if (!payload) {
    return json(
      { ok: false, error: "El envío no era JSON válido.", hint: "Vuelve a instalar el marcador desde el panel." },
      400,
      origin,
    );
  }

  const token =
    request.headers.get("x-bloom-import-token") ??
    (typeof payload.token === "string" ? payload.token : null) ??
    new URL(request.url).searchParams.get("token");

  if (!(await tokenIsValid(token))) {
    return json(
      {
        ok: false,
        error: "El marcador no está autorizado en esta tienda.",
        hint: "Vuelve a arrastrarlo desde el panel: el token cambió o el marcador es de otra tienda.",
      },
      401,
      origin,
    );
  }

  const result = importFromPayload(payload);

  const provider = (typeof payload.provider === "string" ? payload.provider : "manual") as ProviderId;
  const sourceUrl = typeof payload.url === "string" ? payload.url : null;

  if (!result.ok) {
    // Se deja rastro del intento fallido: si no, la usuaria ve el aviso rojo, lo
    // cierra, y en el panel no hay nada que contar lo que pasó.
    try {
      await createFailedImportJob({
        provider,
        method: "bookmarklet" as ImportMethod,
        error: `${result.error}${result.hint ? ` — ${result.hint}` : ""}`,
        sourceUrl,
      });
    } catch {
      // Si ni siquiera se puede escribir el fallo, se responde igual.
    }
    return json({ ok: false, error: result.error, hint: result.hint }, 422, origin);
  }

  const product = result.product;
  product.method = "bookmarklet";
  if (!product.sourceUrl && sourceUrl) product.sourceUrl = sourceUrl;

  let job: { id: string; provider: string; method: string };
  try {
    job = await createImportJob(product, { raw: { url: sourceUrl } });
  } catch (error) {
    return json({ ok: false, error: `No se pudo guardar la importación: ${message(error)}` }, 500, origin);
  }

  const existing = await findProductBySource(product.provider, product.sourceProductId).catch(() => null);
  const base = publicOrigin(request);

  return json(
    {
      ok: true,
      jobId: job.id,
      provider: job.provider,
      method: job.method,
      title: product.title,
      images: product.images.length,
      variants: product.variants.length,
      warnings: product.warnings,
      reviewUrl: `${base}/admin/importar?job=${encodeURIComponent(job.id)}`,
      ...(existing
        ? { duplicate: { productId: existing.id, slug: existing.slug, title: existing.title } }
        : {}),
    },
    200,
    origin,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
