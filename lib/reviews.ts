// Reseñas y carritos abandonados.
//
// Los dos temas viven en el mismo módulo a propósito: comparten muy poco código
// pero sí comparten la única regla que importa aquí — nada se publica ni se da
// por perdido de forma automática. Todo lo que se calcula es determinista y está
// probado en tests/reviews.test.ts.
//
// Las funciones puras (medias, detección de abandono) NO tocan la base de datos:
// así se pueden probar sin sembrar datos falsos.

import { db } from "@/lib/db";

/* ═══════════════════════════════ RESEÑAS ═══════════════════════════════ */

export const ESTADOS_RESENA = ["pending", "approved", "rejected"] as const;
export type EstadoResena = (typeof ESTADOS_RESENA)[number];

export const ETIQUETA_ESTADO: Record<EstadoResena, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
};

/** De dónde salió la reseña. `instagram` es el caso normal de Madeline. */
export const ORIGENES_RESENA = ["instagram", "manual", "web"] as const;
export type OrigenResena = (typeof ORIGENES_RESENA)[number];

export const ETIQUETA_ORIGEN: Record<OrigenResena, string> = {
  instagram: "Instagram",
  manual: "Mostrador / a mano",
  web: "Formulario de la web",
};

export const PUNTUACION_MIN = 1;
export const PUNTUACION_MAX = 5;

export function esEstadoResena(valor: string): valor is EstadoResena {
  return (ESTADOS_RESENA as readonly string[]).includes(valor);
}

export function esOrigenResena(valor: string): valor is OrigenResena {
  return (ORIGENES_RESENA as readonly string[]).includes(valor);
}

export type ResumenPuntuacion = {
  /** Media con un decimal (4.3). 0 cuando no hay reseñas aprobadas. */
  media: number;
  /** Cuántas reseñas aprobadas sostienen esa media. */
  total: number;
};

export const RESUMEN_VACIO: ResumenPuntuacion = { media: 0, total: 0 };

/**
 * Media de una lista de puntuaciones, redondeada a un decimal.
 * Sin reseñas devuelve 0 — nunca NaN: un NaN pintado en la ficha de producto
 * saldría como "NaN de 5 estrellas" delante de una clienta.
 */
export function mediaPuntuaciones(puntuaciones: number[]): number {
  const validas = puntuaciones.filter((p) => Number.isFinite(p));
  if (validas.length === 0) return 0;
  const suma = validas.reduce((acc, p) => acc + p, 0);
  return Math.round((suma / validas.length) * 10) / 10;
}

/**
 * Resume una lista de reseñas contando SOLO las aprobadas. Una reseña pendiente
 * de moderar no puede mover la media pública: si contara, bastaría con que
 * alguien mandase un "1 estrella" por el formulario para hundir la nota antes
 * de que Madeline llegara a verlo.
 */
export function resumirResenas(resenas: { rating: number; status: string }[]): ResumenPuntuacion {
  const aprobadas = resenas.filter((r) => r.status === "approved");
  return { media: mediaPuntuaciones(aprobadas.map((r) => r.rating)), total: aprobadas.length };
}

/** Media y número de reseñas aprobadas de un producto. Para la ficha. */
export async function resumenDeProducto(productId: string): Promise<ResumenPuntuacion> {
  const filas = await db.review.findMany({
    where: { productId, status: "approved" },
    select: { rating: true },
  });
  return { media: mediaPuntuaciones(filas.map((f) => f.rating)), total: filas.length };
}

/**
 * Igual que `resumenDeProducto` pero para muchos a la vez: la portada y el
 * catálogo pintan decenas de tarjetas y una consulta por tarjeta sería un N+1.
 * Los productos sin reseñas aprobadas no salen en el mapa (usa RESUMEN_VACIO).
 */
export async function resumenDeProductos(productIds: string[]): Promise<Map<string, ResumenPuntuacion>> {
  const mapa = new Map<string, ResumenPuntuacion>();
  if (productIds.length === 0) return mapa;

  const filas = await db.review.findMany({
    where: { productId: { in: productIds }, status: "approved" },
    select: { productId: true, rating: true },
  });

  const acumulado = new Map<string, number[]>();
  for (const fila of filas) {
    if (!fila.productId) continue;
    const lista = acumulado.get(fila.productId) ?? [];
    lista.push(fila.rating);
    acumulado.set(fila.productId, lista);
  }
  for (const [id, puntuaciones] of acumulado) {
    mapa.set(id, { media: mediaPuntuaciones(puntuaciones), total: puntuaciones.length });
  }
  return mapa;
}

/** Reseñas aprobadas de un producto, de la más reciente a la más antigua. */
export async function resenasAprobadas(productId: string, limite = 20) {
  return db.review.findMany({
    where: { productId, status: "approved" },
    orderBy: { createdAt: "desc" },
    take: limite,
    select: {
      id: true,
      authorName: true,
      rating: true,
      title: true,
      body: true,
      source: true,
      isVerified: true,
      createdAt: true,
    },
  });
}

/** Reseñas aprobadas que no cuelgan de ningún producto: opinión de la boutique. */
export async function resenasDeLaBoutique(limite = 12) {
  return db.review.findMany({
    where: { productId: null, status: "approved" },
    orderBy: { createdAt: "desc" },
    take: limite,
    select: { id: true, authorName: true, rating: true, title: true, body: true, source: true, createdAt: true },
  });
}

/* ═══════════════════════ CARRITOS ABANDONADOS ═══════════════════════ */

/**
 * Horas sin actividad a partir de las cuales damos un carrito por abandonado.
 * Seis horas es el compromiso: menos y estaríamos persiguiendo a alguien que
 * tiene el catálogo abierto en otra pestaña; más y ya compró en otro sitio.
 * La pantalla deja cambiarlo con el filtro de antigüedad.
 */
export const HORAS_ABANDONO = 6;

/** Opciones de antigüedad que ofrece la pantalla, en horas. */
export const ANTIGUEDADES = [1, 6, 24, 72, 168] as const;

export type CarritoActividad = {
  /** Última vez que se tocó el carrito. */
  updatedAt: Date;
  /** Cuántos artículos tiene dentro (suma de cantidades o número de líneas). */
  articulos: number;
  /** Si acabó convirtiéndose en pedido ya no hay nada que recuperar. */
  recoveredOrderId?: string | null;
};

/** Horas transcurridas desde `fecha`. Negativo si la fecha está en el futuro. */
export function horasDesde(fecha: Date, ahora: Date = new Date()): number {
  return (ahora.getTime() - fecha.getTime()) / 3_600_000;
}

/**
 * Un carrito está abandonado si tiene algo dentro, no acabó en pedido y lleva
 * más de `horas` sin tocarse. Los tres criterios importan: un carrito vacío no
 * es dinero perdido, uno recuperado ya entró, y uno de hace diez minutos sigue
 * vivo — escribirle a esa clienta sería agobiarla, no atenderla.
 */
export function esCarritoAbandonado(
  carrito: CarritoActividad,
  opciones: { ahora?: Date; horas?: number } = {},
): boolean {
  const ahora = opciones.ahora ?? new Date();
  const horas = opciones.horas ?? HORAS_ABANDONO;

  if (carrito.articulos <= 0) return false;
  if (carrito.recoveredOrderId) return false;
  return horasDesde(carrito.updatedAt, ahora) >= horas;
}

/** Fecha de corte para consultar en SQL: `updatedAt < fechaCorteAbandono(h)`. */
export function fechaCorteAbandono(horas: number = HORAS_ABANDONO, ahora: Date = new Date()): Date {
  return new Date(ahora.getTime() - horas * 3_600_000);
}

/** Valor de un carrito en centavos: cantidad × precio de cada línea. */
export function valorCarrito(lineas: { quantity: number; priceCents: number }[]): number {
  return lineas.reduce((total, l) => total + Math.max(0, l.quantity) * Math.max(0, l.priceCents), 0);
}

/* ═══════════════════════════ AUDITORÍA ═══════════════════════════ */

/**
 * Deja constancia en ActivityLog. Nunca revienta la acción que la llamó: si el
 * registro falla se pierde una línea de bitácora, pero la reseña o el carrito ya
 * se guardaron y sería absurdo enseñarle un error a Madeline por eso.
 */
export async function registrarActividad(entrada: {
  admin?: { id: string; email: string } | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.activityLog.create({
      data: {
        userId: entrada.admin?.id ?? null,
        userEmail: entrada.admin?.email ?? "",
        action: entrada.action,
        entityType: entrada.entityType,
        entityId: entrada.entityId ?? null,
        summary: entrada.summary ?? "",
        metaJson: JSON.stringify(entrada.meta ?? {}),
      },
    });
  } catch {
    // Silencio deliberado: la bitácora es un extra, no una condición de éxito.
  }
}
