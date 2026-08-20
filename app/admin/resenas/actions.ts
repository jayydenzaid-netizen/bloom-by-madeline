"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { ESTADOS_RESENA, ORIGENES_RESENA, PUNTUACION_MAX, PUNTUACION_MIN, registrarActividad } from "@/lib/reviews";

/**
 * Acciones de moderación de reseñas.
 *
 * Ninguna lanza excepciones: todas devuelven un resultado tipado que la pantalla
 * pinta como aviso. Una excepción en un Server Action se convierte en la
 * pantalla de error de Next, y Madeline se quedaría sin saber si su reseña se
 * guardó o no.
 *
 * Regla de fondo: solo las reseñas `approved` se enseñan en la tienda, y nada
 * pasa a `approved` sin que alguien lo pulse aquí.
 */

/* ─────────────────────────────── tipos ─────────────────────────────── */

export type EstadoFormulario =
  | { estado: "idle" }
  | { estado: "ok"; mensaje: string }
  | { estado: "error"; error: string; campos?: Record<string, string> };

// Ojo: un fichero "use server" solo puede exportar funciones asíncronas. El
// estado inicial del formulario (una constante) vive en el componente cliente.

export type Resultado = { ok: true; mensaje: string } | { ok: false; error: string };

const SIN_SESION = "Tu sesión ha caducado. Vuelve a entrar en el panel.";

/* ─────────────────────────────── esquemas ─────────────────────────────── */

const idSchema = z.string().trim().min(1, "Falta la reseña.").max(64);

const nuevaResenaSchema = z.object({
  autora: z
    .string()
    .trim()
    .min(2, "Escribe el nombre de la clienta.")
    .max(60, "El nombre es demasiado largo."),
  puntuacion: z
    .number()
    .int("La puntuación va de 1 a 5.")
    .min(PUNTUACION_MIN, "La puntuación va de 1 a 5.")
    .max(PUNTUACION_MAX, "La puntuación va de 1 a 5."),
  titulo: z.string().trim().max(80, "El titular es demasiado largo.").optional().default(""),
  texto: z
    .string()
    .trim()
    .min(4, "Copia lo que escribió la clienta.")
    .max(1200, "La reseña es demasiado larga; recórtala un poco."),
  productoId: z.string().trim().max(64).optional().default(""),
  origen: z.enum(ORIGENES_RESENA),
  verificada: z.boolean().default(false),
  publicar: z.boolean().default(true),
});

const moderarSchema = z.object({
  id: idSchema,
  estado: z.enum(ESTADOS_RESENA),
});

const loteSchema = z.object({
  ids: z.array(idSchema).min(1, "No has seleccionado ninguna reseña."),
  accion: z.enum(["approved", "rejected", "delete"]),
});

/* ─────────────────────────────── utilidades ─────────────────────────────── */

/** Sesión obligatoria: sin admin no se toca ni una reseña. */
async function sesion() {
  return getAdmin();
}

/**
 * Refresca lo que depende de una reseña: el panel siempre, y en el escaparate
 * la ficha del producto y la portada, que es donde se leen las aprobadas.
 */
async function refrescar(productIds: (string | null | undefined)[]): Promise<void> {
  revalidatePath("/admin/resenas");
  revalidatePath("/admin");

  const unicos = [...new Set(productIds.filter((id): id is string => Boolean(id)))];
  if (unicos.length > 0) {
    const productos = await db.product.findMany({ where: { id: { in: unicos } }, select: { slug: true } });
    for (const p of productos) revalidatePath(`/producto/${p.slug}`);
  }
  revalidatePath("/");
}

function primerError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Revisa los datos del formulario.";
}

/* ─────────────────────────────── alta manual ─────────────────────────────── */

/**
 * Alta de una reseña REAL que Madeline copia de su destacado de Instagram o que
 * le dejaron en el mostrador. El formulario no siembra nada por su cuenta.
 */
export async function crearResena(_prev: EstadoFormulario, formData: FormData): Promise<EstadoFormulario> {
  const admin = await sesion();
  if (!admin) return { estado: "error", error: SIN_SESION };

  const puntuacionCruda = Number.parseInt(String(formData.get("puntuacion") ?? ""), 10);

  const datos = nuevaResenaSchema.safeParse({
    autora: String(formData.get("autora") ?? ""),
    puntuacion: Number.isFinite(puntuacionCruda) ? puntuacionCruda : 0,
    titulo: String(formData.get("titulo") ?? ""),
    texto: String(formData.get("texto") ?? ""),
    productoId: String(formData.get("productoId") ?? ""),
    origen: String(formData.get("origen") ?? "instagram"),
    verificada: formData.get("verificada") === "on",
    publicar: formData.get("publicar") === "on",
  });

  if (!datos.success) {
    return { estado: "error", error: primerError(datos.error) };
  }

  const productoId = datos.data.productoId || null;
  if (productoId) {
    // Producto fantasma: mejor decirlo que guardar una reseña que no se verá en
    // ninguna ficha porque apunta a un id que ya no existe.
    const existe = await db.product.findUnique({ where: { id: productoId }, select: { id: true } });
    if (!existe) return { estado: "error", error: "Ese producto ya no existe. Elige otro o déjalo en «la boutique»." };
  }

  const resena = await db.review.create({
    data: {
      productId: productoId,
      authorName: datos.data.autora,
      rating: datos.data.puntuacion,
      title: datos.data.titulo,
      body: datos.data.texto,
      status: datos.data.publicar ? "approved" : "pending",
      isVerified: datos.data.verificada,
      source: datos.data.origen,
    },
  });

  await registrarActividad({
    admin,
    action: "create",
    entityType: "review",
    entityId: resena.id,
    summary: `Reseña de ${datos.data.autora} (${datos.data.puntuacion}★) añadida a mano.`,
    meta: { origen: datos.data.origen, publicada: datos.data.publicar, productoId },
  });

  await refrescar([productoId]);

  return {
    estado: "ok",
    mensaje: datos.data.publicar
      ? `Reseña de ${datos.data.autora} guardada y publicada en la tienda.`
      : `Reseña de ${datos.data.autora} guardada como pendiente. Apruébala cuando quieras que se vea.`,
  };
}

/* ─────────────────────────────── moderación ─────────────────────────────── */

/** Aprueba o rechaza una reseña. La llama el botón de cada fila. */
export async function moderarResena(entrada: { id: string; estado: string }): Promise<Resultado> {
  const admin = await sesion();
  if (!admin) return { ok: false, error: SIN_SESION };

  const datos = moderarSchema.safeParse(entrada);
  if (!datos.success) return { ok: false, error: primerError(datos.error) };

  const resena = await db.review.findUnique({
    where: { id: datos.data.id },
    select: { id: true, authorName: true, productId: true, status: true },
  });
  if (!resena) return { ok: false, error: "Esa reseña ya no existe." };

  await db.review.update({ where: { id: resena.id }, data: { status: datos.data.estado } });

  await registrarActividad({
    admin,
    action: "update",
    entityType: "review",
    entityId: resena.id,
    summary: `Reseña de ${resena.authorName}: ${resena.status} → ${datos.data.estado}.`,
  });

  await refrescar([resena.productId]);

  return {
    ok: true,
    mensaje:
      datos.data.estado === "approved"
        ? `Reseña de ${resena.authorName} publicada en la tienda.`
        : datos.data.estado === "rejected"
          ? `Reseña de ${resena.authorName} rechazada: ya no se ve en la tienda.`
          : `Reseña de ${resena.authorName} devuelta a pendientes.`,
  };
}

/** Borrado definitivo. La pantalla pide confirmación antes de llegar aquí. */
export async function borrarResena(id: string): Promise<Resultado> {
  const admin = await sesion();
  if (!admin) return { ok: false, error: SIN_SESION };

  const datos = idSchema.safeParse(id);
  if (!datos.success) return { ok: false, error: "Falta la reseña que hay que borrar." };

  const resena = await db.review.findUnique({
    where: { id: datos.data },
    select: { id: true, authorName: true, rating: true, body: true, productId: true },
  });
  if (!resena) return { ok: false, error: "Esa reseña ya no existe." };

  await db.review.delete({ where: { id: resena.id } });

  await registrarActividad({
    admin,
    action: "delete",
    entityType: "review",
    entityId: resena.id,
    // El texto se guarda en la bitácora: un borrado por error deja al menos
    // rastro de lo que decía, que es lo único irrecuperable.
    summary: `Reseña de ${resena.authorName} (${resena.rating}★) borrada.`,
    meta: { texto: resena.body.slice(0, 400), productoId: resena.productId },
  });

  await refrescar([resena.productId]);

  return { ok: true, mensaje: `Reseña de ${resena.authorName} borrada.` };
}

/* ─────────────────────────────── lote ─────────────────────────────── */

/**
 * Acción sobre varias reseñas seleccionadas. Va por formulario nativo: las
 * casillas viven en el DOM, así que la tabla sigue siendo Server Component y no
 * hace falta arrastrar el estado de selección por React.
 */
export async function accionEnLote(_prev: EstadoFormulario, formData: FormData): Promise<EstadoFormulario> {
  const admin = await sesion();
  if (!admin) return { estado: "error", error: SIN_SESION };

  const datos = loteSchema.safeParse({
    ids: formData.getAll("ids").map((v) => String(v)),
    accion: String(formData.get("accion") ?? ""),
  });

  if (!datos.success) {
    return { estado: "error", error: primerError(datos.error) };
  }

  const resenas = await db.review.findMany({
    where: { id: { in: datos.data.ids } },
    select: { id: true, productId: true },
  });
  if (resenas.length === 0) return { estado: "error", error: "Esas reseñas ya no existen." };

  const ids = resenas.map((r) => r.id);
  const cuantas = ids.length;
  const plural = cuantas === 1 ? "reseña" : "reseñas";

  if (datos.data.accion === "delete") {
    await db.review.deleteMany({ where: { id: { in: ids } } });
    await registrarActividad({
      admin,
      action: "delete",
      entityType: "review",
      summary: `${cuantas} ${plural} borradas en lote.`,
      meta: { ids },
    });
    await refrescar(resenas.map((r) => r.productId));
    return { estado: "ok", mensaje: `${cuantas} ${plural} borradas.` };
  }

  await db.review.updateMany({ where: { id: { in: ids } }, data: { status: datos.data.accion } });
  await registrarActividad({
    admin,
    action: "update",
    entityType: "review",
    summary: `${cuantas} ${plural} marcadas como ${datos.data.accion === "approved" ? "aprobadas" : "rechazadas"}.`,
    meta: { ids },
  });
  await refrescar(resenas.map((r) => r.productId));

  return {
    estado: "ok",
    mensaje:
      datos.data.accion === "approved"
        ? `${cuantas} ${plural} publicadas en la tienda.`
        : `${cuantas} ${plural} rechazadas: ya no se ven en la tienda.`,
  };
}
