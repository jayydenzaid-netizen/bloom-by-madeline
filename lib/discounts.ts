// Descuentos y promociones: la lógica que decide si un código vale y cuánto
// descuenta. Vive aquí y no dentro del panel porque el checkout de la tienda va
// a usar exactamente estas mismas funciones: si la caja calculara el descuento
// por su cuenta, tarde o temprano cobraría algo distinto de lo que la ficha del
// código prometía, y eso se descubre siempre con la clienta delante.
//
// Dos reglas de la casa que aquí se cumplen sin excepción:
//  1. Todo el dinero va en CENTAVOS ENTEROS. Ni un float.
//  2. Un descuento NUNCA puede dejar el total por debajo de cero. Un pedido con
//     total negativo no es un descuento generoso, es dinero que se devuelve.
//
// Este módulo es universal a propósito: la parte de cálculo no importa Prisma ni
// nada de Node, así que el formulario del panel puede usarla en el navegador
// para la vista previa en vivo. Las dos funciones que sí tocan la base de datos
// (`validateDiscount` y `redeemDiscount`) cargan el cliente de Prisma bajo
// demanda, ya dentro de la función.

import { formatCents } from "@/lib/money";

/* ─────────────────────────────── tipos ─────────────────────────────── */

/** Los tres tipos que entiende el sistema. Coinciden con `Discount.type`. */
export const TIPOS_DESCUENTO = ["percentage", "fixed", "free_shipping"] as const;
export type TipoDescuento = (typeof TIPOS_DESCUENTO)[number];

/** A qué parte del carrito se aplica. Coincide con `Discount.appliesTo`. */
export const AMBITOS_DESCUENTO = ["all", "collection", "product"] as const;
export type AmbitoDescuento = (typeof AMBITOS_DESCUENTO)[number];

/**
 * Forma mínima de un descuento para poder evaluarlo. El modelo `Discount` de
 * Prisma encaja tal cual; los tests pueden construir objetos planos sin
 * arrastrar createdAt/updatedAt ni la relación de usos.
 */
export type DescuentoBase = {
  id: string;
  code: string;
  title?: string;
  /** percentage | fixed | free_shipping */
  type: string;
  /** Porcentaje (0-100) si es `percentage`; centavos si es `fixed`. */
  value: number;
  minSubtotalCents: number;
  /** all | collection | product */
  appliesTo: string;
  appliesToIdsJson: string;
  oncePerCustomer: boolean;
  /** 0 = sin límite. */
  usageLimit: number;
  usageCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
};

/**
 * Una línea del carrito con lo justo para saber si el código la cubre.
 * `collectionIds` son las colecciones a las que pertenece el producto.
 */
export type LineaDescuento = {
  productId?: string | null;
  collectionIds?: string[];
  priceCents: number;
  quantity: number;
};

export type ContextoDescuento = {
  subtotalCents: number;
  /** Necesario para los códigos de "una vez por clienta". */
  email?: string | null;
  /**
   * Líneas del carrito. Si no se pasan, se asume que TODO el subtotal es
   * elegible: es lo que quiere la vista previa del panel, donde Madeline teclea
   * un subtotal de ejemplo y todavía no hay carrito ninguno.
   */
  lineas?: LineaDescuento[];
  /** Para poder fijar "ahora" en los tests. */
  now?: Date;
};

export type ResultadoDescuento =
  | {
      ok: true;
      discount: DescuentoBase;
      /** Cuánto se resta del subtotal, en centavos. Nunca mayor que el subtotal. */
      discountCents: number;
      /** Si es true, la caja debe poner el envío a 0 (los `free_shipping`). */
      freeShipping: boolean;
    }
  | { ok: false; reason: string };

/* ───────────────────────────── utilidades ───────────────────────────── */

/** Los códigos se guardan y se comparan SIEMPRE en mayúsculas y sin espacios. */
export function normalizarCodigo(code: string | null | undefined): string {
  return (code ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

/** El correo también se normaliza: "Ana@X.com" y "ana@x.com" son la misma clienta. */
export function normalizarEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** Los ids de colección/producto viajan como JSON dentro de un String. */
export function idsAplicables(discount: Pick<DescuentoBase, "appliesToIdsJson">): string[] {
  try {
    const datos: unknown = JSON.parse(discount.appliesToIdsJson || "[]");
    if (!Array.isArray(datos)) return [];
    return datos.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    // Un JSON corrupto no puede tumbar el checkout: se trata como "sin lista".
    return [];
  }
}

const FECHA_CORTA = new Intl.DateTimeFormat("es-US", { day: "numeric", month: "long" });
const FECHA_LARGA = new Intl.DateTimeFormat("es-US", { day: "numeric", month: "long", year: "numeric" });

/** "3 de agosto" — y con año solo si no es el actual, que si no suena raro. */
export function fechaLegible(fecha: Date, ahora: Date = new Date()): string {
  return fecha.getFullYear() === ahora.getFullYear() ? FECHA_CORTA.format(fecha) : FECHA_LARGA.format(fecha);
}

function esTipo(valor: string): TipoDescuento {
  return (TIPOS_DESCUENTO as readonly string[]).includes(valor) ? (valor as TipoDescuento) : "percentage";
}

/**
 * Subtotal sobre el que muerde el descuento.
 *
 * Con `appliesTo: "all"` es el subtotal entero. Con "collection"/"product" solo
 * cuentan las líneas que encajan: un 20 % en "Vestidos" no puede rebajar los
 * bolsos que la clienta lleve en la misma bolsa.
 */
export function baseAplicable(
  discount: DescuentoBase,
  subtotalCents: number,
  lineas?: LineaDescuento[],
): number {
  const subtotal = Math.max(0, Math.round(subtotalCents || 0));
  if (discount.appliesTo === "all") return subtotal;
  // Sin líneas no se sabe qué lleva la clienta: se asume que todo es elegible.
  // Solo pasa en la vista previa del panel, nunca en una compra de verdad.
  if (lineas === undefined) return subtotal;

  const ids = new Set(idsAplicables(discount));
  if (ids.size === 0) return 0;

  let base = 0;
  for (const linea of lineas) {
    const encaja =
      discount.appliesTo === "product"
        ? Boolean(linea.productId && ids.has(linea.productId))
        : (linea.collectionIds ?? []).some((c) => ids.has(c));
    if (encaja) base += Math.max(0, Math.round(linea.priceCents)) * Math.max(0, Math.round(linea.quantity));
  }
  // Nunca más que el subtotal real: si las líneas no cuadran con el subtotal que
  // llega, manda el subtotal.
  return Math.min(base, subtotal);
}

/* ──────────────────────────── el cálculo ───────────────────────────── */

/**
 * Cuánto descuenta este código sobre este subtotal, en centavos.
 *
 * - `percentage`: el porcentaje sobre la parte elegible del carrito.
 * - `fixed`: el importe fijo, recortado si es mayor que lo elegible.
 * - `free_shipping`: 0 aquí. El ahorro está en el envío, no en el subtotal, y la
 *   caja lo aplica poniendo `shippingCents` a 0 (ver `freeShipping` en el
 *   resultado). Meterlo en `discountCents` descuadraría el total del pedido.
 *
 * El resultado va siempre recortado a [0, subtotal]: es la garantía de que
 * ningún código puede dejar el total en negativo.
 */
export function computeDiscountCents(
  discount: DescuentoBase,
  subtotalCents: number,
  lineas?: LineaDescuento[],
): number {
  const subtotal = Math.max(0, Math.round(subtotalCents || 0));
  if (subtotal === 0) return 0;

  const base = baseAplicable(discount, subtotal, lineas);
  if (base <= 0) return 0;

  let bruto = 0;
  switch (esTipo(discount.type)) {
    case "percentage": {
      const porcentaje = Math.min(100, Math.max(0, discount.value || 0));
      bruto = Math.round((base * porcentaje) / 100);
      break;
    }
    case "fixed":
      bruto = Math.max(0, Math.round(discount.value || 0));
      break;
    case "free_shipping":
      bruto = 0;
      break;
  }

  // Doble tope: ni más que la parte elegible ni más que el subtotal entero.
  return Math.max(0, Math.min(bruto, base, subtotal));
}

/* ─────────────────────────── la validación ─────────────────────────── */

/**
 * Todas las comprobaciones de un código, sin tocar la base de datos.
 * `yaUsadoPorEsteEmail` lo resuelve quien llame (lo hace `validateDiscount`).
 *
 * Los motivos van en español y escritos para la compradora, no para el log:
 * quien lee "Este código caducó el 3 de agosto" entiende qué pasó; quien lee
 * "DISCOUNT_EXPIRED" escribe un DM preguntando.
 */
export function evaluateDiscount(
  discount: DescuentoBase,
  ctx: ContextoDescuento,
  opciones: { yaUsadoPorEsteEmail?: boolean } = {},
): ResultadoDescuento {
  const ahora = ctx.now ?? new Date();
  const subtotal = Math.max(0, Math.round(ctx.subtotalCents || 0));

  if (!discount.isActive) {
    return { ok: false, reason: "Este código ya no está disponible." };
  }

  if (discount.startsAt && discount.startsAt.getTime() > ahora.getTime()) {
    return {
      ok: false,
      reason: `Este código todavía no empieza: se activa el ${fechaLegible(discount.startsAt, ahora)}.`,
    };
  }

  if (discount.endsAt && discount.endsAt.getTime() < ahora.getTime()) {
    return { ok: false, reason: `Este código caducó el ${fechaLegible(discount.endsAt, ahora)}.` };
  }

  if (discount.usageLimit > 0 && discount.usageCount >= discount.usageLimit) {
    return { ok: false, reason: "Este código ya se agotó: llegó a su límite de usos." };
  }

  if (discount.oncePerCustomer) {
    if (opciones.yaUsadoPorEsteEmail) {
      return { ok: false, reason: "Ya usaste este código en un pedido anterior." };
    }
    if (ctx.email !== undefined && !normalizarEmail(ctx.email)) {
      return {
        ok: false,
        reason: "Este código solo se puede usar una vez por clienta: escribe tu correo para aplicarlo.",
      };
    }
  }

  if (discount.minSubtotalCents > 0 && subtotal < discount.minSubtotalCents) {
    const falta = discount.minSubtotalCents - subtotal;
    return {
      ok: false,
      reason: `Este código pide una compra mínima de ${formatCents(discount.minSubtotalCents)}. Te faltan ${formatCents(falta)}.`,
    };
  }

  const base = baseAplicable(discount, subtotal, ctx.lineas);
  if (base <= 0 && discount.appliesTo !== "all") {
    return {
      ok: false,
      reason: "Este código solo vale para algunos productos, y en tu bolsa no hay ninguno de esos.",
    };
  }

  const discountCents = computeDiscountCents(discount, subtotal, ctx.lineas);
  const freeShipping = esTipo(discount.type) === "free_shipping";

  if (!freeShipping && discountCents <= 0) {
    return { ok: false, reason: "Este código no descuenta nada en esta compra." };
  }

  return { ok: true, discount, discountCents, freeShipping };
}

/** Carga perezosa del cliente de Prisma: mantiene el módulo usable en el navegador. */
async function baseDeDatos() {
  const { db } = await import("@/lib/db");
  return db;
}

/**
 * Comprueba un código escrito por la clienta contra la base de datos:
 * que exista, que esté activo, que estemos dentro de fechas, que no se pasó del
 * límite de usos, que el subtotal llega al mínimo y que —si es de un solo uso
 * por clienta— ese correo no lo gastó ya.
 */
export async function validateDiscount(code: string, ctx: ContextoDescuento): Promise<ResultadoDescuento> {
  const codigo = normalizarCodigo(code);
  if (!codigo) return { ok: false, reason: "Escribe un código de descuento para aplicarlo." };

  const db = await baseDeDatos();
  const discount = await db.discount.findUnique({ where: { code: codigo } });
  if (!discount) {
    return { ok: false, reason: "Ese código no existe. Revísalo, a lo mejor se coló una letra." };
  }

  let yaUsadoPorEsteEmail = false;
  const email = normalizarEmail(ctx.email);
  if (discount.oncePerCustomer && email) {
    const usos = await db.discountUsage.count({ where: { discountId: discount.id, email } });
    yaUsadoPorEsteEmail = usos > 0;
  }

  return evaluateDiscount(discount, ctx, { yaUsadoPorEsteEmail });
}

/* ─────────────────────────────── canje ─────────────────────────────── */

export type ResultadoCanje = { ok: true; usageCount: number } | { ok: false; reason: string };

/**
 * Marca el código como usado: sube `usageCount` y deja constancia en
 * `DiscountUsage`.
 *
 * Va todo dentro de una transacción y el incremento se hace con un `updateMany`
 * condicionado a que aún queden usos. Así, si dos clientas pagan a la vez con el
 * último uso de un código, la segunda no se lo salta: su `updateMany` afecta a
 * cero filas y se le dice que se agotó.
 */
export async function redeemDiscount(
  discountId: string,
  orderId: string,
  email: string | null | undefined,
): Promise<ResultadoCanje> {
  const db = await baseDeDatos();

  return db.$transaction(async (tx): Promise<ResultadoCanje> => {
    const discount = await tx.discount.findUnique({
      where: { id: discountId },
      select: { id: true, usageLimit: true, usageCount: true },
    });
    if (!discount) return { ok: false, reason: "Ese código de descuento ya no existe." };

    const actualizados = await tx.discount.updateMany({
      where:
        discount.usageLimit > 0
          ? { id: discountId, usageCount: { lt: discount.usageLimit } }
          : { id: discountId },
      data: { usageCount: { increment: 1 } },
    });
    if (actualizados.count === 0) {
      return { ok: false, reason: "Este código se agotó justo ahora: alguien usó el último." };
    }

    await tx.discountUsage.create({
      data: { discountId, orderId, email: normalizarEmail(email) },
    });

    return { ok: true, usageCount: discount.usageCount + 1 };
  });
}

/* ───────────────────── cómo se cuenta y se enseña ───────────────────── */

export type ClaveEstado = "activo" | "programado" | "caducado" | "agotado" | "apagado";

/**
 * Estado real de un código, CALCULADO en el momento y nunca guardado.
 *
 * Guardar el estado en una columna significaría que un código caduca solo
 * cuando alguien vuelva a abrir la pantalla; así caduca cuando toca. El orden de
 * las comprobaciones importa: apagado a mano manda sobre todo lo demás, y
 * caducado manda sobre agotado (si además caducó, decir "agotado" despista).
 */
export function estadoDescuento(
  discount: Pick<DescuentoBase, "isActive" | "startsAt" | "endsAt" | "usageLimit" | "usageCount">,
  ahora: Date = new Date(),
): { clave: ClaveEstado; label: string; tone: "success" | "info" | "neutral" | "warning" | "danger" } {
  if (!discount.isActive) return { clave: "apagado", label: "Desactivado", tone: "neutral" };
  if (discount.endsAt && discount.endsAt.getTime() < ahora.getTime()) {
    return { clave: "caducado", label: "Caducado", tone: "neutral" };
  }
  if (discount.usageLimit > 0 && discount.usageCount >= discount.usageLimit) {
    return { clave: "agotado", label: "Agotado", tone: "warning" };
  }
  if (discount.startsAt && discount.startsAt.getTime() > ahora.getTime()) {
    return { clave: "programado", label: "Programado", tone: "info" };
  }
  return { clave: "activo", label: "Activo", tone: "success" };
}

/** "20 %" · "$20.00" · "Envío gratis" — lo que descuenta, en una línea. */
export function describirValor(discount: Pick<DescuentoBase, "type" | "value">): string {
  switch (esTipo(discount.type)) {
    case "percentage":
      return `${discount.value} %`;
    case "fixed":
      return formatCents(discount.value);
    case "free_shipping":
      return "Envío gratis";
  }
}

/** "Siempre" · "Hasta el 3 de agosto" · "Del 1 al 15 de agosto". */
export function describirVigencia(
  discount: Pick<DescuentoBase, "startsAt" | "endsAt">,
  ahora: Date = new Date(),
): string {
  const { startsAt, endsAt } = discount;
  if (!startsAt && !endsAt) return "Siempre";
  if (startsAt && endsAt) return `Del ${fechaLegible(startsAt, ahora)} al ${fechaLegible(endsAt, ahora)}`;
  if (startsAt) return `Desde el ${fechaLegible(startsAt, ahora)}`;
  return `Hasta el ${fechaLegible(endsAt as Date, ahora)}`;
}

/* ────────────────────────── generador de códigos ────────────────────── */

/**
 * Alfabeto sin caracteres que se confunden al dictarlos por teléfono o al
 * leerlos en una story: fuera O y 0, fuera I, L y 1, fuera U (se lee como V en
 * mayúsculas de imprenta).
 */
const ALFABETO = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** "BLOOM" -> "BLOOM-4K2P". Legible, dictable y difícil de adivinar por fuerza bruta. */
export function generateCode(prefix = "BLOOM", longitud = 4): string {
  const limpio = normalizarCodigo(prefix).replace(/[^A-Z0-9]/g, "").slice(0, 12);
  const base = limpio || "BLOOM";

  const bytes = new Uint8Array(Math.max(1, longitud));
  // globalThis.crypto existe en Node 18+ y en el navegador: así el botón
  // "generar" funciona en el panel sin pedirle nada al servidor.
  globalThis.crypto.getRandomValues(bytes);

  let sufijo = "";
  for (const byte of bytes) sufijo += ALFABETO[byte % ALFABETO.length];

  return `${base}-${sufijo}`;
}
