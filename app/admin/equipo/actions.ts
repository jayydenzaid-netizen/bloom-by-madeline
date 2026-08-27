"use server";

import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logActivity } from "@/lib/activity";
import { hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { AYUDA_USUARIO, claveUsuario, validarUsuario } from "@/lib/usuario";
import {
  ETIQUETA_ROL,
  ROLES,
  can,
  getAdminConRol,
  normalizarRol,
  permiteCambioDeCuenta,
} from "@/lib/permissions";

/**
 * Acciones del módulo Equipo. Todas comprueban que quien las ejecuta es la
 * dueña: un Server Action es un endpoint público, y confiar en que la pantalla
 * no se pinta es exactamente el error que abre el agujero.
 *
 * Dos capas a propósito:
 *  - Las funciones "núcleo" (`crearCuenta`, `cambiarRol`, ...) **devuelven un
 *    resultado tipado y nunca lanzan**. Son las que se pueden probar y las que
 *    usaría un componente cliente con useActionState.
 *  - Los envoltorios `enviar*` son los que se enganchan a los `<form>` de la
 *    pantalla: llaman al núcleo y redirigen con un código. El código se traduce
 *    a castellano en la propia pantalla; por la URL nunca viaja nada sensible.
 *
 * Ninguna acción borra cuentas. Una cuenta borrada se lleva por delante el
 * rastro de quién hizo qué; desactivar consigue lo mismo (no puede entrar) sin
 * romper la bitácora.
 */

/* ─────────────────────────────── tipos ─────────────────────────────── */

export type CodigoEquipo =
  | "creada"
  | "rol-cambiado"
  | "desactivada"
  | "reactivada"
  | "sesiones-cerradas"
  | "clave-nueva"
  | "sin-permiso"
  | "datos"
  | "email-duplicado"
  | "usuario-duplicado"
  | "no-existe"
  | "ultimo-owner"
  | "auto-desactivar"
  | "auto-rol"
  | "auto-sesiones"
  | "auto-clave"
  | "error";

export type ResultadoEquipo =
  | { ok: true; codigo: CodigoEquipo; usuarioId?: string; detalle?: string }
  | { ok: false; codigo: CodigoEquipo; detalle?: string };

/* ──────────────────── contraseña inicial de un solo uso ──────────────────── */

/**
 * Aquí no hay correo configurado, así que la contraseña inicial se le da a la
 * persona en mano: se genera al crear la cuenta y se enseña UNA vez en la
 * pantalla siguiente.
 *
 * Se guarda en la tabla Setting (con expiración corta), NO en memoria del
 * proceso. En Vercel el POST que crea la cuenta y el GET que la enseña son dos
 * invocaciones que pueden caer en instancias distintas: un Map no viajaría entre
 * ellas y la ayudante se quedaría sin forma de entrar. Guardarla en la base la
 * hace legible desde cualquier instancia. Va en claro a propósito —se enseña en
 * claro en pantalla igual—, prefijada, con vida de 30 minutos, y se borra al
 * pulsar "Ya la copié" o al caducar.
 */
const CLAVE_PREFIX = "initclave:";
const VIDA_CLAVE_MS = 30 * 60 * 1000;

async function guardarClaveInicial(userId: string, clave: string): Promise<void> {
  const key = CLAVE_PREFIX + userId;
  const value = JSON.stringify({ clave, expira: Date.now() + VIDA_CLAVE_MS });
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function borrarClaveInicial(userId: string): Promise<void> {
  await db.setting.deleteMany({ where: { key: CLAVE_PREFIX + userId } });
}

/**
 * Alfabeto sin caracteres que se confunden al dictar o al copiar a mano
 * (0/O, 1/l/I). La contraseña se lee en voz alta más veces de las que parece.
 */
const ALFABETO = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 3 grupos de 4 = 12 caracteres al azar con randomInt (CSPRNG), no Math.random. */
function generarClaveInicial(): string {
  const grupo = () =>
    Array.from({ length: 4 }, () => ALFABETO[randomInt(ALFABETO.length)]).join("");
  return `${grupo()}-${grupo()}-${grupo()}`;
}

/**
 * Devuelve la contraseña recién generada de una cuenta, si sigue viva.
 * Comprueba permisos porque, al ser exportada de un fichero "use server", es
 * un endpoint alcanzable desde fuera.
 */
export async function leerClaveInicial(userId: string): Promise<string | null> {
  const admin = await getAdminConRol();
  if (!can(admin, "equipo.gestionar")) return null;

  const fila = await db.setting.findUnique({ where: { key: CLAVE_PREFIX + userId }, select: { value: true } });
  if (!fila) return null;
  try {
    const dato = JSON.parse(fila.value) as { clave?: string; expira?: number };
    if (!dato.clave || typeof dato.expira !== "number" || dato.expira <= Date.now()) {
      await borrarClaveInicial(userId);
      return null;
    }
    return dato.clave;
  } catch {
    await borrarClaveInicial(userId);
    return null;
  }
}

/* ─────────────────────────────── esquemas ─────────────────────────────── */

const idSchema = z.string().trim().min(1).max(64);

const nuevaCuentaSchema = z.object({
  nombre: z.string().trim().min(2, "Escribe el nombre.").max(60, "Ese nombre es demasiado largo."),
  // El usuario es con lo que se entra; el correo se queda como forma de contacto.
  usuario: z.string().superRefine((bruto, ctx) => {
    const veredicto = validarUsuario(bruto);
    if (!veredicto.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: veredicto.error });
  }),
  email: z.string().trim().toLowerCase().email("Ese correo no parece válido.").max(160),
  rol: z.enum(ROLES),
});

const cambioRolSchema = z.object({ id: idSchema, rol: z.enum(ROLES) });

/* ────────────────────────────── utilidades ────────────────────────────── */

/** Sesión + permiso de equipo en una línea. */
async function sesionDuena() {
  const admin = await getAdminConRol();
  return can(admin, "equipo.gestionar") ? admin : null;
}

/** Foto de todas las cuentas para decidir el asunto del último owner. */
async function censo() {
  return db.adminUser.findMany({ select: { id: true, role: true, isActive: true } });
}

function refrescar(): void {
  revalidatePath("/admin/equipo");
  revalidatePath("/admin/actividad");
}

/* ═══════════════════════════ acciones núcleo ═══════════════════════════ */

/** Crea una cuenta y deja su contraseña inicial lista para enseñarla una vez. */
export async function crearCuenta(formData: FormData): Promise<ResultadoEquipo> {
  const admin = await sesionDuena();
  if (!admin) return { ok: false, codigo: "sin-permiso" };

  const datos = nuevaCuentaSchema.safeParse({
    nombre: formData.get("nombre"),
    usuario: formData.get("usuario"),
    email: formData.get("email"),
    rol: formData.get("rol"),
  });
  if (!datos.success) {
    return { ok: false, codigo: "datos", detalle: datos.error.issues[0]?.message ?? AYUDA_USUARIO };
  }

  const usuario = datos.data.usuario.trim();

  const yaExiste = await db.adminUser.findUnique({ where: { email: datos.data.email }, select: { id: true } });
  if (yaExiste) return { ok: false, codigo: "email-duplicado" };

  // Se compara en minúsculas: dos cuentas no pueden ser «Ana» y «ana», o nadie
  // sabría cuál de las dos abre el panel. La tabla tiene un puñado de filas.
  const usuarios = await db.adminUser.findMany({ select: { username: true } });
  const ocupado = usuarios.some((c) => c.username && claveUsuario(c.username) === claveUsuario(usuario));
  if (ocupado) return { ok: false, codigo: "usuario-duplicado" };

  const clave = generarClaveInicial();

  try {
    const creada = await db.adminUser.create({
      data: {
        name: datos.data.nombre,
        username: usuario,
        email: datos.data.email,
        role: datos.data.rol,
        isActive: true,
        passwordHash: hashPassword(clave),
      },
      select: { id: true },
    });

    await guardarClaveInicial(creada.id, clave);

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "create",
      entityType: "admin_user",
      entityId: creada.id,
      summary: `Creó la cuenta de ${datos.data.nombre} (usuario ${usuario}) como ${ETIQUETA_ROL[datos.data.rol]}`,
      meta: { rol: datos.data.rol, usuario, email: datos.data.email },
    });

    refrescar();
    return { ok: true, codigo: "creada", usuarioId: creada.id };
  } catch {
    return { ok: false, codigo: "error" };
  }
}

/** Cambia el rol de una cuenta. No deja a la tienda sin dueña activa. */
export async function cambiarRol(formData: FormData): Promise<ResultadoEquipo> {
  const admin = await sesionDuena();
  if (!admin) return { ok: false, codigo: "sin-permiso" };

  const datos = cambioRolSchema.safeParse({ id: formData.get("id"), rol: formData.get("rol") });
  if (!datos.success) return { ok: false, codigo: "datos" };

  // Cambiarse el rol a una misma es la forma más rápida de quedarse fuera de
  // Ajustes sin poder volver: se prohíbe y punto.
  if (datos.data.id === admin.id) return { ok: false, codigo: "auto-rol" };

  const cuentas = await censo();
  const objetivo = cuentas.find((c) => c.id === datos.data.id);
  if (!objetivo) return { ok: false, codigo: "no-existe" };
  if (normalizarRol(objetivo.role) === datos.data.rol) return { ok: true, codigo: "rol-cambiado" };

  const veredicto = permiteCambioDeCuenta(cuentas, { id: datos.data.id, role: datos.data.rol });
  if (!veredicto.ok) return { ok: false, codigo: "ultimo-owner", detalle: veredicto.error };

  try {
    const fila = await db.adminUser.update({
      where: { id: datos.data.id },
      data: { role: datos.data.rol },
      select: { name: true, email: true },
    });

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "update",
      entityType: "admin_user",
      entityId: datos.data.id,
      summary: `${fila.name || fila.email} pasa a ser ${ETIQUETA_ROL[datos.data.rol]}`,
      meta: { antes: objetivo.role, despues: datos.data.rol },
    });

    refrescar();
    return { ok: true, codigo: "rol-cambiado" };
  } catch {
    return { ok: false, codigo: "error" };
  }
}

/**
 * Desactiva una cuenta: deja de poder entrar y se le cierran las sesiones
 * abiertas en el momento. Sin lo segundo seguiría dentro hasta 14 días.
 */
export async function desactivarCuenta(formData: FormData): Promise<ResultadoEquipo> {
  const admin = await sesionDuena();
  if (!admin) return { ok: false, codigo: "sin-permiso" };

  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { ok: false, codigo: "datos" };
  if (id.data === admin.id) return { ok: false, codigo: "auto-desactivar" };

  const cuentas = await censo();
  if (!cuentas.some((c) => c.id === id.data)) return { ok: false, codigo: "no-existe" };

  const veredicto = permiteCambioDeCuenta(cuentas, { id: id.data, isActive: false });
  if (!veredicto.ok) return { ok: false, codigo: "ultimo-owner", detalle: veredicto.error };

  try {
    const fila = await db.adminUser.update({
      where: { id: id.data },
      data: { isActive: false },
      select: { name: true, email: true },
    });
    const cerradas = await db.session.deleteMany({ where: { userId: id.data } });

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "update",
      entityType: "admin_user",
      entityId: id.data,
      summary: `Desactivó la cuenta de ${fila.name || fila.email} y cerró ${cerradas.count} sesión(es)`,
      meta: { isActive: false, sesionesCerradas: cerradas.count },
    });

    refrescar();
    return { ok: true, codigo: "desactivada" };
  } catch {
    return { ok: false, codigo: "error" };
  }
}

/** Vuelve a dejar entrar a una cuenta desactivada, con la misma contraseña. */
export async function reactivarCuenta(formData: FormData): Promise<ResultadoEquipo> {
  const admin = await sesionDuena();
  if (!admin) return { ok: false, codigo: "sin-permiso" };

  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { ok: false, codigo: "datos" };

  try {
    const fila = await db.adminUser.update({
      where: { id: id.data },
      data: { isActive: true },
      select: { name: true, email: true },
    });

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "update",
      entityType: "admin_user",
      entityId: id.data,
      summary: `Reactivó la cuenta de ${fila.name || fila.email}`,
      meta: { isActive: true },
    });

    refrescar();
    return { ok: true, codigo: "reactivada" };
  } catch {
    return { ok: false, codigo: "no-existe" };
  }
}

/** Cierra todas las sesiones de otra persona (móvil perdido, ordenador prestado). */
export async function cerrarSesionesDe(formData: FormData): Promise<ResultadoEquipo> {
  const admin = await sesionDuena();
  if (!admin) return { ok: false, codigo: "sin-permiso" };

  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { ok: false, codigo: "datos" };
  // Las propias se cierran desde "Tu cuenta": aquí sería cerrarse la puerta sola.
  if (id.data === admin.id) return { ok: false, codigo: "auto-sesiones" };

  const fila = await db.adminUser.findUnique({ where: { id: id.data }, select: { name: true, email: true } });
  if (!fila) return { ok: false, codigo: "no-existe" };

  try {
    const cerradas = await db.session.deleteMany({ where: { userId: id.data } });

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "security",
      entityType: "admin_user",
      entityId: id.data,
      summary: `Cerró ${cerradas.count} sesión(es) de ${fila.name || fila.email}`,
      meta: { sesionesCerradas: cerradas.count },
    });

    refrescar();
    return { ok: true, codigo: "sesiones-cerradas" };
  } catch {
    return { ok: false, codigo: "error" };
  }
}

/**
 * Genera una contraseña nueva para otra cuenta. Es la red de seguridad para el
 * "no me acuerdo de la clave" cuando no hay correo de recuperación: la dueña la
 * genera, la lee una vez y se la da en mano.
 */
export async function restablecerClave(formData: FormData): Promise<ResultadoEquipo> {
  const admin = await sesionDuena();
  if (!admin) return { ok: false, codigo: "sin-permiso" };

  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { ok: false, codigo: "datos" };
  if (id.data === admin.id) return { ok: false, codigo: "auto-clave" };

  const fila = await db.adminUser.findUnique({ where: { id: id.data }, select: { name: true, email: true } });
  if (!fila) return { ok: false, codigo: "no-existe" };

  const clave = generarClaveInicial();

  try {
    await db.adminUser.update({ where: { id: id.data }, data: { passwordHash: hashPassword(clave) } });
    // La contraseña vieja deja de valer, así que sus sesiones también.
    const cerradas = await db.session.deleteMany({ where: { userId: id.data } });
    await guardarClaveInicial(id.data, clave);

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "security",
      entityType: "admin_user",
      entityId: id.data,
      summary: `Generó una contraseña nueva para ${fila.name || fila.email}`,
      meta: { sesionesCerradas: cerradas.count },
    });

    refrescar();
    return { ok: true, codigo: "clave-nueva", usuarioId: id.data };
  } catch {
    return { ok: false, codigo: "error" };
  }
}

/** Olvida la contraseña recién enseñada (botón "Ya la copié"). */
export async function descartarClaveInicial(formData: FormData): Promise<ResultadoEquipo> {
  const admin = await sesionDuena();
  if (!admin) return { ok: false, codigo: "sin-permiso" };

  const id = idSchema.safeParse(formData.get("id"));
  if (id.success) await borrarClaveInicial(id.data);
  refrescar();
  return { ok: true, codigo: "creada" };
}

/* ═══════════════════ envoltorios para los <form> ═══════════════════ */

/**
 * Construye la URL de vuelta. Solo viajan códigos de un conjunto cerrado y, en
 * el caso de crear, el id de la cuenta nueva para saber de quién enseñar la
 * contraseña — la contraseña en sí jamás sale por la URL.
 */
function destino(resultado: ResultadoEquipo): string {
  const qs = new URLSearchParams();
  qs.set(resultado.ok ? "ok" : "error", resultado.codigo);
  if (resultado.ok && resultado.usuarioId) qs.set("nuevo", resultado.usuarioId);
  return `/admin/equipo?${qs.toString()}`;
}

export async function enviarCrearCuenta(formData: FormData): Promise<void> {
  const resultado = await crearCuenta(formData);
  // redirect() lanza la excepción de control de Next: fuera de cualquier try.
  redirect(destino(resultado));
}

export async function enviarCambiarRol(formData: FormData): Promise<void> {
  redirect(destino(await cambiarRol(formData)));
}

export async function enviarDesactivar(formData: FormData): Promise<void> {
  redirect(destino(await desactivarCuenta(formData)));
}

export async function enviarReactivar(formData: FormData): Promise<void> {
  redirect(destino(await reactivarCuenta(formData)));
}

export async function enviarCerrarSesiones(formData: FormData): Promise<void> {
  redirect(destino(await cerrarSesionesDe(formData)));
}

export async function enviarRestablecerClave(formData: FormData): Promise<void> {
  redirect(destino(await restablecerClave(formData)));
}

export async function enviarDescartarClave(formData: FormData): Promise<void> {
  await descartarClaveInicial(formData);
  redirect("/admin/equipo");
}
