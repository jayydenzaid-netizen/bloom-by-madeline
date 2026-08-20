// Todo el dinero de la tienda vive en centavos enteros. Estas son las únicas
// funciones autorizadas a convertir entre centavos y lo que ve la clienta.

const USD = new Intl.NumberFormat("es-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

/** 4599 -> "$45.99" */
export function formatCents(cents: number): string {
  return USD.format((cents || 0) / 100);
}

/** "45.99", "$45.99", "45,99" -> 4599. Devuelve null si no hay un número dentro. */
export function parseToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    return Number.isFinite(input) ? Math.round(input * 100) : null;
  }
  // Quita moneda y espacios; acepta coma decimal (proveedores de Europa/LatAm).
  const cleaned = input
    .replace(/[^\d.,-]/g, "")
    .replace(/,(\d{1,2})$/, ".$1")
    .replace(/,/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

export type PricingRule = {
  /** Multiplicador sobre el costo. 2.5 = vender a 2.5x lo que costó. */
  multiplier: number;
  /** Centavos fijos que se suman después del multiplicador (cubre envío/empaque). */
  addCents: number;
  /**
   * Redondeo psicológico del precio final:
   *  none  -> tal cual
   *  99    -> termina en .99
   *  95    -> termina en .95
   *  whole -> dólar entero
   */
  rounding: "none" | "99" | "95" | "whole";
};

export const DEFAULT_PRICING: PricingRule = {
  multiplier: 2.6,
  addCents: 500,
  rounding: "99",
};

/**
 * Convierte lo que cuesta el producto en el proveedor al precio de venta.
 * El redondeo nunca baja del costo: si el ajuste dejara el precio por debajo,
 * sube al siguiente escalón en vez de regalar margen.
 */
export function applyPricing(costCents: number, rule: PricingRule = DEFAULT_PRICING): number {
  const cost = Math.max(0, Math.round(costCents || 0));
  let price = Math.round(cost * rule.multiplier) + Math.round(rule.addCents || 0);

  switch (rule.rounding) {
    case "99":
      price = roundToEnding(price, 99);
      break;
    case "95":
      price = roundToEnding(price, 95);
      break;
    case "whole":
      price = Math.ceil(price / 100) * 100;
      break;
    default:
      break;
  }

  return Math.max(price, cost + 1);
}

function roundToEnding(cents: number, ending: number): number {
  const dollars = Math.floor(cents / 100);
  const candidate = dollars * 100 + ending;
  // Si redondear hacia abajo perdería más de 50¢, sube un dólar.
  return candidate >= cents ? candidate : (dollars + 1) * 100 + ending;
}

/** Margen bruto en centavos y en porcentaje sobre el precio de venta. */
export function margin(priceCents: number, costCents: number | null | undefined) {
  if (costCents === null || costCents === undefined || priceCents <= 0) {
    return { cents: null as number | null, percent: null as number | null };
  }
  const cents = priceCents - costCents;
  return { cents, percent: Math.round((cents / priceCents) * 1000) / 10 };
}
