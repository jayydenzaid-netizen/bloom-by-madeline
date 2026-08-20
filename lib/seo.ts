import type { MetadataRoute } from "next";
import { db } from "@/lib/db";

/**
 * SEO de la tienda: sitemap, robots y redirecciones.
 *
 * La regla que manda en todo este fichero: **Google solo puede ver lo que una
 * clienta puede ver**. Un borrador listado en el sitemap se indexa, sale en los
 * resultados, y alguien acaba en una página que no existe todavía. Por eso el
 * sitemap se construye SIEMPRE desde la base de datos y filtrando por estado,
 * nunca desde una lista escrita a mano que se queda vieja.
 */

/* ════════════════════════════════ base ════════════════════════════════ */

/**
 * Dirección pública del sitio, sin barra final.
 * En dev vale `http://localhost:4590`; en producción la pone el entorno.
 */
export function urlBase(): string {
  const cruda = process.env.NEXT_PUBLIC_SITE_URL || "https://bloom-by-madeline.vercel.app";
  return cruda.replace(/\/+$/, "");
}

/** `/tienda` → `https://…/tienda`. Sitemap y robots piden URL absolutas. */
export function absoluta(ruta: string): string {
  return `${urlBase()}${ruta.startsWith("/") ? ruta : `/${ruta}`}`;
}

/* ══════════════════════════════ sitemap ══════════════════════════════ */

/**
 * Rutas del escaparate que siempre existen. La portada manda (prioridad 1) y
 * el catálogo va detrás: son las dos puertas de entrada reales de la tienda.
 */
const FIJAS: { ruta: string; prioridad: number; frecuencia: "daily" | "weekly" | "monthly" }[] = [
  { ruta: "/", prioridad: 1, frecuencia: "daily" },
  { ruta: "/tienda", prioridad: 0.9, frecuencia: "daily" },
];

/**
 * Construye el sitemap leyendo la base: portada, catálogo, colecciones
 * visibles, productos activos y páginas publicadas.
 *
 * Lo que queda fuera y por qué:
 *  - productos en `draft` o `archived` y páginas en `draft`: no existen para el
 *    público;
 *  - colecciones con `isVisible: false`: apagadas a propósito;
 *  - `/carrito`, `/checkout`, `/pedido/*`: son de una persona concreta, no
 *    contenido; indexarlas es filtrar pedidos ajenos en Google;
 *  - `/admin/*`: ni existe para nadie que no tenga la llave.
 *
 * `lastModified` sale de `updatedAt` de verdad. Un sitemap que dice que todo
 * cambió hoy es un sitemap que Google deja de creerse.
 */
export async function construirSitemap(): Promise<MetadataRoute.Sitemap> {
  const [productos, colecciones, paginas] = await Promise.all([
    db.product.findMany({
      where: { status: "active" },
      select: { slug: true, updatedAt: true, publishedAt: true },
      orderBy: { updatedAt: "desc" },
    }),
    db.collection.findMany({
      where: { isVisible: true },
      select: { slug: true, updatedAt: true },
      orderBy: { position: "asc" },
    }),
    db.page.findMany({
      where: { status: "published" },
      select: { slug: true, updatedAt: true },
      orderBy: { position: "asc" },
    }),
  ]);

  // La fecha del sitio es la del cambio más reciente que se ve por fuera.
  const masReciente = [...productos, ...colecciones, ...paginas]
    .map((r) => r.updatedAt.getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  const fechaSitio = masReciente > 0 ? new Date(masReciente) : new Date();

  const entradas: MetadataRoute.Sitemap = FIJAS.map((f) => ({
    url: absoluta(f.ruta),
    lastModified: fechaSitio,
    changeFrequency: f.frecuencia,
    priority: f.prioridad,
  }));

  for (const c of colecciones) {
    entradas.push({
      url: absoluta(`/coleccion/${c.slug}`),
      lastModified: c.updatedAt,
      changeFrequency: "weekly",
      priority: 0.8,
    });
  }

  for (const p of productos) {
    entradas.push({
      url: absoluta(`/producto/${p.slug}`),
      lastModified: p.updatedAt,
      changeFrequency: "weekly",
      priority: 0.7,
    });
  }

  for (const pg of paginas) {
    entradas.push({
      url: absoluta(`/pagina/${pg.slug}`),
      lastModified: pg.updatedAt,
      changeFrequency: "monthly",
      priority: 0.4,
    });
  }

  return entradas;
}

/** Lo mismo, pero en números, para poder enseñarlo en el panel. */
export async function resumenSitemap(): Promise<{
  total: number;
  productos: number;
  colecciones: number;
  paginas: number;
  fuera: { productos: number; colecciones: number; paginas: number };
}> {
  const [productos, colecciones, paginas, prodFuera, colFuera, pagFuera] = await Promise.all([
    db.product.count({ where: { status: "active" } }),
    db.collection.count({ where: { isVisible: true } }),
    db.page.count({ where: { status: "published" } }),
    db.product.count({ where: { status: { not: "active" } } }),
    db.collection.count({ where: { isVisible: false } }),
    db.page.count({ where: { status: { not: "published" } } }),
  ]);

  return {
    total: FIJAS.length + productos + colecciones + paginas,
    productos,
    colecciones,
    paginas,
    fuera: { productos: prodFuera, colecciones: colFuera, paginas: pagFuera },
  };
}

/* ══════════════════════════════ robots ══════════════════════════════ */

/**
 * Rutas cerradas a los buscadores.
 *
 * `/admin` y `/api` son la trastienda. `/checkout`, `/carrito` y `/pedido` son
 * de una clienta concreta: no hay nada que indexar y sí mucho que filtrar.
 */
export const RUTAS_BLOQUEADAS = ["/admin", "/api", "/checkout", "/carrito", "/pedido"];

export function construirRobots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: RUTAS_BLOQUEADAS }],
    sitemap: absoluta("/sitemap.xml"),
    host: urlBase(),
  };
}

/* ═══════════════════════════ títulos y descripciones ═══════════════════════════ */

/**
 * Límites de Google, en caracteres. No son reglas suyas escritas en piedra:
 * son el ancho que le cabe en el resultado antes de cortar con «…».
 */
export const LIMITES_SEO = {
  tituloMin: 30,
  tituloMax: 60,
  descripcionMin: 70,
  descripcionMax: 160,
} as const;

export type EstadoCampoSeo = "falta" | "corto" | "ok" | "largo";

export function evaluarTitulo(texto: string | null | undefined): { estado: EstadoCampoSeo; largo: number } {
  const largo = (texto ?? "").trim().length;
  if (largo === 0) return { estado: "falta", largo };
  if (largo < LIMITES_SEO.tituloMin) return { estado: "corto", largo };
  if (largo > LIMITES_SEO.tituloMax) return { estado: "largo", largo };
  return { estado: "ok", largo };
}

export function evaluarDescripcion(texto: string | null | undefined): { estado: EstadoCampoSeo; largo: number } {
  const largo = (texto ?? "").trim().length;
  if (largo === 0) return { estado: "falta", largo };
  if (largo < LIMITES_SEO.descripcionMin) return { estado: "corto", largo };
  if (largo > LIMITES_SEO.descripcionMax) return { estado: "largo", largo };
  return { estado: "ok", largo };
}

/* ═══════════════════════════ redirecciones 301 ═══════════════════════════ */

/**
 * Normaliza una ruta para poder compararla: siempre con barra delante, sin
 * barra al final, sin query ni ancla, en minúsculas.
 *
 * Sin esto, `/Producto/Vestido-Rojo/` y `/producto/vestido-rojo` serían dos
 * cosas distintas y la redirección no saltaría justo cuando hace falta.
 */
export function normalizarRuta(ruta: string): string {
  const limpia = (ruta || "").split("#")[0].split("?")[0].trim().toLowerCase();
  const conBarra = limpia.startsWith("/") ? limpia : `/${limpia}`;
  // Las barras repetidas se colapsan: `//tienda` no es una ruta interna, es una
  // dirección relativa al protocolo, y guardarla así abriría la puerta a que una
  // redirección acabase llevando a otro dominio.
  const sinDobles = conBarra.replace(/\/{2,}/g, "/");
  return sinDobles.length > 1 ? sinDobles.replace(/\/+$/, "") : "/";
}

/**
 * Busca a dónde tiene que ir una dirección vieja.
 *
 * Suma un `hit` cada vez que se usa: así se ve en el panel qué enlaces
 * compartidos en Instagram siguen vivos, y cuáles ya se pueden retirar. El
 * contador se actualiza sin bloquear la respuesta —si falla, se redirige
 * igual: llevar a la clienta a la prenda importa más que la estadística.
 */
export async function buscarRedireccion(ruta: string): Promise<string | null> {
  const desde = normalizarRuta(ruta);
  if (desde === "/") return null;

  const encontrada = await db.redirect.findUnique({ where: { fromPath: desde }, select: { id: true, toPath: true } });
  if (!encontrada) return null;

  await db.redirect.update({ where: { id: encontrada.id }, data: { hits: { increment: 1 } } }).catch(() => {});
  return encontrada.toPath;
}

/**
 * Engancha las redirecciones en una página que iba a devolver 404.
 *
 * CÓMO SE USA (una línea, justo antes del `notFound()`):
 *
 * ```ts
 * // app/(shop)/producto/[slug]/page.tsx
 * if (!producto) {
 *   await redirigirSiHay(`/producto/${slug}`); // 308 si hay redirección guardada
 *   notFound();
 * }
 * ```
 *
 * Se hace aquí y no en `middleware.ts` por dos motivos medidos:
 *  1. el middleware corre en el runtime Edge y NO puede hablar con Prisma, que
 *     es donde vive la tabla `Redirect`;
 *  2. el matcher del middleware solo cubre `/admin/*` a propósito, para no
 *     cobrarle una invocación a cada visita del escaparate.
 *
 * Consultar la tabla solo cuando la página ya iba a ser un 404 sale gratis en
 * el 99,9 % de las visitas.
 *
 * `permanentRedirect` emite un 308, el equivalente moderno del 301: permanente
 * y conservando el método. Google lo trata igual y traspasa el posicionamiento.
 */
export async function redirigirSiHay(ruta: string): Promise<void> {
  const destino = await buscarRedireccion(ruta);
  if (!destino) return;

  // Import perezoso: así este módulo se puede seguir usando desde un script o
  // un test sin arrastrar el runtime de navegación de Next.
  const { permanentRedirect } = await import("next/navigation");
  permanentRedirect(destino);
}
