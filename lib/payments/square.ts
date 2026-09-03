import { randomUUID } from "node:crypto";
import type { ConfigSquare } from "./config";
import {
  ErrorPasarela,
  type CodigoDiagnostico,
  type DatosPago,
  type FetchLike,
  type ResultadoPrueba,
  type SesionPago,
  type Verificacion,
} from "./tipos";

/**
 * Square Payment Links (página de cobro hosted), por REST puro.
 *
 * Flujo: crear un payment link con la orden itemizada → mandar a la clienta a
 * su URL → al volver, consultar la ORDEN en la API de Orders y comprobar que ya
 * no debe nada (tenders que cubren el total). El link guarda dentro un order_id
 * y ESE es el que se archiva como referencia: la verificación va por él.
 *
 * El envío y el impuesto van como líneas propias y el descuento como descuento
 * de orden de importe fijo: son los importes exactos ya calculados por la
 * tienda, nunca porcentajes recalculados (los redondeos de un porcentaje
 * podrían descuadrar un centavo y la verificación fallaría con razón).
 *
 * No se fija Square-Version: sin la cabecera, Square usa la versión por defecto
 * de la aplicación del token — para una app recién creada por Madeline es la
 * versión actual, y no arriesgamos clavar aquí una fecha que deje de existir.
 */

function base(cfg: ConfigSquare): string {
  return cfg.entorno === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

type RespuestaSquare = Record<string, unknown> & {
  errors?: { code?: string; detail?: string; category?: string }[];
};

async function llamarSquare(
  cfg: ConfigSquare,
  metodo: "GET" | "POST" | "DELETE",
  ruta: string,
  cuerpo: unknown,
  f: FetchLike,
): Promise<RespuestaSquare> {
  const res = await f(`${base(cfg)}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "Content-Type": "application/json",
    },
    body: cuerpo === null ? undefined : JSON.stringify(cuerpo),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as RespuestaSquare;
  if (!res.ok) {
    const fallo = json.errors?.[0];
    const detalle = fallo?.detail ?? fallo?.code ?? `HTTP ${res.status}`;
    // Square contestó: 401 = token inválido/caducado, 403 = sin permiso.
    // Su categoría AUTHENTICATION_ERROR lo dice explícitamente.
    const categoria = fallo?.category ?? "";
    // El `code` viaja aparte del texto A PROPÓSITO. El `detail` de Square para
    // TODOS los fallos de autorización es la misma frase genérica («This request
    // could not be authorized»), así que quedarse solo con él es quedarse sin
    // diagnóstico: no se puede distinguir un token caducado de uno revocado, de
    // uno sin permisos o de una aplicación desactivada. El `code` sí lo dice.
    throw new ErrorPasarela(
      `Square: ${String(detalle).slice(0, 200)}`,
      res.status === 401 || res.status === 403 || categoria === "AUTHENTICATION_ERROR",
      fallo?.code,
      categoria,
    );
  }
  return json;
}

/**
 * El código de Square traducido a nuestro diagnóstico.
 *
 * Los valores de la izquierda son los que documenta Square para los fallos de
 * autorización. Lo que se gana traduciéndolos: poder decirle a la dueña «ese
 * token está caducado, saca uno nuevo» en vez de «Square rechazó el token»,
 * que es verdad y no sirve de nada.
 */
export function diagnosticoSquare(codigo: string | undefined): CodigoDiagnostico {
  switch ((codigo ?? "").toUpperCase()) {
    case "ACCESS_TOKEN_EXPIRED":
      return "token-caducado";
    case "ACCESS_TOKEN_REVOKED":
      return "token-revocado";
    case "INSUFFICIENT_SCOPES":
    case "FORBIDDEN":
      return "permisos-insuficientes";
    case "APPLICATION_DISABLED":
      return "aplicacion-desactivada";
    default:
      return "credencial-invalida";
  }
}

/** Cuerpo JSON del payment link, como función pura para poder testearlo. */
export function armarLinkSquare(
  datos: DatosPago,
  locationId: string,
  idempotencyKey: string,
): Record<string, unknown> {
  const dinero = (cents: number) => ({ amount: cents, currency: datos.currency });

  const lineas: Record<string, unknown>[] = datos.lineas.map((l) => ({
    name: l.titulo.slice(0, 255),
    quantity: String(l.cantidad),
    base_price_money: dinero(l.precioCents),
  }));
  if (datos.shippingCents > 0) {
    lineas.push({ name: "Envío", quantity: "1", base_price_money: dinero(datos.shippingCents) });
  }
  if (datos.taxCents > 0) {
    lineas.push({
      name: (datos.taxLabel || "Impuesto").slice(0, 255),
      quantity: "1",
      base_price_money: dinero(datos.taxCents),
    });
  }

  const orden: Record<string, unknown> = {
    location_id: locationId,
    reference_id: datos.numero,
    line_items: lineas,
  };
  if (datos.discountCents > 0) {
    orden.discounts = [
      {
        name: "Descuento",
        type: "FIXED_AMOUNT",
        amount_money: dinero(datos.discountCents),
        scope: "ORDER",
      },
    ];
  }

  return {
    idempotency_key: idempotencyKey,
    order: orden,
    checkout_options: {
      redirect_url: datos.urlRetorno,
      ask_for_shipping_address: false,
      allow_tipping: false,
    },
    pre_populated_data: { buyer_email: datos.email },
  };
}

export async function crearLinkSquare(
  cfg: ConfigSquare,
  datos: DatosPago,
  f: FetchLike = fetch,
): Promise<SesionPago> {
  const cuerpo = armarLinkSquare(datos, cfg.locationId, randomUUID());
  const json = await llamarSquare(cfg, "POST", "/v2/online-checkout/payment-links", cuerpo, f);
  const link = json.payment_link as { id?: string; url?: string; order_id?: string } | undefined;
  const ref = link?.order_id ?? "";
  const url = link?.url ?? "";
  if (!ref || !url) throw new Error("Square: el payment link llegó sin order_id o sin url.");
  // La verificación va por order_id; la ANULACIÓN, por el id del link.
  return { ref, url, cancelRef: link?.id };
}

/**
 * Borra un payment link para que no se pueda pagar dos veces el mismo pedido
 * desde una pestaña olvidada (los links de Square no caducan solos jamás).
 * Best-effort: si ya se pagó o ya no existe, se ignora.
 */
export async function anularLinkSquare(cfg: ConfigSquare, linkId: string, f: FetchLike = fetch): Promise<void> {
  try {
    await llamarSquare(cfg, "DELETE", `/v2/online-checkout/payment-links/${encodeURIComponent(linkId)}`, null, f);
  } catch {
    /* link pagado o inexistente: nada que anular */
  }
}

type OrdenSquare = {
  state?: string;
  reference_id?: string;
  total_money?: { amount?: number; currency?: string };
  net_amount_due_money?: { amount?: number };
  tenders?: { id?: string; amount_money?: { amount?: number }; card_details?: { status?: string } }[];
};

/**
 * ¿Este tender es dinero de verdad?
 *
 * Un tender de tarjeta puede estar CAPTURED (cobrado), AUTHORIZED (retenido, aún
 * no cobrado), VOIDED (anulado) o FAILED. Antes se sumaban TODOS por igual, así
 * que un cobro anulado seguía contando y podía llevar la suma por encima del
 * total: el pedido se marcaba «pagado» sin que existiera el dinero. Sin
 * `card_details` (efectivo, tarjeta regalo) se cuenta, que es como se comportaba
 * hasta ahora y es correcto: esos tenders no tienen estado intermedio.
 */
function tenderCobrado(t: { card_details?: { status?: string } }): boolean {
  const estado = t.card_details?.status;
  if (!estado) return true;
  return estado === "CAPTURED";
}

export async function verificarOrdenSquare(
  cfg: ConfigSquare,
  ref: string,
  esperado: { numero: string; totalCents: number; currency: string },
  f: FetchLike = fetch,
): Promise<Verificacion> {
  let json: RespuestaSquare;
  try {
    json = await llamarSquare(cfg, "GET", `/v2/orders/${encodeURIComponent(ref)}`, null, f);
  } catch (err) {
    return {
      estado: "error",
      detalle: err instanceof Error ? err.message : "fallo de red",
      credencial: err instanceof ErrorPasarela && err.credencial,
    };
  }
  const orden = (json.order ?? {}) as OrdenSquare;

  // ¿Hay dinero de verdad? O la orden quedó saldada (no debe nada y tiene
  // tenders), o los tenders cubren el total. Sin tenders no ha pagado nadie.
  // Solo cuentan los tenders efectivamente cobrados: uno anulado o fallido no
  // es dinero, y sumándolo se podía marcar pagado un pedido que nadie pagó.
  const tenders = (orden.tenders ?? []).filter(tenderCobrado);
  const cobrado = tenders.reduce((suma, t) => suma + (t.amount_money?.amount ?? 0), 0);
  const saldada =
    tenders.length > 0 &&
    (orden.net_amount_due_money?.amount === 0 || orden.state === "COMPLETED" || cobrado >= (orden.total_money?.amount ?? Number.POSITIVE_INFINITY));
  if (!saldada) return { estado: "pendiente" };

  const total = orden.total_money?.amount ?? -1;
  const moneda = (orden.total_money?.currency ?? "").toUpperCase();
  if (total !== esperado.totalCents || moneda !== esperado.currency) {
    return {
      estado: "no-coincide",
      detalle: `Square cobró ${total} ${moneda} y el pedido es ${esperado.totalCents} ${esperado.currency}.`,
    };
  }
  const pedido = orden.reference_id ?? "";
  if (pedido && pedido !== esperado.numero) {
    return { estado: "no-coincide", detalle: `La orden es del pedido ${pedido}, no de ${esperado.numero}.` };
  }
  return { estado: "pagado", referencia: tenders[0]?.id || ref };
}

export type LocalSquare = { id: string; nombre: string };

export type PruebaSquare = ResultadoPrueba & { locales: LocalSquare[] };

/** «Probar conexión»: valida el token listando los locales de la cuenta. */
export async function probarSquare(cfg: ConfigSquare, f: FetchLike = fetch): Promise<PruebaSquare> {
  try {
    const json = await llamarSquare(cfg, "GET", "/v2/locations", null, f);
    const crudos = Array.isArray(json.locations)
      ? (json.locations as { id?: string; name?: string; status?: string; business_name?: string }[])
      : [];
    const locales = crudos
      .filter((l) => l.id && l.status !== "INACTIVE")
      .map((l) => ({ id: l.id as string, nombre: l.name ?? l.id! }));
    if (locales.length === 0) {
      return {
        ok: false,
        detalle: "el token vale pero la cuenta no tiene locales activos",
        locales: [],
        motivo: "credencial",
        codigo: "sin-locales",
      };
    }
    // El nombre del negocio según Square. Se enseña en el panel para que la
    // dueña confirme de un vistazo que conectó SU cuenta y no otra.
    const cuenta = crudos.find((l) => l.business_name)?.business_name || locales[0].nombre;
    const coincide = !cfg.locationId || locales.some((l) => l.id === cfg.locationId);
    return {
      ok: coincide,
      detalle: coincide
        ? `${locales.length} ${locales.length === 1 ? "local activo" : "locales activos"}`
        : "el Location ID guardado no es de esta cuenta",
      locales,
      cuenta,
      ...(coincide ? { codigo: "ok" as const } : { motivo: "credencial" as const, codigo: "local-ajeno" as const }),
    };
  } catch (err) {
    const rechazado = err instanceof ErrorPasarela && err.credencial;
    // El error nº 1 al conectar Square: pegar el token de la pestaña «Sandbox»
    // teniendo el entorno en «Real» (o al revés). Square solo dice
    // «Unauthorized», que no ayuda nada. Así que se prueba el OTRO entorno: si
    // allí funciona, se puede decir exactamente qué pasa y cómo arreglarlo.
    if (rechazado) {
      const otro = cfg.entorno === "production" ? "sandbox" : "production";
      try {
        await llamarSquare({ ...cfg, entorno: otro } as ConfigSquare, "GET", "/v2/locations", null, f);
        return {
          ok: false,
          motivo: "credencial",
          codigo: "entorno-cruzado",
          locales: [],
          detalle:
            otro === "sandbox"
              ? "ese token es de PRUEBAS (Sandbox) y el entorno está en «Real»"
              : "ese token es de PRODUCCIÓN (Real) y el entorno está en «Pruebas»",
        };
      } catch {
        /* tampoco vale en el otro entorno: es un token malo a secas */
      }
    }
    return {
      ok: false,
      detalle: err instanceof Error ? err.message : "fallo de red",
      locales: [],
      motivo: rechazado ? "credencial" : "red",
      // Con el token rechazado, el `code` de Square dice EXACTAMENTE qué pasa
      // (caducado / revocado / sin permisos / aplicación desactivada). Sin él,
      // lo único honesto que se puede decir es «no se pudo preguntar».
      codigo: rechazado
        ? diagnosticoSquare(err instanceof ErrorPasarela ? err.codigo : undefined)
        : "sin-respuesta",
    };
  }
}
