import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

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

export type AdminIdentity = { id: string; email: string; name: string };

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
    select: { id: true, email: true, name: true },
  });
  return user ?? null;
}

/**
 * Crea el admin de la primera vez con las credenciales del entorno.
 * Nunca pisa una cuenta existente: si ya hay admin, no toca nada.
 */
export async function ensureSeedAdmin(): Promise<void> {
  const count = await db.adminUser.count();
  if (count > 0) return;

  const email = process.env.ADMIN_EMAIL || "admin@bloombymadeline.com";
  const password = process.env.ADMIN_PASSWORD || "bloom2026";
  await db.adminUser.create({
    data: { email: email.toLowerCase(), name: "Madeline", passwordHash: hashPassword(password) },
  });
}
