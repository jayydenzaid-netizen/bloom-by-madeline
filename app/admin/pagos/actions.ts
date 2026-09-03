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
  type ConfigPagos,
  type MetodoOnline,
} from "@/lib/payments/config";
import { anotarSalud, leerSalud, olvidarSalud, type SaludProveedor } from "@/lib/payments/estado";
import { probarPaypal } from "@/lib/payments/paypal";
import { probarSquare } from "@/lib/payments/square";
import { probarStripe } from "@/lib/payments/stripe";
import type { ResultadoPrueba } from "@/lib/payments/tipos";
import { requireOwner } from "@/lib/permissions";
import { getSettings, saveSettings } from "@/lib/settings";

/**
 * Acciones de la página Pagos (solo la dueña).
 *
 * Reglas que mandan aquí:
 *
 *  - Las credenciales JAMÁS aparecen en la URL, en la bitácora ni en un error.
 *    Los resultados viajan como CÓDIGOS (?hecho= / ?error=) que la página
 *    traduce con sus mapas — un texto libre en la querystring es un cartel que
 *    cualquiera puede fabricar con un enlace.
 *
 *  - Un campo secreto vacío CONSERVA lo guardado: así se puede activar o
 *    desactivar un método sin volver a pegar la llave cada vez.
 *
 *  - **Se guarda APAGADO antes de sondear.** Una credencial recién pegada no se
 *    pierde nunca, aunque la pasarela tarde quince segundos en contestar o
 *    aunque el cifrado falle. Antes era al revés y por eso guardar Square podía
 *    morir sin escribir nada.
 *
 *  - **Se sondea UNA sola vez** y se reutiliza el resultado. Antes, guardar
 *    Square llamaba a `probarSquare` para rellenar el local y acto seguido otra
 *    comprobación la volvía a llamar tirando la primera: hasta cuatro peticiones
 *    en la misma acción.
 *
 *  - **Encender exige confirmación; seguir encendido, no.** Para activar un
 *    método hace falta que la pasarela diga que sí. Un fallo de red no apaga
 *    nada (eso lo decide el veto de `metodosOnlineActivos`, que solo veta un
 *    rechazo explícito), pero tampoco sirve para encender: prometer una tarjeta
 *    sin haber confirmado que cobra deja a la clienta con el pedido hecho, su
 *    talla apartada y sin forma de pagar.
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

function proveedorDe(formData: FormData): MetodoOnline {
  const p = texto(formData, "proveedor");
  if (p === "stripe" || p === "paypal" || p === "square") return p;
  terminar({ error: "desconocido" });
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

/* ─────────────────────── sondeo y salud ─────────────────────── */

/** Pregunta a la pasarela por las credenciales YA GUARDADAS de un proveedor. */
async function sondear(proveedor: MetodoOnline, cfg: ConfigPagos): Promise<ResultadoPrueba> {
  if (proveedor === "stripe") return probarStripe(cfg.stripe);
  if (proveedor === "paypal") return probarPaypal(cfg.paypal);
  return probarSquare(cfg.square);
}

/** El resultado del sondeo, traducido a lo que se guarda en `paymentsEstado`. */
function saludDe(proveedor: MetodoOnline, r: ResultadoPrueba, cfg: ConfigPagos): SaludProveedor {
  const salud: SaludProveedor = {
    resultado: r.ok ? "ok" : r.motivo === "red" ? "sin-respuesta" : "rechazada",
    codigo: r.codigo ?? (r.ok ? "ok" : "credencial-invalida"),
    en: new Date().toISOString(),
  };
  if (r.cuenta) salud.cuenta = r.cuenta;
  // El entorno se deduce de lo que se está usando de verdad, no del desplegable.
  if (proveedor === "stripe" && r.ok) {
    salud.entornoReal = cfg.stripe.secretKey.startsWith("sk_test_") ? "pruebas" : "real";
  }
  if (proveedor === "paypal" && r.ok) {
    salud.entornoReal = cfg.paypal.entorno === "sandbox" ? "pruebas" : "real";
  }
  if (proveedor === "square" && r.ok) {
    salud.entornoReal = cfg.square.entorno === "sandbox" ? "pruebas" : "real";
  }
  return salud;
}

/** ¿Tiene lo mínimo para poder sondear? (Sin esto el sondeo acaba en un error confuso.) */
function hayCredenciales(proveedor: MetodoOnline, cfg: ConfigPagos): boolean {
  if (proveedor === "stripe") return cfg.stripe.secretKey.length > 0;
  if (proveedor === "paypal") return paypalConfigurado(cfg.paypal);
  // Para Square basta el token: el local lo rellena el propio sondeo.
  return cfg.square.accessToken.length >= 10;
}

/* ─────────────────────── conectar (un solo gesto) ─────────────────────── */

/**
 * Guarda las credenciales pegadas, pregunta a la pasarela y, si dice que sí,
 * enciende el método. Un solo botón donde antes había guardar → probar → volver
 * a guardar, tres pasos que además estaban explicados al final de la página.
 */
export async function conectarProveedor(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const proveedor = proveedorDe(formData);
  const previa = await leerConfigPagos();
  const quiereActivo = marcado(formData, "activo");

  /* ── 1. Armar la configuración con lo pegado (vacío = conservar) ── */
  let cfg: ConfigPagos;
  if (proveedor === "stripe") {
    const pegada = texto(formData, "secretKey");
    // Una llave publicable (pk_) no puede cobrar: es el error de pegado más
    // común y se ataja antes de guardar nada.
    if (pegada && !pegada.startsWith("sk_") && !pegada.startsWith("rk_")) {
      await anotarSalud("stripe", {
        resultado: "rechazada",
        codigo: "llave-no-secreta",
        en: new Date().toISOString(),
      });
      terminar({ error: "stripe-clave" });
    }
    cfg = { ...previa, stripe: { activo: false, secretKey: pegada || previa.stripe.secretKey } };
  } else if (proveedor === "paypal") {
    cfg = {
      ...previa,
      paypal: {
        activo: false,
        clientId: texto(formData, "clientId") || previa.paypal.clientId,
        clientSecret: texto(formData, "clientSecret") || previa.paypal.clientSecret,
        entorno: texto(formData, "entorno") === "sandbox" ? "sandbox" : "live",
      },
    };
  } else {
    cfg = {
      ...previa,
      square: {
        activo: false,
        accessToken: texto(formData, "accessToken") || previa.square.accessToken,
        locationId: texto(formData, "locationId") || previa.square.locationId,
        entorno: texto(formData, "entorno") === "sandbox" ? "sandbox" : "production",
      },
    };
  }

  if (!hayCredenciales(proveedor, cfg)) terminar({ error: `${proveedor}-sin-llaves` });

  /* ── 2. Guardar APAGADO antes de hablar con nadie ── */
  await guardar(proveedor, cfg);

  /* ── 3. Un solo sondeo ── */
  const r = await sondear(proveedor, cfg);

  // Square: el identificador de local escrito a mano casi siempre viene mal (se
  // pone el nombre del negocio en vez del código). Si el token vale y la cuenta
  // tiene un solo local, se corrige aquí y no se vuelve a sondear.
  if (proveedor === "square" && "locales" in r) {
    const locales = (r as { locales: { id: string; nombre: string }[] }).locales;
    if (locales.length === 1 && cfg.square.locationId !== locales[0].id) {
      cfg = { ...cfg, square: { ...cfg.square, locationId: locales[0].id } };
      await guardar("square", cfg);
    }
  }

  await anotarSalud(proveedor, saludDe(proveedor, r, cfg));

  /* ── 4. Encender solo si la pasarela ha dicho que sí ── */
  if (!quiereActivo) {
    await registrarActividad({
      admin,
      action: "update",
      entityType: "setting",
      summary: `${proveedor}: credenciales guardadas sin activar en Pagos.`,
    });
    terminar({ hecho: r.ok ? `${proveedor}-guardado` : `${proveedor}-guardado-con-fallo` });
  }

  if (!r.ok) {
    await registrarActividad({
      admin,
      action: "update",
      entityType: "setting",
      summary: `${proveedor}: no se pudo activar (${r.motivo === "red" ? "sin respuesta" : "rechazado"}).`,
    });
    // Un fallo de red no es culpa de las llaves, así que el mensaje es otro.
    terminar({ error: r.motivo === "red" ? `${proveedor}-sin-respuesta` : `${proveedor}-fallo-activar` });
  }

  await guardar(proveedor, encender(proveedor, cfg));
  await registrarActividad({
    admin,
    action: "update",
    entityType: "setting",
    summary: `${proveedor} conectado y ACTIVO en el checkout.`,
  });
  terminar({ hecho: `${proveedor}-activo` });
}

function encender(proveedor: MetodoOnline, cfg: ConfigPagos): ConfigPagos {
  if (proveedor === "stripe") return { ...cfg, stripe: { ...cfg.stripe, activo: true } };
  if (proveedor === "paypal") return { ...cfg, paypal: { ...cfg.paypal, activo: true } };
  return { ...cfg, square: { ...cfg.square, activo: true } };
}

async function guardar(proveedor: MetodoOnline, cfg: ConfigPagos): Promise<void> {
  if (proveedor === "stripe") return guardarConfigStripe(cfg.stripe);
  if (proveedor === "paypal") return guardarConfigPaypal(cfg.paypal);
  return guardarConfigSquare(cfg.square);
}

/* ─────────────────────── apagar sin desconectar ─────────────────────── */

/**
 * Deja de ofrecer un método sin borrar sus llaves. Existe porque apagar no
 * debería exigir volver a pegar nada, y porque juntar «apagar» con «guardar
 * credenciales» en el mismo botón hacía que apagar disparase un sondeo.
 */
export async function apagarProveedor(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const proveedor = proveedorDe(formData);
  const cfg = await leerConfigPagos();

  if (proveedor === "stripe") await guardarConfigStripe({ ...cfg.stripe, activo: false });
  else if (proveedor === "paypal") await guardarConfigPaypal({ ...cfg.paypal, activo: false });
  else await guardarConfigSquare({ ...cfg.square, activo: false });

  await registrarActividad({
    admin,
    action: "update",
    entityType: "setting",
    summary: `${proveedor} apagado en el checkout (las llaves siguen guardadas).`,
  });
  terminar({ hecho: `${proveedor}-apagado` });
}

/* ─────────────────────── comprobar ─────────────────────── */

/** Vuelve a preguntarle a la pasarela por las llaves guardadas y apunta la salud. */
export async function comprobarProveedor(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const proveedor = proveedorDe(formData);
  // Siempre desde la base, nunca de un caché: se prueba lo que está GUARDADO.
  let cfg = await leerConfigPagos();
  if (!hayCredenciales(proveedor, cfg)) terminar({ error: `${proveedor}-sin-llaves` });

  const r = await sondear(proveedor, cfg);

  let rellenado = false;
  if (proveedor === "square" && "locales" in r) {
    const locales = (r as { locales: { id: string; nombre: string }[] }).locales;
    if (locales.length === 1 && cfg.square.locationId !== locales[0].id) {
      cfg = { ...cfg, square: { ...cfg.square, locationId: locales[0].id } };
      await guardarConfigSquare(cfg.square);
      rellenado = true;
    }
  }

  await anotarSalud(proveedor, saludDe(proveedor, r, cfg));
  await registrarActividad({
    admin,
    action: "update",
    entityType: "setting",
    summary: `Comprobó la conexión con ${proveedor}: ${r.ok ? "bien" : `falló (${r.codigo ?? "sin código"})`}.`,
  });

  if (r.ok) terminar({ hecho: rellenado ? "square-local" : `${proveedor}-conexion` });
  terminar({ error: r.motivo === "red" ? `${proveedor}-sin-respuesta` : `${proveedor}-fallo` });
}

/**
 * Comprueba de una vez las que estén configuradas. Es el botón de la cabecera:
 * la pregunta que se hace de verdad es «¿está todo cobrando?», no «¿cómo está
 * Stripe?».
 */
export async function comprobarTodas(): Promise<void> {
  const admin = await exigirDuena();
  const cfg = await leerConfigPagos();
  const proveedores: MetodoOnline[] = ["stripe", "paypal", "square"];
  const hechas = proveedores.filter((p) => hayCredenciales(p, cfg));
  if (hechas.length === 0) terminar({ error: "nada-que-comprobar" });

  // En serie a propósito: son tres llamadas con timeout de 15 s y `anotarSalud`
  // lee y reescribe la misma fila. En paralelo se pisarían entre ellas.
  let fallos = 0;
  for (const p of hechas) {
    const r = await sondear(p, cfg);
    if (!r.ok) fallos += 1;
    await anotarSalud(p, saludDe(p, r, cfg));
  }

  await registrarActividad({
    admin,
    action: "update",
    entityType: "setting",
    summary: `Comprobó ${hechas.length} ${hechas.length === 1 ? "pasarela" : "pasarelas"}: ${fallos} con problemas.`,
  });
  terminar({ hecho: fallos === 0 ? "todas-bien" : "todas-con-fallos" });
}

/* ─────────────────────── métodos sin pasarela ─────────────────────── */

export async function guardarManuales(formData: FormData): Promise<void> {
  const admin = await exigirDuena();

  const payDm = marcado(formData, "payDm");
  const payPickup = marcado(formData, "payPickup");

  // La tienda no puede quedarse sin NINGUNA forma de terminar una compra.
  const online = metodosOnlineActivos(await leerConfigPagos(), await leerSalud());
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

/* ─────────────────────── desconectar ─────────────────────── */

const CLAVE_SETTING: Record<MetodoOnline, string> = {
  stripe: "paymentsStripe",
  paypal: "paymentsPaypal",
  square: "paymentsSquare",
};

/**
 * Borra las credenciales guardadas de un proveedor (rotación de llaves o
 * desconexión) y olvida su salud. No es destructivo de verdad: se recupera
 * pegándolas otra vez.
 *
 * Borra por CLAVE, no por lo que se pudo descifrar: si la fila existe pero este
 * servidor ya no puede leerla (cambió `SESSION_SECRET`), esto es lo único que
 * permite limpiarla desde la interfaz. Antes el botón salía deshabilitado
 * justamente en ese caso, que es cuando más falta hacía.
 */
export async function desconectarProveedor(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const proveedor = proveedorDe(formData);

  await db.setting.deleteMany({ where: { key: CLAVE_SETTING[proveedor] } });
  await olvidarSalud(proveedor);
  await registrarActividad({
    admin,
    action: "delete",
    entityType: "setting",
    summary: `Quitó las llaves de ${proveedor} en Pagos.`,
  });
  terminar({ hecho: `${proveedor}-quitado` });
}
