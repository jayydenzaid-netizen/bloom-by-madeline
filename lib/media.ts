// Biblioteca de medios — capa de servidor.
//
// Aquí vive TODO lo que escribe o borra ficheros de imagen del sitio. Es el
// único sitio del proyecto autorizado a componer una ruta dentro de
// `public/uploads`, y por eso está escrito a la defensiva:
//
//  · El nombre del fichero NUNCA sale del cliente. Se construye desde cero
//    (raíz saneada + marca de tiempo + azar) y la extensión sale de una lista
//    blanca elegida por el tipo REAL del contenido, no por lo que diga nadie.
//    Usar `file.name` tal cual es el camino clásico para escribir tres carpetas
//    más arriba con un nombre como `../../../.env`.
//  · El tipo se comprueba leyendo los bytes mágicos de la cabecera. El
//    `content-type` que manda el navegador es un dato del cliente, o sea, una
//    sugerencia.
//  · Antes de escribir se vuelve a resolver la ruta y se comprueba que sigue
//    dentro de la carpeta. Cinturón y tirantes: si algún día alguien toca el
//    saneador, el escape sigue sin ocurrir.
//
// La "carpeta" (`MediaAsset.folder`) es una ETIQUETA de organización, no una
// ruta del disco: todos los ficheros viven planos en `public/uploads`. Así
// renombrar una carpeta no mueve nada ni rompe ninguna URL ya publicada, y no
// hay una segunda vía por la que colar separadores de ruta.

import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";

/* ───────────────────────────── límites ───────────────────────────── */

/**
 * 8 MB por fichero. Una foto de móvil ronda los 3-5 MB; por encima de esto casi
 * siempre es un fichero equivocado (un vídeo, un PSD).
 */
export const MAX_BYTES = 8 * 1024 * 1024;

export const TIPOS_PERMITIDOS = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"] as const;
export type TipoImagen = (typeof TIPOS_PERMITIDOS)[number];

/** Extensión con la que se GUARDA cada tipo real. Una sola por tipo. */
const EXTENSION_DE: Record<TipoImagen, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
};

/** Extensiones que el cliente puede traer sin que se considere una mentira. */
const EXTENSIONES_COHERENTES: Record<TipoImagen, string[]> = {
  "image/jpeg": [".jpg", ".jpeg", ".jpe", ".jfif"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/avif": [".avif", ".avifs"],
  "image/gif": [".gif"],
};

/** Valor para el atributo accept del <input type="file">. */
export const TIPOS_ACEPTA_HTML = TIPOS_PERMITIDOS.join(",");

const DIR_UPLOADS = path.join(process.cwd(), "public", "uploads");
const TIEMPO_MAXIMO_DESCARGA_MS = 20_000;

/* ───────────────────────────── contratos ───────────────────────────── */

export type MedioVista = {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  alt: string;
  folder: string;
  /** ISO, para poder cruzar la frontera servidor→cliente sin sorpresas. */
  createdAt: string;
};

/** Dónde está usada una imagen. Se enseña ANTES de borrar nada. */
export type UsoMedio = {
  tipo: "producto" | "variante" | "coleccion" | "portada" | "pagina";
  etiqueta: string;
  titulo: string;
  href?: string;
};

export type ResultadoSubida = { ok: true; asset: MedioVista; aviso?: string } | { ok: false; error: string };

export type ResultadoBorrado =
  | { ok: true; filename: string; ficheroBorrado: boolean }
  | { ok: false; error: string; usos?: UsoMedio[]; filename?: string };

export type Actor = { id?: string | null; email?: string | null } | null | undefined;

export type OpcionesSubida = {
  folder?: string | null;
  alt?: string | null;
  actor?: Actor;
};

/* ────────────────────────── utilidades varias ────────────────────────── */

/** Pasa cualquier texto a un identificador seguro: solo [a-z0-9-]. */
function sanear(texto: string, largo: number): string {
  return (texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, largo)
    .toLowerCase();
}

/**
 * Normaliza el nombre de carpeta. Es solo una etiqueta, pero se sanea igual:
 * mañana alguien la usará para construir algo y más vale que ya venga limpia.
 */
export function sanearCarpeta(folder: string | null | undefined): string {
  return sanear(String(folder ?? ""), 32);
}

/** Peso legible para la interfaz: 1048576 -> "1,0 MB". */
export function formatearPeso(bytes: number): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function mensaje(error: unknown): string {
  return error instanceof Error ? error.message : "error desconocido";
}

export function aVista(asset: {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  alt: string;
  folder: string;
  createdAt: Date;
}): MedioVista {
  return { ...asset, createdAt: asset.createdAt.toISOString() };
}

/* ────────────────── tipo real: bytes mágicos, no promesas ────────────────── */

/**
 * Deduce el tipo mirando la cabecera del fichero. Devuelve null si no es
 * ninguno de los cinco formatos que aceptamos: un PDF renombrado a .jpg muere
 * aquí, y con él la vía más cómoda de subir algo ejecutable a /public.
 */
export function detectarTipo(buffer: Buffer): TipoImagen | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  const cabecera6 = buffer.toString("latin1", 0, 6);
  if (cabecera6 === "GIF87a" || cabecera6 === "GIF89a") return "image/gif";

  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }

  // AVIF es un contenedor ISOBMFF: "ftyp" en 4..8 y la marca principal en 8..12.
  if (buffer.toString("latin1", 4, 8) === "ftyp") {
    const marca = buffer.toString("latin1", 8, 12);
    if (marca === "avif" || marca === "avis") return "image/avif";
    // Algunos codificadores ponen otra marca principal y dejan "avif" entre las
    // compatibles, que van justo detrás en bloques de 4 bytes.
    const compatibles = buffer.toString("latin1", 16, Math.min(buffer.length, 64));
    if (compatibles.includes("avif")) return "image/avif";
  }

  return null;
}

/* ─────────────────── ancho y alto sin depender de nadie ─────────────────── */

type Dimensiones = { width: number; height: number };

const SIN_DIMENSIONES: Dimensiones = { width: 0, height: 0 };

function medirPng(b: Buffer): Dimensiones {
  if (b.length < 24) return SIN_DIMENSIONES;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function medirGif(b: Buffer): Dimensiones {
  if (b.length < 10) return SIN_DIMENSIONES;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function medirJpeg(b: Buffer): Dimensiones {
  // Se recorren los segmentos hasta dar con un SOF (marcador de trama), que es
  // el único que lleva las dimensiones reales.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marcador = b[i + 1];
    if (marcador === 0xd8 || marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      i += 2;
      continue;
    }
    const largo = b.readUInt16BE(i + 2);
    const esSOF = marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc;
    if (esSOF) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    if (largo < 2) return SIN_DIMENSIONES;
    i += 2 + largo;
  }
  return SIN_DIMENSIONES;
}

function medirWebp(b: Buffer): Dimensiones {
  if (b.length < 30) return SIN_DIMENSIONES;
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const ancho = b[24] | (b[25] << 8) | (b[26] << 16);
    const alto = b[27] | (b[28] << 8) | (b[29] << 16);
    return { width: ancho + 1, height: alto + 1 };
  }
  return SIN_DIMENSIONES;
}

function medirAvif(b: Buffer): Dimensiones {
  // Parsear ISOBMFF entero sería desproporcionado para esto: basta con localizar
  // la caja `ispe` (image spatial extents), que lleva versión+flags (4 bytes) y
  // después ancho y alto en 32 bits.
  const indice = b.indexOf("ispe", 0, "latin1");
  if (indice < 0 || indice + 16 > b.length) return SIN_DIMENSIONES;
  const width = b.readUInt32BE(indice + 8);
  const height = b.readUInt32BE(indice + 12);
  if (width <= 0 || height <= 0 || width > 40000 || height > 40000) return SIN_DIMENSIONES;
  return { width, height };
}

/**
 * Ancho y alto de la imagen. Primero con un lector de cabeceras propio (rápido
 * y sin dependencias); si ese no lo saca, se intenta con sharp, que viene
 * dentro de Next. Si tampoco, se guardan 0 y no pasa nada: son un dato
 * informativo y no pueden tumbar una subida.
 */
export async function medirImagen(buffer: Buffer, tipo: TipoImagen): Promise<Dimensiones> {
  let dimensiones = SIN_DIMENSIONES;
  try {
    if (tipo === "image/png") dimensiones = medirPng(buffer);
    else if (tipo === "image/gif") dimensiones = medirGif(buffer);
    else if (tipo === "image/jpeg") dimensiones = medirJpeg(buffer);
    else if (tipo === "image/webp") dimensiones = medirWebp(buffer);
    else if (tipo === "image/avif") dimensiones = medirAvif(buffer);
  } catch {
    dimensiones = SIN_DIMENSIONES;
  }
  if (dimensiones.width > 0 && dimensiones.height > 0) return dimensiones;

  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buffer).metadata();
    if (meta.width && meta.height) return { width: meta.width, height: meta.height };
  } catch {
    // sharp puede no estar disponible según cómo se empaquete: no es un error.
  }
  return SIN_DIMENSIONES;
}

/* ──────────────────────── nombre y ruta de destino ──────────────────────── */

/**
 * Nombre de fichero seguro. La raíz se saca del nombre del cliente SOLO para
 * que a Madeline le siga sonando ("vestido-rojo-..."), pero pasada por el
 * saneador, que borra puntos y barras: "../../etc/passwd" queda en "etc-passwd".
 */
export function nombreSeguro(nombreCliente: string | null | undefined, tipo: TipoImagen): string {
  const sinExtension = String(nombreCliente ?? "").replace(/\.[^./\\]*$/, "");
  const raiz = sanear(sinExtension, 48) || "imagen";
  const marca = Date.now().toString(36);
  const azar = randomBytes(3).toString("hex");
  return `${raiz}-${marca}-${azar}${EXTENSION_DE[tipo]}`;
}

/** Resuelve la ruta absoluta y comprueba que no se ha salido de public/uploads. */
function rutaDentroDeUploads(nombre: string): string | null {
  const raiz = path.resolve(DIR_UPLOADS);
  const destino = path.resolve(raiz, nombre);
  if (destino === raiz || !destino.startsWith(raiz + path.sep)) return null;
  return destino;
}

/** Extensión declarada por el cliente, en minúsculas y con punto. "" si no hay. */
function extensionDeclarada(nombre: string | null | undefined): string {
  const limpio = String(nombre ?? "").replace(/[?#].*$/, "");
  const match = /\.([a-zA-Z0-9]{1,6})$/.exec(limpio);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/* ────────────────────────── registro de actividad ────────────────────────── */

/**
 * Deja rastro de quién hizo qué. Nunca puede tumbar la operación principal: si
 * el log falla, la subida ya ocurrió y negarla sería mentir.
 */
async function registrar(
  actor: Actor,
  action: "create" | "update" | "delete",
  entityId: string,
  summary: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.activityLog.create({
      data: {
        userId: actor?.id ?? null,
        userEmail: actor?.email ?? "",
        action,
        entityType: "media",
        entityId,
        summary,
        metaJson: JSON.stringify(meta),
      },
    });
  } catch {
    // silencio deliberado
  }
}

/* ────────────────────── guardar un buffer ya validado ────────────────────── */

/** ¿La URL es de nuestro almacén de fotos en Vercel Blob? */
function esUrlDeBlob(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".vercel-storage.com");
  } catch {
    return false;
  }
}

async function guardarBuffer(
  buffer: Buffer,
  tipo: TipoImagen,
  nombreOriginal: string | null | undefined,
  opciones: OpcionesSubida,
): Promise<ResultadoSubida> {
  const nombre = nombreSeguro(nombreOriginal, tipo);
  const destino = rutaDentroDeUploads(nombre);
  if (!destino) {
    // Inalcanzable con el saneador actual; queda como red de seguridad.
    return { ok: false, error: "El nombre del fichero no es válido." };
  }

  const { width, height } = await medirImagen(buffer, tipo);

  /*
   * DÓNDE SE GUARDA LA FOTO.
   *
   * En el portátil, en `public/uploads`: es cómodo y se ve al instante.
   *
   * En producción NO puede ser el disco. La tienda corre en funciones sin
   * servidor: cada petición puede caer en una máquina distinta y su disco se
   * borra al terminar. Escribir ahí significaba que Madeline subía una foto
   * desde el móvil, la veía un momento… y al rato el producto aparecía sin
   * foto, sin ningún error que lo explicara. Por eso en producción va a Vercel
   * Blob (almacenamiento de verdad, servido por CDN): es lo que hace que subir
   * fotos desde el teléfono funcione.
   */
  let url: string;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { put } = await import("@vercel/blob");
      const subida = await put(`productos/${nombre}`, buffer, {
        access: "public",
        contentType: tipo,
        // El nombre ya lleva su parte aleatoria (ver `nombreSeguro`): sin otro
        // sufijo encima, la URL se queda legible.
        addRandomSuffix: false,
      });
      url = subida.url;
    } catch (error) {
      return { ok: false, error: `No se pudo guardar la foto: ${mensaje(error)}.` };
    }
  } else {
    try {
      await mkdir(DIR_UPLOADS, { recursive: true });
      // "wx" falla si el fichero ya existe: preferimos un error a pisar una foto
      // que ya estuviera publicada en la tienda.
      await writeFile(destino, buffer, { flag: "wx" });
    } catch (error) {
      return { ok: false, error: `No se pudo guardar el fichero: ${mensaje(error)}.` };
    }
    url = `/uploads/${nombre}`;
  }

  const asset = await db.mediaAsset.create({
    data: {
      url,
      filename: nombre,
      mimeType: tipo,
      bytes: buffer.byteLength,
      width,
      height,
      alt: String(opciones.alt ?? "").slice(0, 300),
      folder: sanearCarpeta(opciones.folder),
    },
  });

  await registrar(opciones.actor, "create", asset.id, `Subió la imagen ${nombre}`, {
    bytes: asset.bytes,
    folder: asset.folder,
  });

  const aviso = width === 0 || height === 0 ? "No se pudieron leer las dimensiones de la imagen." : undefined;
  return { ok: true, asset: aVista(asset), aviso };
}

/* ──────────────────────────────── saveUpload ──────────────────────────────── */

/**
 * Guarda un fichero subido desde el navegador en `public/uploads` y lo registra
 * en la biblioteca. Devuelve un resultado tipado en vez de lanzar: quien sube
 * doce fotos de golpe necesita saber cuál falló, no perder la tanda entera.
 */
export async function saveUpload(file: File, opciones: OpcionesSubida = {}): Promise<ResultadoSubida> {
  if (!file || typeof file.arrayBuffer !== "function") {
    return { ok: false, error: "No llegó ningún fichero." };
  }
  if (file.size === 0) return { ok: false, error: "El fichero está vacío." };
  if (file.size > MAX_BYTES) {
    return { ok: false, error: `Pesa ${formatearPeso(file.size)} y el tope son ${formatearPeso(MAX_BYTES)}.` };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // El tamaño se vuelve a medir sobre lo recibido: `file.size` lo declara el cliente.
  if (buffer.byteLength > MAX_BYTES) {
    return { ok: false, error: `Pesa ${formatearPeso(buffer.byteLength)} y el tope son ${formatearPeso(MAX_BYTES)}.` };
  }

  const tipo = detectarTipo(buffer);
  if (!tipo) {
    return { ok: false, error: "No es una imagen JPG, PNG, WebP, AVIF ni GIF." };
  }

  // Solo se rechaza cuando el cliente declara OTRA imagen: un genérico
  // "application/octet-stream" lo mandan Windows y algún móvil viejo con WebP y
  // AVIF perfectamente válidos, y tumbarlos sería un falso positivo. Quien
  // decide es el contenido; la declaración solo sirve para pillar la mentira.
  const declarado = (file.type || "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (declarado.startsWith("image/") && declarado !== tipo) {
    return { ok: false, error: `Dice ser ${declarado} pero por dentro es ${tipo}. No se acepta.` };
  }

  const extension = extensionDeclarada(file.name);
  if (extension && !EXTENSIONES_COHERENTES[tipo].includes(extension)) {
    return { ok: false, error: `La extensión ${extension} no corresponde a un ${tipo}. No se acepta.` };
  }

  return guardarBuffer(buffer, tipo, file.name, opciones);
}

/* ─────────────────────────────── importFromUrl ─────────────────────────────── */

/**
 * Anfitriones que no se descargan nunca: apuntan a la propia máquina o a la red
 * interna, y un importador que los siga es una puerta abierta a la intranet.
 */
function anfitrionProhibido(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

/**
 * Baja una imagen desde una URL externa y la mete en la biblioteca.
 *
 * Es la vía para las fotos de los proveedores: sus CDN caducan y un día la
 * tienda amanece sin fotos. Bajarlas una vez las hace nuestras.
 */
export async function importFromUrl(url: string, opciones: OpcionesSubida = {}): Promise<ResultadoSubida> {
  const texto = String(url ?? "").trim();
  if (!texto) return { ok: false, error: "Falta la dirección de la imagen." };

  let destinoUrl: URL;
  try {
    destinoUrl = new URL(texto);
  } catch {
    return { ok: false, error: "Eso no parece una dirección web." };
  }
  if (destinoUrl.protocol !== "http:" && destinoUrl.protocol !== "https:") {
    return { ok: false, error: "Solo se aceptan direcciones http:// o https://." };
  }
  if (anfitrionProhibido(destinoUrl.hostname)) {
    return { ok: false, error: "Esa dirección apunta a la propia máquina o a la red interna." };
  }

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), TIEMPO_MAXIMO_DESCARGA_MS);
  try {
    const respuesta = await fetch(destinoUrl.toString(), {
      signal: controlador.signal,
      redirect: "follow",
      headers: {
        // Sin cabeceras de navegador varios CDN de proveedores responden 403.
        "User-Agent": "Mozilla/5.0 (compatible; BloomByMadeline/1.0)",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      },
    });
    if (!respuesta.ok) return { ok: false, error: `El servidor respondió ${respuesta.status}.` };

    const declarado = Number(respuesta.headers.get("content-length") ?? "0");
    if (declarado > MAX_BYTES) {
      return { ok: false, error: `Pesa ${formatearPeso(declarado)} y el tope son ${formatearPeso(MAX_BYTES)}.` };
    }

    const buffer = Buffer.from(await respuesta.arrayBuffer());
    if (buffer.byteLength === 0) return { ok: false, error: "La imagen llegó vacía." };
    // El content-length se puede mentir: manda lo realmente recibido.
    if (buffer.byteLength > MAX_BYTES) {
      return { ok: false, error: `Pesa ${formatearPeso(buffer.byteLength)} y el tope son ${formatearPeso(MAX_BYTES)}.` };
    }

    const tipo = detectarTipo(buffer);
    if (!tipo) {
      return { ok: false, error: "Lo que hay en esa dirección no es una imagen JPG, PNG, WebP, AVIF ni GIF." };
    }

    const cabecera = (respuesta.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (cabecera && cabecera.startsWith("image/") && cabecera !== tipo) {
      return { ok: false, error: `El servidor dice ${cabecera} pero el fichero es ${tipo}. No se acepta.` };
    }

    // El nombre se saca de la ruta de la URL solo como raíz legible; el saneador
    // se encarga de que no aporte ni puntos ni barras.
    const sugerido = decodeURIComponent(destinoUrl.pathname.split("/").pop() ?? "") || destinoUrl.hostname;
    return guardarBuffer(buffer, tipo, sugerido, opciones);
  } catch (error) {
    const causa = controlador.signal.aborted ? "tardó demasiado en responder" : mensaje(error);
    return { ok: false, error: `No se pudo descargar: ${causa}.` };
  } finally {
    clearTimeout(temporizador);
  }
}

/* ─────────────────────────── dónde se está usando ─────────────────────────── */

/**
 * Busca la URL por todo el sitio. Se llama SIEMPRE antes de borrar: una foto
 * borrada a ciegas deja un hueco en la portada que nadie relaciona con esto.
 */
export async function usosDeUrl(url: string): Promise<UsoMedio[]> {
  if (!url) return [];
  const usos: UsoMedio[] = [];

  const [imagenes, variantes, colecciones, bloques, paginas] = await Promise.all([
    db.productImage.findMany({
      where: { OR: [{ url }, { localPath: url }] },
      select: { product: { select: { id: true, title: true } } },
    }),
    db.productVariant.findMany({
      where: { imageUrl: url },
      select: { id: true, title: true, productId: true, product: { select: { title: true } } },
    }),
    db.collection.findMany({ where: { imageUrl: url }, select: { id: true, title: true } }),
    db.homeBlock.findMany({ where: { imageUrl: url }, select: { id: true, kind: true, title: true } }),
    db.page.findMany({ where: { content: { contains: url } }, select: { id: true, title: true } }),
  ]);

  for (const img of imagenes) {
    usos.push({
      tipo: "producto",
      etiqueta: "Producto",
      titulo: img.product.title,
      href: `/admin/productos/${img.product.id}`,
    });
  }
  for (const v of variantes) {
    usos.push({
      tipo: "variante",
      etiqueta: "Variante",
      titulo: `${v.product?.title ?? "Producto"} · ${v.title}`,
      href: `/admin/productos/${v.productId}`,
    });
  }
  for (const c of colecciones) {
    usos.push({ tipo: "coleccion", etiqueta: "Colección", titulo: c.title, href: "/admin/colecciones" });
  }
  for (const b of bloques) {
    usos.push({ tipo: "portada", etiqueta: "Bloque de portada", titulo: b.title || b.kind });
  }
  for (const p of paginas) {
    usos.push({ tipo: "pagina", etiqueta: "Página", titulo: p.title });
  }

  return usos;
}

/* ─────────────────────────────── deleteAsset ─────────────────────────────── */

/**
 * Borra el registro y el fichero. Si la imagen está en uso NO borra nada y
 * devuelve la lista de sitios exactos donde aparece; solo con `confirmado`
 * (segundo gesto explícito de la usuaria) se borra de todas formas.
 */
export async function deleteAsset(
  id: string,
  opciones: { confirmado?: boolean; actor?: Actor } = {},
): Promise<ResultadoBorrado> {
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset) return { ok: false, error: "Esa imagen ya no está en la biblioteca." };

  if (!opciones.confirmado) {
    const usos = await usosDeUrl(asset.url);
    if (usos.length > 0) {
      return {
        ok: false,
        error: `Esta imagen se está usando en ${usos.length} ${usos.length === 1 ? "sitio" : "sitios"}.`,
        usos,
        filename: asset.filename,
      };
    }
  }

  let ficheroBorrado = false;
  // Solo se borra lo que es NUESTRO: el disco en local, o el Blob en
  // producción. Una imagen apuntada al CDN de un proveedor no se toca.
  if (asset.url.startsWith("/uploads/")) {
    const destino = rutaDentroDeUploads(asset.url.slice("/uploads/".length));
    if (destino) {
      try {
        await unlink(destino);
        ficheroBorrado = true;
      } catch {
        // Si el fichero ya no está, el registro se limpia igual: dejar la ficha
        // huérfana sería peor que no tener ninguna.
      }
    }
  } else if (esUrlDeBlob(asset.url) && process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { del } = await import("@vercel/blob");
      await del(asset.url);
      ficheroBorrado = true;
    } catch {
      // Igual que arriba: el registro se limpia aunque el borrado remoto falle.
    }
  }

  await db.mediaAsset.delete({ where: { id } });
  await registrar(opciones.actor, "delete", id, `Borró la imagen ${asset.filename}`, {
    url: asset.url,
    forzado: Boolean(opciones.confirmado),
  });

  return { ok: true, filename: asset.filename, ficheroBorrado };
}

/* ─────────────────────────────── consultas ─────────────────────────────── */

/** Carpetas existentes, con cuántas imágenes tiene cada una. */
export async function listarCarpetas(): Promise<{ folder: string; total: number }[]> {
  const filas = await db.mediaAsset.groupBy({ by: ["folder"], _count: { _all: true } });
  return filas
    .map((f) => ({ folder: f.folder, total: f._count._all }))
    .sort((a, b) => (a.folder === "" ? -1 : b.folder === "" ? 1 : a.folder.localeCompare(b.folder)));
}

/** Listado de la biblioteca con buscador por nombre/alt y filtro por carpeta. */
export async function listarMedios(
  opciones: { consulta?: string; carpeta?: string | null; limite?: number } = {},
): Promise<MedioVista[]> {
  const consulta = String(opciones.consulta ?? "").trim();
  const carpeta = opciones.carpeta;

  const assets = await db.mediaAsset.findMany({
    where: {
      ...(consulta ? { OR: [{ filename: { contains: consulta } }, { alt: { contains: consulta } }] } : {}),
      ...(carpeta === null || carpeta === undefined ? {} : { folder: sanearCarpeta(carpeta) }),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opciones.limite ?? 300, 1), 500),
  });

  return assets.map(aVista);
}

/** Cambia el texto alternativo. Es lo que lee quien no puede ver la foto. */
export async function actualizarAlt(id: string, alt: string, actor?: Actor): Promise<MedioVista> {
  const asset = await db.mediaAsset.update({ where: { id }, data: { alt: String(alt ?? "").slice(0, 300) } });
  await registrar(actor, "update", id, `Cambió el texto alternativo de ${asset.filename}`);
  return aVista(asset);
}

/** Mueve imágenes a una carpeta (etiqueta). "" las saca de toda carpeta. */
export async function moverACarpeta(ids: string[], folder: string, actor?: Actor): Promise<number> {
  const limpios = ids.filter((id) => typeof id === "string" && id.length > 0);
  if (limpios.length === 0) return 0;
  const carpeta = sanearCarpeta(folder);
  const resultado = await db.mediaAsset.updateMany({ where: { id: { in: limpios } }, data: { folder: carpeta } });
  await registrar(actor, "update", limpios[0], `Movió ${resultado.count} imagen(es) a "${carpeta || "sin carpeta"}"`, {
    ids: limpios,
    folder: carpeta,
  });
  return resultado.count;
}
