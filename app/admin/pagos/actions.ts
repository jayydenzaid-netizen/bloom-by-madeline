"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { registrarActividad } from "@/lib/activity";
import { db } from "@/lib/db";
import {
  guardarConfigPaypal,
  guardarConfigSquare,
  guardarConfigStripe,
  leerConfigPagos,
  metodosOnlineActivos,
  paypalConfigurado,
  squareConfigurado,
  stripeConfigurado,
} from "@/lib/payments/config";
import { probarPaypal } from "@/lib/payments/paypal";
import { probarSquare } from "@/lib/payments/square";
import { probarStripe } from "@/lib/payments/stripe";
import { requireOwner } from "@/lib/permissions";
import { getSettings, saveSettings } from "@/lib/settings";

/**
 * Acciones de la página Pagos (solo la dueña).
 *
 * Reglas que mandan aquí:
 *  - Las credenciales JAMÁS aparecen en la URL, en la bitácora ni en un error.
 *    Los resultados viajan como CÓDIGOS (?hecho= / ?error=) que la página
 *    traduce con sus mapas — un texto libre en la querystring es un cartel que
 *    cualquiera puede fabricar con un enlace.
 *  - Un campo secreto vacío CONSERVA lo guardado: así Madeline puede activar o
 *    desactivar un método sin volver a pegar la llave cada vez.
 *  - Activar sin credenciales completas no se guarda: prometer una forma de
 *    pago que no puede cobrar deja a una clienta con el carrito lleno y sin
 *    manera de pagar.
 */

async function exigirDuena() {
  return requireOwner("pagos");
}

function texto(formData: FormData, campo: string): string {
  const raw = formData.get(campo);
  return typeof raw === "string" ? raw.trim() : "";
}

/** Un checkbox sin marcar no viaja en el FormData: ausencia = false. */
function marcado(formData: FormData, campo: string): boolean {
  return formData.get(campo) === "on";
}

function terminar(resultado: { hecho?: string; error?: string }): never {
  revalidatePath("/admin/pagos");
  // El checkout enseña los métodos según esta configuración.
  revalidatePath("/checkout");
  revalidatePath("/carrito");
  revalidatePath("/", "layout");
  const qs = resultado.hecho
    ? `hecho=${encodeURIComponent(resultado.hecho)}`
    : `error=${encodeURIComponent(resultado.error ?? "desconocido")}`;
  redirect(`/admin/pagos?${qs}`);
}

/* ────────────────────────────── Stripe ────────────────────────────── */

export async function guardarStripe(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const previa = (await leerConfigPagos()).stripe;

  const pegada = texto(formData, "secretKey");
  // Una llave publicable (pk_) no puede cobrar: es el error de pegado más común.
  if (pegada && !pegada.startsWith("sk_") && !pegada.startsWith("rk_")) {
    terminar({ error: "stripe-clave" });
  }

  const cfg = {
    activo: marcado(formData, "activo"),
    secretKey: pegada || previa.secretKey,
  };
  if (cfg.activo && !stripeConfigurado(cfg)) terminar({ error: "stripe-sin-llave" });

  await guardarConfigStripe(cfg);
  await registrarActividad({
    admin,
    action: "update",
    entityType: "setting",
    summary: `Stripe ${cfg.activo ? "activado" : "guardado (inactivo)"} en Pagos.`,
  });
  terminar({ hecho: cfg.activo ? "stripe-activo" : "stripe-guardado" });
}

/* ────────────────────────────── PayPal ────────────────────────────── */

export async function guardarPaypal(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const previa = (await leerConfigPagos()).paypal;

  const cfg = {
    activo: marcado(formData, "activo"),
    clientId: texto(formData, "clientId") || previa.clientId,
    clientSecret: texto(formData, "clientSecret") || previa.clientSecret,
    entorno: (texto(formData, "entorno") === "sandbox" ? "sandbox" : "live") as "live" | "sandbox",
  };
  if (cfg.activo && !paypalConfigurado(cfg)) terminar({ error: "paypal-sin-llaves" });

  await guardarConfigPaypal(cfg);
  await registrarActividad({
    admin,
    action: "update",
    entityType: "setting",
    summary: `PayPal ${cfg.activo ? "activado" : "guardado (inactivo)"} en Pagos (${cfg.entorno}).`,
  });
  terminar({ hecho: cfg.activo ? "paypal-activo" : "paypal-guardado" });
}

/* ────────────────────────────── Square ────────────────────────────── */

export async function guardarSquare(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const previa = (await leerConfigPagos()).square;

  const cfg = {
    activo: marcado(formData, "activo"),
    accessToken: texto(formData, "accessToken") || previa.accessToken,
    locationId: texto(formData, "locationId") || previa.locationId,
    entorno: (texto(formData, "entorno") === "sandbox" ? "sandbox" : "production") as
      | "production"
      | "sandbox",
  };
  if (cfg.activo && !squareConfigurado(cfg)) terminar({ error: "square-sin-llaves" });

  await guardarConfigSquare(cfg);
  await registrarActividad({
    admin,
    action: "update",
    entityType: "setting",
    summary: `Square ${cfg.activo ? "activado" : "guardado (inactivo)"} en Pagos (${cfg.entorno}).`,
  });
  terminar({ hecho: cfg.activo ? "square-activo" : "square-guardado" });
}

/* ─────────────────────── métodos sin pasarela ─────────────────────── */

export async function guardarManuales(formData: FormData): Promise<void> {
  const admin = await exigirDuena();

  const payDm = marcado(formData, "payDm");
  const payPickup = marcado(formData, "payPickup");

  // La tienda no puede quedarse sin NINGUNA forma de terminar una compra.
  const online = metodosOnlineActivos(await leerConfigPagos());
  const hayOnline = online.stripe || online.paypal || online.square;
  if (!payDm && !payPickup && !hayOnline) terminar({ error: "sin-metodos" });

  await saveSettings({ payDm, payPickup });
  await registrarActividad({
    admin,
    action: "update",
    entityType: "setting",
    summary: `Métodos sin pasarela: DM ${payDm ? "sí" : "no"} · recogida ${payPickup ? "sí" : "no"}.`,
  });
  terminar({ hecho: "manuales" });
}

/* ───────────────────────── quitar llaves ───────────────────────── */

const CLAVE_SETTING: Record<string, string> = {
  stripe: "paymentsStripe",
  paypal: "paymentsPaypal",
  square: "paymentsSquare",
};

/**
 * Borra las credenciales guardadas de un proveedor (rotación de llaves o
 * desconexión). No es destructivo de verdad: se recupera pegándolas otra vez.
 */
export async function quitarProveedor(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const proveedor = texto(formData, "proveedor");
  const clave = CLAVE_SETTING[proveedor];
  if (!clave) terminar({ error: "desconocido" });

  await db.setting.deleteMany({ where: { key: clave } });
  await registrarActividad({
    admin,
    action: "delete",
    entityType: "setting",
    summary: `Quitó las llaves de ${proveedor} en Pagos.`,
  });
  terminar({ hecho: `${proveedor}-quitado` });
}

/* ───────────────────────── probar conexión ───────────────────────── */

export async function probarConexion(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const proveedor = texto(formData, "proveedor");
  // Siempre desde la BD, nunca de un caché: se prueba lo que está GUARDADO.
  const cfg = await leerConfigPagos();

  if (proveedor === "stripe") {
    if (!stripeConfigurado(cfg.stripe)) terminar({ error: "stripe-sin-llave" });
    const r = await probarStripe(cfg.stripe);
    await registrarActividad({
      admin,
      action: "update",
      entityType: "setting",
      summary: `Probó la conexión con Stripe: ${r.ok ? `bien (${r.detalle})` : "falló"}.`,
    });
    terminar(r.ok ? { hecho: "stripe-conexion" } : { error: "stripe-fallo" });
  }

  if (proveedor === "paypal") {
    if (!paypalConfigurado(cfg.paypal)) terminar({ error: "paypal-sin-llaves" });
    const r = await probarPaypal(cfg.paypal);
    await registrarActividad({
      admin,
      action: "update",
      entityType: "setting",
      summary: `Probó la conexión con PayPal: ${r.ok ? "bien" : "falló"}.`,
    });
    terminar(r.ok ? { hecho: "paypal-conexion" } : { error: "paypal-fallo" });
  }

  if (proveedor === "square") {
    // Para probar Square basta el token: si falta el Location ID, la propia
    // prueba lo rellena cuando la cuenta tiene un único local.
    if (cfg.square.accessToken.length < 10) terminar({ error: "square-sin-llaves" });
    const r = await probarSquare(cfg.square);
    if (r.ok && !cfg.square.locationId && r.locales.length === 1) {
      await guardarConfigSquare({ ...cfg.square, locationId: r.locales[0].id });
      await registrarActividad({
        admin,
        action: "update",
        entityType: "setting",
        summary: `Probó la conexión con Square: bien. Location ID rellenado solo (${r.locales[0].nombre}).`,
      });
      terminar({ hecho: "square-local" });
    }
    await registrarActividad({
      admin,
      action: "update",
      entityType: "setting",
      summary: `Probó la conexión con Square: ${r.ok ? `bien (${r.detalle})` : "falló"}.`,
    });
    terminar(r.ok ? { hecho: "square-conexion" } : { error: "square-fallo" });
  }

  terminar({ error: "desconocido" });
}
