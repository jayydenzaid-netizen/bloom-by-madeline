// Endpoint de subida de la biblioteca de medios.
//
// Existe como ruta HTTP y no como Server Action por una razón concreta: el
// navegador solo sabe informar del progreso de una subida a través de
// XMLHttpRequest (`upload.onprogress`), y eso necesita una URL. Sin barra de
// progreso, subir doce fotos desde el móvil de la boutique con cobertura mala
// parece que se ha colgado.
//
// Reglas:
//  · Solo con sesión de administradora. Un buzón de ficheros abierto a internet
//    es el fallo de seguridad más caro que puede tener una tienda.
//  · Cada fichero se valida y se responde por separado. Que la número 7 sea un
//    PDF no puede tumbar las otras once.
//  · La respuesta es SIEMPRE JSON con la misma forma, también en los errores:
//    el cliente pinta la lista de fallos a partir de `error`.

import { NextResponse } from "next/server";
import { getAdmin } from "@/lib/auth";
import { MAX_BYTES, saveUpload, type MedioVista } from "@/lib/media";

// Prisma y node:fs: runtime de Node, no edge. Y nada de caché: cada subida es
// un fichero distinto.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ResultadoFichero = {
  nombre: string;
  ok: boolean;
  error?: string;
  aviso?: string;
  asset?: MedioVista;
};

export type RespuestaSubida =
  | { ok: true; subidos: number; fallidos: number; resultados: ResultadoFichero[] }
  | { ok: false; error: string };

function fallo(error: string, status: number) {
  return NextResponse.json<RespuestaSubida>({ ok: false, error }, { status });
}

export async function POST(request: Request) {
  const admin = await getAdmin();
  if (!admin) return fallo("Tu sesión caducó. Vuelve a entrar y repite la subida.", 401);

  const tipoContenido = request.headers.get("content-type") ?? "";
  if (!tipoContenido.toLowerCase().includes("multipart/form-data")) {
    return fallo("La subida tiene que venir como formulario con ficheros.", 415);
  }

  let formulario: FormData;
  try {
    formulario = await request.formData();
  } catch {
    // Un fichero enorme revienta aquí antes de llegar a la validación por
    // fichero, así que el mensaje tiene que decir el tope igualmente.
    return fallo(`No se pudo leer la subida. El tope por foto son ${Math.round(MAX_BYTES / (1024 * 1024))} MB.`, 413);
  }

  const carpeta = String(formulario.get("carpeta") ?? "");
  const alt = String(formulario.get("alt") ?? "");

  // Se acepta tanto "file" (una a una, que es como sube el panel para poder
  // enseñar progreso) como "files" (tanda entera de golpe).
  const entradas = [...formulario.getAll("file"), ...formulario.getAll("files")];
  const ficheros = entradas.filter((entrada): entrada is File => entrada instanceof File);

  if (ficheros.length === 0) return fallo("No llegó ningún fichero.", 400);

  const resultados: ResultadoFichero[] = [];
  for (const fichero of ficheros) {
    const nombre = fichero.name || "imagen";
    try {
      const resultado = await saveUpload(fichero, { folder: carpeta, alt, actor: admin });
      if (resultado.ok) {
        resultados.push({ nombre, ok: true, asset: resultado.asset, aviso: resultado.aviso });
      } else {
        resultados.push({ nombre, ok: false, error: resultado.error });
      }
    } catch (error) {
      // Una excepción inesperada de una sola foto tampoco tumba la tanda.
      resultados.push({
        nombre,
        ok: false,
        error: error instanceof Error ? error.message : "Error inesperado al guardar.",
      });
    }
  }

  const subidos = resultados.filter((r) => r.ok).length;
  return NextResponse.json<RespuestaSubida>({
    ok: true,
    subidos,
    fallidos: resultados.length - subidos,
    resultados,
  });
}

/** Un GET aquí casi siempre es alguien probando la URL a mano. */
export async function GET() {
  return fallo("Este endpoint solo acepta POST con ficheros.", 405);
}
