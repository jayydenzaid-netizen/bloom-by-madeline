"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { readCartToken } from "@/lib/cart";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import {
  cargarZonas,
  getTaxConfig,
  type AjustesEnvio,
  type Destino,
} from "@/lib/shipping";
import {
  calcularTotales,
  canViewOrder,
  createOrderFromCart,
  emailMatchesOrder,
  grantOrderAccess,
  normalizeOrderNumber,
  type LineaCalculo,
  type OrderPaymentMethod,
} from "@/lib/orders";
import {
  esMetodoOnline,
  iniciarPagoOnline,
  leerConfigPagos,
  metodosOnlineActivos,
} from "@/lib/payments";

/**
 * Server Actions del checkout.
 *
 * Nada de lo que llega aquí se cree: el método de pago se contrasta con los ajustes
 * de la tienda y los importes se recalculan en `createOrderFromCart` leyendo la BD.
 * Del formulario solo se aceptan datos de contacto y de envío.
 */

export type CheckoutField =
  | "name"
  | "email"
  | "phone"
  | "line1"
  | "line2"
  | "city"
  | "state"
  | "zip"
  | "note"
  | "paymentMethod"
  | "discountCode";

export type CheckoutState = {
  /** Error general (carrito vacío, método no disponible, fallo al guardar). */
  formError?: string;
  /** Mensajes por campo, para pintarlos al lado del input. */
  fieldErrors: Partial<Record<CheckoutField, string>>;
  /** Lo que escribió: si algo falla, no se le borra el formulario. */
  values: Record<CheckoutField, string>;
};

/**
 * Un fichero "use server" solo puede exportar funciones asíncronas, así que el estado
 * inicial del formulario no se puede compartir desde aquí: vive en CheckoutForm.tsx.
 */
const ESTADO_VACIO: CheckoutState = {
  fieldErrors: {},
  values: {
    name: "",
    email: "",
    phone: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    zip: "",
    note: "",
    paymentMethod: "",
    discountCode: "",
  },
};

const CAMPOS: CheckoutField[] = [
  "name",
  "email",
  "phone",
  "line1",
  "line2",
  "city",
  "state",
  "zip",
  "note",
  "paymentMethod",
  "discountCode",
];

function readValues(formData: FormData): Record<CheckoutField, string> {
  const values = { ...ESTADO_VACIO.values };
  for (const campo of CAMPOS) {
    const raw = formData.get(campo);
    values[campo] = typeof raw === "string" ? raw : "";
  }
  return values;
}

/**
 * Esquema de validación. El envío solo se exige cuando hay envío: en "recoger en la
 * boutique" pedir una dirección es fricción por gusto.
 */
const checkoutSchema = z
  .object({
    name: z.string().trim().min(2, "Escribe tu nombre completo.").max(80, "Nombre demasiado largo."),
    email: z.string().trim().toLowerCase().email("Ese correo no parece válido."),
    phone: z
      .string()
      .trim()
      .max(30, "Teléfono demasiado largo.")
      .refine(
        (v) => v === "" || v.replace(/\D/g, "").length >= 7,
        "Ese teléfono parece incompleto. Puedes dejarlo vacío.",
      ),
    line1: z.string().trim().max(120, "Dirección demasiado larga."),
    line2: z.string().trim().max(120, "Dirección demasiado larga."),
    city: z.string().trim().max(60, "Ciudad demasiado larga."),
    state: z.string().trim().max(40, "Estado demasiado largo."),
    zip: z.string().trim().max(12, "Código postal demasiado largo."),
    note: z.string().trim().max(500, "La nota es demasiado larga."),
    paymentMethod: z.enum(["dm", "pickup", "stripe", "paypal", "square"], {
      errorMap: () => ({ message: "Elige cómo quieres pagar." }),
    }),
    // El código es opcional; su validez la decide `validateDiscount` en el pedido.
    discountCode: z.string().trim().max(40, "El código es demasiado largo."),
  })
  .superRefine((data, ctx) => {
    if (data.paymentMethod === "pickup") return;

    if (data.line1.length < 4) {
      ctx.addIssue({ code: "custom", path: ["line1"], message: "Escribe tu dirección." });
    }
    if (data.city.length < 2) {
      ctx.addIssue({ code: "custom", path: ["city"], message: "Escribe tu ciudad." });
    }
    if (data.state.length < 2) {
      ctx.addIssue({ code: "custom", path: ["state"], message: "Escribe tu estado (ej. OH)." });
    }
    if (!/^\d{5}(-\d{4})?$/.test(data.zip)) {
      ctx.addIssue({ code: "custom", path: ["zip"], message: "El ZIP son 5 dígitos (ej. 45011)." });
    }
  });

export async function submitCheckout(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const values = readValues(formData);

  const parsed = checkoutSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<CheckoutField, string>> = {};
    for (const issue of parsed.error.issues) {
      const campo = issue.path[0] as CheckoutField | undefined;
      if (campo && !fieldErrors[campo]) fieldErrors[campo] = issue.message;
    }
    return { fieldErrors, values, formError: "Revisa los datos marcados." };
  }

  const data = parsed.data;
  const settings = await getSettings();

  // El método de pago se comprueba contra los ajustes y las pasarelas REALMENTE
  // configuradas: que el <input> exista en el HTML no significa que Madeline lo
  // tenga activo, y un toggle encendido sin credenciales tampoco cobra nada.
  const online = metodosOnlineActivos(await leerConfigPagos());
  const habilitado: Record<OrderPaymentMethod, boolean> = {
    dm: settings.payDm,
    pickup: settings.payPickup,
    stripe: online.stripe,
    paypal: online.paypal,
    square: online.square,
    cash: false,
  };
  if (!habilitado[data.paymentMethod]) {
    return {
      fieldErrors: { paymentMethod: "Ese método de pago no está disponible ahora mismo." },
      values,
      formError: "Elige otra forma de pago.",
    };
  }

  const cartToken = await readCartToken();
  const result = await createOrderFromCart(cartToken, {
    name: data.name,
    email: data.email,
    phone: data.phone,
    line1: data.line1,
    line2: data.line2,
    city: data.city,
    state: data.state,
    zip: data.zip,
    country: "US",
    note: data.note,
    paymentMethod: data.paymentMethod,
    discountCode: data.discountCode,
  });

  if (!result.ok) {
    // Si el fallo es del código (y ella escribió uno), se marca junto al campo del
    // código para que sepa qué corregir, en vez de un error general despistante.
    if (data.discountCode && !result.changed) {
      return {
        fieldErrors: { discountCode: result.error },
        values,
        formError: "Revisa el código de descuento.",
      };
    }
    return { fieldErrors: {}, values, formError: result.error };
  }

  // La compradora acaba de crear el pedido: se le da la llave de su confirmación.
  await grantOrderAccess(result.number);
  // El carrito quedó vacío dentro de la transacción; el badge del nav vive en el layout.
  revalidatePath("/", "layout");

  /*
   * PAGO ONLINE (Stripe / PayPal / Square): el pedido ya existe como «pendiente»
   * con el stock reservado; ahora se abre la sesión de cobro hosted con los
   * importes congelados en la fila Order — nunca con precios del navegador — y
   * se manda a la clienta a la página segura del proveedor. Si la pasarela no
   * responde, el pedido NO se pierde: aterriza en su confirmación con un aviso
   * y el botón «Pagar ahora» para reintentar.
   *
   * «Pagado» solo lo pone la verificación server-side (lib/payments), jamás la
   * vuelta del navegador: esa URL la puede escribir cualquiera.
   */
  if (esMetodoOnline(data.paymentMethod)) {
    const pago = await iniciarPagoOnline(result.orderId);
    // Fuera de cualquier try: redirect() funciona lanzando y un catch se lo tragaría.
    if (pago.ok) redirect(pago.url);
    redirect(`/pedido/${result.number}?pago=${pago.codigo === "minimo" ? "minimo" : "sin-conexion"}`);
  }

  redirect(`/pedido/${result.number}`);
}

/**
 * Reintenta el pago de un pedido pendiente (botón «Pagar ahora» de la página
 * del pedido). Crea una sesión NUEVA: las de Stripe y PayPal caducan, y aquí
 * ya no hay carrito que rearmar — el pedido guarda las líneas congeladas.
 * Solo con la llave del pedido (cookie HMAC): el número solo es adivinable.
 */
export async function reintentarPago(formData: FormData): Promise<void> {
  const number = normalizeOrderNumber(String(formData.get("number") ?? ""));
  if (!number) redirect("/tienda");
  if (!(await canViewOrder(number))) redirect(`/pedido/${encodeURIComponent(number)}`);

  const order = await db.order.findUnique({
    where: { number },
    select: { id: true, paymentStatus: true, paymentMethod: true },
  });
  if (!order || order.paymentStatus !== "pending" || !esMetodoOnline(order.paymentMethod)) {
    redirect(`/pedido/${encodeURIComponent(number)}`);
  }

  const pago = await iniciarPagoOnline(order.id);
  if (pago.ok) redirect(pago.url);
  redirect(
    `/pedido/${encodeURIComponent(number)}?pago=${pago.codigo === "minimo" ? "minimo" : "sin-conexion"}`,
  );
}

/* ───────────────────────── cotización en vivo ───────────────────────── */

/** Lo que el resumen del checkout necesita para pintarse sin sorpresas al pagar. */
export type CotizacionCheckout = {
  subtotalCents: number;
  discountCents: number;
  discountLabel: string | null;
  discountError: string | null;
  freeShipping: boolean;
  shippingCents: number;
  taxCents: number;
  taxLabel: string;
  totalCents: number;
};

/**
 * Recalcula el desglose (descuento, envío por zona, impuesto) con los datos que
 * la clienta va escribiendo, para que el resumen enseñe EXACTAMENTE lo que se va
 * a registrar. Usa la misma `calcularTotales` que el pedido: es imposible que
 * difieran. Solo lee; no crea nada. Los precios salen de la BD, nunca del
 * navegador.
 */
export async function cotizarCheckout(input: {
  state: string;
  country?: string;
  pickup: boolean;
  code: string;
  email: string;
}): Promise<CotizacionCheckout> {
  const token = await readCartToken();
  const [cart, settings, zonas, taxCfg] = await Promise.all([
    token
      ? db.cart.findUnique({
          where: { token },
          include: {
            items: {
              include: {
                variant: true,
                product: { include: { collections: { select: { collectionId: true } } } },
              },
            },
          },
        })
      : null,
    getSettings(),
    cargarZonas(),
    getTaxConfig(),
  ]);

  const lines: LineaCalculo[] = [];
  for (const item of cart?.items ?? []) {
    const { product, variant } = item;
    if (!product || !variant || product.status !== "active" || variant.priceCents <= 0) continue;
    let cantidad = item.quantity;
    if (variant.trackStock) {
      if (variant.stock <= 0) continue;
      if (variant.stock < item.quantity) cantidad = variant.stock;
    }
    lines.push({
      productId: product.id,
      collectionIds: product.collections.map((c) => c.collectionId),
      priceCents: variant.priceCents,
      quantity: cantidad,
    });
  }

  const ajustesEnvio: AjustesEnvio = {
    freeShippingOverCents: settings.freeShippingOverCents,
    flatShippingCents: settings.flatShippingCents,
    localPickup: settings.localPickup,
    shippingNotice: settings.shippingNotice,
  };
  const destino: Destino = input.pickup
    ? { country: "US" }
    : { state: input.state, country: (input.country ?? "US").trim().toUpperCase() || "US" };

  const d = await calcularTotales({
    lines,
    destino,
    pickup: input.pickup,
    code: input.code,
    // Con correo se comprueba «una vez por clienta»; vacío no rompe nada.
    email: input.email.trim(),
    zonas,
    ajustesEnvio,
    taxCfg,
  });

  return {
    subtotalCents: d.subtotalCents,
    discountCents: d.discountCents,
    discountLabel: d.discountLabel,
    discountError: d.discountError,
    freeShipping: d.freeShipping,
    shippingCents: d.shippingCents,
    taxCents: d.taxCents,
    taxLabel: d.taxLabel,
    totalCents: d.totalCents,
  };
}

/**
 * Desbloquea la confirmación de un pedido demostrando que se conoce el email.
 *
 * Es un `<form action>` normal: funciona sin JavaScript. El resultado viaja como
 * bandera en la URL (`?acceso=fallo`), nunca el email — un dato personal no se pone
 * en una query string que acaba en logs e historial.
 */
export async function verifyOrderAccess(formData: FormData): Promise<void> {
  const number = normalizeOrderNumber(String(formData.get("number") ?? ""));
  const email = String(formData.get("email") ?? "").trim();

  if (!number) redirect("/tienda");

  const ok = email.length > 3 && (await emailMatchesOrder(number, email));
  if (!ok) {
    redirect(`/pedido/${encodeURIComponent(number)}?acceso=fallo`);
  }

  await grantOrderAccess(number);
  redirect(`/pedido/${encodeURIComponent(number)}`);
}
