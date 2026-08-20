"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseToCents } from "@/lib/money";

/**
 * Edición rápida desde el listado: poner precio o existencias de un producto sin
 * abrir el editor entero.
 *
 * Por qué existe: los productos de la boutique tienen un mismo precio para todas
 * sus tallas (una talla S y una M del mismo vestido cuestan lo mismo). Abrir el
 * editor, ver tres filas S/M/L y rellenar precio en cada una es un muro para
 * quien no es técnico — que era justo lo que frenaba a Madeline. Aquí un número
 * se aplica a TODAS las variantes de golpe, que es como ella piensa el precio.
 *
 * Si de verdad hiciera falta un precio distinto por talla, eso se hace en el
 * editor completo; esto es la vía cómoda para el caso normal.
 */

export type ResultadoRapido = {
  ok: boolean;
  /** Mensaje corto para enseñar junto a la celda. */
  mensaje?: string;
  priceCents?: number;
  stock?: number;
  trackStock?: boolean;
};

async function slugDe(productId: string): Promise<string | null> {
  const p = await db.product.findUnique({ where: { id: productId }, select: { slug: true } });
  return p?.slug ?? null;
}

/** Refresca las páginas públicas que enseñan este producto y el propio listado. */
function refrescar(slug: string | null): void {
  revalidatePath("/admin/productos");
  revalidatePath("/");
  revalidatePath("/tienda");
  if (slug) revalidatePath(`/producto/${slug}`);
}

/**
 * Fija el precio de venta de todas las variantes del producto (y el precio de
 * referencia del producto). Acepta "45.99", "45,99" o "$45.99".
 */
export async function fijarPrecio(productId: string, texto: string): Promise<ResultadoRapido> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, mensaje: "Tu sesión caducó. Vuelve a entrar." };

  const cents = parseToCents(texto);
  if (cents === null || cents < 0) {
    return { ok: false, mensaje: "Escribe un precio, por ejemplo 45.99" };
  }

  const existe = await db.product.findUnique({ where: { id: productId }, select: { slug: true, title: true } });
  if (!existe) return { ok: false, mensaje: "Ese producto ya no existe." };

  await db.$transaction([
    db.productVariant.updateMany({ where: { productId }, data: { priceCents: cents } }),
    // El precio de referencia del producto es el de la variante más barata; como
    // todas quedan igual, es ese mismo número.
    db.product.update({ where: { id: productId }, data: { priceCents: cents } }),
  ]);

  await logActivity({
    action: "update",
    entityType: "product",
    entityId: productId,
    summary:
      cents > 0
        ? `Puso precio ${(cents / 100).toFixed(2)} a ${existe.title} desde el listado`
        : `Quitó el precio de ${existe.title} desde el listado`,
    userId: admin.id,
    userEmail: admin.email,
  });

  refrescar(existe.slug);
  return {
    ok: true,
    priceCents: cents,
    mensaje: cents > 0 ? "Precio guardado" : "Precio quitado",
  };
}

/**
 * Fija las existencias de todas las variantes y activa el control de stock.
 * Un número por talla: 5 = cinco de cada talla. Para cantidades distintas por
 * talla está el editor completo.
 */
export async function fijarStock(productId: string, texto: string): Promise<ResultadoRapido> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, mensaje: "Tu sesión caducó. Vuelve a entrar." };

  const n = Number.parseInt(texto.trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, mensaje: "Escribe un número, por ejemplo 5" };
  }

  const existe = await db.product.findUnique({ where: { id: productId }, select: { slug: true, title: true } });
  if (!existe) return { ok: false, mensaje: "Ese producto ya no existe." };

  await db.productVariant.updateMany({
    where: { productId },
    data: { stock: n, trackStock: true },
  });

  await logActivity({
    action: "update",
    entityType: "product",
    entityId: productId,
    summary: `Puso ${n} en existencias de ${existe.title} desde el listado`,
    userId: admin.id,
    userEmail: admin.email,
  });

  refrescar(existe.slug);
  return { ok: true, stock: n, trackStock: true, mensaje: "Existencias guardadas" };
}

/**
 * Vuelve a "sin límite": la tienda deja de contar unidades y el producto nunca
 * sale agotado. Es lo normal en dropshipping, donde el stock lo tiene el
 * proveedor, no la boutique.
 */
export async function quitarLimiteStock(productId: string): Promise<ResultadoRapido> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, mensaje: "Tu sesión caducó. Vuelve a entrar." };

  const existe = await db.product.findUnique({ where: { id: productId }, select: { slug: true, title: true } });
  if (!existe) return { ok: false, mensaje: "Ese producto ya no existe." };

  await db.productVariant.updateMany({ where: { productId }, data: { trackStock: false } });

  await logActivity({
    action: "update",
    entityType: "product",
    entityId: productId,
    summary: `Quitó el límite de existencias de ${existe.title} desde el listado`,
    userId: admin.id,
    userEmail: admin.email,
  });

  refrescar(existe.slug);
  return { ok: true, trackStock: false, mensaje: "Sin límite de existencias" };
}
