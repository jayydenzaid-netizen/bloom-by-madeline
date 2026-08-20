import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";

/**
 * Pedidos: numeración correlativa, creación desde el carrito y control de acceso
 * a la página de confirmación.
 *
 * Dos cosas mandan aquí sobre cualquier comodidad:
 *
 *  1. **El precio se recalcula desde la base de datos, siempre.** Ni un centavo
 *     viene del formulario. Un `<input type="hidden" name="precio">` es el agujero
 *     por el que se compra un vestido por 1 centavo.
 *  2. **Todo o nada.** Crear el pedido, descontar stock y vaciar el carrito ocurren
 *     dentro de UNA transacción: si el stock se acabó a mitad, no queda un pedido
 *     huérfano ni un carrito vaciado sin pedido.
 */

// ─────────────────────────────── numeración ───────────────────────────────

export const ORDER_PREFIX = "BLM-";
/** El primero es BLM-1001: un "pedido nº 1" le dice a la clienta que es el conejillo de indias. */
const FIRST_ORDER_NUMBER = 1001;
/** Reintentos si dos compras simultáneas piden el mismo número. */
const NUMBER_RETRIES = 4;

/**
 * Siguiente número correlativo.
 *
 * Se calcula DENTRO de la transacción que crea el pedido (por eso recibe el cliente
 * de la transacción): leerlo por fuera abre una ventana en la que dos compradoras
 * ven el mismo máximo. Aun así la garantía de verdad no es esta lectura sino el
 * índice único de `Order.number`: si dos transacciones se cruzan, la segunda revienta
 * con P2002 y `createOrderFromCart` la reintenta con el número siguiente.
 *
 * Escanea la columna entera a propósito: como texto, "BLM-9999" ordena DESPUÉS de
 * "BLM-10000", así que un `orderBy` descendente empezaría a mentir en el pedido
 * 9.000. Una boutique no va a tener tantos pedidos como para que el escaneo pese.
 */
export async function nextOrderNumber(
  client: Prisma.TransactionClient | typeof db = db,
): Promise<string> {
  const rows = await client.order.findMany({ select: { number: true } });

  let max = FIRST_ORDER_NUMBER - 1;
  for (const row of rows) {
    const n = parseOrderNumber(row.number);
    if (n !== null && n > max) max = n;
  }
  return `${ORDER_PREFIX}${max + 1}`;
}

/** "BLM-1042" -> 1042. Devuelve null si el número no sigue el formato de la casa. */
export function parseOrderNumber(value: string): number | null {
  if (!value.startsWith(ORDER_PREFIX)) return null;
  const n = Number.parseInt(value.slice(ORDER_PREFIX.length), 10);
  return Number.isFinite(n) ? n : null;
}

/** Normaliza lo que escribe la compradora en la barra ("blm-1001", " BLM-1001 "). */
export function normalizeOrderNumber(value: string): string {
  return value.trim().toUpperCase();
}

// ──────────────────────────── crear el pedido ────────────────────────────

export type OrderPaymentMethod = "stripe" | "dm" | "pickup" | "cash";

/** Datos que llegan del formulario. Aquí NO viaja ningún importe: los pone la BD. */
export type CheckoutDetails = {
  name: string;
  email: string;
  phone?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  note?: string;
  paymentMethod: OrderPaymentMethod;
};

/**
 * `changed` distingue "el carrito cambió mientras compraba" (hay que mandarla al
 * carrito a revisar) de un fallo técnico (hay que pedirle que reintente).
 */
export type CreateOrderResult =
  | { ok: true; orderId: string; number: string; totalCents: number }
  | { ok: false; error: string; changed: boolean };

/** Motivos de rechazo que abortan la transacción con un mensaje ya escrito en español. */
class OrderProblem extends Error {
  constructor(
    message: string,
    readonly changed: boolean,
  ) {
    super(message);
    this.name = "OrderProblem";
  }
}

export async function createOrderFromCart(
  cartToken: string | null,
  details: CheckoutDetails,
): Promise<CreateOrderResult> {
  if (!cartToken) {
    return { ok: false, error: "Tu carrito está vacío.", changed: true };
  }

  // Los ajustes son configuración, no dinero del pedido: se pueden leer fuera de la
  // transacción. Los precios, no.
  const settings = await getSettings();
  const email = details.email.trim().toLowerCase();
  const pickup = details.paymentMethod === "pickup";

  for (let intento = 0; intento < NUMBER_RETRIES; intento++) {
    try {
      return await db.$transaction(async (tx) => {
        const cart = await tx.cart.findUnique({
          where: { token: cartToken },
          include: {
            items: {
              include: {
                variant: true,
                product: {
                  include: {
                    images: { orderBy: { position: "asc" }, take: 1, select: { url: true } },
                  },
                },
              },
            },
          },
        });

        if (!cart || cart.items.length === 0) {
          throw new OrderProblem("Tu carrito está vacío.", true);
        }

        // ── 1. Revalidar el carrito contra la BD y congelar los datos de cada línea ──
        const cambios: string[] = [];
        const lines: {
          productId: string;
          variantId: string;
          title: string;
          variantTitle: string;
          sku: string;
          imageUrl: string | null;
          priceCents: number;
          costCents: number | null;
          quantity: number;
          descontarStock: boolean;
        }[] = [];

        for (const item of cart.items) {
          const { product, variant } = item;

          if (!product || !variant || product.status !== "active") {
            cambios.push(`«${product?.title ?? "Una pieza"}» ya no está disponible.`);
            continue;
          }
          // Un producto sin precio es un borrador a medio revisar: cobrarlo sería cobrar $0.
          if (variant.priceCents <= 0) {
            cambios.push(`«${product.title}» todavía no tiene precio publicado.`);
            continue;
          }
          if (variant.trackStock) {
            if (variant.stock <= 0) {
              cambios.push(`«${product.title} · ${variant.title}» se agotó.`);
              continue;
            }
            if (variant.stock < item.quantity) {
              cambios.push(
                `De «${product.title} · ${variant.title}» solo quedan ${variant.stock}.`,
              );
              continue;
            }
          }

          lines.push({
            productId: product.id,
            variantId: variant.id,
            title: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            // La foto también se congela: si mañana cambia el catálogo, el pedido viejo
            // tiene que seguir enseñando lo que ella compró.
            imageUrl: variant.imageUrl ?? product.images[0]?.url ?? null,
            priceCents: variant.priceCents,
            costCents: variant.costCents ?? null,
            quantity: item.quantity,
            descontarStock: variant.trackStock,
          });
        }

        if (cambios.length > 0) {
          throw new OrderProblem(
            `Algo cambió mientras comprabas: ${cambios.join(" ")} Revisa tu carrito antes de continuar.`,
            true,
          );
        }
        if (lines.length === 0) {
          throw new OrderProblem("Tu carrito está vacío.", true);
        }

        // ── 2. Totales, calculados aquí y solo aquí ──
        const subtotalCents = lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
        const shippingCents = pickup ? 0 : shippingForSubtotal(subtotalCents, settings);
        const totalCents = subtotalCents + shippingCents;

        // ── 3. Clienta (upsert por email, sin borrar lo que ya sabíamos de ella) ──
        const customer = await tx.customer.upsert({
          where: { email },
          create: {
            email,
            name: details.name.trim(),
            phone: (details.phone ?? "").trim(),
          },
          update: {
            ...(details.name.trim() ? { name: details.name.trim() } : {}),
            ...((details.phone ?? "").trim() ? { phone: (details.phone ?? "").trim() } : {}),
          },
        });

        // ── 4. El pedido con sus líneas congeladas ──
        const number = await nextOrderNumber(tx);
        const order = await tx.order.create({
          data: {
            number,
            customerId: customer.id,
            email,
            phone: (details.phone ?? "").trim(),
            name: details.name.trim(),
            // Ningún método cobra todavía en el momento de crear el pedido: el pago se
            // confirma por DM, al recoger, o (cuando exista) por el webhook de Stripe.
            paymentStatus: "pending",
            fulfillStatus: "unfulfilled",
            paymentMethod: details.paymentMethod,
            subtotalCents,
            shippingCents,
            taxCents: 0,
            discountCents: 0,
            totalCents,
            // En recogida no se pide dirección: guardar una a medias confunde al preparar.
            shipName: pickup ? "" : details.name.trim(),
            shipLine1: pickup ? "" : details.line1.trim(),
            shipLine2: pickup ? "" : (details.line2 ?? "").trim(),
            shipCity: pickup ? "" : details.city.trim(),
            shipState: pickup ? "" : details.state.trim().toUpperCase(),
            shipZip: pickup ? "" : details.zip.trim(),
            shipCountry: pickup ? "" : (details.country ?? "US").trim().toUpperCase(),
            note: (details.note ?? "").trim(),
            items: {
              create: lines.map((l) => ({
                productId: l.productId,
                variantId: l.variantId,
                title: l.title,
                variantTitle: l.variantTitle,
                sku: l.sku,
                imageUrl: l.imageUrl,
                priceCents: l.priceCents,
                costCents: l.costCents,
                quantity: l.quantity,
              })),
            },
          },
          select: { id: true, number: true, totalCents: true },
        });

        // ── 5. Stock: solo de las variantes que lo controlan ──
        for (const l of lines) {
          if (!l.descontarStock) continue;
          // El `gte` en el WHERE es la comprobación de verdad: si otra compra se coló
          // entre la validación y este UPDATE, no descuenta nada y la cuenta sale 0.
          const res = await tx.productVariant.updateMany({
            where: { id: l.variantId, trackStock: true, stock: { gte: l.quantity } },
            data: { stock: { decrement: l.quantity } },
          });
          if (res.count !== 1) {
            throw new OrderProblem(
              `«${l.title} · ${l.variantTitle}» se agotó mientras confirmabas. Revisa tu carrito.`,
              true,
            );
          }
        }

        // ── 6. El carrito ya cumplió su función ──
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

        return {
          ok: true as const,
          orderId: order.id,
          number: order.number,
          totalCents: order.totalCents,
        };
      });
    } catch (err) {
      if (err instanceof OrderProblem) {
        return { ok: false, error: err.message, changed: err.changed };
      }
      // Choque de número correlativo: dos compras a la vez. Se reintenta con el siguiente.
      if (isDuplicateNumber(err) && intento < NUMBER_RETRIES - 1) continue;

      console.error("[orders] no se pudo crear el pedido:", err);
      return {
        ok: false,
        error: "No pudimos registrar tu pedido. Inténtalo otra vez en un momento.",
        changed: false,
      };
    }
  }

  return {
    ok: false,
    error: "No pudimos registrar tu pedido. Inténtalo otra vez en un momento.",
    changed: false,
  };
}

function isDuplicateNumber(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Misma regla que el carrito: gratis a partir del umbral, tarifa plana por debajo. */
export function shippingForSubtotal(
  subtotalCents: number,
  settings: { freeShippingOverCents: number; flatShippingCents: number },
): number {
  if (subtotalCents <= 0) return 0;
  if (settings.freeShippingOverCents <= 0) return 0;
  if (subtotalCents >= settings.freeShippingOverCents) return 0;
  return settings.flatShippingCents;
}

// ─────────────────────────────── consultar ───────────────────────────────

export type OrderForBuyer = NonNullable<Awaited<ReturnType<typeof getOrderByNumber>>>;

export async function getOrderByNumber(number: string) {
  return db.order.findUnique({
    where: { number: normalizeOrderNumber(number) },
    include: { items: { orderBy: { id: "asc" } } },
  });
}

// ──────────────────── acceso a la página de confirmación ────────────────────

/**
 * Por qué hay control de acceso en una página "pública".
 *
 * `Order.number` es correlativo (BLM-1001, BLM-1002…), o sea ADIVINABLE: cualquiera
 * podría recorrer los números y leer nombre, dirección y teléfono de todas las
 * clientas. El esquema no se puede tocar para añadir un token aleatorio, así que la
 * llave se genera fuera de la base de datos:
 *
 *  · al confirmar el pedido se firma su número con HMAC-SHA256 (secreto del servidor)
 *    y la firma se guarda en una cookie httpOnly. Quien acaba de comprar entra directo.
 *  · quien llegue por un enlace sin esa cookie ve solo el número y un formulario que
 *    pide el email del pedido. Si acierta, se le concede la misma cookie.
 *  · la cookie va firmada porque una cookie es del cliente: sin HMAC bastaría con
 *    escribir "BLM-1002" en el navegador para colarse.
 *
 * El formulario responde lo mismo si el pedido no existe que si el email no coincide,
 * para que tampoco sirva de detector de pedidos existentes.
 */
export const ORDER_ACCESS_COOKIE = "bloom_pedidos";
/** Cuántos pedidos recuerda la cookie. Suficiente para un historial reciente sin engordarla. */
const ACCESS_MAX_ENTRIES = 12;

function accessSecret(): string {
  return process.env.SESSION_SECRET || "bloom-dev-secret";
}

function signOrder(number: string): string {
  return createHmac("sha256", accessSecret()).update(number).digest("hex");
}

function sameSignature(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** ¿La visitante tiene llave para ver este pedido? Solo lee: sirve en Server Components. */
export async function canViewOrder(number: string): Promise<boolean> {
  const jar = await cookies();
  const raw = jar.get(ORDER_ACCESS_COOKIE)?.value;
  if (!raw) return false;

  const target = normalizeOrderNumber(number);
  const expected = signOrder(target);
  for (const entry of raw.split("~")) {
    const [num, sig] = entry.split(".");
    if (num === target && sig && sameSignature(sig, expected)) return true;
  }
  return false;
}

/**
 * Concede acceso al pedido. Escribe cookie: solo desde Server Actions o Route Handlers.
 */
export async function grantOrderAccess(number: string): Promise<void> {
  const jar = await cookies();
  const target = normalizeOrderNumber(number);
  const previas = (jar.get(ORDER_ACCESS_COOKIE)?.value ?? "")
    .split("~")
    .filter((e) => e && !e.startsWith(`${target}.`));

  const value = [`${target}.${signOrder(target)}`, ...previas]
    .slice(0, ACCESS_MAX_ENTRIES)
    .join("~");

  jar.set(ORDER_ACCESS_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 120,
  });
}

/** Comprueba el email del pedido sin filtrar si el pedido existe. */
export async function emailMatchesOrder(number: string, email: string): Promise<boolean> {
  const order = await db.order.findUnique({
    where: { number: normalizeOrderNumber(number) },
    select: { email: true },
  });
  if (!order) return false;
  return order.email.trim().toLowerCase() === email.trim().toLowerCase();
}

// ─────────────────────────── seguimiento y resumen ───────────────────────────

/** Enlace de rastreo del transportista. null si no reconocemos el transportista. */
export function trackingUrl(carrier: string | null, number: string | null): string | null {
  if (!number) return null;
  const code = encodeURIComponent(number.trim());
  switch ((carrier ?? "").trim().toLowerCase()) {
    case "usps":
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${code}`;
    case "ups":
      return `https://www.ups.com/track?tracknum=${code}`;
    case "fedex":
      return `https://www.fedex.com/fedextrack/?trknbr=${code}`;
    case "dhl":
      return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${code}`;
    default:
      return null;
  }
}

/**
 * Resumen en texto plano para pegar en el DM de Instagram.
 *
 * ig.me no admite mensaje prefijado en la URL, así que el canal real de Madeline
 * sigue siendo: copiar esto y pegarlo en el chat. Se arma en el servidor para que
 * los importes salgan de `formatCents` y nunca de un `toFixed` del navegador.
 */
export function buildDmSummary(input: {
  lines: { title: string; variantTitle?: string | null; quantity: number; lineTotalCents: number }[];
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  orderNumber?: string | null;
}): string {
  const cabecera = input.orderNumber
    ? `✿ Pedido ${input.orderNumber} — Bloom by Madeline`
    : "✿ Pedido — Bloom by Madeline";

  return [
    cabecera,
    ...input.lines.map(
      (l) =>
        `${l.quantity}× ${l.title}${l.variantTitle ? ` · ${l.variantTitle}` : ""} — ${formatCents(l.lineTotalCents)}`,
    ),
    `Subtotal: ${formatCents(input.subtotalCents)}`,
    `Envío: ${input.shippingCents === 0 ? "gratis" : formatCents(input.shippingCents)}`,
    `Total: ${formatCents(input.totalCents)}`,
  ].join("\n");
}

// ───────────────────────────── etiquetas en español ─────────────────────────────

export function paymentStatusLabel(status: string): string {
  switch (status) {
    case "paid":
      return "Pagado";
    case "refunded":
      return "Reembolsado";
    case "cancelled":
      return "Cancelado";
    default:
      return "Pendiente de pago";
  }
}

export function fulfillStatusLabel(status: string): string {
  switch (status) {
    case "fulfilled":
      return "Enviado";
    case "cancelled":
      return "Cancelado";
    default:
      return "En preparación";
  }
}

export function paymentMethodLabel(method: string): string {
  switch (method) {
    case "stripe":
      return "Tarjeta";
    case "pickup":
      return "Recoger en la boutique";
    case "cash":
      return "Efectivo";
    default:
      return "Instagram DM";
  }
}
