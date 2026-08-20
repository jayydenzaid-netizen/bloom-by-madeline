"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import {
  actualizarAlt,
  deleteAsset,
  importFromUrl,
  listarMedios,
  moverACarpeta,
  type MedioVista,
  type ResultadoBorrado,
  type UsoMedio,
} from "@/lib/media";

/**
 * Mutaciones de la biblioteca de medios.
 *
 * Todas siguen la misma disciplina: sesión válida, entrada validada con zod y
 * un resultado TIPADO de vuelta. Ninguna lanza. Una excepción que sube hasta
 * React deja a Madeline delante de una pantalla de error genérica sin saber si
 * la foto se subió o no; un objeto `{ ok: false, error }` le dice qué pasó.
 *
 * Lo que NO está aquí: la subida de ficheros. Vive en /api/media/upload porque
 * la barra de progreso necesita XMLHttpRequest, y eso necesita una URL.
 */

/* ─────────────────────────────── contratos ─────────────────────────────── */

export type EstadoSimple = { ok: boolean; mensaje?: string; error?: string };

export type EstadoImportacion = {
  ok?: boolean;
  mensaje?: string;
  error?: string;
  /** Un renglón por URL pegada, en el mismo orden. */
  detalles?: { url: string; ok: boolean; error?: string }[];
};

export type ResultadoBorrar =
  | { ok: true; mensaje: string }
  | { ok: false; error: string; usos?: UsoMedio[]; requiereConfirmacion?: boolean };

export type ResultadoBorrarVarios = {
  borrados: number;
  /** Las que no se tocaron porque están en uso, con el detalle de dónde. */
  bloqueadas: { id: string; nombre: string; usos: UsoMedio[] }[];
  error?: string;
};

const SIN_SESION = "Tu sesión caducó. Vuelve a entrar y repite la operación.";

/** Todo lo que cambia la biblioteca refresca estas rutas. */
function refrescar(): void {
  revalidatePath("/admin/medios");
}

function textoError(error: unknown): string {
  return error instanceof Error ? error.message : "error desconocido";
}

/* ───────────────────────────── importar por URL ───────────────────────────── */

const EsquemaImportacion = z.object({
  urls: z.string().min(1, "Pega al menos una dirección de imagen."),
  carpeta: z.string().max(60).default(""),
});

/**
 * Añade imágenes pegando enlaces, uno por línea.
 *
 * Es la vía práctica para las fotos de proveedor: sus CDN caducan, y bajarlas a
 * la biblioteca una sola vez evita que la tienda amanezca sin fotos. Cada URL se
 * informa por separado; que una falle no cancela las demás.
 */
export async function importarUrls(_prev: EstadoImportacion, fd: FormData): Promise<EstadoImportacion> {
  const admin = await getAdmin();
  if (!admin) return { error: SIN_SESION };

  const datos = EsquemaImportacion.safeParse({
    urls: String(fd.get("urls") ?? ""),
    carpeta: String(fd.get("carpeta") ?? ""),
  });
  if (!datos.success) {
    return { error: datos.error.issues[0]?.message ?? "Revisa las direcciones." };
  }

  const lineas = datos.data.urls
    .split(/[\s,]+/)
    .map((linea) => linea.trim())
    .filter(Boolean)
    .slice(0, 30); // tope de cordura: 30 descargas por tanda

  if (lineas.length === 0) return { error: "No encontré ninguna dirección en lo que pegaste." };

  const detalles: EstadoImportacion["detalles"] = [];
  for (const url of lineas) {
    try {
      const resultado = await importFromUrl(url, { folder: datos.data.carpeta, actor: admin });
      detalles.push(resultado.ok ? { url, ok: true } : { url, ok: false, error: resultado.error });
    } catch (error) {
      detalles.push({ url, ok: false, error: textoError(error) });
    }
  }

  refrescar();

  const buenas = detalles.filter((d) => d.ok).length;
  const malas = detalles.length - buenas;

  if (buenas === 0) {
    return { ok: false, error: "No se pudo traer ninguna imagen.", detalles };
  }
  return {
    ok: true,
    mensaje:
      malas === 0
        ? `Se añadieron ${buenas} ${buenas === 1 ? "imagen" : "imágenes"}.`
        : `Se añadieron ${buenas} de ${detalles.length}. Las demás fallaron.`,
    detalles,
  };
}

/* ────────────────────────────── texto alternativo ────────────────────────────── */

const EsquemaAlt = z.object({
  id: z.string().min(1),
  alt: z.string().max(300, "El texto alternativo no puede pasar de 300 caracteres."),
});

/**
 * Guarda el texto alternativo. No es un adorno: es lo que lee quien navega con
 * lector de pantalla y lo que Google usa para entender la foto.
 */
export async function guardarAlt(id: string, alt: string): Promise<EstadoSimple> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: SIN_SESION };

  const datos = EsquemaAlt.safeParse({ id, alt });
  if (!datos.success) return { ok: false, error: datos.error.issues[0]?.message ?? "Texto no válido." };

  try {
    await actualizarAlt(datos.data.id, datos.data.alt, admin);
  } catch (error) {
    return { ok: false, error: `No se pudo guardar: ${textoError(error)}.` };
  }

  refrescar();
  return { ok: true, mensaje: "Texto alternativo guardado." };
}

/* ─────────────────────────────── carpetas ─────────────────────────────── */

const EsquemaMover = z.object({
  ids: z.array(z.string().min(1)).min(1, "Selecciona al menos una imagen."),
  carpeta: z.string().max(60).default(""),
});

/** Mueve imágenes a una carpeta. La carpeta se crea sola al usarla. */
export async function moverCarpeta(ids: string[], carpeta: string): Promise<EstadoSimple> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: SIN_SESION };

  const datos = EsquemaMover.safeParse({ ids, carpeta });
  if (!datos.success) return { ok: false, error: datos.error.issues[0]?.message ?? "Selección no válida." };

  let movidos = 0;
  try {
    movidos = await moverACarpeta(datos.data.ids, datos.data.carpeta, admin);
  } catch (error) {
    return { ok: false, error: `No se pudo mover: ${textoError(error)}.` };
  }

  refrescar();
  const destino = datos.data.carpeta.trim() || "sin carpeta";
  return { ok: true, mensaje: `${movidos} ${movidos === 1 ? "imagen movida" : "imágenes movidas"} a "${destino}".` };
}

/* ──────────────────────────────── borrado ──────────────────────────────── */

const EsquemaBorrar = z.object({
  id: z.string().min(1),
  confirmado: z.boolean().default(false),
});

/**
 * Borra una imagen. La primera llamada va SIN confirmar a propósito: si la foto
 * está puesta en un producto o en la portada, devuelve la lista de sitios y no
 * borra nada. Solo un segundo gesto explícito de la usuaria fuerza el borrado.
 */
export async function borrarMedio(id: string, confirmado = false): Promise<ResultadoBorrar> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: SIN_SESION };

  const datos = EsquemaBorrar.safeParse({ id, confirmado });
  if (!datos.success) return { ok: false, error: "No sé qué imagen quieres borrar." };

  let resultado: ResultadoBorrado;
  try {
    resultado = await deleteAsset(datos.data.id, { confirmado: datos.data.confirmado, actor: admin });
  } catch (error) {
    return { ok: false, error: `No se pudo borrar: ${textoError(error)}.` };
  }

  if (!resultado.ok) {
    return { ok: false, error: resultado.error, usos: resultado.usos, requiereConfirmacion: Boolean(resultado.usos) };
  }

  refrescar();
  return { ok: true, mensaje: `Se borró ${resultado.filename}.` };
}

const EsquemaBorrarVarios = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });

/**
 * Borra varias imágenes de golpe, pero NUNCA a ciegas: las que estén en uso se
 * dejan intactas y se devuelven con el detalle de dónde aparecen, para que
 * Madeline decida una por una.
 */
export async function borrarMedios(ids: string[]): Promise<ResultadoBorrarVarios> {
  const admin = await getAdmin();
  if (!admin) return { borrados: 0, bloqueadas: [], error: SIN_SESION };

  const datos = EsquemaBorrarVarios.safeParse({ ids });
  if (!datos.success) return { borrados: 0, bloqueadas: [], error: "Selección no válida." };

  const bloqueadas: ResultadoBorrarVarios["bloqueadas"] = [];
  let borrados = 0;

  for (const id of datos.data.ids) {
    try {
      const resultado = await deleteAsset(id, { actor: admin });
      if (resultado.ok) borrados += 1;
      else if (resultado.usos?.length) {
        bloqueadas.push({ id, nombre: resultado.filename ?? "una imagen", usos: resultado.usos });
      }
    } catch {
      // Una que falle no puede parar la tanda; queda sin borrar y se ve en la rejilla.
    }
  }

  refrescar();
  return { borrados, bloqueadas };
}

/* ─────────────────────── consulta para el MediaPicker ─────────────────────── */

const EsquemaBusqueda = z.object({
  consulta: z.string().max(120).default(""),
  carpeta: z.string().max(60).nullable().default(null),
});

/**
 * Devuelve imágenes de la biblioteca. La usa `MediaPicker` desde otros módulos
 * para que nadie tenga que volver a pegar URLs a mano en un formulario.
 */
export async function buscarMedios(consulta = "", carpeta: string | null = null): Promise<MedioVista[]> {
  const admin = await getAdmin();
  if (!admin) return [];

  const datos = EsquemaBusqueda.safeParse({ consulta, carpeta });
  if (!datos.success) return [];

  return listarMedios({ consulta: datos.data.consulta, carpeta: datos.data.carpeta, limite: 120 });
}
