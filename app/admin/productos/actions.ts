"use server";

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { slugify, uniqueProductSlug } from "@/lib/slug";

/**
 * Mutaciones del catálogo.
 *
 * Todo lo que escribe en Product / ProductVariant / ProductImage pasa por aquí,
 * y todo pasa por la misma puerta: sesión válida, validación con zod, y una sola
 * transacción por guardado. Un producto a medio guardar (con las variantes
 * nuevas puestas pero las viejas sin borrar) sería peor que no guardar nada.
 */

/* ─────────────────────────── contratos ─────────────────────────── */

export type VarianteDraft = {
  /** null = variante nueva que todavía no existe en la base. */
  id: string | null;
  title: string;
  sku: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  priceCents: number;
  compareAtCents: number | null;
  costCents: number | null;
  stock: number;
  trackStock: boolean;
  imageUrl: string | null;
};

export type ImagenDraft = {
  id: string | null;
  url: string;
  alt: string;
};

export type EstadoProducto = {
  ok?: boolean;
  /** Mensaje de cabecera cuando algo impidió guardar. */
  error?: string;
  /** Mensaje de cabecera cuando sí se guardó. */
  mensaje?: string;
  /** Errores por campo, para pintarlos dentro de su Field. */
  errores?: Record<string, string>;
};

const ESTADOS = ["draft", "active", "archived"] as const;

/* Subida de ficheros: qué aceptamos y hasta dónde. */
const TIPOS_IMAGEN = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MAX_BYTES = 5 * 1024 * 1024;
const EXTENSIONES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

const EsquemaVariante = z.object({
  id: z.string().nullable().default(null),
  title: z.string().default(""),
  sku: z.string().default(""),
  option1: z.string().nullable().default(null),
  option2: z.string().nullable().default(null),
  option3: z.string().nullable().default(null),
  priceCents: z.number().int().min(0),
  compareAtCents: z.number().int().min(0).nullable().default(null),
  costCents: z.number().int().min(0).nullable().default(null),
  stock: z.number().int().default(0),
  trackStock: z.boolean().default(true),
  imageUrl: z.string().nullable().default(null),
});

const EsquemaImagen = z.object({
  id: z.string().nullable().default(null),
  url: z.string().min(1),
  alt: z.string().default(""),
});

/** Aceptamos URLs remotas y rutas locales servidas desde /public. */
function urlAceptable(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith("/");
}

/* ─────────────────────── guardar un producto ─────────────────────── */

type Resultado =
  | { ok: false; estado: EstadoProducto }
  | {
      ok: true;
      id: string;
      slug: string;
      slugAnterior: string | null;
      creado: boolean;
      slugsColeccion: string[];
    };

export async function guardarProducto(_prev: EstadoProducto, fd: FormData): Promise<EstadoProducto> {
  const admin = await getAdmin();
  if (!admin) return { error: "Tu sesión caducó. Vuelve a entrar y repite el guardado." };

  let resultado: Resultado;
  try {
    resultado = await procesarGuardado(fd);
  } catch (error) {
    return { error: `No se pudo guardar: ${error instanceof Error ? error.message : "error desconocido"}.` };
  }

  if (!resultado.ok) return resultado.estado;

  // El escaparate se sirve cacheado: sin invalidar, Madeline cambia un precio
  // aquí y la ficha pública sigue enseñando el viejo.
  revalidarTienda(resultado.slug, resultado.slugAnterior, resultado.slugsColeccion);

  // redirect() lanza una excepción de control de Next: tiene que quedar fuera
  // de cualquier try/catch o el editor nunca llegaría a abrirse.
  if (resultado.creado) redirect(`/admin/productos/${resultado.id}?guardado=1`);

  return { ok: true, mensaje: "Cambios guardados." };
}

async function procesarGuardado(fd: FormData): Promise<Resultado> {
  const id = String(fd.get("id") ?? "").trim() || null;
  const title = String(fd.get("title") ?? "").trim();
  const slugPedido = String(fd.get("slug") ?? "").trim();
  const description = String(fd.get("description") ?? "");
  const statusRaw = String(fd.get("status") ?? "draft");
  const status = (ESTADOS as readonly string[]).includes(statusRaw) ? statusRaw : "draft";
  const vendor = String(fd.get("vendor") ?? "").trim();
  const productType = String(fd.get("productType") ?? "").trim();
  const seoTitle = String(fd.get("seoTitle") ?? "").trim();
  const seoDescription = String(fd.get("seoDescription") ?? "").trim();
  const etiquetas = String(fd.get("tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const colecciones = fd.getAll("colecciones").map(String).filter(Boolean);

  const errores: Record<string, string> = {};
  if (!title) errores.title = "El producto necesita un título.";

  let variantes: VarianteDraft[];
  let imagenes: ImagenDraft[];
  let nombresOpcion: string[];
  try {
    variantes = EsquemaVariante.array().parse(JSON.parse(String(fd.get("variantesJson") ?? "[]")));
    imagenes = EsquemaImagen.array()
      .parse(JSON.parse(String(fd.get("imagenesJson") ?? "[]")))
      .filter((img) => urlAceptable(img.url));
    nombresOpcion = z
      .string()
      .array()
      .parse(JSON.parse(String(fd.get("optionNamesJson") ?? "[]")))
      .map((n) => n.trim())
      .filter(Boolean);
  } catch {
    return {
      ok: false,
      estado: { error: "El formulario llegó incompleto. Recarga la página y vuelve a intentarlo." },
    };
  }

  // Las fotos subidas se añaden al final: la portada es la primera de la lista
  // y un archivo suelto no debe desplazar a la que Madeline eligió.
  const subidas = await guardarSubidas(fd.getAll("archivos"));
  if (subidas.error) return { ok: false, estado: { error: subidas.error } };
  imagenes = [...imagenes, ...subidas.imagenes];

  // Sin variante no hay nada que meter en el carrito (CartItem exige variantId),
  // así que un producto "simple" es en realidad uno de una sola variante.
  if (variantes.length === 0) {
    variantes = [
      {
        id: null,
        title: "Estándar",
        sku: "",
        option1: null,
        option2: null,
        option3: null,
        priceCents: 0,
        compareAtCents: null,
        costCents: null,
        stock: 0,
        trackStock: false,
        imageUrl: null,
      },
    ];
  }

  // El precio del producto es el de su variante más barata, ignorando las que
  // están a 0: un 0 significa "sin precio puesto", no "regalado".
  const positivos = variantes.map((v) => v.priceCents).filter((p) => p > 0);
  const precioMin = positivos.length > 0 ? Math.min(...positivos) : 0;
  const barata = variantes.find((v) => v.priceCents === precioMin) ?? variantes[0];

  if (status === "active") {
    if (precioMin <= 0) {
      errores.status =
        "No se puede publicar sin precio: la ficha saldría a $0.00 y cualquiera podría llevárselo gratis.";
    } else if (imagenes.length === 0) {
      errores.status =
        "No se puede publicar sin ninguna foto: en una boutique de ropa la foto es el producto.";
    }
  }

  if (Object.keys(errores).length > 0) {
    return { ok: false, estado: { error: "Revisa lo que está marcado en rojo.", errores } };
  }

  const anterior = id
    ? await db.product.findUnique({
        where: { id },
        select: {
          slug: true,
          publishedAt: true,
          collections: { select: { collection: { select: { slug: true } } } },
        },
      })
    : null;
  if (id && !anterior) {
    return {
      ok: false,
      estado: { error: "Ese producto ya no existe: alguien lo borró mientras lo editabas." },
    };
  }

  const slug = await uniqueProductSlug(slugPedido || title, id ?? undefined);

  // publishedAt marca la primera publicación y no se toca al despublicar: es el
  // dato con el que el escaparate ordena "lo nuevo".
  const publishedAt = status === "active" ? anterior?.publishedAt ?? new Date() : anterior?.publishedAt ?? null;

  const datos = {
    slug,
    title,
    description,
    status,
    vendor: vendor || "Bloom by Madeline",
    productType,
    tagsJson: JSON.stringify(etiquetas),
    optionNamesJson: JSON.stringify(nombresOpcion),
    priceCents: precioMin,
    compareAtCents: barata.compareAtCents,
    costCents: barata.costCents,
    seoTitle: seoTitle || null,
    seoDescription: seoDescription || null,
    publishedAt,
  };

  const productoId = await db.$transaction(async (tx) => {
    let pid: string;
    if (id) {
      await tx.product.update({ where: { id }, data: datos });
      pid = id;
    } else {
      const creado = await tx.product.create({ data: { ...datos, sourceProvider: "manual" } });
      pid = creado.id;
    }

    /* Imágenes: lo que no venga en la lista es que se borró en el editor. */
    const idsImagen = imagenes.map((i) => i.id).filter((x): x is string => Boolean(x));
    await tx.productImage.deleteMany({ where: { productId: pid, id: { notIn: idsImagen } } });
    for (const [i, img] of imagenes.entries()) {
      if (img.id) {
        // updateMany con productId: si alguien manipula el id oculto del
        // formulario, no puede reescribir la imagen de otro producto.
        await tx.productImage.updateMany({
          where: { id: img.id, productId: pid },
          data: { url: img.url, alt: img.alt, position: i },
        });
      } else {
        await tx.productImage.create({ data: { productId: pid, url: img.url, alt: img.alt, position: i } });
      }
    }

    /* Variantes: mismo criterio. Al borrarlas caen sus CartItem por cascada. */
    const idsVariante = variantes.map((v) => v.id).filter((x): x is string => Boolean(x));
    await tx.productVariant.deleteMany({ where: { productId: pid, id: { notIn: idsVariante } } });
    for (const [i, v] of variantes.entries()) {
      const base = {
        title: v.title || "Estándar",
        sku: v.sku,
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        priceCents: v.priceCents,
        compareAtCents: v.compareAtCents,
        costCents: v.costCents,
        stock: v.stock,
        trackStock: v.trackStock,
        imageUrl: v.imageUrl,
        position: i,
      };
      if (v.id) {
        await tx.productVariant.updateMany({ where: { id: v.id, productId: pid }, data: base });
      } else {
        await tx.productVariant.create({ data: { ...base, productId: pid } });
      }
    }

    /* Colecciones */
    await tx.collectionProduct.deleteMany({ where: { productId: pid, collectionId: { notIn: colecciones } } });
    for (const collectionId of colecciones) {
      await tx.collectionProduct.upsert({
        where: { collectionId_productId: { collectionId, productId: pid } },
        create: { collectionId, productId: pid },
        update: {},
      });
    }

    return pid;
  });

  const despues = await db.collectionProduct.findMany({
    where: { productId: productoId },
    select: { collection: { select: { slug: true } } },
  });

  // Hay que refrescar tanto las colecciones donde estaba como donde está ahora:
  // si se quitó de "Vestidos", esa página también cambió.
  const slugsColeccion = new Set<string>();
  for (const c of anterior?.collections ?? []) slugsColeccion.add(c.collection.slug);
  for (const c of despues) slugsColeccion.add(c.collection.slug);

  return {
    ok: true,
    id: productoId,
    slug,
    slugAnterior: anterior?.slug ?? null,
    creado: !id,
    slugsColeccion: [...slugsColeccion],
  };
}

/* ─────────────────────── subida de imágenes ─────────────────────── */

async function guardarSubidas(entradas: FormDataEntryValue[]): Promise<{ imagenes: ImagenDraft[]; error?: string }> {
  const ficheros = entradas.filter((e): e is File => e instanceof File && e.size > 0);
  if (ficheros.length === 0) return { imagenes: [] };

  const destino = path.join(process.cwd(), "public", "uploads");
  await mkdir(destino, { recursive: true });

  const imagenes: ImagenDraft[] = [];
  for (const fichero of ficheros) {
    if (!TIPOS_IMAGEN.has(fichero.type)) {
      return { imagenes: [], error: `"${fichero.name}" no es una imagen (JPG, PNG, WebP, GIF o AVIF).` };
    }
    if (fichero.size > MAX_BYTES) {
      return {
        imagenes: [],
        error: `"${fichero.name}" pesa más de 5 MB. Comprímela antes de subirla o la ficha tardará una eternidad en cargar.`,
      };
    }

    // Nombre saneado: el que viene del disco puede traer acentos, espacios o
    // "../". slugify deja solo [a-z0-9-] y el sufijo evita pisar otra foto.
    const base = slugify(fichero.name.replace(/\.[^.]+$/, "")) || "imagen";
    const nombre = `${base}-${randomBytes(4).toString("hex")}${EXTENSIONES[fichero.type]}`;
    await writeFile(path.join(destino, nombre), Buffer.from(await fichero.arrayBuffer()));

    imagenes.push({ id: null, url: `/uploads/${nombre}`, alt: "" });
  }

  return { imagenes };
}

/* ───────────────────────── acciones en lote ───────────────────────── */

/**
 * Activar / pasar a borrador / archivar / añadir a colección / borrar, sobre la
 * selección del listado. El borrado nunca ocurre aquí de golpe: manda a una
 * pantalla de confirmación que dice cuántos son y cuáles.
 */
export async function accionEnLote(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const accion = String(fd.get("accion") ?? "");
  const volver = String(fd.get("volver") ?? "/admin/productos") || "/admin/productos";

  let ids = fd.getAll("ids").map(String).filter(Boolean);
  // "Aplicar a los N de esta página": la lista viaja en un campo oculto con los
  // ids ya renderizados, así no hay que reconstruir el filtro aquí y arriesgarse
  // a que se desincronice con el de la pantalla.
  if (fd.get("todos") === "on") {
    ids = String(fd.get("idsPagina") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  ids = [...new Set(ids)];

  if (ids.length === 0) redirect(conParametros(volver, { hecho: "nada" }));

  if (accion === "borrar") {
    // Paso intermedio obligatorio: la confirmación enseña los títulos uno a uno.
    redirect(conParametros(volver, { borrar: ids.join(",") }));
  }

  const afectados = await db.product.findMany({
    where: { id: { in: ids } },
    select: { slug: true, collections: { select: { collection: { select: { slug: true } } } } },
  });
  const slugs = afectados.map((p) => p.slug);
  const slugsColeccion = [...new Set(afectados.flatMap((p) => p.collections.map((c) => c.collection.slug)))];

  let hecho = "";
  let n = 0;
  let m = 0;

  switch (accion) {
    case "activar": {
      // Publicar sin precio o sin foto es la forma más cara de perder dinero:
      // se activan solo los que están listos y se dice cuántos quedaron fuera.
      const aptos = await db.product.findMany({
        where: { id: { in: ids }, priceCents: { gt: 0 }, images: { some: {} } },
        select: { id: true },
      });
      const idsAptos = aptos.map((p) => p.id);
      await db.product.updateMany({ where: { id: { in: idsAptos } }, data: { status: "active" } });
      await db.product.updateMany({
        where: { id: { in: idsAptos }, publishedAt: null },
        data: { publishedAt: new Date() },
      });
      hecho = "activados";
      n = idsAptos.length;
      m = ids.length - idsAptos.length;
      break;
    }
    case "borrador":
      await db.product.updateMany({ where: { id: { in: ids } }, data: { status: "draft" } });
      hecho = "borradores";
      n = ids.length;
      break;
    case "archivar":
      await db.product.updateMany({ where: { id: { in: ids } }, data: { status: "archived" } });
      hecho = "archivados";
      n = ids.length;
      break;
    case "coleccion": {
      const collectionId = String(fd.get("coleccionId") ?? "");
      if (!collectionId) redirect(conParametros(volver, { hecho: "sin-coleccion" }));
      for (const productId of ids) {
        await db.collectionProduct.upsert({
          where: { collectionId_productId: { collectionId, productId } },
          create: { collectionId, productId },
          update: {},
        });
      }
      hecho = "coleccion";
      n = ids.length;
      break;
    }
    case "borrar-confirmado":
      await db.product.deleteMany({ where: { id: { in: ids } } });
      hecho = "borrados";
      n = ids.length;
      break;
    default:
      redirect(conParametros(volver, { hecho: "nada" }));
  }

  for (const slug of slugs) revalidarTienda(slug, null, []);
  revalidarTienda("", null, slugsColeccion);
  revalidatePath("/admin/productos");

  redirect(conParametros(volver, { hecho, n: String(n), m: String(m) }));
}

/* ─────────────────────────── utilidades ─────────────────────────── */

function revalidarTienda(slug: string, slugAnterior: string | null, slugsColeccion: string[]): void {
  revalidatePath("/");
  revalidatePath("/tienda");
  if (slug) revalidatePath(`/producto/${slug}`);
  if (slugAnterior && slugAnterior !== slug) revalidatePath(`/producto/${slugAnterior}`);
  for (const s of slugsColeccion) revalidatePath(`/coleccion/${s}`);
}

/**
 * Añade parámetros a una URL conservando los que ya trae (el filtro y la página
 * en los que estaba Madeline) y limpiando los del mensaje anterior.
 */
function conParametros(url: string, extra: Record<string, string>): string {
  const [ruta, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  for (const clave of ["hecho", "n", "m", "borrar"]) params.delete(clave);
  for (const [clave, valor] of Object.entries(extra)) {
    if (valor) params.set(clave, valor);
  }
  const cadena = params.toString();
  return cadena ? `${ruta}?${cadena}` : ruta;
}
