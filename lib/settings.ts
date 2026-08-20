import { db } from "@/lib/db";
import { DEFAULT_PRICING, type PricingRule } from "@/lib/money";

/**
 * Ajustes de la tienda. Viven en la tabla Setting como pares clave/valor para que
 * Madeline pueda cambiarlos desde el panel sin tocar código ni redesplegar.
 */
export type StoreSettings = {
  storeName: string;
  tagline: string;
  email: string;
  phone: string;
  address: string;
  instagram: string;
  instagramDm: string;
  hours: string;
  currency: string;

  pricing: PricingRule;

  /** Envío gratis a partir de este subtotal. 0 = siempre gratis. */
  freeShippingOverCents: number;
  flatShippingCents: number;
  localPickup: boolean;

  /** Métodos de cobro visibles en el checkout. */
  payStripe: boolean;
  payDm: boolean;
  payPickup: boolean;

  /** Aviso de plazos: en dropshipping el envío tarda semanas y hay que decirlo. */
  shippingNotice: string;
};

export const DEFAULT_SETTINGS: StoreSettings = {
  storeName: "Bloom by Madeline",
  tagline: "Tendencias exclusivas · Elevamos tu estilo casual elegante",
  email: "",
  phone: "",
  address: "1305 Grand Blvd, Hamilton, OH 45011",
  instagram: "bloombymadelin",
  instagramDm: "https://ig.me/m/bloombymadelin",
  hours: "Jueves a sábado · 1:00 – 8:00 PM",
  currency: "USD",

  pricing: DEFAULT_PRICING,

  freeShippingOverCents: 7500,
  flatShippingCents: 695,
  localPickup: true,

  payStripe: false,
  payDm: true,
  payPickup: true,

  shippingNotice: "Los pedidos salen de la boutique en 1–2 días hábiles.",
};

const CACHE_MS = 5_000;
let cache: { at: number; value: StoreSettings } | null = null;

export async function getSettings(): Promise<StoreSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const rows = await db.setting.findMany();
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const value: StoreSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof StoreSettings)[]) {
    const raw = map.get(key);
    if (raw === undefined) continue;
    try {
      (value as Record<string, unknown>)[key] = JSON.parse(raw);
    } catch {
      (value as Record<string, unknown>)[key] = raw;
    }
  }
  // La regla de precio puede llegar a medias si se añadieron campos después.
  value.pricing = { ...DEFAULT_PRICING, ...(value.pricing || {}) };

  cache = { at: Date.now(), value };
  return value;
}

export async function saveSettings(patch: Partial<StoreSettings>): Promise<void> {
  const entries = Object.entries(patch);
  for (const [key, val] of entries) {
    if (val === undefined) continue;
    const value = JSON.stringify(val);
    await db.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
  cache = null;
}

export function invalidateSettingsCache() {
  cache = null;
}
