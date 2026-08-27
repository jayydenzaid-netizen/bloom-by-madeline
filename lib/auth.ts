import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { claveUsuario, normalizarUsuario, usuarioDesdeCorreo, usuarioLibre, validarUsuario } from "@/lib/usuario";

export const SESSION_COOKIE = "bloom_admin";
const SESSION_DAYS = 14;

// scrypt de node en vez de bcrypt: misma resistencia a fuerza bruta y sin binario
// nativo que compilar (importa para que el build de Vercel no se rompa).
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = (stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expected] = parts;
  const derived = scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.session.create({ data: { token, userId, expiresAt } });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { token } });
  jar.delete(SESSION_COOKIE);
}

export type AdminIdentity = { id: string; email: string; name: string; username: string | null };

/** Devuelve el admin de la sesión actual, o null. Caduca sesiones vencidas. */
export async function getAdmin(): Promise<AdminIdentity | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({ where: { token } });
  if (!session) return null;

  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  const user = await db.adminUser.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, username: true, isActive: true },
  });
  // Una cuenta desactivada deja de valer AL INSTANTE, no cuando caduque su
  // sesión (hasta 14 días). El layout ya la expulsa del render vía
  // getAdminConRol, pero las Server Actions autentican por aquí: sin este corte,
  // una ayudante apagada con cookie viva podría seguir borrando o cambiando cosas
  // por POST. Ver lib/permissions.ts (can() aplica la misma regla).
  if (!user || !user.isActive) return null;
  const { isActive: _activa, ...identidad } = user;
  return identidad;
}

/* ═══════════════════════ entrada por usuario ═══════════════════════ */

/**
 * Credenciales de arranque. Salen del entorno a propósito: este repositorio es
 * público, así que la contraseña de verdad vive en el `.env` local y en las
 * variables del proyecto en Vercel, nunca aquí. Los valores de reserva son de
 * desarrollo y solo aparecen cuando no hay nada configurado.
 */
function credencialesDeArranque(): { usuario: string; clave: string | null; email: string } {
  const pedido = validarUsuario(process.env.ADMIN_USERNAME);

  return {
    usuario: pedido.ok ? pedido.usuario : "admin",
    // null = «no se ha configurado ninguna»: quien llame decide si eso significa
    // usar la de desarrollo (cuenta nueva) o no tocar la que ya hay (cuenta viva).
    clave: process.env.ADMIN_PASSWORD || null,
    email: (process.env.ADMIN_EMAIL || "admin@bloombymadeline.com").trim().toLowerCase(),
  };
}

/**
 * Busca una cuenta por su nombre de usuario, sin distinguir mayúsculas.
 *
 * Se hace en dos pasos en vez de con un `mode: "insensitive"` porque ese modo no
 * existe en SQLite, y este proyecto corre sobre SQLite en el portátil y sobre
 * Postgres en producción (ver scripts/db-provider.mjs). El primer paso resuelve
 * el caso normal de un golpe; el segundo recorre las cuentas, que en este panel
 * se cuentan con los dedos de una mano.
 */
export async function findAdminByUsername(bruto: string) {
  const escrito = normalizarUsuario(bruto);
  if (!escrito) return null;

  const exacto = await db.adminUser.findUnique({ where: { username: escrito } });
  if (exacto) return exacto;

  const buscada = claveUsuario(escrito);
  const cuentas = await db.adminUser.findMany({ select: { id: true, username: true } });
  const fila = cuentas.find((c) => c.username && claveUsuario(c.username) === buscada);

  return fila ? db.adminUser.findUnique({ where: { id: fila.id } }) : null;
}

/**
 * Crea el admin de la primera vez con las credenciales del entorno.
 * Nunca pisa una cuenta existente: si ya hay admin, no toca nada.
 */
export async function ensureSeedAdmin(): Promise<void> {
  const count = await db.adminUser.count();
  if (count > 0) return;

  const { usuario, clave, email } = credencialesDeArranque();

  await db.adminUser.create({
    data: {
      username: usuario,
      email,
      name: "Madeline",
      passwordHash: hashPassword(clave || "bloom2026"),
    },
  });
}

/**
 * Rellena el nombre de usuario de las cuentas creadas antes de que el panel
 * dejara de entrar por correo.
 *
 * Sin esto, una cuenta anterior al cambio se quedaría sin forma de entrar: la
 * pantalla pide usuario y su fila tiene la columna vacía. Se ejecuta al intentar
 * entrar, es idempotente (en cuanto una cuenta tiene usuario ya no se la toca) y
 * es la única vez que este código escribe sobre una cuenta ajena.
 *
 * Dos reglas para no hacer daño:
 *  - A la cuenta de la dueña se le pone el usuario del entorno (ADMIN_USERNAME);
 *    a las demás, uno derivado de su correo, que es lo que ya escribían.
 *  - La contraseña SOLO se cambia si hay ADMIN_PASSWORD configurada, y solo en
 *    esta migración. Si no la hay, se deja la que la persona ya tenía: es mucho
 *    peor dejar a alguien fuera que dejarle la contraseña de siempre.
 */
export async function ensureUsernames(): Promise<void> {
  const pendientes = await db.adminUser.findMany({
    where: { OR: [{ username: null }, { username: "" }] },
    select: { id: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (pendientes.length === 0) return;

  const { usuario: usuarioDuena, clave, email: emailDuena } = credencialesDeArranque();

  // La cuenta de la dueña: la que coincide con ADMIN_EMAIL y, si no hay ninguna,
  // el owner más antiguo (que es como se creó siempre la primera cuenta).
  const duena =
    pendientes.find((c) => c.email === emailDuena) ??
    pendientes.find((c) => c.role === "owner") ??
    pendientes[0];

  const tomados = (await db.adminUser.findMany({ select: { username: true } }))
    .map((c) => c.username)
    .filter((u): u is string => Boolean(u));

  for (const cuenta of pendientes) {
    const esDuena = cuenta.id === duena.id;
    const deseado = esDuena ? usuarioDuena : usuarioDesdeCorreo(cuenta.email);
    const username = usuarioLibre(deseado, tomados);
    tomados.push(username);

    await db.adminUser.update({
      where: { id: cuenta.id },
      data: {
        username,
        ...(esDuena && clave ? { passwordHash: hashPassword(clave) } : {}),
      },
    });
  }
}
