"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logActivity } from "@/lib/activity";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { aplicarStockEnTx } from "@/lib/inventory";
import { parseToCents } from "@/lib/money";
import { uniqueProductSlug } from "@/lib/slug";

/**
 * Alta rápida de una prenda, pensada para el móvil de la boutique.
 *
 * El editor completo (`../_components/ProductForm`) sigue existiendo y hace
 * falta para casos raros, pero para el día a día pide demasiado: slug, SKU,
 * SEO, nombres de opciones, proveedor… Madeline solo quiere hacer una foto,
 * poner un nombre, un precio y decir cuántas tiene de cada talla.
 *
 * Aquí se toman esas cuatro cosas y se rellena TODO lo demás con valores
 * sensatos: el slug sale del nombre, cada talla marcada es una variante con su
 * precio y sus existencias, y el control de stock queda encendido.
 */

const TALLAS_VALIDAS = ["XS", "S", "M", "L", "XL", "XXL", "Única"] as const;

const esquema = z.object({
  nombre: z
    .string()
    .trim()
    .min(2, "Escribe el nombre de la prenda.")
    .max(120, "El nombre es demasiado largo."),
  descripcion: z.string().trim().max(2000, "La descripción es demasiado larga."),
  precio: z.string().trim().min(1, "Escribe el precio."),
  publicar: z.boolean(),
  fotos: z.array(z.string().trim().min(1)).max(12, "Como mucho 12 fotos por prenda."),
  tallas: z
    .array(
      z.object({
        talla: z.string().trim().min(1).max(20),
        piezas: z.number().int().min(0).max(9999),
      }),
    )
    .min(1, "Marca al menos una talla."),
});

export type EstadoPrenda = { error?: string; campo?: "nombre" | "precio" | "tallas" | "fotos" };

export async function crearPrenda(_prev: EstadoPrenda, fd: FormData): Promise<EstadoPrenda> {
  const admin = await getAdmin();
  if (!admin) return { error: "Tu sesión caducó. Vuelve a entrar y repite el guardado." };

  let datos: z.infer<typeof esquema>;
  try {
    datos = esquema.parse({
      nombre: String(fd.get("nombre") ?? ""),
      descripcion: String(fd.get("descripcion") ?? ""),
      precio: String(fd.get("precio") ?? ""),
      publicar: String(fd.get("publicar") ?? "") === "si",
      fotos: JSON.parse(String(fd.get("fotosJson") ?? "[]")),
      tallas: JSON.parse(String(fd.get("tallasJson") ?? "[]")),
    });
  } catch (error) {
    const primero = error instanceof z.ZodError ? error.issues[0] : null;
    const campo = primero?.path[0];
    return {
      error: primero?.message ?? "Revisa los datos e inténtalo otra vez.",
      campo: campo === "nombre" || campo === "precio" || campo === "tallas" || campo === "fotos" ? campo : undefined,
    };
  }

  const cents = parseToCents(datos.precio);
  if (cents === null || cents <= 0) {
    return { error: "Ese precio no se entiende. Escríbelo así: 45.99", campo: "precio" };
  }

  // Publicar sin foto deja una tarjeta gris en la tienda: se avisa en vez de
  // hacerlo en silencio (misma regla que el lote «activar» del listado).
  if (datos.publicar && datos.fotos.length === 0) {
    return { error: "Para ponerla a la venta hace falta al menos una foto.", campo: "fotos" };
  }

  const tallas = datos.tallas.filter((t) => TALLAS_VALIDAS.includes(t.talla as (typeof TALLAS_VALIDAS)[number]) || t.talla.length <= 20);
  if (tallas.length === 0) return { error: "Marca al menos una talla.", campo: "tallas" };

  const slug = await uniqueProductSlug(datos.nombre);
  const publicar = datos.publicar;

  let productoId = "";
  try {
    productoId = await db.$transaction(async (tx) => {
      const producto = await tx.product.create({
        data: {
          slug,
          title: datos.nombre,
          description: datos.descripcion,
          status: publicar ? "active" : "draft",
          ...(publicar ? { publishedAt: new Date() } : {}),
          priceCents: cents,
          // Una sola opción y se llama Talla: es como piensa la boutique.
          optionNamesJson: JSON.stringify(["Talla"]),
          sourceProvider: "manual",
          images: {
            create: datos.fotos.map((url, i) => ({ url, alt: datos.nombre, position: i })),
          },
          variants: {
            create: tallas.map((t, i) => ({
              title: t.talla,
              option1: t.talla,
              priceCents: cents,
              // El stock se pone después por la puerta oficial de inventario,
              // para que quede su línea en el historial.
              stock: 0,
              trackStock: true,
              position: i,
            })),
          },
        },
        select: { id: true, variants: { select: { id: true, option1: true } } },
      });

      // Existencias con su movimiento: el historial de inventario no puede
      // empezar a mentir en el alta (regla de lib/inventory.ts).
      for (const variante of producto.variants) {
        const pedida = tallas.find((t) => t.talla === variante.option1);
        if (!pedida || pedida.piezas <= 0) continue;
        await aplicarStockEnTx(tx, variante.id, { setTo: pedida.piezas }, {
          reason: "count",
          userId: admin.id,
          note: "Alta de la prenda desde el móvil",
        });
      }

      return producto.id;
    });
  } catch (error) {
    return {
      error: `No se pudo guardar: ${error instanceof Error ? error.message : "error desconocido"}.`,
    };
  }

  await logActivity({
    userId: admin.id,
    userEmail: admin.email,
    action: "create",
    entityType: "product",
    entityId: productoId,
    summary: `Añadió «${datos.nombre}» (${tallas.length} ${tallas.length === 1 ? "talla" : "tallas"})${publicar ? " y la puso a la venta" : " como borrador"}`,
  });

  revalidatePath("/admin/productos");
  revalidatePath("/admin/inventario");
  if (publicar) {
    revalidatePath("/");
    revalidatePath("/tienda");
    revalidatePath(`/producto/${slug}`);
  }

  // Fuera de todo try: redirect() funciona lanzando.
  redirect(`/admin/productos/nueva-prenda?hecha=${encodeURIComponent(datos.nombre)}&pub=${publicar ? "1" : "0"}&id=${productoId}`);
}
