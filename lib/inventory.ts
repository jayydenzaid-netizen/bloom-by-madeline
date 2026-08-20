import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * INVENTARIO — la única puerta por la que debe cambiar el stock.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * REGLA DE LA CASA: nadie escribe `ProductVariant.stock` a mano. Ni el panel, ni
 * el checkout, ni el importador. Todo pasa por `adjustStock`, `setStock` o
 * `bulkAdjust`, y cada una de esas funciones deja un `StockMovement` con el
 * antes y el después dentro de la MISMA transacción que cambia el número.
 *
 * El porqué: cuando faltan tres vestidos, la pregunta no es "cuántos hay" sino
 * "quién se los llevó y cuándo". Un `update({ stock: ... })` suelto responde a
 * la primera y borra para siempre la respuesta a la segunda. Y el descuadre de
 * inventario siempre acaba costando dinero: o se vende lo que no hay (y hay que
 * devolverle el dinero a una clienta) o se deja de vender lo que sí hay.
 *
 * Por eso la lectura del stock actual y su escritura viven dentro de
 * `db.$transaction`: entre "leer 5" y "escribir 4" puede colarse una venta, y
 * sin transacción el movimiento diría `before: 5` cuando ya era 4.
 *
 * Convenio de razones (`StockMovement.reason`, tal como lo fija el esquema):
 *   sale    · se vendió (lo descuenta el checkout)
 *   return  · devolución de una clienta
 *   manual  · Madeline corrigió el número a mano
 *   restock · llegó mercancía
 *   cancel  · pedido cancelado, el stock vuelve
 *   import  · lo trajo el importador de proveedor
 *   count   · recuento físico: se fija el valor real del armario
 */

/* ───────────────────────────── tipos ───────────────────────────── */

export const STOCK_REASONS = ["sale", "return", "manual", "restock", "cancel", "import", "count"] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

/** Etiquetas en cristiano para el panel: nadie tiene que aprenderse "restock". */
export const REASON_LABELS: Record<StockReason, string> = {
  sale: "Venta",
  return: "Devolución",
  manual: "Ajuste a mano",
  restock: "Llegó mercancía",
  cancel: "Pedido cancelado",
  import: "Importación",
  count: "Recuento físico",
};

export type AdjustOptions = {
  reason?: StockReason;
  /** Número de pedido, id de importación... lo que permita rastrear el cambio. */
  reference?: string | null;
  note?: string;
  /** Quién lo hizo. Null cuando lo hace el sistema (una venta del escaparate). */
  userId?: string | null;
};

export type StockChange = {
  variantId: string;
  before: number;
  after: number;
  /** Delta REAL aplicado, que puede no ser el pedido si se topó en 0. */
  delta: number;
  /** null cuando no hubo nada que registrar (delta 0 y no era un recuento). */
  movementId: string | null;
};

export type AdjustResult = { ok: true; change: StockChange } | { ok: false; error: string };

export type BulkEntry = {
  variantId: string;
  /** Unidades a sumar (negativo para restar). Se ignora si viene `setTo`. */
  delta?: number;
  /** Valor absoluto al que dejar la variante. Manda sobre `delta`. */
  setTo?: number;
};

export type BulkResult = { ok: true; changes: StockChange[] } | { ok: false; error: string };

/* ─────────────────────── el motor, en transacción ─────────────────────── */

/**
 * Aplica un cambio de stock a una variante dentro de una transacción ya abierta.
 * `siguiente(before)` decide el valor final: sumar, restar o fijar.
 *
 * El stock nunca baja de 0: "quedan −3 vestidos" no significa nada en una
 * boutique, y un número negativo en pantalla solo consigue que Madeline deje de
 * fiarse del panel. Si el ajuste pedido se pasa, se aplica lo que cabe y el
 * movimiento guarda el delta REAL, no el pedido.
 */
async function aplicar(
  tx: Prisma.TransactionClient,
  variantId: string,
  siguiente: (before: number) => number,
  reason: StockReason,
  opts: AdjustOptions,
): Promise<StockChange | null> {
  const variante = await tx.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true, stock: true },
  });
  if (!variante) return null;

  const before = variante.stock;
  const after = Math.max(0, Math.trunc(siguiente(before)));
  const delta = after - before;

  if (delta !== 0) {
    await tx.productVariant.update({ where: { id: variantId }, data: { stock: after } });
  }

  // Un ajuste que no cambia nada no ensucia el historial... salvo el recuento:
  // "conté el armario y el número estaba bien" es justo el dato que salva a
  // Madeline cuando dentro de un mes no cuadre y quiera saber desde cuándo.
  if (delta === 0 && reason !== "count") {
    return { variantId, before, after, delta, movementId: null };
  }

  const movimiento = await tx.stockMovement.create({
    data: {
      variantId,
      reason,
      delta,
      before,
      after,
      reference: opts.reference ?? null,
      note: opts.note ?? "",
      userId: opts.userId ?? null,
    },
    select: { id: true },
  });

  return { variantId, before, after, delta, movementId: movimiento.id };
}

/* ─────────────────────────── API pública ─────────────────────────── */

/**
 * Suma (o resta, con delta negativo) unidades a una variante y deja el rastro.
 * Razón por defecto: `manual`, que es lo que hace Madeline desde el panel.
 */
export async function adjustStock(
  variantId: string,
  delta: number,
  opts: AdjustOptions = {},
): Promise<AdjustResult> {
  const paso = Math.trunc(delta);
  if (!Number.isFinite(paso)) return { ok: false, error: "El ajuste tiene que ser un número entero de unidades." };

  const reason = normalizarRazon(opts.reason, "manual");

  try {
    const cambio = await db.$transaction((tx) => aplicar(tx, variantId, (before) => before + paso, reason, opts));
    if (!cambio) return { ok: false, error: "Esa variante ya no existe: alguien la borró mientras la editabas." };
    return { ok: true, change: cambio };
  } catch (error) {
    return { ok: false, error: mensajeDeError(error) };
  }
}

/**
 * Deja la variante en un valor exacto. Es lo que ocurre cuando Madeline cuenta
 * el armario de verdad: no sabe cuántas faltan, sabe cuántas hay. Por eso la
 * razón por defecto es `count` y el delta lo calcula el sistema.
 */
export async function setStock(
  variantId: string,
  nuevoValor: number,
  opts: AdjustOptions = {},
): Promise<AdjustResult> {
  const objetivo = Math.trunc(nuevoValor);
  if (!Number.isFinite(objetivo)) return { ok: false, error: "El stock tiene que ser un número entero de unidades." };
  if (objetivo < 0) return { ok: false, error: "El stock no puede ser negativo." };

  const reason = normalizarRazon(opts.reason, "count");

  try {
    const cambio = await db.$transaction((tx) => aplicar(tx, variantId, () => objetivo, reason, opts));
    if (!cambio) return { ok: false, error: "Esa variante ya no existe: alguien la borró mientras la editabas." };
    return { ok: true, change: cambio };
  } catch (error) {
    return { ok: false, error: mensajeDeError(error) };
  }
}

/**
 * Ajuste en lote, todo dentro de UNA transacción: o se aplican los N cambios o
 * no se aplica ninguno. Si una variante de la lista ya no existe, se cae entera
 * a propósito — un lote a medias es peor que un lote fallido, porque nadie sabe
 * qué mitad quedó hecha.
 */
export async function bulkAdjust(lista: BulkEntry[], opts: AdjustOptions = {}): Promise<BulkResult> {
  const entradas = lista.filter((e) => e.variantId);
  if (entradas.length === 0) return { ok: false, error: "No había ninguna variante seleccionada." };

  const reason = normalizarRazon(opts.reason, "manual");

  try {
    const cambios = await db.$transaction(async (tx) => {
      const salida: StockChange[] = [];
      for (const entrada of entradas) {
        const siguiente =
          entrada.setTo !== undefined
            ? () => Math.trunc(entrada.setTo as number)
            : (before: number) => before + Math.trunc(entrada.delta ?? 0);

        const cambio = await aplicar(tx, entrada.variantId, siguiente, reason, opts);
        // Reventar aquí es lo que revierte la transacción entera.
        if (!cambio) throw new Error("VARIANTE_INEXISTENTE");
        salida.push(cambio);
      }
      return salida;
    });

    return { ok: true, changes: cambios };
  } catch (error) {
    if (error instanceof Error && error.message === "VARIANTE_INEXISTENTE") {
      return {
        ok: false,
        error: "Una de las variantes seleccionadas ya no existe. No se ha cambiado ninguna; recarga y repite.",
      };
    }
    return { ok: false, error: mensajeDeError(error) };
  }
}

/* ───────────────────────── consultas de apoyo ───────────────────────── */

export type LowStockVariant = {
  variantId: string;
  variantTitle: string;
  sku: string;
  stock: number;
  productId: string;
  productTitle: string;
  productStatus: string;
};

/**
 * Variantes con control de stock por debajo del umbral, el umbral incluido:
 * con umbral 3 entran las que tienen 3, 2, 1 y 0. Es la lectura útil — "avísame
 * cuando queden 3" quiere decir que a las 3 ya hay que avisar.
 *
 * Las variantes con `trackStock: false` NO aparecen nunca: su stock lo tiene el
 * proveedor, y el 0 que guarda la base es un cero sin significado.
 */
export async function lowStockVariants(umbral = 3): Promise<LowStockVariant[]> {
  const limite = Math.max(0, Math.trunc(umbral));

  const variantes = await db.productVariant.findMany({
    where: { trackStock: true, stock: { lte: limite } },
    orderBy: [{ stock: "asc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      title: true,
      sku: true,
      stock: true,
      product: { select: { id: true, title: true, status: true } },
    },
  });

  return variantes.map((v) => ({
    variantId: v.id,
    variantTitle: v.title,
    sku: v.sku,
    stock: v.stock,
    productId: v.product.id,
    productTitle: v.product.title,
    productStatus: v.product.status,
  }));
}

export type StockValue = {
  /** Unidades físicas en variantes con control de stock. */
  units: number;
  /** Lo que costó comprar lo que hay en el armario. */
  costCents: number;
  /** Lo que se ingresaría vendiéndolo todo a precio de tarifa. */
  retailCents: number;
  trackedVariants: number;
  /** Variantes de proveedor: no se cuentan, y hay que decirlo en pantalla. */
  untrackedVariants: number;
  /** Variantes con stock pero sin coste puesto: el valor a coste se queda corto. */
  variantsWithoutCost: number;
  unitsWithoutCost: number;
  /** Variantes con control a cero: dinero que no se puede ingresar. */
  outOfStockVariants: number;
};

/**
 * Cuánto vale el inventario, a coste y a precio de venta. Es el número que casi
 * ningún dueño de tienda sabe de memoria y que todos necesitan: es el dinero
 * que está parado en el armario.
 *
 * Se calcula en JavaScript y no con un `aggregate` porque cada línea es una
 * multiplicación (stock × precio) y SQL agregado no multiplica columnas por
 * fila. Con el tamaño de una boutique son decenas de filas, no millones.
 *
 * El coste que falta NO se inventa: si una variante no tiene `costCents` se
 * intenta el del producto y, si tampoco, se cuenta aparte para poder avisar de
 * que el valor a coste está incompleto.
 */
export async function stockValue(): Promise<StockValue> {
  const [variantes, untracked] = await Promise.all([
    db.productVariant.findMany({
      where: { trackStock: true },
      select: {
        stock: true,
        priceCents: true,
        costCents: true,
        product: { select: { costCents: true } },
      },
    }),
    db.productVariant.count({ where: { trackStock: false } }),
  ]);

  let units = 0;
  let costCents = 0;
  let retailCents = 0;
  let variantsWithoutCost = 0;
  let unitsWithoutCost = 0;
  let outOfStockVariants = 0;

  for (const v of variantes) {
    if (v.stock <= 0) {
      outOfStockVariants += 1;
      continue;
    }
    const coste = v.costCents ?? v.product.costCents ?? null;
    units += v.stock;
    retailCents += v.stock * v.priceCents;
    if (coste === null) {
      variantsWithoutCost += 1;
      unitsWithoutCost += v.stock;
    } else {
      costCents += v.stock * coste;
    }
  }

  return {
    units,
    costCents,
    retailCents,
    trackedVariants: variantes.length,
    untrackedVariants: untracked,
    variantsWithoutCost,
    unitsWithoutCost,
    outOfStockVariants,
  };
}

/* ─────────────────────────── utilidades ─────────────────────────── */

export function isStockReason(valor: unknown): valor is StockReason {
  return typeof valor === "string" && (STOCK_REASONS as readonly string[]).includes(valor);
}

function normalizarRazon(valor: StockReason | undefined, porDefecto: StockReason): StockReason {
  return isStockReason(valor) ? valor : porDefecto;
}

function mensajeDeError(error: unknown): string {
  return `No se pudo cambiar el stock: ${error instanceof Error ? error.message : "error desconocido"}.`;
}
