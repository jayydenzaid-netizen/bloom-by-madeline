"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/permissions";
import { db } from "@/lib/db";
import { parseToCents } from "@/lib/money";
import { saveSettings } from "@/lib/settings";

/**
 * Guardado de los ajustes de la tienda.
 *
 * Una acción por sección y no una sola gigante: guardar el precio no debe poder
 * pisar el horario, y así cada formulario valida solo lo suyo y el mensaje de
 * error señala el campo que la usuaria acaba de tocar.
 *
 * El dinero entra como texto ("7.50", "$7,50") y se convierte con parseToCents:
 * en ningún momento existe un float de dólares.
 */

/**
 * Clave del token del bookmarklet en la tabla Setting.
 *
 * No se exporta: en un fichero "use server" solo pueden salir funciones async,
 * y exportar el valor convertiría la constante en un endpoint. La página de
 * ajustes repite la clave a propósito, con este mismo comentario.
 */
const IMPORT_TOKEN_KEY = "importToken";

async function exigirSesion(): Promise<void> {
  // Ajustes es solo de la dueña (precios, cobros, impuestos). requireOwner rebota
  // a una ayudante a su cuenta con el motivo, incluso ante un POST directo.
  await requireOwner("ajustes");
}

function texto(formData: FormData, campo: string): string {
  return String(formData.get(campo) ?? "").trim();
}

function marcado(formData: FormData, campo: string): boolean {
  // Un checkbox sin marcar sencillamente no se envía; su ausencia es el "false".
  return formData.get(campo) !== null;
}

function terminar(seccion: string, error?: string): never {
  revalidatePath("/admin/ajustes");
  // Los ajustes se leen en el storefront (envío, métodos de pago, avisos), así
  // que el escaparate también tiene que enterarse del cambio.
  revalidatePath("/", "layout");
  const qs = new URLSearchParams(error ? { error: seccion, msg: error.slice(0, 140) } : { guardado: seccion });
  redirect(`/admin/ajustes?${qs.toString()}`);
}

/* ─────────────────────────────── tienda ─────────────────────────────── */

const tiendaSchema = z.object({
  storeName: z.string().trim().min(1, "El nombre de la tienda no puede quedar vacío.").max(80),
  tagline: z.string().trim().max(160, "El lema es demasiado largo."),
  email: z.union([z.literal(""), z.string().trim().email("El correo no tiene un formato válido.")]),
  phone: z.string().trim().max(40),
  address: z.string().trim().max(200),
  hours: z.string().trim().max(140),
  instagram: z.string().trim().max(60),
  instagramDm: z.union([z.literal(""), z.string().trim().url("El enlace del DM debe ser una URL completa.")]),
});

export async function guardarTienda(formData: FormData): Promise<void> {
  await exigirSesion();

  const datos = tiendaSchema.safeParse({
    storeName: texto(formData, "storeName"),
    tagline: texto(formData, "tagline"),
    email: texto(formData, "email"),
    phone: texto(formData, "phone"),
    address: texto(formData, "address"),
    hours: texto(formData, "hours"),
    // La arroba la pone la interfaz; guardarla duplicaría el símbolo en enlaces.
    instagram: texto(formData, "instagram").replace(/^@+/, ""),
    instagramDm: texto(formData, "instagramDm"),
  });

  if (!datos.success) terminar("tienda", datos.error.issues[0]?.message);

  await saveSettings(datos.data);
  terminar("tienda");
}

/* ─────────────────────────────── precios ─────────────────────────────── */

const preciosSchema = z.object({
  multiplier: z
    .number({ invalid_type_error: "El multiplicador tiene que ser un número." })
    .min(1, "Un multiplicador menor que 1 vendería por debajo del costo.")
    .max(20, "Un multiplicador mayor que 20 casi siempre es un dedazo."),
  addCents: z.number().int().min(0, "La suma fija no puede ser negativa.").max(100_000),
  rounding: z.enum(["none", "99", "95", "whole"]),
});

export async function guardarPrecios(formData: FormData): Promise<void> {
  await exigirSesion();

  // Coma decimal aceptada: "2,6" es lo que teclea quien aprendió a escribir
  // números en español.
  const multiplicador = Number.parseFloat(texto(formData, "multiplier").replace(",", "."));
  const suma = parseToCents(texto(formData, "addCents"));

  const datos = preciosSchema.safeParse({
    multiplier: Number.isFinite(multiplicador) ? Math.round(multiplicador * 100) / 100 : Number.NaN,
    addCents: suma ?? 0,
    rounding: texto(formData, "rounding"),
  });

  if (!datos.success) terminar("precios", datos.error.issues[0]?.message);

  await saveSettings({ pricing: datos.data });
  terminar("precios");
}

/* ──────────────────────────────── envío ──────────────────────────────── */

const envioSchema = z.object({
  freeShippingOverCents: z.number().int().min(0).max(1_000_000),
  flatShippingCents: z.number().int().min(0).max(1_000_000),
  localPickup: z.boolean(),
  shippingNotice: z.string().trim().max(300, "El aviso de plazos es demasiado largo."),
});

export async function guardarEnvio(formData: FormData): Promise<void> {
  await exigirSesion();

  const datos = envioSchema.safeParse({
    freeShippingOverCents: parseToCents(texto(formData, "freeShippingOverCents")) ?? 0,
    flatShippingCents: parseToCents(texto(formData, "flatShippingCents")) ?? 0,
    localPickup: marcado(formData, "localPickup"),
    shippingNotice: texto(formData, "shippingNotice"),
  });

  if (!datos.success) terminar("envio", datos.error.issues[0]?.message);

  await saveSettings(datos.data);
  terminar("envio");
}

/* ──────────────────────────────── pagos ──────────────────────────────── */

const pagosSchema = z.object({
  payStripe: z.boolean(),
  payDm: z.boolean(),
  payPickup: z.boolean(),
});

export async function guardarPagos(formData: FormData): Promise<void> {
  await exigirSesion();

  // Sin llaves de Stripe no hay cobro con tarjeta posible. Se fuerza a false
  // aunque llegue marcado: prometer un pago que no podemos procesar deja a la
  // clienta con el carrito lleno y sin manera de pagar.
  const hayStripe = Boolean(process.env.STRIPE_SECRET_KEY);

  const datos = pagosSchema.safeParse({
    payStripe: hayStripe && marcado(formData, "payStripe"),
    payDm: marcado(formData, "payDm"),
    payPickup: marcado(formData, "payPickup"),
  });

  if (!datos.success) terminar("pagos", datos.error.issues[0]?.message);

  if (!datos.data.payStripe && !datos.data.payDm && !datos.data.payPickup) {
    terminar("pagos", "Deja al menos un método de pago activo o nadie podrá terminar una compra.");
  }

  await saveSettings(datos.data);
  terminar("pagos");
}

/* ───────────────────────────── importación ───────────────────────────── */

/**
 * Regenera el token del bookmarklet. Vive en la tabla Setting pero fuera de
 * StoreSettings: es un secreto de infraestructura, no un ajuste de la tienda, y
 * no debe acabar en ninguna respuesta del escaparate.
 */
export async function regenerarToken(): Promise<void> {
  await exigirSesion();

  const token = randomBytes(24).toString("hex");
  // Se guarda en CRUDO, sin JSON.stringify: es el formato en el que ya lo
  // escribe y lo lee el importador. Envolverlo en comillas haría que el
  // bookmarklet mandara un token que no coincide con el guardado.
  await db.setting.upsert({
    where: { key: IMPORT_TOKEN_KEY },
    create: { key: IMPORT_TOKEN_KEY, value: token },
    update: { value: token },
  });

  terminar("token");
}
