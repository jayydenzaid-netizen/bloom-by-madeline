"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  contarLimpiables,
  exportAllJson,
  exportShopifyCsv,
  importAll,
  limpiarCarritos,
  limpiarImportacionesFallidas,
  nombreArchivoCopia,
  nombreArchivoCsv,
  type ModoImportacion,
} from "@/lib/backup";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizarRuta } from "@/lib/seo";

/**
 * Mutaciones de la pantalla de Herramientas: copias, restauración, SEO,
 * redirecciones y limpieza.
 *
 * Aquí vive casi todo lo irreversible del panel, así que se repite un patrón:
 * **nada destructivo pasa en un solo gesto**. La pantalla enseña primero un
 * aviso con lo que se va a borrar y cuántos registros son, y solo entonces
 * aparece el botón rojo. Cuando el borrado es de verdad grave (reemplazar la
 * tienda) hace falta además teclear una palabra a mano.
 */

/* ─────────────────────────── auditoría ─────────────────────────── */

/**
 * Rastro en ActivityLog. No se comparte con otros módulos a propósito: cada uno
 * escribe su `entityType` y así el historial se puede filtrar por área.
 * Nunca tumba la acción: si el registro falla, la acción ya ocurrió.
 */
async function registrar(
  admin: { id: string; email: string },
  action: string,
  entityType: string,
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
        entityType,
        entityId,
        summary,
        metaJson: JSON.stringify(meta),
      },
    })
    .catch(() => {});
}

/** Vuelve a la pantalla con un mensaje corto. Los textos largos se recortan. */
function volver(parametros: Record<string, string>): never {
  const query = new URLSearchParams();
  for (const [clave, valor] of Object.entries(parametros)) {
    if (valor) query.set(clave, valor.slice(0, 300));
  }
  redirect(`/admin/herramientas?${query.toString()}`);
}

/* ═══════════════════════════ copias de seguridad ═══════════════════════════ */

export type ArchivoGenerado =
  | { ok: true; nombre: string; contenido: string; bytes: number }
  | { ok: false; error: string };

/**
 * Genera el JSON de la copia y lo devuelve al navegador, que lo guarda como
 * fichero. Se hace así, y no con un enlace a una ruta, porque un enlace a un
 * fichero de copia es una dirección adivinable con TODOS los pedidos y datos de
 * las clientas dentro. Por un Server Action solo pasa quien tiene sesión.
 */
export async function generarCopia(): Promise<ArchivoGenerado> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: "Tu sesión caducó. Vuelve a entrar y repite la descarga." };

  try {
    const contenido = await exportAllJson();
    const nombre = nombreArchivoCopia();
    await registrar(admin, "export", "backup", null, "Descargó una copia de seguridad completa", {
      bytes: contenido.length,
      nombre,
    });
    return { ok: true, nombre, contenido, bytes: contenido.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No se pudo generar la copia." };
  }
}

/** El catálogo en el CSV de la plantilla de productos de Shopify. */
export async function generarCsvShopify(): Promise<ArchivoGenerado> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: "Tu sesión caducó. Vuelve a entrar y repite la descarga." };

  try {
    const contenido = await exportShopifyCsv();
    const nombre = nombreArchivoCsv();
    await registrar(admin, "export", "backup", null, "Exportó el catálogo al CSV de Shopify", {
      bytes: contenido.length,
      nombre,
    });
    return { ok: true, nombre, contenido, bytes: contenido.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "No se pudo generar el CSV." };
  }
}

/** 25 MB. Una copia de esta tienda pesa kilobytes; esto es solo un tope sano. */
const MAX_BYTES_COPIA = 25 * 1024 * 1024;

/**
 * Restaura desde un fichero de copia.
 *
 * Va por formulario normal (sin JavaScript) para que funcione igual en el móvil
 * de Madeline. Al terminar redirige con el resultado: así un F5 no repite la
 * restauración.
 */
export async function restaurarCopia(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const archivo = fd.get("archivo");
  const modo: ModoImportacion = String(fd.get("modo") ?? "anadir") === "reemplazar" ? "reemplazar" : "anadir";
  const confirmacion = String(fd.get("confirmacion") ?? "");

  if (!(archivo instanceof File) || archivo.size === 0) {
    volver({ error: "Elige primero el fichero .json de la copia." });
  }
  if (archivo.size > MAX_BYTES_COPIA) {
    volver({ error: "Ese fichero pesa demasiado para ser una copia de esta tienda." });
  }

  const texto = await archivo.text();
  const resultado = await importAll(texto, { modo, confirmacion });

  if (!resultado.ok) {
    volver({ error: resultado.error, pista: resultado.pista ?? "" });
  }

  await registrar(
    admin,
    "import",
    "backup",
    null,
    modo === "reemplazar" ? "Reemplazó la tienda con una copia de seguridad" : "Restauró datos desde una copia",
    { modo, creados: resultado.creados, omitidos: resultado.omitidos, archivo: archivo.name },
  );

  // Cambia media tienda: se refresca el escaparate entero y el panel.
  revalidatePath("/", "layout");
  revalidatePath("/admin", "layout");

  volver({ ok: resultado.mensaje });
}

/* ═══════════════════════════ SEO ═══════════════════════════ */

const EsquemaSeo = z.object({
  tipo: z.enum(["producto", "pagina"]),
  id: z.string().min(1),
  seoTitle: z.string().trim().max(200, "El título SEO no puede pasar de 200 caracteres.").default(""),
  seoDescription: z.string().trim().max(400, "La descripción SEO no puede pasar de 400 caracteres.").default(""),
});

export type ResultadoSeo = { ok: true; mensaje: string } | { ok: false; error: string };

/**
 * Guarda el título y la descripción SEO de un producto o de una página.
 *
 * Se llama desde la edición en línea del panel de SEO, que manda un objeto (no
 * un FormData): son dos campos y así el componente no tiene que montar un
 * formulario por fila.
 *
 * Guardar vacío es legítimo y significa «usa el texto por defecto»: se guarda
 * `null`, no la cadena vacía, para que la ficha pueda distinguir «no lo he
 * escrito» de «lo he dejado en blanco a propósito».
 */
export async function guardarSeo(entrada: {
  tipo: "producto" | "pagina";
  id: string;
  seoTitle: string;
  seoDescription: string;
}): Promise<ResultadoSeo> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: "Tu sesión caducó. Vuelve a entrar y repite el guardado." };

  const datos = EsquemaSeo.safeParse(entrada);
  if (!datos.success) return { ok: false, error: datos.error.issues[0]?.message ?? "Revisa lo que escribiste." };

  const { tipo, id, seoTitle, seoDescription } = datos.data;
  const campos = { seoTitle: seoTitle || null, seoDescription: seoDescription || null };

  if (tipo === "producto") {
    const producto = await db.product.findUnique({ where: { id }, select: { id: true, slug: true, title: true } });
    if (!producto) return { ok: false, error: "Ese producto ya no existe. Recarga la pantalla." };

    await db.product.update({ where: { id }, data: campos });
    await registrar(admin, "update", "product", id, `Cambió el SEO de "${producto.title}"`, campos);
    revalidatePath(`/producto/${producto.slug}`);
  } else {
    const pagina = await db.page.findUnique({ where: { id }, select: { id: true, slug: true, title: true } });
    if (!pagina) return { ok: false, error: "Esa página ya no existe. Recarga la pantalla." };

    await db.page.update({ where: { id }, data: campos });
    await registrar(admin, "update", "page", id, `Cambió el SEO de la página "${pagina.title}"`, campos);
    revalidatePath(`/pagina/${pagina.slug}`);
  }

  revalidatePath("/admin/herramientas");
  return { ok: true, mensaje: "Guardado." };
}

/* ═══════════════════════════ redirecciones ═══════════════════════════ */

const EsquemaRedireccion = z
  .object({
    fromPath: z.string().trim().min(2, "Escribe la dirección vieja, empezando por /."),
    toPath: z.string().trim().min(1, "Escribe a dónde tiene que llevar."),
  })
  .refine((v) => normalizarRuta(v.fromPath) !== normalizarRuta(v.toPath), {
    message: "La dirección vieja y la nueva son la misma: eso daría vueltas sin fin.",
  });

export async function crearRedireccion(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const datos = EsquemaRedireccion.safeParse({
    fromPath: String(fd.get("fromPath") ?? ""),
    toPath: String(fd.get("toPath") ?? ""),
  });

  if (!datos.success) {
    volver({ error: datos.error.issues[0]?.message ?? "Revisa la redirección." });
  }

  const desde = normalizarRuta(datos.data.fromPath);
  // El destino admite una dirección completa (por si algún día apunta fuera),
  // pero si es interna se normaliza igual para no guardar barras de más.
  const destinoCrudo = datos.data.toPath.trim();
  const hacia = /^https?:\/\//i.test(destinoCrudo) ? destinoCrudo : normalizarRuta(destinoCrudo);

  if (desde === "/") {
    volver({ error: "La portada no se puede redirigir desde aquí." });
  }
  if (desde.startsWith("/admin")) {
    volver({ error: "No se pueden redirigir direcciones del panel." });
  }

  const yaExiste = await db.redirect.findUnique({ where: { fromPath: desde }, select: { id: true } });
  if (yaExiste) {
    volver({ error: `Ya hay una redirección para ${desde}. Bórrala antes de crear otra.` });
  }

  const creada = await db.redirect.create({ data: { fromPath: desde, toPath: hacia } });
  await registrar(admin, "create", "redirect", creada.id, `Creó la redirección ${desde} → ${hacia}`);

  volver({ ok: `Redirección creada: ${desde} lleva ahora a ${hacia}.` });
}

export async function eliminarRedireccion(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const redireccion = await db.redirect.findUnique({ where: { id } });
  if (!redireccion) {
    volver({ error: "Esa redirección ya no existe." });
  }

  await db.redirect.delete({ where: { id } });
  await registrar(
    admin,
    "delete",
    "redirect",
    id,
    `Borró la redirección ${redireccion.fromPath} → ${redireccion.toPath}`,
    { hits: redireccion.hits },
  );

  volver({ ok: `Borrada la redirección de ${redireccion.fromPath}. Ese enlace vuelve a dar página no encontrada.` });
}

/* ═══════════════════════════ limpieza ═══════════════════════════ */

/**
 * Borra datos caducados. Dos cerrojos:
 *  1. la pantalla obliga a pasar por el aviso (`?limpiar=…`) antes de enseñar
 *     el botón rojo;
 *  2. el formulario manda cuántos registros se le prometieron, y si al llegar
 *     aquí la cuenta ya no cuadra (otra pestaña, otro día), no se borra nada.
 */
export async function ejecutarLimpieza(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const tipo = String(fd.get("tipo") ?? "");
  const esperados = Number.parseInt(String(fd.get("esperados") ?? ""), 10);
  const actual = await contarLimpiables();

  if (tipo !== "carritos" && tipo !== "importaciones") {
    volver({ error: "No sé qué querías limpiar. Vuelve a intentarlo." });
  }

  const cuentaAhora = tipo === "carritos" ? actual.carritos : actual.importacionesFallidas;
  if (!Number.isFinite(esperados) || esperados !== cuentaAhora) {
    volver({
      error: `La cuenta cambió mientras confirmabas (ahora hay ${cuentaAhora}). No se borró nada: vuelve a mirarlo.`,
    });
  }
  if (cuentaAhora === 0) {
    volver({ ok: "No había nada que limpiar." });
  }

  if (tipo === "carritos") {
    const borrados = await limpiarCarritos();
    await registrar(admin, "delete", "cart", null, `Borró ${borrados} carritos abandonados`, { borrados });
    volver({ ok: `Borrados ${borrados} carritos abandonados.` });
  }

  const borrados = await limpiarImportacionesFallidas();
  await registrar(admin, "delete", "importJob", null, `Borró ${borrados} importaciones fallidas`, { borrados });
  volver({ ok: `Borradas ${borrados} importaciones fallidas.` });
}
