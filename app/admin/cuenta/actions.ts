"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logActivity } from "@/lib/activity";
import { SESSION_COOKIE, hashPassword, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAdminConRol } from "@/lib/permissions";

/**
 * Acciones de "Tu cuenta". Valen para cualquier rol: cada quien manda sobre su
 * nombre, su contraseña y sus dispositivos, y sobre nada más.
 *
 * Igual que en Equipo: el núcleo devuelve un resultado tipado y nunca lanza; el
 * envoltorio `enviar*` es el que redirige con un código para el `<form>`.
 */

export type CodigoCuenta =
  | "nombre"
  | "clave"
  | "sesiones-cerradas"
  | "sesion-cerrada"
  | "sin-sesion"
  | "datos"
  | "clave-actual"
  | "clave-debil"
  | "no-coincide"
  | "clave-repetida"
  | "sesion-actual"
  | "error";

export type ResultadoCuenta =
  | { ok: true; codigo: CodigoCuenta; detalle?: string }
  | { ok: false; codigo: CodigoCuenta; detalle?: string };

/* ─────────────────────────────── esquemas ─────────────────────────────── */

const nombreSchema = z.string().trim().min(2, "Escribe tu nombre.").max(60, "Ese nombre es demasiado largo.");
const idSchema = z.string().trim().min(1).max(64);

const MIN_CLAVE = 10;

/**
 * Fuerza mínima razonable, no un examen.
 *
 * Diez caracteres con letras y números paran el ataque realista aquí (probar
 * contraseñas contra el formulario, que además está frenado por intentos). Se
 * permite una frase larga sin números porque "vestidos de verano en hamilton"
 * es mejor contraseña que "Bloom1!" y hay que dejar que la gente la use.
 */
function evaluarFuerza(
  clave: string,
  contexto: { email: string; nombre: string; usuario: string | null },
): string | null {
  if (clave.length < MIN_CLAVE) return `La contraseña necesita al menos ${MIN_CLAVE} caracteres.`;
  if (clave.length > 200) return "Esa contraseña es absurdamente larga.";

  const tieneLetra = /\p{L}/u.test(clave);
  const tieneNumero = /\d/.test(clave);
  const esFrase = clave.length >= 16;
  if (!tieneLetra) return "Mete alguna letra, no solo números.";
  if (!tieneNumero && !esFrase) {
    return "Añade algún número, o alárgala hasta 16 caracteres si prefieres una frase.";
  }

  const minuscula = clave.toLowerCase();
  const correo = contexto.email.split("@")[0]?.toLowerCase() ?? "";
  if (correo.length >= 4 && minuscula.includes(correo)) return "No uses tu correo dentro de la contraseña.";
  const usuario = (contexto.usuario ?? "").toLowerCase();
  if (usuario.length >= 4 && minuscula.includes(usuario)) return "No uses tu usuario dentro de la contraseña.";
  const nombre = contexto.nombre.trim().toLowerCase();
  if (nombre.length >= 4 && minuscula.includes(nombre)) return "No uses tu nombre dentro de la contraseña.";
  if (["bloom2026", "contrasena", "password", "12345678910"].some((mala) => minuscula.includes(mala))) {
    return "Esa contraseña es de las primeras que prueba cualquiera. Elige otra.";
  }
  return null;
}

/** Token de la sesión desde la que se está actuando (para no cerrarse sola). */
async function tokenActual(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

function refrescar(): void {
  revalidatePath("/admin/cuenta");
  revalidatePath("/admin/equipo");
  revalidatePath("/admin/actividad");
}

/* ═══════════════════════════ acciones núcleo ═══════════════════════════ */

/** Cambia el nombre con el que apareces en el panel y en la bitácora. */
export async function cambiarNombre(formData: FormData): Promise<ResultadoCuenta> {
  const admin = await getAdminConRol();
  if (!admin) return { ok: false, codigo: "sin-sesion" };

  const nombre = nombreSchema.safeParse(formData.get("nombre"));
  if (!nombre.success) return { ok: false, codigo: "datos", detalle: nombre.error.issues[0]?.message };
  if (nombre.data === admin.name) return { ok: true, codigo: "nombre" };

  try {
    await db.adminUser.update({ where: { id: admin.id }, data: { name: nombre.data } });

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "update",
      entityType: "admin_user",
      entityId: admin.id,
      summary: `Cambió su nombre a ${nombre.data}`,
      meta: { antes: admin.name, despues: nombre.data },
    });

    refrescar();
    return { ok: true, codigo: "nombre" };
  } catch {
    return { ok: false, codigo: "error" };
  }
}

/**
 * Cambia la contraseña. Exige la actual (si no, cualquiera que pille el móvil
 * desbloqueado se queda con la cuenta para siempre) y, al terminar, cierra las
 * demás sesiones: si la cambias es porque sospechas de alguna.
 */
export async function cambiarContrasena(formData: FormData): Promise<ResultadoCuenta> {
  const admin = await getAdminConRol();
  if (!admin) return { ok: false, codigo: "sin-sesion" };

  const actual = String(formData.get("actual") ?? "");
  const nueva = String(formData.get("nueva") ?? "");
  const repetida = String(formData.get("repetida") ?? "");

  if (!actual || !nueva || !repetida) return { ok: false, codigo: "datos" };
  if (nueva !== repetida) return { ok: false, codigo: "no-coincide" };

  const fila = await db.adminUser.findUnique({ where: { id: admin.id }, select: { passwordHash: true } });
  if (!fila) return { ok: false, codigo: "sin-sesion" };

  if (!verifyPassword(actual, fila.passwordHash)) {
    // Se deja rastro: un intento fallido de cambio de contraseña es justo el
    // tipo de cosa que interesa ver en la bitácora después.
    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "security",
      entityType: "admin_user",
      entityId: admin.id,
      summary: "Falló al escribir su contraseña actual para cambiarla",
    });
    return { ok: false, codigo: "clave-actual" };
  }

  if (verifyPassword(nueva, fila.passwordHash)) return { ok: false, codigo: "clave-repetida" };

  const problema = evaluarFuerza(nueva, { email: admin.email, nombre: admin.name, usuario: admin.username });
  if (problema) return { ok: false, codigo: "clave-debil", detalle: problema };

  try {
    await db.adminUser.update({ where: { id: admin.id }, data: { passwordHash: hashPassword(nueva) } });

    const token = await tokenActual();
    const cerradas = await db.session.deleteMany({
      where: { userId: admin.id, ...(token ? { NOT: { token } } : {}) },
    });

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "security",
      entityType: "admin_user",
      entityId: admin.id,
      summary: `Cambió su contraseña y cerró ${cerradas.count} sesión(es) en otros dispositivos`,
      meta: { sesionesCerradas: cerradas.count },
    });

    refrescar();
    return { ok: true, codigo: "clave" };
  } catch {
    return { ok: false, codigo: "error" };
  }
}

/** Cierra todas tus sesiones menos la de este dispositivo. */
export async function cerrarOtrasSesiones(): Promise<ResultadoCuenta> {
  const admin = await getAdminConRol();
  if (!admin) return { ok: false, codigo: "sin-sesion" };

  try {
    const token = await tokenActual();
    const cerradas = await db.session.deleteMany({
      where: { userId: admin.id, ...(token ? { NOT: { token } } : {}) },
    });

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "security",
      entityType: "admin_user",
      entityId: admin.id,
      summary: `Cerró ${cerradas.count} sesión(es) suyas en otros dispositivos`,
      meta: { sesionesCerradas: cerradas.count },
    });

    refrescar();
    return { ok: true, codigo: "sesiones-cerradas" };
  } catch {
    return { ok: false, codigo: "error" };
  }
}

/** Cierra una sesión concreta de la lista. Nunca la de este dispositivo. */
export async function cerrarUnaSesion(formData: FormData): Promise<ResultadoCuenta> {
  const admin = await getAdminConRol();
  if (!admin) return { ok: false, codigo: "sin-sesion" };

  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { ok: false, codigo: "datos" };

  const sesion = await db.session.findUnique({ where: { id: id.data }, select: { id: true, userId: true, token: true } });
  // Solo tus propias sesiones: un id ajeno se trata como inexistente.
  if (!sesion || sesion.userId !== admin.id) return { ok: false, codigo: "datos" };

  const token = await tokenActual();
  // Cerrar la propia sería salir del panel por la puerta de atrás, sin decirlo.
  // Para eso está "Salir" en el menú.
  if (token && sesion.token === token) return { ok: false, codigo: "sesion-actual" };

  try {
    await db.session.delete({ where: { id: sesion.id } });

    await logActivity({
      userId: admin.id,
      userEmail: admin.email,
      action: "security",
      entityType: "admin_user",
      entityId: admin.id,
      summary: "Cerró una sesión suya desde la lista de dispositivos",
    });

    refrescar();
    return { ok: true, codigo: "sesion-cerrada" };
  } catch {
    return { ok: false, codigo: "error" };
  }
}

/* ═══════════════════ envoltorios para los <form> ═══════════════════ */

function destino(resultado: ResultadoCuenta): string {
  const qs = new URLSearchParams();
  qs.set(resultado.ok ? "ok" : "error", resultado.codigo);
  return `/admin/cuenta?${qs.toString()}`;
}

export async function enviarCambiarNombre(formData: FormData): Promise<void> {
  redirect(destino(await cambiarNombre(formData)));
}

export async function enviarCambiarContrasena(formData: FormData): Promise<void> {
  redirect(destino(await cambiarContrasena(formData)));
}

export async function enviarCerrarOtrasSesiones(): Promise<void> {
  redirect(destino(await cerrarOtrasSesiones()));
}

export async function enviarCerrarUnaSesion(formData: FormData): Promise<void> {
  redirect(destino(await cerrarUnaSesion(formData)));
}
