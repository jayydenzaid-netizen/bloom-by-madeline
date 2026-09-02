import { headers } from "next/headers";
import { logActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { getTaxConfig } from "@/lib/shipping";
import {
  esMetodoOnline,
  ETIQUETA_PROVEEDOR,
  leerConfigPagos,
  metodosOnlineActivos,
  paypalConfigurado,
  squareConfigurado,
  stripeConfigurado,
  type ConfigPagos,
  type MetodoOnline,
} from "./config";
import { crearOrdenPaypal, verificarOrdenPaypal } from "./paypal";
import { anularLinkSquare, crearLinkSquare, verificarOrdenSquare } from "./square";
import { anularSesionStripe, crearSesionStripe, verificarSesionStripe } from "./stripe";
import type { DatosPago, Verificacion } from "./tipos";

export { esMetodoOnline, ETIQUETA_PROVEEDOR, leerConfigPagos, metodosOnlineActivos };
export type { MetodoOnline };

/**
 * Orquestación del pago online sobre un pedido YA creado.
 *
 * El pedido nace igual que siempre (createOrderFromCart: pending, stock
 * reservado, carrito vacío) y DESPUÉS se abre la sesión de cobro con los
 * importes congelados en la fila Order — nunca dentro de la transacción (una
 * llamada HTTP dentro de la tx la mantendría abierta segundos y se repetiría
 * con cada reintento de número).
 *
 * Marcar «pagado» solo ocurre aquí, tras preguntarle al proveedor por la
 * sesión con la llave secreta y comprobar que el importe CUADRA. La vuelta del
 * navegador jamás se cree por sí sola: cualquiera puede escribir esa URL.
 *
 * Contra el doble cobro: al reintentar, la sesión anterior se ANULA en el
 * proveedor (expire en Stripe, delete del link en Square; PayPal ya rechaza un
 * segundo cobro del mismo invoice_id). Y al confirmar un pago se echa un
 * vistazo al resto de intentos: si otro también aparece cobrado, queda escrito
 * en la bitácora para que Madeline reembolse.
 */

const MAX_INTENTOS = 8;

/**
 * Importe mínimo cobrable por proveedor, en centavos. Por debajo, la sesión ni
 * se intenta: Stripe rechaza menos de 50¢ y la página de Square menos de $1;
 * crearla solo produciría un error críptico con el pedido ya creado.
 */
const MINIMO_CENTS: Record<MetodoOnline, number> = {
  stripe: 50,
  paypal: 1,
  square: 100,
};

/** Mínimo cobrable online del método (para que la UI explique, no adivine). */
export function minimoOnlineCents(metodo: string): number {
  return esMetodoOnline(metodo) ? MINIMO_CENTS[metodo] : 0;
}

type IntentoPago = { p: MetodoOnline; ref: string; at: string; cancelRef?: string };

function leerIntentos(json: string): IntentoPago[] {
  try {
    const crudo = JSON.parse(json);
    if (!Array.isArray(crudo)) return [];
    return crudo.filter(
      (x): x is IntentoPago =>
        !!x && typeof x === "object" && esMetodoOnline((x as IntentoPago).p) && typeof (x as IntentoPago).ref === "string",
    );
  } catch {
    return [];
  }
}

/** Mismo sello de fecha que la bitácora del panel (separarNota lo reconoce). */
const selloFecha = new Intl.DateTimeFormat("es-US", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function anotarNota(notaActual: string, texto: string): string {
  const linea = `[${selloFecha.format(new Date())}] ${texto}`;
  const previo = (notaActual || "").trimEnd();
  return previo ? `${previo}\n${linea}` : linea;
}

/**
 * URL pública de la tienda para las vueltas de la pasarela. La del request
 * manda (siempre es el dominio por el que la clienta entró); el env var queda
 * de reserva para contextos sin request.
 */
async function baseTienda(): Promise<string> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) {
      const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
      return `${proto}://${host}`;
    }
  } catch {
    /* fuera de un request no hay headers(): cae al env var */
  }
  const env = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");
  return env.startsWith("http") ? env : "http://localhost:4590";
}

/* ────────────────────────────── anular ────────────────────────────── */

async function anularIntentos(cfg: ConfigPagos, intentos: IntentoPago[]): Promise<void> {
  for (const intento of intentos) {
    try {
      if (intento.p === "stripe" && stripeConfigurado(cfg.stripe)) {
        await anularSesionStripe(cfg.stripe, intento.cancelRef ?? intento.ref);
      } else if (intento.p === "square" && squareConfigurado(cfg.square) && intento.cancelRef) {
        await anularLinkSquare(cfg.square, intento.cancelRef);
      }
      // PayPal: nada que anular — invoice_id ya bloquea un segundo cobro, y la
      // captura solo la hace este servidor (nunca sobre pedidos cancelados).
    } catch {
      /* best-effort: anular es higiene, no puede tumbar el flujo */
    }
  }
}

/**
 * Anula en el proveedor TODAS las sesiones de cobro vivas del pedido. La llama
 * la cancelación del panel: un pedido cancelado con su link de pago aún abierto
 * es un cobro fantasma esperando a ocurrir.
 */
export async function anularSesionesPago(orderId: string): Promise<void> {
  try {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: { paymentAttemptsJson: true },
    });
    if (!order) return;
    const intentos = leerIntentos(order.paymentAttemptsJson);
    if (intentos.length === 0) return;
    const cfg = await leerConfigPagos();
    await anularIntentos(cfg, intentos);
  } catch (err) {
    console.error("[pagos] no se pudieron anular las sesiones del pedido:", err);
  }
}

/* ────────────────────────────── iniciar ────────────────────────────── */

export type InicioPago =
  | { ok: true; url: string }
  | { ok: false; error: string; codigo?: "minimo" };

/**
 * Crea (o recrea, en un reintento) la sesión de cobro del pedido y devuelve la
 * URL hosted a la que mandar a la clienta. No lanza: el checkout decide a dónde
 * redirigir según el resultado, y redirect() no puede vivir dentro de un try.
 */
export async function iniciarPagoOnline(orderId: string): Promise<InicioPago> {
  try {
    const order = await db.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) return { ok: false, error: "El pedido ya no existe." };
    if (order.paymentStatus !== "pending") {
      return { ok: false, error: "Este pedido ya no está pendiente de pago." };
    }
    const metodo = order.paymentMethod;
    if (!esMetodoOnline(metodo)) return { ok: false, error: "Este pedido no se paga online." };

    const cfg = await leerConfigPagos();
    if (!metodosOnlineActivos(cfg)[metodo]) {
      return { ok: false, error: "Ese método de pago no está disponible ahora mismo." };
    }

    // Total 0 (un cupón del 100 % con envío gratis): no hay nada que cobrar y
    // ninguna pasarela acepta una sesión de $0. El pedido queda pagado con su
    // nota — fingir un cobro o dejarlo pendiente para siempre sería peor.
    if (order.totalCents === 0) {
      await marcarPagadoSinCobro(order.id, order.number);
      return { ok: true, url: `/pedido/${encodeURIComponent(order.number)}?pago=confirmado` };
    }
    if (order.totalCents < MINIMO_CENTS[metodo]) {
      return {
        ok: false,
        codigo: "minimo",
        error: "El importe es demasiado pequeño para cobrarlo online.",
      };
    }

    const [settings, taxCfg, base] = await Promise.all([getSettings(), getTaxConfig(), baseTienda()]);
    const numero = encodeURIComponent(order.number);
    const datos: DatosPago = {
      numero: order.number,
      email: order.email,
      currency: (settings.currency || "USD").toUpperCase(),
      // Las líneas salen de OrderItem, congeladas al crear el pedido: si el
      // catálogo cambió desde entonces, se cobra lo que se reservó.
      lineas: order.items.map((i) => ({
        titulo: i.variantTitle ? `${i.title} · ${i.variantTitle}` : i.title,
        cantidad: i.quantity,
        precioCents: i.priceCents,
      })),
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      taxCents: order.taxCents,
      discountCents: order.discountCents,
      totalCents: order.totalCents,
      taxLabel: taxCfg.etiqueta || "Impuesto",
      urlRetorno: `${base}/api/pagos/retorno?pedido=${numero}`,
      urlCancelacion: `${base}/pedido/${numero}?pago=cancelado`,
    };

    // Antes de abrir una sesión nueva se ANULAN las anteriores: dos páginas de
    // pago vivas para el mismo pedido son un doble cobro esperando a ocurrir.
    // (Si alguna ya se pagó, anularla falla en el proveedor y la verificación
    // la encontrará igual: los refs se conservan.)
    const previos = leerIntentos(order.paymentAttemptsJson);
    await anularIntentos(cfg, previos);

    const sesion =
      metodo === "stripe"
        ? await crearSesionStripe(cfg.stripe, datos)
        : metodo === "paypal"
          ? await crearOrdenPaypal(cfg.paypal, datos)
          : await crearLinkSquare(cfg.square, datos);

    const nuevo: IntentoPago = {
      p: metodo,
      ref: sesion.ref,
      at: new Date().toISOString(),
      ...(sesion.cancelRef ? { cancelRef: sesion.cancelRef } : {}),
    };

    // Guardado con candado optimista: dos reintentos a la vez no deben pisarse
    // la lista (perder un ref = un pago que la verificación jamás encontraría).
    for (let intento = 0; intento < 2; intento++) {
      const fila = await db.order.findUnique({
        where: { id: order.id },
        select: { paymentAttemptsJson: true },
      });
      const base_ = fila?.paymentAttemptsJson ?? "[]";
      const lista = [nuevo, ...leerIntentos(base_).filter((i) => i.ref !== nuevo.ref)].slice(0, MAX_INTENTOS);
      const escrito = await db.order.updateMany({
        where: { id: order.id, paymentAttemptsJson: base_ },
        data: {
          paymentRef: sesion.ref,
          paymentUrl: sesion.url,
          paymentAttemptsJson: JSON.stringify(lista),
          ...(metodo === "stripe" ? { stripeSessionId: sesion.ref } : {}),
        },
      });
      if (escrito.count === 1) break;
    }

    return { ok: true, url: sesion.url };
  } catch (err) {
    console.error("[pagos] no se pudo iniciar el pago:", err);
    return { ok: false, error: "No pudimos conectar con la pasarela de pago." };
  }
}

/* ────────────────────────────── verificar ────────────────────────────── */

export type ResultadoPago = {
  estado: "pagado" | "pendiente" | "sin-verificar" | "revisar";
  detalle?: string;
};

/**
 * Freno por pedido para /api/pagos/retorno y las páginas: cualquiera puede
 * abrirlas con un número adivinable, y cada verificación son llamadas reales a
 * las APIs del proveedor. Por instancia serverless (best-effort): suficiente
 * para que un bucle de curl no se convierta en un bombardeo a Stripe.
 */
const ultimaVerificacion = new Map<string, number>();
const FRENO_MS = 5_000;

async function consultarIntento(
  cfg: ConfigPagos,
  intento: IntentoPago,
  esperado: { numero: string; totalCents: number; currency: string },
  opciones: { capturar: boolean },
): Promise<Verificacion | null> {
  if (intento.p === "stripe") {
    if (!stripeConfigurado(cfg.stripe)) return null;
    return verificarSesionStripe(cfg.stripe, intento.ref, esperado);
  }
  if (intento.p === "paypal") {
    if (!paypalConfigurado(cfg.paypal)) return null;
    return verificarOrdenPaypal(cfg.paypal, intento.ref, esperado, fetch, { capturar: opciones.capturar });
  }
  if (!squareConfigurado(cfg.square)) return null;
  return verificarOrdenSquare(cfg.square, intento.ref, esperado);
}

/**
 * Pregunta al proveedor por TODOS los intentos de cobro del pedido y, si alguno
 * está pagado con el importe correcto, lo marca pagado (una sola vez, aunque la
 * verificación corra varias veces en paralelo). Nunca lanza.
 *
 * "revisar" = hay un cobro que no debería existir tal cual: no cuadra el
 * importe, o cayó sobre un pedido ya cancelado. Eso no se marca solo: queda en
 * la bitácora con el detalle y lo decide Madeline.
 */
export async function verificarPagoPedido(orderId: string): Promise<ResultadoPago> {
  try {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        number: true,
        paymentStatus: true,
        paymentMethod: true,
        totalCents: true,
        paymentAttemptsJson: true,
      },
    });
    if (!order) return { estado: "sin-verificar", detalle: "El pedido no existe." };
    if (order.paymentStatus === "paid") return { estado: "pagado" };
    if (!esMetodoOnline(order.paymentMethod)) return { estado: "sin-verificar" };
    const intentos = leerIntentos(order.paymentAttemptsJson);
    if (intentos.length === 0) return { estado: "sin-verificar" };

    // Un pedido cancelado también se revisa (sin capturar nada): si una clienta
    // pagó una sesión vieja DESPUÉS de la cancelación, ese dinero existe y
    // alguien tiene que enterarse — pero el pedido no revive solo.
    const cancelado = order.paymentStatus !== "pending";

    const ahora = Date.now();
    const previa = ultimaVerificacion.get(order.id) ?? 0;
    if (ahora - previa < FRENO_MS) return { estado: cancelado ? "sin-verificar" : "pendiente" };
    ultimaVerificacion.set(order.id, ahora);

    const [cfg, settings] = await Promise.all([leerConfigPagos(), getSettings()]);
    const esperado = {
      numero: order.number,
      totalCents: order.totalCents,
      currency: (settings.currency || "USD").toUpperCase(),
    };

    let sospecha: string | null = null;
    for (const [indice, intento] of intentos.entries()) {
      const v = await consultarIntento(cfg, intento, esperado, { capturar: !cancelado }).catch(() => null);
      if (!v) continue;

      if (v.estado === "pagado") {
        if (cancelado) {
          const aviso = `Cobro recibido vía ${ETIQUETA_PROVEEDOR[intento.p]} (${v.referencia}) sobre un pedido CANCELADO: hay que reembolsarlo.`;
          await anotarAviso(order.id, order.number, v.referencia, aviso);
          return { estado: "revisar", detalle: aviso };
        }
        await marcarPagadoVerificado(order.id, order.number, intento.p, v.referencia);
        // Vistazo único al resto de intentos: si otra sesión también aparece
        // cobrada (pestaña vieja pagada dos veces), Madeline debe saberlo.
        for (const otro of intentos.slice(indice + 1)) {
          const v2 = await consultarIntento(cfg, otro, esperado, { capturar: false }).catch(() => null);
          if (v2?.estado === "pagado" && v2.referencia !== v.referencia) {
            await anotarAviso(
              order.id,
              order.number,
              v2.referencia,
              `Posible COBRO DUPLICADO vía ${ETIQUETA_PROVEEDOR[otro.p]} (${v2.referencia}): revisar y reembolsar uno.`,
            );
          }
        }
        return { estado: "pagado" };
      }
      if (v.estado === "no-coincide") sospecha = v.detalle;
    }

    if (sospecha) {
      await anotarAviso(order.id, order.number, sospecha, `Revisar cobro: ${sospecha}`);
      return { estado: "revisar", detalle: sospecha };
    }
    return { estado: cancelado ? "sin-verificar" : "pendiente" };
  } catch (err) {
    console.error("[pagos] fallo al verificar el pago:", err);
    return { estado: "pendiente" };
  }
}

async function marcarPagadoVerificado(
  orderId: string,
  numero: string,
  proveedor: MetodoOnline,
  referencia: string,
): Promise<void> {
  const etiqueta = ETIQUETA_PROVEEDOR[proveedor];
  let marcado = false;
  await db.$transaction(async (tx) => {
    const fila = await tx.order.findUnique({
      where: { id: orderId },
      select: { note: true, paymentStatus: true, paidAt: true },
    });
    // Idempotencia: la verificación puede correr a la vez desde la vuelta de la
    // pasarela, la página del pedido y el panel. Solo el primero escribe. Y si
    // Madeline lo devolvió a pendiente y se re-verifica, la nota con la misma
    // referencia no se duplica.
    if (!fila || fila.paymentStatus !== "pending") return;
    const linea = `Pago confirmado vía ${etiqueta} (${referencia}).`;
    await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: "paid",
        paidAt: fila.paidAt ?? new Date(),
        ...(fila.note.includes(referencia) ? {} : { note: anotarNota(fila.note, linea) }),
      },
    });
    marcado = true;
  });
  if (marcado) {
    // Sin userId: lo confirmó la pasarela, no una cuenta del panel.
    await logActivity({
      userId: null,
      userEmail: "",
      action: "update",
      entityType: "order",
      entityId: orderId,
      summary: `Pago del pedido ${numero} confirmado vía ${etiqueta}.`,
    });
  }
}

/** Marca pagado un pedido de total $0 (cupón del 100 %): no hay nada que cobrar. */
async function marcarPagadoSinCobro(orderId: string, numero: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const fila = await tx.order.findUnique({
      where: { id: orderId },
      select: { note: true, paymentStatus: true, paidAt: true },
    });
    if (!fila || fila.paymentStatus !== "pending") return;
    await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: "paid",
        paidAt: fila.paidAt ?? new Date(),
        note: anotarNota(fila.note, "Total $0.00 — no requería cobro."),
      },
    });
  });
  await logActivity({
    userId: null,
    userEmail: "",
    action: "update",
    entityType: "order",
    entityId: orderId,
    summary: `Pedido ${numero} con total $0.00: marcado pagado sin cobro.`,
  });
}

/** Deja un aviso en la bitácora UNA vez (no en cada verificación) + actividad. */
async function anotarAviso(orderId: string, numero: string, marcador: string, texto: string): Promise<void> {
  let escrito = false;
  await db.$transaction(async (tx) => {
    const fila = await tx.order.findUnique({ where: { id: orderId }, select: { note: true } });
    if (!fila || fila.note.includes(marcador)) return;
    await tx.order.update({
      where: { id: orderId },
      data: { note: anotarNota(fila.note, `⚠ ${texto}`) },
    });
    escrito = true;
  });
  if (escrito) {
    await logActivity({
      userId: null,
      userEmail: "",
      action: "update",
      entityType: "order",
      entityId: orderId,
      summary: `⚠ Pedido ${numero}: ${texto}`.slice(0, 200),
    });
  }
}
