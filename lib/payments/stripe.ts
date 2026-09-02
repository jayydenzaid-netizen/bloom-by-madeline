import type { ConfigStripe } from "./config";
import type { DatosPago, FetchLike, SesionPago, Verificacion } from "./tipos";

/**
 * Stripe Checkout (página hosted), por REST puro con fetch.
 *
 * Sin SDK a propósito: son dos endpoints con form-encoding y el paquete `stripe`
 * arrastra decenas de APIs que no usamos. Menos superficie, mismo resultado.
 *
 * El desglose viaja itemizado para que el recibo sea legible: cada prenda como
 * line item, el envío y el impuesto como líneas propias y el descuento como un
 * cupón de un solo uso (Stripe no admite líneas negativas). La aritmética es la
 * misma de calcularTotales — max(0, subtotal − descuento) + envío + impuesto —
 * así que el total de la sesión coincide EXACTO con Order.totalCents, y la
 * verificación lo vuelve a comprobar contra amount_total antes de marcar nada.
 */

const API = "https://api.stripe.com";

function cabeceras(cfg: ConfigStripe): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

/** Cuerpo form-encoded de la sesión, como función pura para poder testearla. */
export function armarParamsSesionStripe(datos: DatosPago): URLSearchParams {
  const p = new URLSearchParams();
  p.set("mode", "payment");
  p.set("client_reference_id", datos.numero);
  p.set("customer_email", datos.email);
  p.set("metadata[pedido]", datos.numero);
  // Stripe sustituye el marcador literal {CHECKOUT_SESSION_ID} al redirigir.
  const union = datos.urlRetorno.includes("?") ? "&" : "?";
  p.set("success_url", `${datos.urlRetorno}${union}sid={CHECKOUT_SESSION_ID}`);
  p.set("cancel_url", datos.urlCancelacion);

  const moneda = datos.currency.toLowerCase();
  let i = 0;
  const linea = (nombre: string, unitCents: number, cantidad: number) => {
    p.set(`line_items[${i}][price_data][currency]`, moneda);
    p.set(`line_items[${i}][price_data][product_data][name]`, nombre.slice(0, 250));
    p.set(`line_items[${i}][price_data][unit_amount]`, String(unitCents));
    p.set(`line_items[${i}][quantity]`, String(cantidad));
    i += 1;
  };
  for (const l of datos.lineas) linea(l.titulo, l.precioCents, l.cantidad);
  if (datos.shippingCents > 0) linea("Envío", datos.shippingCents, 1);
  if (datos.taxCents > 0) linea(datos.taxLabel || "Impuesto", datos.taxCents, 1);
  return p;
}

type RespuestaStripe = Record<string, unknown> & {
  error?: { message?: string; type?: string };
};

async function llamarStripe(
  cfg: ConfigStripe,
  metodo: "GET" | "POST",
  ruta: string,
  cuerpo: URLSearchParams | null,
  f: FetchLike,
): Promise<RespuestaStripe> {
  const res = await f(`${API}${ruta}`, {
    method: metodo,
    headers: cabeceras(cfg),
    body: cuerpo ? cuerpo.toString() : undefined,
    cache: "no-store",
    // Sin timeout, una pasarela colgada congela el checkout y la página del
    // pedido hasta el límite de la plataforma. 15 s es de sobra para Stripe.
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as RespuestaStripe;
  if (!res.ok) {
    // El mensaje de Stripe es seguro de propagar (no incluye la llave), pero se
    // recorta: acaba en logs y en códigos de aviso, no en novelas.
    const detalle = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Stripe: ${String(detalle).slice(0, 200)}`);
  }
  return json;
}

export async function crearSesionStripe(
  cfg: ConfigStripe,
  datos: DatosPago,
  f: FetchLike = fetch,
): Promise<SesionPago> {
  const params = armarParamsSesionStripe(datos);

  if (datos.discountCents > 0) {
    // Cupón de un solo uso con el importe exacto ya calculado por la tienda.
    const cupon = new URLSearchParams();
    cupon.set("amount_off", String(datos.discountCents));
    cupon.set("currency", datos.currency.toLowerCase());
    cupon.set("duration", "once");
    cupon.set("name", "Descuento");
    const creado = await llamarStripe(cfg, "POST", "/v1/coupons", cupon, f);
    params.set("discounts[0][coupon]", String(creado.id));
  }

  const sesion = await llamarStripe(cfg, "POST", "/v1/checkout/sessions", params, f);
  const ref = typeof sesion.id === "string" ? sesion.id : "";
  const url = typeof sesion.url === "string" ? sesion.url : "";
  if (!ref || !url) throw new Error("Stripe: la sesión llegó sin id o sin url.");
  return { ref, url, cancelRef: ref };
}

/**
 * Expira una sesión abierta para que no se pueda pagar dos veces el mismo
 * pedido desde una pestaña olvidada. Best-effort: si ya se pagó o ya caducó,
 * Stripe responde error y aquí se ignora — el dinero nunca corre peligro.
 */
export async function anularSesionStripe(cfg: ConfigStripe, ref: string, f: FetchLike = fetch): Promise<void> {
  try {
    await llamarStripe(cfg, "POST", `/v1/checkout/sessions/${encodeURIComponent(ref)}/expire`, new URLSearchParams(), f);
  } catch {
    /* sesión ya completada/expirada: exactamente lo que queríamos */
  }
}

export async function verificarSesionStripe(
  cfg: ConfigStripe,
  ref: string,
  esperado: { numero: string; totalCents: number; currency: string },
  f: FetchLike = fetch,
): Promise<Verificacion> {
  let s: RespuestaStripe;
  try {
    s = await llamarStripe(cfg, "GET", `/v1/checkout/sessions/${encodeURIComponent(ref)}`, null, f);
  } catch (err) {
    return { estado: "error", detalle: err instanceof Error ? err.message : "fallo de red" };
  }

  const pagado = s.payment_status === "paid" || s.payment_status === "no_payment_required";
  if (!pagado) return { estado: "pendiente" };

  // Cobro confirmado: ahora tiene que CUADRAR con el pedido. Un importe distinto
  // no se marca pagado en silencio — se deja en revisión para Madeline.
  const monto = typeof s.amount_total === "number" ? s.amount_total : -1;
  const moneda = typeof s.currency === "string" ? s.currency.toUpperCase() : "";
  const pedido = typeof s.client_reference_id === "string" ? s.client_reference_id : "";
  if (monto !== esperado.totalCents || moneda !== esperado.currency) {
    return {
      estado: "no-coincide",
      detalle: `Stripe cobró ${monto} ${moneda} y el pedido es ${esperado.totalCents} ${esperado.currency}.`,
    };
  }
  if (pedido && pedido !== esperado.numero) {
    return { estado: "no-coincide", detalle: `La sesión es del pedido ${pedido}, no de ${esperado.numero}.` };
  }

  const referencia = typeof s.payment_intent === "string" ? s.payment_intent : ref;
  return { estado: "pagado", referencia };
}

/** «Probar conexión» del panel: valida la llave contra la cuenta, sin cobrar nada. */
export async function probarStripe(
  cfg: ConfigStripe,
  f: FetchLike = fetch,
): Promise<{ ok: boolean; detalle: string }> {
  try {
    const cuenta = await llamarStripe(cfg, "GET", "/v1/account", null, f);
    const settings = cuenta.settings as { dashboard?: { display_name?: string } } | undefined;
    const nombre = settings?.dashboard?.display_name || (cuenta.email as string) || "cuenta conectada";
    const modo = cfg.secretKey.startsWith("sk_test_") ? " (modo prueba)" : "";
    return { ok: true, detalle: `${nombre}${modo}` };
  } catch (err) {
    // Una llave restringida (rk_) puede no tener permiso de Account y aun así
    // cobrar perfectamente: antes de declarar el fallo se prueba con Balance,
    // que casi cualquier rk_ puede leer.
    try {
      await llamarStripe(cfg, "GET", "/v1/balance", null, f);
      return { ok: true, detalle: "llave válida (restringida, sin permiso de cuenta)" };
    } catch {
      return { ok: false, detalle: err instanceof Error ? err.message : "fallo de red" };
    }
  }
}
