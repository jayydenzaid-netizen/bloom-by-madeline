import test from "node:test";
import assert from "node:assert/strict";
import { cifrar, descifrar } from "@/lib/payments/cifrado";
import {
  CONFIG_PAGOS_VACIA,
  metodosOnlineActivos,
  paypalConfigurado,
  squareConfigurado,
  stripeConfigurado,
} from "@/lib/payments/config";
import { minimoOnlineCents } from "@/lib/payments";
import { armarOrdenPaypal, verificarOrdenPaypal } from "@/lib/payments/paypal";
import { armarLinkSquare, verificarOrdenSquare } from "@/lib/payments/square";
import { armarParamsSesionStripe, verificarSesionStripe } from "@/lib/payments/stripe";
import { centavosADecimales, type DatosPago, type FetchLike } from "@/lib/payments/tipos";

/**
 * Tests de la capa de pagos. Ni base de datos ni red: las funciones que arman
 * las peticiones son puras, y las que llaman a la API reciben un fetch
 * inyectable que aquí se sustituye por stubs con respuestas fijas.
 *
 * Lo que de verdad protege este archivo es la ARITMÉTICA: que lo que se manda
 * a cada pasarela cuadre exacto con los importes congelados del pedido, y que
 * un cobro con importe distinto NUNCA se dé por bueno.
 */

/* ─────────────────────────── datos de ejemplo ─────────────────────────── */

function pedido(cambios: Partial<DatosPago> = {}): DatosPago {
  // subtotal 6000 − descuento 1000 = 5000; + envío 695 + impuesto 325 = 6020.
  return {
    numero: "BLM-1042",
    email: "clienta@example.com",
    currency: "USD",
    lineas: [
      { titulo: "Vestido coral · M", cantidad: 2, precioCents: 2500 },
      { titulo: "Blusa corazón · S", cantidad: 1, precioCents: 1000 },
    ],
    subtotalCents: 6000,
    discountCents: 1000,
    shippingCents: 695,
    taxCents: 325,
    totalCents: 6020,
    taxLabel: "Impuesto OH 6.5 %",
    urlRetorno: "https://tienda.test/api/pagos/retorno?pedido=BLM-1042",
    urlCancelacion: "https://tienda.test/pedido/BLM-1042?pago=cancelado",
    ...cambios,
  };
}

/** Stub de fetch: responde según una lista de reglas (método + trozo de URL). */
function fetchFalso(
  reglas: { metodo?: string; url: string; status?: number; cuerpo: unknown }[],
): FetchLike {
  return (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = String(entrada);
    const metodo = init?.method ?? "GET";
    const regla = reglas.find((r) => url.includes(r.url) && (!r.metodo || r.metodo === metodo));
    if (!regla) throw new Error(`fetchFalso: sin regla para ${metodo} ${url}`);
    return {
      ok: (regla.status ?? 200) < 400,
      status: regla.status ?? 200,
      json: async () => regla.cuerpo,
    } as Response;
  }) as FetchLike;
}

/* ────────────────────────────── cifrado ────────────────────────────── */

test("cifrar/descifrar: ida y vuelta y rechazo de valores manipulados", () => {
  const secreto = JSON.stringify({ secretKey: "sk_live_abc123" });
  const guardado = cifrar(secreto);

  assert.notEqual(guardado, secreto, "lo guardado no puede ser el texto plano");
  assert.ok(!guardado.includes("sk_live"), "la llave no puede asomar en lo cifrado");
  assert.equal(descifrar(guardado), secreto);

  // Manipular un carácter del cuerpo rompe la autenticación GCM → null, no basura.
  // El carácter nuevo se elige mirando el QUE HAY, no el último de la cadena: al
  // mirar el último, una de cada tantas veces se «sustituía» una A por otra A, el
  // texto salía idéntico, descifraba bien y la prueba fallaba sin motivo. Un test
  // que falla al azar acaba bloqueando un despliegue de verdad.
  const i = guardado.length - 6;
  const roto = guardado.slice(0, i) + (guardado[i] === "A" ? "B" : "A") + guardado.slice(i + 1);
  assert.equal(descifrar(roto), null);
  assert.equal(descifrar("cualquier cosa"), null);
  assert.equal(descifrar(""), null);
});

test("centavosADecimales: enteros exactos, sin flotantes raros", () => {
  assert.equal(centavosADecimales(6020), "60.20");
  assert.equal(centavosADecimales(5), "0.05");
  assert.equal(centavosADecimales(0), "0.00");
  // El clásico que rompe con float: 0.1 + 0.2.
  assert.equal(centavosADecimales(30), "0.30");
});

/* ─────────────────────────── configuración ─────────────────────────── */

test("metodosOnlineActivos: activo sin credenciales NO ofrece el método", () => {
  const cfg = structuredClone(CONFIG_PAGOS_VACIA);
  cfg.stripe.activo = true; // encendido pero sin llave
  cfg.paypal = { activo: true, clientId: "A".repeat(20), clientSecret: "B".repeat(20), entorno: "live" };
  cfg.square = { activo: false, accessToken: "EAAA" + "x".repeat(20), locationId: "L123456", entorno: "production" };

  const activos = metodosOnlineActivos(cfg);
  assert.equal(activos.stripe, false, "sin secretKey no hay Stripe aunque esté marcado");
  assert.equal(activos.paypal, true);
  assert.equal(activos.square, false, "configurado pero apagado sigue apagado");
});

test("configurado por proveedor: formatos mínimos", () => {
  assert.ok(stripeConfigurado({ activo: false, secretKey: "sk_live_x" }));
  assert.ok(stripeConfigurado({ activo: false, secretKey: "rk_live_x" }));
  assert.ok(!stripeConfigurado({ activo: false, secretKey: "pk_live_x" }), "una publishable no cobra");
  assert.ok(!paypalConfigurado({ activo: true, clientId: "corto", clientSecret: "", entorno: "live" }));
  assert.ok(!squareConfigurado({ activo: true, accessToken: "EAAAtoken1234", locationId: "", entorno: "production" }));
});

/* ─────────────────────────────── Stripe ─────────────────────────────── */

test("Stripe: las líneas de la sesión suman el total del pedido", () => {
  const datos = pedido({ discountCents: 0, totalCents: 7020 }); // sin descuento: 6000+695+325
  const p = armarParamsSesionStripe(datos);

  let suma = 0;
  for (let i = 0; ; i++) {
    const unit = p.get(`line_items[${i}][price_data][unit_amount]`);
    if (unit === null) break;
    suma += Number(unit) * Number(p.get(`line_items[${i}][quantity]`));
  }
  assert.equal(suma, datos.totalCents, "productos + envío + impuesto = total");
  assert.equal(p.get("client_reference_id"), "BLM-1042");
  assert.ok(p.get("success_url")?.includes("sid={CHECKOUT_SESSION_ID}"), "Stripe sustituye el marcador literal");
  assert.equal(p.get("mode"), "payment");
});

test("Stripe: verificación acepta el cobro exacto y rechaza el descuadrado", async () => {
  const esperado = { numero: "BLM-1042", totalCents: 6020, currency: "USD" };
  const cfg = { activo: true, secretKey: "sk_test_x" };

  const sesion = (extra: Record<string, unknown>) => ({
    id: "cs_123",
    payment_status: "paid",
    amount_total: 6020,
    currency: "usd",
    client_reference_id: "BLM-1042",
    payment_intent: "pi_999",
    ...extra,
  });

  const bien = await verificarSesionStripe(cfg, "cs_123", esperado, fetchFalso([
    { url: "/v1/checkout/sessions/cs_123", cuerpo: sesion({}) },
  ]));
  assert.deepEqual(bien, { estado: "pagado", referencia: "pi_999" });

  const sinPagar = await verificarSesionStripe(cfg, "cs_123", esperado, fetchFalso([
    { url: "/v1/checkout/sessions/cs_123", cuerpo: sesion({ payment_status: "unpaid" }) },
  ]));
  assert.equal(sinPagar.estado, "pendiente");

  const descuadrado = await verificarSesionStripe(cfg, "cs_123", esperado, fetchFalso([
    { url: "/v1/checkout/sessions/cs_123", cuerpo: sesion({ amount_total: 100 }) },
  ]));
  assert.equal(descuadrado.estado, "no-coincide", "un cobro de otro importe no marca pagado");

  const otroPedido = await verificarSesionStripe(cfg, "cs_123", esperado, fetchFalso([
    { url: "/v1/checkout/sessions/cs_123", cuerpo: sesion({ client_reference_id: "BLM-9999" }) },
  ]));
  assert.equal(otroPedido.estado, "no-coincide");
});

/* ─────────────────────────────── PayPal ─────────────────────────────── */

test("PayPal: el breakdown cuadra por construcción", () => {
  const datos = pedido();
  const orden = armarOrdenPaypal(datos) as {
    purchase_units: {
      invoice_id: string;
      amount: {
        value: string;
        breakdown: Record<string, { value: string }>;
      };
      items: { unit_amount: { value: string }; quantity: string }[];
    }[];
    application_context: { shipping_preference: string };
  };
  const unidad = orden.purchase_units[0];
  const b = unidad.amount.breakdown;

  // item_total + shipping + tax_total − discount = total (la regla dura de PayPal).
  const centavos = (v: string) => Math.round(Number(v) * 100);
  const total =
    centavos(b.item_total.value) + centavos(b.shipping.value) + centavos(b.tax_total.value) - centavos(b.discount.value);
  assert.equal(total, datos.totalCents);
  assert.equal(unidad.amount.value, "60.20");

  // Y los items suman el item_total exacto.
  const sumaItems = unidad.items.reduce(
    (s, it) => s + centavos(it.unit_amount.value) * Number(it.quantity),
    0,
  );
  assert.equal(sumaItems, centavos(b.item_total.value));

  assert.equal(unidad.invoice_id, "BLM-1042", "el invoice_id bloquea cobros duplicados del mismo pedido");
  assert.equal(orden.application_context.shipping_preference, "NO_SHIPPING");
});

test("PayPal: una orden APPROVED se captura y el cobro completado marca pagado", async () => {
  const cfg = { activo: true, clientId: "A".repeat(20), clientSecret: "B".repeat(20), entorno: "sandbox" as const };
  const esperado = { numero: "BLM-1042", totalCents: 6020, currency: "USD" };

  const capturada = {
    id: "PPORDER",
    status: "COMPLETED",
    purchase_units: [
      {
        reference_id: "BLM-1042",
        amount: { value: "60.20", currency_code: "USD" },
        payments: { captures: [{ id: "CAP123", status: "COMPLETED" }] },
      },
    ],
  };

  const f = fetchFalso([
    { metodo: "POST", url: "/v1/oauth2/token", cuerpo: { access_token: "tok" } },
    { metodo: "POST", url: "/v2/checkout/orders/PPORDER/capture", cuerpo: capturada },
    { metodo: "GET", url: "/v2/checkout/orders/PPORDER", cuerpo: { id: "PPORDER", status: "APPROVED" } },
  ]);

  const v = await verificarOrdenPaypal(cfg, "PPORDER", esperado, f);
  assert.deepEqual(v, { estado: "pagado", referencia: "CAP123" });

  // Un eCheck deja la captura PENDING: el dinero aún no está, no se marca nada.
  const pendiente = await verificarOrdenPaypal(cfg, "PPORDER", esperado, fetchFalso([
    { metodo: "POST", url: "/v1/oauth2/token", cuerpo: { access_token: "tok" } },
    {
      metodo: "GET",
      url: "/v2/checkout/orders/PPORDER",
      cuerpo: {
        ...capturada,
        purchase_units: [
          { ...capturada.purchase_units[0], payments: { captures: [{ id: "CAP123", status: "PENDING" }] } },
        ],
      },
    },
  ]));
  assert.equal(pendiente.estado, "pendiente");

  // Con capturar:false (pedidos cancelados) una orden APPROVED se queda como
  // está: mirar sí, mover dinero jamás.
  const sinCapturar = await verificarOrdenPaypal(cfg, "PPORDER", esperado, fetchFalso([
    { metodo: "POST", url: "/v1/oauth2/token", cuerpo: { access_token: "tok" } },
    { metodo: "GET", url: "/v2/checkout/orders/PPORDER", cuerpo: { id: "PPORDER", status: "APPROVED" } },
  ]), { capturar: false });
  assert.equal(sinCapturar.estado, "pendiente");
});

test("PayPal: la respuesta de captura SIN amount en la unidad verifica por el amount de la captura", async () => {
  // El caso que rompía todo: PayPal a veces devuelve la captura sin el amount
  // de la purchase_unit — el importe fiable es el de la propia captura.
  const cfg = { activo: true, clientId: "A".repeat(20), clientSecret: "B".repeat(20), entorno: "live" as const };
  const esperado = { numero: "BLM-1042", totalCents: 6020, currency: "USD" };

  const v = await verificarOrdenPaypal(cfg, "PPORDER", esperado, fetchFalso([
    { metodo: "POST", url: "/v1/oauth2/token", cuerpo: { access_token: "tok" } },
    {
      metodo: "GET",
      url: "/v2/checkout/orders/PPORDER",
      cuerpo: {
        id: "PPORDER",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "BLM-1042",
            // SIN amount aquí, a propósito.
            payments: {
              captures: [{ id: "CAP77", status: "COMPLETED", amount: { value: "60.20", currency_code: "USD" } }],
            },
          },
        ],
      },
    },
  ]));
  assert.deepEqual(v, { estado: "pagado", referencia: "CAP77" });
});

/* ─────────────────────────── mínimos por pasarela ─────────────────────────── */

test("minimoOnlineCents: cada pasarela tiene su suelo y los manuales no tienen", () => {
  assert.equal(minimoOnlineCents("stripe"), 50);
  assert.equal(minimoOnlineCents("square"), 100);
  assert.equal(minimoOnlineCents("paypal"), 1);
  assert.equal(minimoOnlineCents("dm"), 0);
  assert.equal(minimoOnlineCents("pickup"), 0);
});

/* ─────────────────────────────── Square ─────────────────────────────── */

test("Square: las líneas más el descuento cuadran con el total del pedido", () => {
  const datos = pedido();
  const cuerpo = armarLinkSquare(datos, "L123", "idem-1") as {
    order: {
      reference_id: string;
      line_items: { base_price_money: { amount: number }; quantity: string }[];
      discounts?: { amount_money: { amount: number }; type: string }[];
    };
    checkout_options: { redirect_url: string; ask_for_shipping_address: boolean };
  };

  const sumaLineas = cuerpo.order.line_items.reduce(
    (s, l) => s + l.base_price_money.amount * Number(l.quantity),
    0,
  );
  const descuento = cuerpo.order.discounts?.[0]?.amount_money.amount ?? 0;
  assert.equal(sumaLineas - descuento, datos.totalCents);
  assert.equal(cuerpo.order.discounts?.[0]?.type, "FIXED_AMOUNT", "importe exacto, nunca porcentaje recalculado");
  assert.equal(cuerpo.order.reference_id, "BLM-1042");
  assert.equal(cuerpo.checkout_options.ask_for_shipping_address, false);
});

test("Square: pagado solo con tenders que cubren el total exacto", async () => {
  const cfg = { activo: true, accessToken: "EAAA" + "x".repeat(20), locationId: "L123", entorno: "sandbox" as const };
  const esperado = { numero: "BLM-1042", totalCents: 6020, currency: "USD" };

  const orden = (extra: Record<string, unknown>) => ({
    order: {
      reference_id: "BLM-1042",
      state: "OPEN",
      total_money: { amount: 6020, currency: "USD" },
      net_amount_due_money: { amount: 0 },
      tenders: [{ id: "TENDER1", amount_money: { amount: 6020 } }],
      ...extra,
    },
  });

  const bien = await verificarOrdenSquare(cfg, "SQORDER", esperado, fetchFalso([
    { url: "/v2/orders/SQORDER", cuerpo: orden({}) },
  ]));
  assert.deepEqual(bien, { estado: "pagado", referencia: "TENDER1" });

  const sinPagar = await verificarOrdenSquare(cfg, "SQORDER", esperado, fetchFalso([
    { url: "/v2/orders/SQORDER", cuerpo: orden({ tenders: [], net_amount_due_money: { amount: 6020 } }) },
  ]));
  assert.equal(sinPagar.estado, "pendiente");

  const descuadrado = await verificarOrdenSquare(cfg, "SQORDER", esperado, fetchFalso([
    { url: "/v2/orders/SQORDER", cuerpo: orden({ total_money: { amount: 100, currency: "USD" } }) },
  ]));
  assert.equal(descuadrado.estado, "no-coincide");
});
