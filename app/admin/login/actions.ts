"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { createSession, ensureSeedAdmin, verifyPassword } from "@/lib/auth";

export type LoginState = { error?: string };

/**
 * Freno de fuerza bruta, por correo y por IP.
 *
 * En memoria del proceso a propósito: el panel lo usan una o dos personas y
 * meter una tabla para esto complicaría el despliegue.
 *
 * LIMITACIÓN QUE HAY QUE TENER PRESENTE: en un despliegue serverless (Vercel)
 * cada instancia tiene su propio Map, así que el contador NO es global — quien
 * ataque desde muchas conexiones a la vez consigue más intentos de los 8 que
 * dice la constante. Sigue frenando el caso realista (probar contraseñas desde
 * un sitio), pero cuando esto crezca, el contador tiene que mudarse a la base
 * de datos o a un almacén compartido (Redis/Upstash). Mientras tanto, la
 * bitácora deja rastro de cada intento para poder verlo en Actividad.
 */
const attempts = new Map<string, { count: number; until: number }>();
const MAX_ATTEMPTS = 8;
/** Por IP se permite más: detrás de una IP puede haber dos personas legítimas. */
const MAX_ATTEMPTS_IP = 20;
const LOCK_MS = 10 * 60 * 1000;

function throttleKey(email: string): string {
  return email.trim().toLowerCase() || "sin-email";
}

/** IP de quien pide, según las cabeceras del proxy. Solo para el contador. */
async function clientIp(): Promise<string> {
  const h = await headers();
  const reenviada = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return reenviada || h.get("x-real-ip") || "ip-desconocida";
}

function isLocked(key: string, max: number = MAX_ATTEMPTS): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= max;
}

function registerFailure(key: string): void {
  const entry = attempts.get(key);
  const count = entry && Date.now() <= entry.until ? entry.count + 1 : 1;
  attempts.set(key, { count, until: Date.now() + LOCK_MS });
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Escribe tu correo y tu contraseña." };
  }

  const ip = await clientIp();
  const key = throttleKey(email);
  const keyIp = `ip:${ip}`;
  if (isLocked(key) || isLocked(keyIp, MAX_ATTEMPTS_IP)) {
    // No se registra nada aquí: mientras dure el bloqueo, cada recarga escribiría
    // una línea y la bitácora se llenaría de ruido. La línea ya se escribió al
    // cerrarse el freno, más abajo.
    return { error: "Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo." };
  }

  // Primer arranque del proyecto: si la tabla está vacía se crea la cuenta con
  // las credenciales del entorno, si no sería imposible entrar nunca.
  await ensureSeedAdmin();

  const user = await db.adminUser.findUnique({ where: { email } });

  // Mismo mensaje si falla el correo o la contraseña: decir cuál de los dos
  // falló le regala al atacante la mitad del trabajo.
  const genericError = "Correo o contraseña incorrectos.";

  if (!user || !verifyPassword(password, user.passwordHash)) {
    registerFailure(key);
    registerFailure(keyIp);

    await logActivity({
      userId: user?.id ?? null,
      userEmail: email,
      action: "login_failed",
      entityType: "admin_user",
      entityId: user?.id ?? null,
      summary: `Intento de entrada fallido con ${email}`,
      // El motivo solo lo ve la dueña en Actividad; en pantalla el mensaje
      // sigue siendo el mismo para los dos casos.
      meta: { ip, motivo: user ? "contraseña incorrecta" : "correo desconocido" },
    });

    if (isLocked(key) || isLocked(keyIp, MAX_ATTEMPTS_IP)) {
      await logActivity({
        userId: user?.id ?? null,
        userEmail: email,
        action: "security",
        entityType: "admin_user",
        entityId: user?.id ?? null,
        summary: `Entrada bloqueada 10 minutos tras demasiados intentos fallidos (${email})`,
        meta: { ip },
      });
    }

    return { error: genericError };
  }

  // Contraseña correcta pero cuenta apagada. Aquí sí se puede ser explícito:
  // quien acierta la contraseña ya sabe que la cuenta existe, y dejarle con el
  // mensaje genérico solo conseguiría que probara veinte veces más.
  if (!user.isActive) {
    await logActivity({
      userId: user.id,
      userEmail: user.email,
      action: "login_failed",
      entityType: "admin_user",
      entityId: user.id,
      summary: `Intento de entrada con una cuenta desactivada (${user.email})`,
      meta: { ip, motivo: "cuenta desactivada" },
    });
    return { error: "Esta cuenta está desactivada. Pídele a la dueña de la tienda que la vuelva a activar." };
  }

  attempts.delete(key);
  attempts.delete(keyIp);
  await createSession(user.id);
  await db.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  await logActivity({
    userId: user.id,
    userEmail: user.email,
    action: "login",
    entityType: "admin_user",
    entityId: user.id,
    summary: `${user.name || user.email} entró en el panel`,
    meta: { ip },
  });

  // redirect() lanza una excepción de control de Next: tiene que quedar fuera
  // de cualquier try/catch o el panel nunca llegaría a abrirse.
  redirect("/admin");
}
