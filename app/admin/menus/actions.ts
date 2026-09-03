"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { cargarMenu } from "@/lib/navegacion";

/**
 * Mutaciones de los menús: los enlaces del nav de arriba y los del pie.
 *
 * Son dos listas del mismo modelo (MenuItem) separadas por el campo `menu`.
 * Quitar un enlace sí borra la fila —un enlace no guarda contenido, se vuelve a
 * crear en diez segundos—, pero la pantalla lo pide dos veces igualmente: en el
 * móvil, el botón de quitar cae justo donde está el pulgar.
 */

/* ─────────────────────────── contratos ─────────────────────────── */

export type EstadoMenu = {
  ok?: boolean;
  error?: string;
  mensaje?: string;
  errores?: Record<string, string>;
};

const MENUS = ["main", "footer"] as const;

/** Enlace externo, ruta del propio sitio o ancla de la portada. */
const DESTINO_OK = /^(?:https?:\/\/|mailto:|tel:|\/|#)/i;

const EsquemaItem = z.object({
  id: z.string().default(""),
  menu: z.enum(MENUS).default("main"),
  label: z.string().trim().min(1, "Escribe lo que se tiene que leer en el enlace.").max(60, "Un enlace de menú tan largo no cabe."),
  url: z.string().trim().min(1, "Dinos a dónde lleva el enlace.").max(500),
});

/* ─────────────────────────── auditoría ─────────────────────────── */

/** Ver la nota de app/admin/contenido/actions.ts: no se comparte a propósito. */
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
        entityType: "menuItem",
        entityId,
        summary,
        metaJson: JSON.stringify(meta),
      },
    })
    .catch(() => {});
}

/** Nav y pie salen en todas las páginas: se invalida el layout entero. */
function refrescar(): void {
  revalidatePath("/", "layout");
  revalidatePath("/admin/menus");
}

/* ─────────────────────────── guardar ─────────────────────────── */

export async function guardarItemMenu(_prev: EstadoMenu, fd: FormData): Promise<EstadoMenu> {
  const admin = await getAdmin();
  if (!admin) return { error: "Tu sesión caducó. Vuelve a entrar y repite el guardado." };

  const datos = EsquemaItem.safeParse({
    id: String(fd.get("id") ?? ""),
    menu: String(fd.get("menu") ?? "main"),
    label: String(fd.get("label") ?? ""),
    url: String(fd.get("url") ?? ""),
  });

  if (!datos.success) {
    const errores: Record<string, string> = {};
    for (const problema of datos.error.issues) {
      const campo = String(problema.path[0] ?? "");
      if (campo && !errores[campo]) errores[campo] = problema.message;
    }
    return { error: "Revisa los campos marcados.", errores };
  }

  const v = datos.data;
  if (!DESTINO_OK.test(v.url)) {
    return {
      error: "Revisa la dirección.",
      errores: {
        url: "Tiene que empezar por https:// (una web de fuera), por / (una página tuya) o por # (una sección de la portada).",
      },
    };
  }

  if (v.id) {
    const existente = await db.menuItem.findUnique({ where: { id: v.id }, select: { id: true, menu: true } });
    if (!existente) return { error: "Ese enlace ya no existe. Vuelve atrás y recarga." };

    await db.menuItem.update({ where: { id: existente.id }, data: { label: v.label, url: v.url } });
    await registrar(admin, "update", existente.id, `Editó el enlace "${v.label}" del menú ${existente.menu}`, {
      url: v.url,
    });
    refrescar();
    redirect(`/admin/menus?menu=${existente.menu}&ok=guardado`);
  }

  // Nuevo: va al final de su menú. Adivinar dónde quiere ponerlo alguien es
  // peor que dejarlo abajo y que lo suba con las flechas.
  const ultimo = await db.menuItem.aggregate({ where: { menu: v.menu }, _max: { position: true } });
  const creado = await db.menuItem.create({
    data: { menu: v.menu, label: v.label, url: v.url, position: (ultimo._max.position ?? 0) + 1 },
  });

  await registrar(admin, "create", creado.id, `Añadió el enlace "${v.label}" al menú ${v.menu}`, { url: v.url });
  refrescar();
  redirect(`/admin/menus?menu=${v.menu}&ok=creado`);
}

/* ─────────────────────────── orden y visibilidad ─────────────────────────── */

export async function moverItemMenu(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const direccion = String(fd.get("direccion") ?? "");
  const item = await db.menuItem.findUnique({ where: { id }, select: { id: true, menu: true, label: true } });
  if (!item || (direccion !== "arriba" && direccion !== "abajo")) redirect("/admin/menus");

  const hermanos = await db.menuItem.findMany({
    where: { menu: item.menu },
    orderBy: [{ position: "asc" }, { label: "asc" }],
    select: { id: true },
  });
  const indice = hermanos.findIndex((h) => h.id === item.id);
  const destino = direccion === "arriba" ? indice - 1 : indice + 1;
  if (indice < 0 || destino < 0 || destino >= hermanos.length) redirect(`/admin/menus?menu=${item.menu}`);

  const nuevo = [...hermanos];
  nuevo[indice] = hermanos[destino];
  nuevo[destino] = hermanos[indice];
  await db.$transaction(nuevo.map((h, i) => db.menuItem.update({ where: { id: h.id }, data: { position: i } })));

  await registrar(admin, "update", item.id, `Cambió el orden del enlace "${item.label}"`);
  refrescar();
  redirect(`/admin/menus?menu=${item.menu}`);
}

export async function alternarItemMenu(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const item = await db.menuItem.findUnique({
    where: { id },
    select: { id: true, menu: true, label: true, isVisible: true },
  });
  if (!item) redirect("/admin/menus");

  await db.menuItem.update({ where: { id: item.id }, data: { isVisible: !item.isVisible } });
  await registrar(admin, "update", item.id, `${item.isVisible ? "Ocultó" : "Mostró"} el enlace "${item.label}"`);

  refrescar();
  redirect(`/admin/menus?menu=${item.menu}`);
}

export async function eliminarItemMenu(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const item = await db.menuItem.findUnique({ where: { id }, select: { id: true, menu: true, label: true } });
  if (!item) redirect("/admin/menus");

  await db.menuItem.delete({ where: { id: item.id } });
  await registrar(admin, "delete", item.id, `Quitó el enlace "${item.label}" del menú ${item.menu}`);

  refrescar();
  redirect(`/admin/menus?menu=${item.menu}&ok=quitado`);
}

/* ─────────────────────────── siembra ─────────────────────────── */

/**
 * Copia a la base los enlaces que la web enseña HOY, para que Madeline no parta
 * de una lista en blanco y no tenga que reescribir lo que ya tiene.
 *
 * Los textos y destinos NO se escriben aquí: se leen de `lib/navegacion.ts`, que
 * es la misma fuente que usa el escaparate cuando la tabla está vacía. Es
 * deliberado — cuando estaban duplicados, sembrar cambiaba "Nuevas Llegadas" por
 * "Nuevas llegadas" sin que nadie lo hubiera pedido.
 *
 * El pie se siembra con los enlaces de su columna "Tienda". Las páginas legales
 * NO se copian aquí: el pie ya las lista solo, en su propio bloque, en cuanto
 * están publicadas y marcadas "sale en el pie". Meterlas también en el menú las
 * enseñaría dos veces.
 *
 * Se siembra menú por menú y solo si está vacío: un menú con enlaces es trabajo
 * de ella y no se pisa.
 */
export async function sembrarMenus(fd?: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const pedido = String(fd?.get("menu") ?? "");
  const objetivo = MENUS.filter((m) => (pedido === "main" || pedido === "footer" ? m === pedido : true));

  const existentes = await db.menuItem.findMany({ select: { menu: true } });
  const resumen: string[] = [];

  for (const menu of objetivo) {
    if (existentes.some((e) => e.menu === menu)) continue;

    // `cargarMenu`, no `menuPorDefecto`: el botón promete copiar «los enlaces que
    // ya tenía la web», y la web no enseña los que apuntan a una sección apagada.
    // Sembrarlos crearía enlaces rotos y un aviso rojo nada más pulsar.
    const enlaces = await cargarMenu(menu);
    await db.$transaction(
      enlaces.map((enlace, i) =>
        db.menuItem.create({ data: { menu, label: enlace.label, url: enlace.href, position: i } }),
      ),
    );
    resumen.push(`${enlaces.length} en ${menu}`);
  }

  if (resumen.length === 0) redirect(`/admin/menus?menu=${pedido === "footer" ? "footer" : "main"}`);

  await registrar(admin, "create", null, `Copió los enlaces que ya tenía la web: ${resumen.join(" y ")}`);
  refrescar();
  redirect(`/admin/menus?menu=${pedido === "footer" ? "footer" : "main"}&ok=sembrado`);
}
