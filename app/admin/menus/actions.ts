"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

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
 * Crea los menús con lo que hoy tiene la web: el nav del sitio en producción
 * (`legacy/index.html`) y, en el pie, las páginas que ya existan y estén
 * marcadas para salir ahí. Si un menú ya tiene enlaces, no se toca.
 */
export async function sembrarMenus(): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const cuantos = await db.menuItem.count();
  if (cuantos > 0) redirect("/admin/menus");

  const principal = [
    { label: "Nuevas llegadas", url: "/tienda" },
    { label: "Filosofía", url: "/#filosofia" },
    { label: "La boutique", url: "/#boutique" },
    { label: "Visítanos", url: "/#visitanos" },
  ];

  await db.$transaction(
    principal.map((item, i) =>
      db.menuItem.create({ data: { menu: "main", label: item.label, url: item.url, position: i } }),
    ),
  );

  // El pie se llena con las páginas que ya existan: si aún no hay ninguna, se
  // queda vacío en vez de inventar enlaces rotos.
  const paginas = await db.page.findMany({
    where: { showInFooter: true },
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: { title: true, slug: true },
  });

  if (paginas.length > 0) {
    await db.$transaction(
      paginas.map((p, i) =>
        db.menuItem.create({ data: { menu: "footer", label: p.title, url: `/pagina/${p.slug}`, position: i } }),
      ),
    );
  }

  await registrar(admin, "create", null, `Sembró los menús: ${principal.length} enlaces arriba y ${paginas.length} en el pie`);
  refrescar();
  redirect("/admin/menus?ok=sembrado");
}
