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
import { activacionTrasSondeo } from "@/lib/payments/activacion";
import { esDePruebas } from "@/lib/payments/entorno";
import { anotarSalud, leerSalud, olvidarSalud, type SaludProveedor } from "@/lib/payments/estado";
import { probarPaypal } from "@/lib/payments/paypal";
import { probarSquare } from "@/lib/payments/square";
import { probarStripe } from "@/lib/payments/stripe";
import {
  PROVEEDORES,
  proveedorPorId,
  reconocerConValores,
  type PistaConValor,
} from "@/lib/payments/proveedores";
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

/**
 * El «entorno» solo si el formulario lo manda de verdad. `null` = no venía, y
 * entonces manda el que ya estaba guardado (que lo dedujo la sonda).
 */
function esSandbox(formData: FormData): boolean | null {
  const v = texto(formData, "entorno");
  if (!v) return null;
  return v === "sandbox";
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
async function sondearUnaVez(proveedor: MetodoOnline, cfg: ConfigPagos): Promise<ResultadoPrueba> {
  if (proveedor === "stripe") return probarStripe(cfg.stripe);
  if (proveedor === "paypal") return probarPaypal(cfg.paypal);
  return probarSquare(cfg.square);
}

/** El mismo `cfg` con el entorno del proveedor cambiado al otro. */
function conElOtroEntorno(proveedor: MetodoOnline, cfg: ConfigPagos): ConfigPagos {
  if (proveedor === "paypal") {
    return { ...cfg, paypal: { ...cfg.paypal, entorno: cfg.paypal.entorno === "sandbox" ? "live" : "sandbox" } };
  }
  if (proveedor === "square") {
    return {
      ...cfg,
      square: { ...cfg.square, entorno: cfg.square.entorno === "sandbox" ? "production" : "sandbox" },
    };
  }
  return cfg;
}

/**
 * Sondea y, si hace falta, AVERIGUA EL ENTORNO en vez de preguntárselo a nadie.
 *
 * Por qué: «Entorno» era el campo más confuso del panel y la causa número uno de
 * que un cobro no funcione — se pega el token de la pestaña Sandbox teniendo el
 * desplegable en «Real» (o al revés) y el proveedor solo contesta «no
 * autorizado», que no explica nada. Los tokens de Square y las credenciales de
 * PayPal no dicen de qué entorno son, así que la única fuente fiable es
 * preguntar: si con el entorno guardado nos rechazan, se prueba el otro. Si allí
 * funciona, ESE es el bueno y se guarda. La dueña no vuelve a elegirlo nunca.
 *
 * Stripe no entra aquí porque su llave lleva el entorno escrito (sk_live_ /
 * sk_test_): probar el otro no tendría ningún sentido.
 */
async function sondear(
  proveedor: MetodoOnline,
  cfg: ConfigPagos,
): Promise<{ r: ResultadoPrueba; cfg: ConfigPagos; entornoCambiado: boolean }> {
  const primera = await sondearUnaVez(proveedor, cfg);
  const puedeDeducirse = proveedorPorId(proveedor).entornoSeDeduce;
  // Solo cuando la pasarela RECHAZA de verdad: un fallo de red no dice nada del
  // entorno y reintentarlo en el otro solo alargaría la espera.
  if (primera.ok || !puedeDeducirse || primera.motivo !== "credencial") {
    return { r: primera, cfg, entornoCambiado: false };
  }
  const otro = conElOtroEntorno(proveedor, cfg);
  const segunda = await sondearUnaVez(proveedor, otro);
  if (!segunda.ok) return { r: primera, cfg, entornoCambiado: false };
  return { r: segunda, cfg: otro, entornoCambiado: true };
}

/** El resultado del sondeo, traducido a lo que se guarda en `paymentsEstado`. */
function saludDe(proveedor: MetodoOnline, r: ResultadoPrueba, cfg: ConfigPagos): SaludProveedor {
  const salud: SaludProveedor = {
    resultado: r.ok ? "ok" : r.motivo === "red" ? "sin-respuesta" : "rechazada",
    codigo: r.codigo ?? (r.ok ? "ok" : "credencial-invalida"),
    en: new Date().toISOString(),
  };
  if (r.cuenta) salud.cuenta = r.cuenta;
  // El entorno sale de las credenciales que se usan de verdad, no de un
  // desplegable (que ya no existe). Ver lib/payments/entorno.ts. Se anota
  // SIEMPRE, no solo cuando la conexión va bien: una pasarela en pruebas y
  // rechazada sigue siendo una pasarela en pruebas, y hay que poder decirlo.
  salud.entornoReal = esDePruebas(proveedor, cfg) ? "pruebas" : "real";
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
  // Cómo estaba el interruptor ANTES. Si la pasarela no contesta hay que
  // devolverlo a esto: no se ha aprendido nada como para cambiarlo.
  const activoAntes = previa[proveedor].activo;

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
        // El panel ya no dibuja «Entorno»: lo deduce la sonda. Si el formulario
        // no lo manda hay que CONSERVAR el que se averiguó, no reiniciarlo a
        // «real» — eso descartaba el sandbox recién deducido y obligaba a dos
        // viajes extra a la pasarela en cada guardado.
        entorno: esSandbox(formData) === null ? previa.paypal.entorno : esSandbox(formData) ? "sandbox" : "live",
      },
    };
  } else {
    cfg = {
      ...previa,
      square: {
        activo: false,
        accessToken: texto(formData, "accessToken") || previa.square.accessToken,
        locationId: texto(formData, "locationId") || previa.square.locationId,
        entorno: esSandbox(formData) === null ? previa.square.entorno : esSandbox(formData) ? "sandbox" : "production",
      },
    };
  }

  if (!hayCredenciales(proveedor, cfg)) terminar({ error: `${proveedor}-sin-llaves` });

  /* ── 2. Guardar APAGADO antes de hablar con nadie ── */
  await guardar(proveedor, cfg);

  /* ── 3. Un solo sondeo (que además averigua el entorno si hace falta) ── */
  const sonda = await sondear(proveedor, cfg);
  const r = sonda.r;
  if (sonda.entornoCambiado) {
    // El token era del otro entorno: se corrige y se guarda, en vez de
    // devolverle un error que la obligue a adivinar cuál de los dos era.
    cfg = sonda.cfg;
    await guardar(proveedor, cfg);
  }

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
    // Ella desmarcó la casilla: apagar es lo que pidió, y ya está guardado así.
    await registrarActividad({
      admin,
      action: "update",
      entityType: "setting",
      summary: `${proveedor}: credenciales guardadas sin activar en Pagos.`,
    });
    terminar({ hecho: r.ok ? `${proveedor}-guardado` : `${proveedor}-guardado-con-fallo` });
  }

  if (!r.ok) {
    // ⚠️ Sin respuesta ≠ rechazo. Con la pasarela caída se devuelve el
    // interruptor a como estaba: si el cobro estaba encendido, sigue encendido.
    // Sin esto, un bajón de treinta segundos apagaba la tarjeta de una tienda
    // viva mientras la pantalla decía «tus llaves están guardadas y sin tocar»,
    // que era mentira. Un rechazo explícito SÍ deja apagado: ofrecer una tarjeta
    // que no cobra es peor que no ofrecerla.
    await guardar(proveedor, comoEstaba(proveedor, cfg, activacionTrasSondeo(quiereActivo, activoAntes, r)));
    await registrarActividad({
      admin,
      action: "update",
      entityType: "setting",
      summary: `${proveedor}: no se pudo activar (${r.motivo === "red" ? "sin respuesta; se deja como estaba" : "rechazado"}).`,
    });
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

/**
 * Deja el interruptor de un proveedor como estaba antes de tocar nada.
 *
 * Se usa cuando la pasarela NO CONTESTA. Guardar apagado antes de sondear
 * protege la credencial recién pegada, pero si luego no se puede preguntar hay
 * que deshacerlo: de un fallo de red no se concluye nada, y dejarlo apagado
 * significa que un bajón ajeno de treinta segundos deja a la tienda sin cobro
 * con tarjeta por tiempo indefinido. La regla está escrita arriba y este es el
 * único sitio donde puede romperse.
 */
function comoEstaba(proveedor: MetodoOnline, cfg: ConfigPagos, activo: boolean): ConfigPagos {
  if (proveedor === "stripe") return { ...cfg, stripe: { ...cfg.stripe, activo } };
  if (proveedor === "paypal") return { ...cfg, paypal: { ...cfg.paypal, activo } };
  return { ...cfg, square: { ...cfg.square, activo } };
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

  const sonda = await sondear(proveedor, cfg);
  const r = sonda.r;
  if (sonda.entornoCambiado) {
    cfg = sonda.cfg;
    await guardar(proveedor, cfg);
  }

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
  // Del registro, no de una lista escrita a mano: un procesador nuevo entra
  // aquí solo.
  const proveedores: MetodoOnline[] = PROVEEDORES.map((x) => x.id);
  const hechas = proveedores.filter((p) => hayCredenciales(p, cfg));
  if (hechas.length === 0) terminar({ error: "nada-que-comprobar" });

  // Se PREGUNTA en paralelo y se ESCRIBE en serie.
  //
  // Antes era todo en serie porque `anotarSalud` lee y reescribe la misma fila y
  // en paralelo se pisarían. Pero eso solo obliga a serializar la escritura: las
  // preguntas son a tres servidores distintos. En serie, tres pasarelas lentas
  // sumaban hasta 45 s dentro de una Server Action y Vercel la habría cortado a
  // media comprobación.
  const sondas = await Promise.all(hechas.map(async (p) => ({ p, sonda: await sondear(p, cfg) })));
  let fallos = 0;
  for (const { p, sonda } of sondas) {
    if (sonda.entornoCambiado) await guardar(p, sonda.cfg);
    if (!sonda.r.ok) fallos += 1;
    await anotarSalud(p, saludDe(p, sonda.r, sonda.cfg));
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

/* ═══════════════════════ pegar y que se detecte solo ═══════════════════════ */

/**
 * UNA caja donde pegar lo que sea, y el sistema decide de quién es.
 *
 * Es la respuesta a lo que de verdad hace una dueña de boutique: abre el panel
 * de su procesador, selecciona el bloque de credenciales y lo pega. No sabe (ni
 * tiene por qué) si eso es un «Access token» de Square, un «Client ID» de PayPal
 * o una llave secreta de Stripe, y menos aún si es de pruebas o real.
 *
 * `reconocerConValores` mira la FORMA de lo pegado y lo reparte. Después se
 * guarda, se sondea —averiguando el entorno de paso— y se enciende si el
 * proveedor confirma. Acepta varias credenciales del mismo proveedor a la vez,
 * que es justo lo que hace falta en PayPal (Client ID + Secret).
 *
 * Lo que NO hace: adivinar. Si no reconoce nada, lo dice y no toca nada; si lo
 * pegado es de dos proveedores distintos, también, porque mezclarlos dejaría una
 * configuración a medias. Los campos de cada tarjeta siguen ahí para el caso raro.
 */
export async function pegarCredencial(formData: FormData): Promise<void> {
  const admin = await exigirDuena();
  const pegado = texto(formData, "pegado");
  if (!pegado) terminar({ error: "pegado-vacio" });

  const pistas = reconocerConValores(pegado);
  if (pistas.length === 0) terminar({ error: "pegado-desconocido" });

  // Un problema conocido (la llave publicable de Stripe) se dice tal cual: es
  // más útil que un «no reconocido» y evita guardar algo que no puede cobrar.
  const conProblema = pistas.find((p) => p.problema);
  if (conProblema) {
    await anotarSalud(conProblema.proveedor, {
      resultado: "rechazada",
      codigo: conProblema.problema ?? "credencial-invalida",
      en: new Date().toISOString(),
    });
    terminar({ error: "stripe-clave" });
  }

  const proveedores = [...new Set(pistas.map((p) => p.proveedor))];
  if (proveedores.length > 1) terminar({ error: "pegado-mezclado" });
  const proveedor = proveedores[0];

  /* ── Meter cada valor en su sitio, sin tocar lo que no venga ── */
  const previa = await leerConfigPagos();
  // Igual que en `conectarProveedor`: si la pasarela no contesta, el interruptor
  // vuelve a como estaba. Un bajón ajeno no puede apagar un cobro que funciona.
  const activoAntes = previa[proveedor].activo;
  let cfg = aplicarPistas(previa, proveedor, pistas);

  if (!hayCredenciales(proveedor, cfg)) {
    // Reconocido pero incompleto: PayPal sin su Secret, por ejemplo. Se guarda
    // lo que hay (no se pierde) y se dice qué falta — conservando el
    // interruptor: media credencial nueva no es motivo para apagar el cobro.
    await guardar(proveedor, comoEstaba(proveedor, cfg, activoAntes));
    terminar({ error: `${proveedor}-sin-llaves` });
  }

  await guardar(proveedor, cfg);
  const sonda = await sondear(proveedor, cfg);
  if (sonda.entornoCambiado) {
    cfg = sonda.cfg;
    await guardar(proveedor, cfg);
  }

  // Square: el local se rellena solo cuando la cuenta tiene uno.
  if (proveedor === "square" && "locales" in sonda.r) {
    const locales = (sonda.r as { locales: { id: string; nombre: string }[] }).locales;
    if (locales.length === 1 && cfg.square.locationId !== locales[0].id) {
      cfg = { ...cfg, square: { ...cfg.square, locationId: locales[0].id } };
      await guardar("square", cfg);
    }
  }

  await anotarSalud(proveedor, saludDe(proveedor, sonda.r, cfg));
  await registrarActividad({
    admin,
    action: "update",
    entityType: "setting",
    summary: `Pegó una credencial: reconocida como ${proveedor} (${pistas.map((p) => p.campo).join(", ")}); ${sonda.r.ok ? "conectada" : "rechazada"}.`,
  });

  if (!sonda.r.ok) {
    await guardar(proveedor, comoEstaba(proveedor, cfg, activacionTrasSondeo(true, activoAntes, sonda.r)));
    terminar({ error: sonda.r.motivo === "red" ? `${proveedor}-sin-respuesta` : `${proveedor}-fallo-activar` });
  }

  // Reconocido, comprobado y funcionando: se enciende. Es el punto de todo esto
  // — pegar y estar cobrando, sin pasar por tres botones y un desplegable.
  await guardar(proveedor, encender(proveedor, cfg));
  terminar({ hecho: `${proveedor}-activo` });
}

/** Coloca cada valor reconocido en su campo de la configuración. */
function aplicarPistas(
  previa: ConfigPagos,
  proveedor: MetodoOnline,
  pistas: PistaConValor[],
): ConfigPagos {
  const valor = (campo: string) => pistas.find((p) => p.campo === campo)?.valor;
  if (proveedor === "stripe") {
    return { ...previa, stripe: { activo: false, secretKey: valor("secretKey") ?? previa.stripe.secretKey } };
  }
  if (proveedor === "paypal") {
    return {
      ...previa,
      paypal: {
        ...previa.paypal,
        activo: false,
        clientId: valor("clientId") ?? previa.paypal.clientId,
        clientSecret: valor("clientSecret") ?? previa.paypal.clientSecret,
      },
    };
  }
  return {
    ...previa,
    square: {
      ...previa.square,
      activo: false,
      accessToken: valor("accessToken") ?? previa.square.accessToken,
      locationId: valor("locationId") ?? previa.square.locationId,
    },
  };
}
