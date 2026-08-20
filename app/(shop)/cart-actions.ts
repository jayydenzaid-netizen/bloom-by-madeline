"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { getOrCreateCart, readCartToken } from "@/lib/cart";

/**
 * Mutaciones del carrito.
 *
 * Todas devuelven un resultado tipado en vez de lanzar: un throw dentro de una
 * Server Action llega al cliente como "an error occurred in the Server
 * Components render", que no le dice nada a la clienta. Aquí el mensaje ya
 * viene escrito en español y listo para el toast.
 */
export type CartActionResult = { ok: boolean; message?: string };

/** Tope por línea. Esto es una boutique, no un mayorista: 20 de la misma talla es un error de dedo. */
const MAX_QTY = 20;

const idSchema = z.string().trim().min(1).max(60);
const qtySchema = z.number().int().min(1).max(MAX_QTY);
const zeroableQtySchema = z.number().int().min(0).max(MAX_QTY);

/**
 * El contador del carrito vive en el layout del storefront, así que un cambio
 * afecta a todas las rutas, no solo a la que disparó la acción.
 */
function revalidateShop(): void {
  revalidatePath("/", "layout");
}

/**
 * Devuelve la línea solo si pertenece al carrito de quien pide.
 * Sin esta comprobación, cualquiera con un id de línea podría vaciar carritos ajenos.
 */
async function ownLine(lineId: string) {
  const parsed = idSchema.safeParse(lineId);
  if (!parsed.success) return null;

  const token = await readCartToken();
  if (!token) return null;

  const line = await db.cartItem.findUnique({
    where: { id: parsed.data },
    select: {
      id: true,
      quantity: true,
      cart: { select: { token: true } },
      variant: { select: { stock: true, trackStock: true } },
    },
  });
  if (!line || line.cart.token !== token) return null;
  return line;
}

/** Unidades que se pueden vender. null = sin control de stock (el proveedor lo tiene). */
function availableOf(v: { stock: number; trackStock: boolean }): number | null {
  return v.trackStock ? v.stock : null;
}

export async function addToCart(variantId: string, quantity: number = 1): Promise<CartActionResult> {
  const id = idSchema.safeParse(variantId);
  const qty = qtySchema.safeParse(quantity);
  if (!id.success || !qty.success) {
    return { ok: false, message: "No pudimos añadir esa pieza. Recarga la página." };
  }

  const variant = await db.productVariant.findUnique({
    where: { id: id.data },
    select: {
      id: true,
      productId: true,
      stock: true,
      trackStock: true,
      product: { select: { status: true } },
    },
  });

  // El storefront solo vende lo publicado: un borrador tiene precio 0 y no está revisado.
  if (!variant || variant.product.status !== "active") {
    return { ok: false, message: "Esa pieza ya no está disponible." };
  }

  const available = availableOf(variant);
  if (available !== null && available <= 0) {
    return { ok: false, message: "Esta talla está agotada." };
  }

  const token = await getOrCreateCart();
  const cart = await db.cart.findUnique({ where: { token }, select: { id: true } });
  if (!cart) return { ok: false, message: "No pudimos abrir tu carrito. Recarga la página." };

  const existing = await db.cartItem.findUnique({
    where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
    select: { id: true, quantity: true },
  });

  const desired = (existing?.quantity ?? 0) + qty.data;
  const capped = Math.min(desired, available ?? MAX_QTY, MAX_QTY);

  if (existing) {
    await db.cartItem.update({ where: { id: existing.id }, data: { quantity: capped } });
  } else {
    await db.cartItem.create({
      data: {
        cartId: cart.id,
        productId: variant.productId,
        variantId: variant.id,
        quantity: capped,
      },
    });
  }

  revalidateShop();

  // Si el stock recortó la cantidad hay que decirlo, no dejar que lo descubra en el checkout.
  if (capped < desired) {
    return { ok: true, message: `Solo quedan ${capped} disponibles de esa talla.` };
  }
  return { ok: true, message: "Añadido a tu carrito" };
}

export async function updateCartLine(lineId: string, quantity: number): Promise<CartActionResult> {
  const qty = zeroableQtySchema.safeParse(quantity);
  if (!qty.success) return { ok: false, message: "Esa cantidad no es válida." };

  const line = await ownLine(lineId);
  if (!line) return { ok: false, message: "Ese artículo ya no está en tu carrito." };

  if (qty.data === 0) {
    await db.cartItem.delete({ where: { id: line.id } });
    revalidateShop();
    return { ok: true };
  }

  const available = availableOf(line.variant);
  const capped = Math.min(qty.data, available ?? MAX_QTY, MAX_QTY);
  if (capped <= 0) {
    await db.cartItem.delete({ where: { id: line.id } });
    revalidateShop();
    return { ok: true, message: "Esa talla se agotó." };
  }

  await db.cartItem.update({ where: { id: line.id }, data: { quantity: capped } });
  revalidateShop();

  if (capped < qty.data) return { ok: true, message: `Solo quedan ${capped} disponibles de esa talla.` };
  return { ok: true };
}

export async function removeCartLine(lineId: string): Promise<CartActionResult> {
  const line = await ownLine(lineId);
  // Quitar algo que ya no está es el resultado que pedía: no es un error.
  if (!line) return { ok: true };

  await db.cartItem.delete({ where: { id: line.id } });
  revalidateShop();
  return { ok: true };
}

export async function clearCart(): Promise<CartActionResult> {
  const token = await readCartToken();
  if (!token) return { ok: true };

  const cart = await db.cart.findUnique({ where: { token }, select: { id: true } });
  if (!cart) return { ok: true };

  await db.cartItem.deleteMany({ where: { cartId: cart.id } });
  revalidateShop();
  return { ok: true, message: "Carrito vaciado" };
}
