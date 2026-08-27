"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdminConRol, requireOwner } from "@/lib/permissions";
import { db } from "@/lib/db";
import { KINDS_PORTADA, KINDS_SIEMPRE_VISIBLES, semillaDeBloque, semillaPortada } from "@/lib/home-content";

/**
 * Mutaciones de los bloques de la portada.
 *
 * Un bloque no se borra nunca: se apaga. La portada es la cara del negocio y
 * "quitar" una sección de la que luego no te acuerdas es exactamente el error
 * que no se puede deshacer desde el móvil un sábado a las 7 de la tarde. Por eso
 * aquí solo hay: guardar, ordenar, encender/apagar y restaurar el texto original.
 */

/* ─────────────────────────── contratos ─────────────────────────── */

export type EstadoBloque = {
  ok?: boolean;
  error?: string;
  mensaje?: string;
  errores?: Record<string, string>;
};

/** Aceptamos enlaces externos, rutas del propio sitio y anclas de la portada. */
const DESTINO_OK = /^(?:https?:\/\/|mailto:|tel:|\/|#)/i;

const EsquemaBloque = z.object({
  id: z.string().min(1),
  title: z.string().max(200).default(""),
  subtitle: z.string().max(300).default(""),
  body: z.string().max(4000).default(""),
  imageUrl: z.string().max(500).default(""),
  linkUrl: z.string().max(500).default(""),
  linkLabel: z.string().max(120).default(""),
  items: z.string().max(4000).default(""),
});

/* ─────────────────────────── auditoría ─────────────────────────── */

/**
 * Deja rastro de quién tocó qué. Se repite en cada módulo a propósito: un
 * fichero "use server" solo puede exportar funciones asíncronas, así que un
 * helper compartido se convertiría en un endpoint público sin querer.
 */
async function registrar(
  admin: { id: string; email: string },
  action: string,
  entityId: string | null,
  summary: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await db.activityLog
    .create({
      data: {
        userId: admin.id,
        userEmail: admin.email,
        action,
        entityType: "homeBlock",
        entityId,
        summary,
        metaJson: JSON.stringify(meta),
      },
    })
    // El registro es para poder mirar atrás, no para bloquear el trabajo: si
    // falla, el cambio ya está guardado y no se le puede quitar a Madeline.
    .catch(() => {});
}

/** La portada se sirve cacheada; sin esto el cambio no se ve hasta el redeploy. */
function refrescarPortada(): void {
  revalidatePath("/", "layout");
  revalidatePath("/admin/contenido");
}

/* ─────────────────────────── guardar ─────────────────────────── */

export async function guardarBloque(_prev: EstadoBloque, fd: FormData): Promise<EstadoBloque> {
  // La portada es solo de la dueña: define lo que ve toda clienta.
  const admin = await getAdminConRol();
  if (!admin || admin.role !== "owner") {
    return { error: "Solo la dueña puede editar la portada." };
  }

  const datos = EsquemaBloque.safeParse({
    id: String(fd.get("id") ?? ""),
    title: String(fd.get("title") ?? ""),
    subtitle: String(fd.get("subtitle") ?? ""),
    body: String(fd.get("body") ?? ""),
    imageUrl: String(fd.get("imageUrl") ?? ""),
    linkUrl: String(fd.get("linkUrl") ?? ""),
    linkLabel: String(fd.get("linkLabel") ?? ""),
    items: String(fd.get("items") ?? ""),
  });

  if (!datos.success) {
    return { error: "Hay algo demasiado largo en el formulario. Acorta el texto y prueba otra vez." };
  }
  const v = datos.data;

  const errores: Record<string, string> = {};
  if (v.imageUrl && !DESTINO_OK.test(v.imageUrl)) {
    errores.imageUrl = "Pega una dirección que empiece por https:// o una ruta del sitio como /assets/foto.jpg";
  }
  if (v.linkUrl && !DESTINO_OK.test(v.linkUrl)) {
    errores.linkUrl = "El destino debe empezar por https://, por / (una página del sitio) o por # (una sección).";
  }
  if (Object.keys(errores).length > 0) {
    return { error: "Revisa los campos marcados.", errores };
  }

  const bloque = await db.homeBlock.findUnique({ where: { id: v.id }, select: { id: true, kind: true } });
  if (!bloque) return { error: "Ese bloque ya no existe. Vuelve a la lista y recarga." };

  // Las listas se escriben una por línea porque es lo que una persona hace sin
  // pensar; por dentro viajan como JSON en dataJson.
  const items = v.items
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  await db.homeBlock.update({
    where: { id: v.id },
    data: {
      title: v.title.trim(),
      subtitle: v.subtitle.trim(),
      body: v.body.trim(),
      imageUrl: v.imageUrl.trim() || null,
      linkUrl: v.linkUrl.trim() || null,
      linkLabel: v.linkLabel.trim(),
      dataJson: JSON.stringify({ items }),
    },
  });

  await registrar(admin, "update", bloque.id, `Editó el bloque "${bloque.kind}" de la portada`);
  refrescarPortada();

  return { ok: true, mensaje: "Bloque guardado. Míralo en la portada." };
}

/* ─────────────────────────── orden y visibilidad ─────────────────────────── */

/**
 * Sube o baja un bloque intercambiándolo con su vecino. Se hace con posiciones
 * reales y no con un índice del array porque dos pestañas abiertas a la vez
 * dejarían el orden mentiroso.
 */
export async function moverBloque(fd: FormData): Promise<void> {
  const admin = await requireOwner("contenido");

  const id = String(fd.get("id") ?? "");
  const direccion = String(fd.get("direccion") ?? "");
  if (!id || (direccion !== "arriba" && direccion !== "abajo")) redirect("/admin/contenido");

  const bloques = await db.homeBlock.findMany({
    orderBy: [{ position: "asc" }, { kind: "asc" }],
    select: { id: true, position: true, kind: true },
  });
  const indice = bloques.findIndex((b) => b.id === id);
  const destino = direccion === "arriba" ? indice - 1 : indice + 1;
  if (indice < 0 || destino < 0 || destino >= bloques.length) redirect("/admin/contenido");

  const a = bloques[indice];
  const b = bloques[destino];

  // Se reescriben TODAS las posiciones: si alguna vez quedaron empatadas (dos
  // bloques con position 0), un simple intercambio no arreglaría el orden.
  const nuevo = [...bloques];
  nuevo[indice] = b;
  nuevo[destino] = a;
  await db.$transaction(
    nuevo.map((bloque, i) => db.homeBlock.update({ where: { id: bloque.id }, data: { position: i } })),
  );

  await registrar(admin, "update", a.id, `Movió el bloque "${a.kind}" hacia ${direccion}`);
  refrescarPortada();
  redirect(`/admin/contenido#bloque-${a.id}`);
}

export async function alternarBloque(fd: FormData): Promise<void> {
  const admin = await requireOwner("contenido");

  const id = String(fd.get("id") ?? "");
  const bloque = await db.homeBlock.findUnique({ where: { id }, select: { id: true, kind: true, isVisible: true } });
  if (!bloque) redirect("/admin/contenido");

  // Una portada sin su cabecera no es una portada: es una página rota que
  // empieza por la mitad. La pantalla ya lo explica en vez de ofrecer el botón;
  // esto es el cerrojo de verdad, por si alguien llega aquí por otro camino.
  if (KINDS_SIEMPRE_VISIBLES.includes(bloque.kind)) {
    redirect(`/admin/contenido?aviso=hero-siempre#bloque-${bloque.id}`);
  }

  await db.homeBlock.update({ where: { id: bloque.id }, data: { isVisible: !bloque.isVisible } });
  await registrar(
    admin,
    "update",
    bloque.id,
    `${bloque.isVisible ? "Ocultó" : "Mostró"} el bloque "${bloque.kind}" de la portada`,
  );

  refrescarPortada();
  redirect(`/admin/contenido#bloque-${bloque.id}`);
}

/* ─────────────────────────── siembra ─────────────────────────── */

/**
 * El contenido de la portada NO se escribe aquí: vive en `lib/home-content.ts`,
 * que es lo mismo que pinta la web cuando no hay nada guardado.
 *
 * Que la semilla y los valores por defecto salgan del MISMO sitio es la razón
 * por la que pulsar «Traer los textos de mi web» no puede cambiar cómo se ve la
 * portada: se guarda exactamente lo que ya se estaba pintando. Si estuvieran
 * duplicados, el día que alguien tocara uno de los dos, sembrar movería el
 * escaparate sin que nadie lo pidiera.
 */
function datosDeSemilla(s: {
  title: string;
  subtitle: string;
  body: string;
  imageUrl: string;
  linkUrl: string;
  linkLabel: string;
  items: string[];
}) {
  return {
    title: s.title,
    subtitle: s.subtitle,
    body: s.body,
    imageUrl: s.imageUrl || null,
    linkUrl: s.linkUrl || null,
    linkLabel: s.linkLabel,
    dataJson: JSON.stringify({ items: s.items }),
  };
}

/**
 * Crea los bloques que falten con el contenido que hoy está en la web.
 * No pisa lo que ya exista: se puede llamar dos veces sin miedo.
 */
export async function sembrarBloques(): Promise<void> {
  const admin = await requireOwner("contenido");

  const existentes = await db.homeBlock.findMany({ select: { kind: true } });
  const yaEstan = new Set(existentes.map((b) => b.kind));

  let creados = 0;
  for (const s of semillaPortada()) {
    if (yaEstan.has(s.kind)) continue;
    await db.homeBlock.create({
      data: {
        kind: s.kind,
        position: s.position,
        isVisible: s.isVisible,
        ...datosDeSemilla(s),
      },
    });
    creados++;
  }

  await registrar(admin, "create", null, `Sembró la portada con ${creados} bloques del sitio actual`);
  refrescarPortada();
  redirect("/admin/contenido?ok=sembrado");
}

/**
 * Vuelve a poner en un bloque el texto original del sitio. Es la salida de
 * emergencia de «lo he dejado peor que estaba», y por eso la pantalla la pide
 * dos veces antes de ejecutarla.
 */
export async function restaurarBloque(fd: FormData): Promise<void> {
  const admin = await requireOwner("contenido");

  const id = String(fd.get("id") ?? "");
  const bloque = await db.homeBlock.findUnique({ where: { id }, select: { id: true, kind: true } });
  if (!bloque) redirect("/admin/contenido");

  const s = semillaDeBloque(bloque.kind);
  if (!s) redirect(`/admin/contenido?bloque=${bloque.id}`);

  await db.homeBlock.update({ where: { id: bloque.id }, data: datosDeSemilla(s) });
  await registrar(admin, "update", bloque.id, `Restauró el texto original del bloque "${bloque.kind}"`);

  refrescarPortada();
  redirect(`/admin/contenido?bloque=${bloque.id}&ok=restaurado`);
}

/**
 * Los tipos de bloque que entiende la portada. Se expone para que la pantalla
 * pueda avisar de un bloque huérfano (creado a mano en la base) en vez de
 * enseñarlo como si fuera a salir en la web, porque no saldría.
 */
export async function tiposDeBloque(): Promise<readonly string[]> {
  return KINDS_PORTADA;
}
