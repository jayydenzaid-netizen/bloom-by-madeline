import type { ConfigPaypal } from "./config";
import { centavosADecimales, type DatosPago, type FetchLike, type SesionPago, type Verificacion } from "./tipos";

/**
 * PayPal Orders v2 (página de aprobación hosted), por REST puro.
 *
 * Flujo: crear la orden con intent CAPTURE → mandar a la clienta al enlace de
 * aprobación → al volver, CAPTURAR en el servidor y comprobar COMPLETED. La
 * captura es la que mueve el dinero: la vuelta del navegador no vale nada sola.
 *
 * Peculiaridades que aquí quedan resueltas:
 *  - PayPal quiere importes como texto decimal ("12.34"), no centavos.
 *  - El breakdown tiene que cuadrar EXACTO: item_total + shipping + tax_total −
 *    discount = total, o rechaza la orden. Sale solo, porque calcularTotales
 *    hace esa misma suma con enteros.
 *  - invoice_id = número de pedido: si alguien intenta pagar dos veces el mismo
 *    pedido con dos sesiones, PayPal rechaza la segunda captura (DUPLICATE_INVOICE_ID).
 */

function base(cfg: ConfigPaypal): string {
  return cfg.entorno === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
}

type RespuestaPaypal = Record<string, unknown> & {
  message?: string;
  details?: { issue?: string; description?: string }[];
};

async function tokenPaypal(cfg: ConfigPaypal, f: FetchLike): Promise<string> {
  const credenciales = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await f(`${base(cfg)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credenciales}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`PayPal: ${String(json.error_description ?? `HTTP ${res.status}`).slice(0, 200)}`);
  }
  return json.access_token;
}

async function llamarPaypal(
  cfg: ConfigPaypal,
  token: string,
  metodo: "GET" | "POST",
  ruta: string,
  cuerpo: unknown,
  f: FetchLike,
  extraCabeceras: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; json: RespuestaPaypal }> {
  const res = await f(`${base(cfg)}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraCabeceras,
    },
    body: cuerpo === null ? undefined : JSON.stringify(cuerpo),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as RespuestaPaypal;
  return { ok: res.ok, status: res.status, json };
}

/** Cuerpo JSON de la orden, como función pura para poder testear el breakdown. */
export function armarOrdenPaypal(datos: DatosPago): Record<string, unknown> {
  const dinero = (cents: number) => ({
    currency_code: datos.currency,
    value: centavosADecimales(cents),
  });

  // El total de PayPal se arma con SU fórmula para que cuadre por construcción;
  // coincide con datos.totalCents porque es la misma de calcularTotales.
  const descuentoEfectivo = Math.min(datos.discountCents, datos.subtotalCents);

  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: datos.numero,
        invoice_id: datos.numero,
        description: `Pedido ${datos.numero} · Bloom by Madeline`,
        amount: {
          ...dinero(datos.totalCents),
          breakdown: {
            item_total: dinero(datos.subtotalCents),
            shipping: dinero(datos.shippingCents),
            tax_total: dinero(datos.taxCents),
            discount: dinero(descuentoEfectivo),
          },
        },
        items: datos.lineas.map((l) => ({
          name: l.titulo.slice(0, 127),
          quantity: String(l.cantidad),
          unit_amount: dinero(l.precioCents),
          category: "PHYSICAL_GOODS",
        })),
      },
    ],
    application_context: {
      brand_name: "Bloom by Madeline",
      user_action: "PAY_NOW",
      // La dirección ya la tenemos del checkout propio; pedirla otra vez en
      // PayPal descuadra pedidos (la clienta podría poner otra).
      shipping_preference: "NO_SHIPPING",
      return_url: datos.urlRetorno,
      cancel_url: datos.urlCancelacion,
    },
  };
}

export async function crearOrdenPaypal(
  cfg: ConfigPaypal,
  datos: DatosPago,
  f: FetchLike = fetch,
): Promise<SesionPago> {
  const token = await tokenPaypal(cfg, f);
  const { ok, status, json } = await llamarPaypal(
    cfg,
    token,
    "POST",
    "/v2/checkout/orders",
    armarOrdenPaypal(datos),
    f,
  );
  if (!ok) {
    const detalle = json.details?.[0]?.description ?? json.message ?? `HTTP ${status}`;
    throw new Error(`PayPal: ${String(detalle).slice(0, 200)}`);
  }
  const ref = typeof json.id === "string" ? json.id : "";
  const enlaces = Array.isArray(json.links) ? (json.links as { rel?: string; href?: string }[]) : [];
  // Con application_context el enlace es rel=approve; la variante nueva de la
  // API lo llama payer-action. Se aceptan ambos por si PayPal migra el formato.
  const aprobacion = enlaces.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href ?? "";
  if (!ref || !aprobacion) throw new Error("PayPal: la orden llegó sin id o sin enlace de aprobación.");
  return { ref, url: aprobacion };
}

type OrdenPaypal = RespuestaPaypal & {
  status?: string;
  purchase_units?: {
    reference_id?: string;
    amount?: { value?: string; currency_code?: string };
    payments?: {
      captures?: { id?: string; status?: string; amount?: { value?: string; currency_code?: string } }[];
    };
  }[];
};

function evaluarOrden(orden: OrdenPaypal, esperado: { numero: string; totalCents: number; currency: string }): Verificacion {
  const unidad = orden.purchase_units?.[0];
  const captura = unidad?.payments?.captures?.[0];

  if (orden.status !== "COMPLETED" || !captura) return { estado: "pendiente" };
  // Un eCheck puede quedar PENDING días: el dinero aún no está.
  if (captura.status !== "COMPLETED") return { estado: "pendiente" };

  // OJO: la respuesta de una CAPTURA recién hecha no siempre trae el amount de
  // la purchase_unit (aunque se pida Prefer: return=representation, PayPal ha
  // cambiado ese detalle entre versiones). El importe fiable es el de la propia
  // captura — es lo que de verdad se cobró — y el de la unidad queda de respaldo.
  const importe = captura.amount ?? unidad?.amount;
  const valor = importe?.value ?? "";
  const moneda = (importe?.currency_code ?? "").toUpperCase();
  if (valor !== centavosADecimales(esperado.totalCents) || moneda !== esperado.currency) {
    return {
      estado: "no-coincide",
      detalle: `PayPal cobró ${valor || "(sin importe)"} ${moneda} y el pedido es ${centavosADecimales(esperado.totalCents)} ${esperado.currency}.`,
    };
  }
  const pedido = unidad?.reference_id ?? "";
  if (pedido && pedido !== esperado.numero) {
    return { estado: "no-coincide", detalle: `La orden es del pedido ${pedido}, no de ${esperado.numero}.` };
  }
  return { estado: "pagado", referencia: captura.id || "paypal" };
}

export async function verificarOrdenPaypal(
  cfg: ConfigPaypal,
  ref: string,
  esperado: { numero: string; totalCents: number; currency: string },
  f: FetchLike = fetch,
  opciones: { capturar?: boolean } = {},
): Promise<Verificacion> {
  const capturar = opciones.capturar !== false;
  let token: string;
  try {
    token = await tokenPaypal(cfg, f);
  } catch (err) {
    return { estado: "error", detalle: err instanceof Error ? err.message : "fallo de red" };
  }

  const ruta = `/v2/checkout/orders/${encodeURIComponent(ref)}`;
  const consulta = await llamarPaypal(cfg, token, "GET", ruta, null, f);
  if (!consulta.ok) {
    return { estado: "error", detalle: `PayPal: HTTP ${consulta.status} al consultar la orden.` };
  }
  const orden = consulta.json as OrdenPaypal;

  // La clienta aprobó pero nadie capturó todavía (p.ej. cerró la pestaña justo
  // al volver): capturar AHORA es lo que cobra de verdad. Con capturar:false
  // (pedidos ya cancelados) SOLO se mira: jamás se mueve dinero de un pedido
  // que Madeline canceló.
  if (orden.status === "APPROVED") {
    if (!capturar) return { estado: "pendiente" };
    const captura = await llamarPaypal(cfg, token, "POST", `${ruta}/capture`, {}, f, {
      // Idempotencia POR SESIÓN: si dos verificaciones corren a la vez sobre la
      // misma orden, PayPal deduplica. La ref va incluida para que el id nunca
      // se repita entre intentos distintos del mismo pedido (replicaría la
      // respuesta — quizá fallida — del intento viejo).
      "PayPal-Request-Id": `captura-${esperado.numero}-${ref}`,
      // Pedimos la representación completa para que la respuesta traiga los
      // importes con los que se verifica el cobro.
      Prefer: "return=representation",
    });
    if (captura.ok) return evaluarOrden(captura.json as OrdenPaypal, esperado);
    const yaCapturada = captura.json.details?.some((d) => d.issue === "ORDER_ALREADY_CAPTURED");
    if (!yaCapturada) {
      return { estado: "error", detalle: `PayPal: no se pudo capturar (HTTP ${captura.status}).` };
    }
    // Capturada por otra verificación en paralelo: releer y evaluar.
    const releida = await llamarPaypal(cfg, token, "GET", ruta, null, f);
    if (!releida.ok) return { estado: "error", detalle: "PayPal: no se pudo releer la orden capturada." };
    return evaluarOrden(releida.json as OrdenPaypal, esperado);
  }

  return evaluarOrden(orden, esperado);
}

export async function probarPaypal(
  cfg: ConfigPaypal,
  f: FetchLike = fetch,
): Promise<{ ok: boolean; detalle: string }> {
  try {
    await tokenPaypal(cfg, f);
    return { ok: true, detalle: cfg.entorno === "sandbox" ? "credenciales válidas (sandbox)" : "credenciales válidas" };
  } catch (err) {
    return { ok: false, detalle: err instanceof Error ? err.message : "fallo de red" };
  }
}
