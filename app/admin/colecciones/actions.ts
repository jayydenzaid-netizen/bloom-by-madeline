"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { uniqueCollectionSlug } from "@/lib/slug";

/**
 * Mutaciones de colecciones. Son formularios normales (sin JavaScript), así que
 * el resultado se cuenta con un código en la URL y la pantalla lo traduce a
 * castellano: nada de meter texto libre en la barra de direcciones, que acaba
 * siendo un cartel que cualquiera puede escribir con un enlace preparado.
 */

const EsquemaColeccion = z.object({
  title: z.string().trim().min(1, "vacia"),
  description: z.string().default(""),
  imageUrl: z.string().trim().default(""),
});

export async function guardarColeccion(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "").trim() || null;
  const datos = EsquemaColeccion.safeParse({
    title: String(fd.get("title") ?? ""),
    description: String(fd.get("description") ?? ""),
    imageUrl: String(fd.get("imageUrl") ?? ""),
  });

  if (!datos.success) {
    redirect(`/admin/colecciones?editar=${id ?? "nueva"}&error=titulo`);
  }

  const slugPedido = String(fd.get("slug") ?? "").trim();
  const isVisible = fd.get("isVisible") === "on";
  const slug = await uniqueCollectionSlug(slugPedido || datos.data.title, id ?? undefined);

  const anterior = id ? await db.collection.findUnique({ where: { id }, select: { slug: true } }) : null;
  if (id && !anterior) redirect("/admin/colecciones?hecho=no-existe");

  const comun = {
    slug,
    title: datos.data.title,
    description: datos.data.description,
    imageUrl: datos.data.imageUrl || null,
    isVisible,
  };

  let destinoId: string;
  if (id) {
    await db.collection.update({ where: { id }, data: comun });
    destinoId = id;
  } else {
    // La nueva se pone al final: el orden manual lo decide Madeline, no el reloj.
    const ultima = await db.collection.aggregate({ _max: { position: true } });
    const creada = await db.collection.create({
      data: { ...comun, position: (ultima._max.position ?? 0) + 1 },
    });
    destinoId = creada.id;
  }

  revalidarColecciones([slug, anterior?.slug ?? ""]);
  redirect(`/admin/colecciones?editar=${destinoId}&hecho=guardada`);
}

export async function borrarColeccion(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "").trim();
  if (!id) redirect("/admin/colecciones");

  const confirmado = fd.get("confirmado") === "1";
  if (!confirmado) {
    // Igual que con los productos: el borrado pasa antes por una pantalla que
    // dice qué se borra y cuántos productos se quedan sueltos.
    redirect(`/admin/colecciones?borrar=${id}`);
  }

  const coleccion = await db.collection.findUnique({ where: { id }, select: { slug: true } });
  if (!coleccion) redirect("/admin/colecciones?hecho=no-existe");

  // Solo desaparece la agrupación: CollectionProduct cae por cascada y los
  // productos siguen existiendo tal cual.
  await db.collection.delete({ where: { id } });

  revalidarColecciones([coleccion.slug]);
  redirect("/admin/colecciones?hecho=borrada");
}

/** Sube o baja una colección en el orden manual del escaparate. */
export async function moverColeccion(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "").trim();
  const salto = String(fd.get("direccion") ?? "") === "arriba" ? -1 : 1;

  const todas = await db.collection.findMany({
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: { id: true },
  });
  const indice = todas.findIndex((c) => c.id === id);
  const destino = indice + salto;
  if (indice < 0 || destino < 0 || destino >= todas.length) redirect("/admin/colecciones");

  const orden = [...todas];
  const [movida] = orden.splice(indice, 1);
  orden.splice(destino, 0, movida);

  // Se reescriben todas las posiciones: si vinieran con huecos o empates de una
  // importación vieja, esto las deja limpias de paso.
  await db.$transaction(
    orden.map((c, i) => db.collection.update({ where: { id: c.id }, data: { position: i } })),
  );

  revalidarColecciones([]);
  redirect("/admin/colecciones?hecho=movida");
}

/** Añade o quita un producto de una colección desde el buscador de la ficha. */
export async function asignarProducto(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const collectionId = String(fd.get("coleccionId") ?? "").trim();
  const productId = String(fd.get("productoId") ?? "").trim();
  const quitar = String(fd.get("accion") ?? "") === "quitar";
  const buscar = String(fd.get("buscar") ?? "").trim();
  if (!collectionId || !productId) redirect("/admin/colecciones");

  const coleccion = await db.collection.findUnique({ where: { id: collectionId }, select: { slug: true } });
  if (!coleccion) redirect("/admin/colecciones?hecho=no-existe");

  if (quitar) {
    await db.collectionProduct.deleteMany({ where: { collectionId, productId } });
  } else {
    const ultimo = await db.collectionProduct.aggregate({
      where: { collectionId },
      _max: { position: true },
    });
    await db.collectionProduct.upsert({
      where: { collectionId_productId: { collectionId, productId } },
      create: { collectionId, productId, position: (ultimo._max.position ?? 0) + 1 },
      update: {},
    });
  }

  const producto = await db.product.findUnique({ where: { id: productId }, select: { slug: true } });

  revalidarColecciones([coleccion.slug]);
  if (producto) revalidatePath(`/producto/${producto.slug}`);

  const params = new URLSearchParams({ editar: collectionId, hecho: quitar ? "quitado" : "anadido" });
  if (buscar) params.set("buscar", buscar);
  redirect(`/admin/colecciones?${params.toString()}`);
}

/** Reordena un producto dentro de la colección: el orden es el del escaparate. */
export async function moverProductoEnColeccion(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const collectionId = String(fd.get("coleccionId") ?? "").trim();
  const productId = String(fd.get("productoId") ?? "").trim();
  const salto = String(fd.get("direccion") ?? "") === "arriba" ? -1 : 1;
  if (!collectionId || !productId) redirect("/admin/colecciones");

  const filas = await db.collectionProduct.findMany({
    where: { collectionId },
    orderBy: { position: "asc" },
    select: { productId: true },
  });
  const indice = filas.findIndex((f) => f.productId === productId);
  const destino = indice + salto;
  if (indice < 0 || destino < 0 || destino >= filas.length) {
    redirect(`/admin/colecciones?editar=${collectionId}`);
  }

  const orden = [...filas];
  const [movido] = orden.splice(indice, 1);
  orden.splice(destino, 0, movido);

  await db.$transaction(
    orden.map((f, i) =>
      db.collectionProduct.update({
        where: { collectionId_productId: { collectionId, productId: f.productId } },
        data: { position: i },
      }),
    ),
  );

  const coleccion = await db.collection.findUnique({ where: { id: collectionId }, select: { slug: true } });
  revalidarColecciones([coleccion?.slug ?? ""]);
  redirect(`/admin/colecciones?editar=${collectionId}&hecho=ordenado`);
}

/* ─────────────────────────── utilidades ─────────────────────────── */

function revalidarColecciones(slugs: string[]): void {
  revalidatePath("/");
  revalidatePath("/tienda");
  for (const slug of slugs) {
    if (slug) revalidatePath(`/coleccion/${slug}`);
  }
  revalidatePath("/admin/colecciones");
}
