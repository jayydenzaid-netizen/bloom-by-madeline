import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";

export const CART_COOKIE = "bloom_cart";

export type CartLine = {
  id: string;
  productId: string;
  variantId: string;
  slug: string;
  title: string;
  variantTitle: string;
  imageUrl: string | null;
  priceCents: number;
  quantity: number;
  lineTotalCents: number;
  /** Unidades disponibles. null = sin límite (el proveedor tiene el stock). */
  available: number | null;
  /**
   * Se agotó mientras estaba en el carrito.
   *
   * Estas líneas SE ENSEÑAN, tachadas y con su botón de quitar, en vez de
   * desaparecer. Ocultarlas dejaba el carrito en un callejón sin salida: la
   * fila seguía en la base y el checkout abortaba el pedido entero diciendo
   * «revisa tu carrito», pero en el carrito no había nada que revisar ni nada
   * que pulsar. La compradora no podía comprar nunca más, y nadie se enteraba.
   */
  soldOut?: boolean;
};

export type CartView = {
  token: string;
  lines: CartLine[];
  count: number;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  freeShippingMissingCents: number;
};

export const EMPTY_CART: CartView = {
  token: "",
  lines: [],
  count: 0,
  subtotalCents: 0,
  shippingCents: 0,
  totalCents: 0,
  freeShippingMissingCents: 0,
};

/** Lee el token del carrito sin crearlo. Para Server Components (no pueden escribir cookies). */
export async function readCartToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(CART_COOKIE)?.value ?? null;
}

/**
 * Devuelve el carrito de la visitante creando uno si hace falta.
 * Solo se puede llamar desde Server Actions o Route Handlers: escribe la cookie.
 */
export async function getOrCreateCart(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(CART_COOKIE)?.value;
  if (existing) {
    const cart = await db.cart.findUnique({ where: { token: existing }, select: { id: true } });
    if (cart) return existing;
  }

  const token = randomBytes(24).toString("hex");
  await db.cart.create({ data: { token } });
  jar.set(CART_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 60,
  });
  return token;
}

export async function getCart(token: string | null): Promise<CartView> {
  if (!token) return EMPTY_CART;

  const cart = await db.cart.findUnique({
    where: { token },
    include: {
      items: {
        include: {
          product: { select: { slug: true, title: true, status: true } },
          variant: true,
        },
      },
    },
  });
  if (!cart) return EMPTY_CART;

  const settings = await getSettings();

  const lines: CartLine[] = [];
  for (const item of cart.items) {
    // Un producto archivado o borrado no puede seguir cobrándose.
    if (!item.product || !item.variant || item.product.status === "archived") continue;

    const priceCents = item.variant.priceCents;
    const available = item.variant.trackStock ? item.variant.stock : null;
    const quantity = available === null ? item.quantity : Math.min(item.quantity, Math.max(0, available));
    // Agotada: se conserva en la lista marcada, para que la clienta la vea y
    // pueda quitarla. Ni suma al total ni cuenta como pieza (ver más abajo).
    const soldOut = quantity <= 0;

    lines.push({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      slug: item.product.slug,
      title: item.product.title,
      variantTitle: item.variant.title,
      imageUrl: item.variant.imageUrl,
      priceCents,
      quantity: soldOut ? item.quantity : quantity,
      lineTotalCents: soldOut ? 0 : priceCents * quantity,
      available,
      ...(soldOut ? { soldOut: true } : {}),
    });
  }

  // El dinero y el badge solo cuentan lo que se puede comprar de verdad.
  const comprables = lines.filter((l) => !l.soldOut);
  const subtotalCents = comprables.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const count = comprables.reduce((sum, l) => sum + l.quantity, 0);

  const qualifies =
    settings.freeShippingOverCents <= 0 || subtotalCents >= settings.freeShippingOverCents;
  const shippingCents = comprables.length === 0 || qualifies ? 0 : settings.flatShippingCents;
  const freeShippingMissingCents =
    settings.freeShippingOverCents > 0 && !qualifies
      ? settings.freeShippingOverCents - subtotalCents
      : 0;

  return {
    token,
    lines,
    count,
    subtotalCents,
    shippingCents,
    totalCents: subtotalCents + shippingCents,
    freeShippingMissingCents,
  };
}

/**
 * Atajo para el badge del nav: solo cuenta, sin traer todo el carrito.
 *
 * Cuenta lo COMPRABLE, igual que `getCart`: una talla agotada sigue en el
 * carrito para poder quitarla, pero un badge que anuncia una pieza que ya no
 * se puede comprar manda a la clienta a un carrito donde no hay nada que hacer.
 */
export async function getCartCount(): Promise<number> {
  const token = await readCartToken();
  if (!token) return 0;
  const cart = await db.cart.findUnique({
    where: { token },
    select: {
      items: {
        select: {
          quantity: true,
          product: { select: { status: true } },
          variant: { select: { stock: true, trackStock: true } },
        },
      },
    },
  });
  return (
    cart?.items.reduce((s, i) => {
      if (!i.product || !i.variant || i.product.status === "archived") return s;
      const disponible = i.variant.trackStock ? i.variant.stock : null;
      const cantidad = disponible === null ? i.quantity : Math.min(i.quantity, Math.max(0, disponible));
      return s + Math.max(0, cantidad);
    }, 0) ?? 0
  );
}
