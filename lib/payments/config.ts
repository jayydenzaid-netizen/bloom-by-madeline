import { db } from "@/lib/db";
import { cifrar, descifrar } from "./cifrado";

/**
 * Credenciales y estado de las pasarelas de pago.
 *
 * Viven en la tabla Setting, con claves PROPIAS fuera de StoreSettings a
 * propósito (mismo patrón que el token del importador): `getSettings()` lo llama
 * el escaparate público y nada secreto puede entrar ahí. Cada proveedor se
 * guarda como UN valor JSON cifrado (ver ./cifrado.ts) y se lee siempre de la
 * base de datos, sin caché: las credenciales cambian poco y el caché de 5 s de
 * settings ya mordió una vez con instancias serverless desincronizadas.
 */

export type MetodoOnline = "stripe" | "paypal" | "square";

export type ConfigStripe = {
  activo: boolean;
  /** Llave secreta (sk_live_… / sk_test_…). Con Checkout hosted no hace falta más. */
  secretKey: string;
};

export type ConfigPaypal = {
  activo: boolean;
  clientId: string;
  clientSecret: string;
  entorno: "live" | "sandbox";
};

export type ConfigSquare = {
  activo: boolean;
  accessToken: string;
  locationId: string;
  entorno: "production" | "sandbox";
};

export type ConfigPagos = {
  stripe: ConfigStripe;
  paypal: ConfigPaypal;
  square: ConfigSquare;
};

export const CONFIG_PAGOS_VACIA: ConfigPagos = {
  stripe: { activo: false, secretKey: "" },
  paypal: { activo: false, clientId: "", clientSecret: "", entorno: "live" },
  square: { activo: false, accessToken: "", locationId: "", entorno: "production" },
};

/** Claves en la tabla Setting. NUNCA añadirlas a DEFAULT_SETTINGS (ver cabecera). */
const CLAVE: Record<MetodoOnline, string> = {
  stripe: "paymentsStripe",
  paypal: "paymentsPaypal",
  square: "paymentsSquare",
};

export function esMetodoOnline(valor: string): valor is MetodoOnline {
  return valor === "stripe" || valor === "paypal" || valor === "square";
}

export const ETIQUETA_PROVEEDOR: Record<MetodoOnline, string> = {
  stripe: "Stripe",
  paypal: "PayPal",
  square: "Square",
};

/* ───────────────────────── normalización defensiva ─────────────────────────
 * Lo guardado pudo escribirlo una versión vieja del panel: cada campo se
 * revalida al leer para que un JSON a medias nunca reviente el checkout. */

function texto(valor: unknown): string {
  return typeof valor === "string" ? valor.trim() : "";
}

function normStripe(x: unknown): ConfigStripe {
  const o = (x ?? {}) as Record<string, unknown>;
  return { activo: o.activo === true, secretKey: texto(o.secretKey) };
}

function normPaypal(x: unknown): ConfigPaypal {
  const o = (x ?? {}) as Record<string, unknown>;
  return {
    activo: o.activo === true,
    clientId: texto(o.clientId),
    clientSecret: texto(o.clientSecret),
    entorno: o.entorno === "sandbox" ? "sandbox" : "live",
  };
}

function normSquare(x: unknown): ConfigSquare {
  const o = (x ?? {}) as Record<string, unknown>;
  return {
    activo: o.activo === true,
    accessToken: texto(o.accessToken),
    locationId: texto(o.locationId),
    entorno: o.entorno === "sandbox" ? "sandbox" : "production",
  };
}

/* ─────────────────────────── lectura y escritura ─────────────────────────── */

function parsear(valor: string | undefined): unknown {
  if (!valor) return null;
  // Si no descifra (SESSION_SECRET cambió, valor corrupto) se trata como no
  // configurado: el panel pedirá pegar las llaves otra vez. Nunca a medias.
  const plano = descifrar(valor);
  if (plano === null) return null;
  try {
    return JSON.parse(plano);
  } catch {
    return null;
  }
}

export type MetaConfigPagos = Record<MetodoOnline, Date | null>;

export async function leerConfigPagos(): Promise<ConfigPagos> {
  const { config } = await leerConfigPagosConMeta();
  return config;
}

/** Igual que leerConfigPagos pero con la fecha de guardado, para el panel. */
export async function leerConfigPagosConMeta(): Promise<{
  config: ConfigPagos;
  actualizado: MetaConfigPagos;
}> {
  const filas = await db.setting.findMany({
    where: { key: { in: Object.values(CLAVE) } },
  });
  const mapa = new Map(filas.map((f) => [f.key, f]));

  const fila = (p: MetodoOnline) => mapa.get(CLAVE[p]);
  return {
    config: {
      stripe: normStripe(parsear(fila("stripe")?.value)),
      paypal: normPaypal(parsear(fila("paypal")?.value)),
      square: normSquare(parsear(fila("square")?.value)),
    },
    actualizado: {
      stripe: fila("stripe")?.updatedAt ?? null,
      paypal: fila("paypal")?.updatedAt ?? null,
      square: fila("square")?.updatedAt ?? null,
    },
  };
}

export async function guardarConfigStripe(cfg: ConfigStripe): Promise<void> {
  await guardar("stripe", normStripe(cfg));
}

export async function guardarConfigPaypal(cfg: ConfigPaypal): Promise<void> {
  await guardar("paypal", normPaypal(cfg));
}

export async function guardarConfigSquare(cfg: ConfigSquare): Promise<void> {
  await guardar("square", normSquare(cfg));
}

async function guardar(proveedor: MetodoOnline, cfg: unknown): Promise<void> {
  const value = cifrar(JSON.stringify(cfg));
  await db.setting.upsert({
    where: { key: CLAVE[proveedor] },
    create: { key: CLAVE[proveedor], value },
    update: { value },
  });
}

/* ──────────────────────────── disponibilidad ──────────────────────────── */

/** ¿Tiene lo mínimo para poder cobrar? (Sin validar contra la API: eso es «probar conexión».) */
export function stripeConfigurado(c: ConfigStripe): boolean {
  // sk_ = llave secreta normal; rk_ = llave restringida. Una publishable (pk_) aquí
  // sería un error de pegado: no puede cobrar y se rechaza al guardar.
  return c.secretKey.startsWith("sk_") || c.secretKey.startsWith("rk_");
}

export function paypalConfigurado(c: ConfigPaypal): boolean {
  return c.clientId.length >= 10 && c.clientSecret.length >= 10;
}

export function squareConfigurado(c: ConfigSquare): boolean {
  return c.accessToken.length >= 10 && c.locationId.length >= 4;
}

/**
 * Qué métodos online puede ofrecer el checkout AHORA: activados por Madeline
 * Y con credenciales completas. Un toggle encendido sin llaves no promete nada.
 */
export function metodosOnlineActivos(cfg: ConfigPagos): Record<MetodoOnline, boolean> {
  return {
    stripe: cfg.stripe.activo && stripeConfigurado(cfg.stripe),
    paypal: cfg.paypal.activo && paypalConfigurado(cfg.paypal),
    square: cfg.square.activo && squareConfigurado(cfg.square),
  };
}
