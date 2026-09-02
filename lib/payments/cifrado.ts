import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Cifrado de las credenciales de pago que Madeline pega en el panel.
 *
 * Las llaves de Stripe/PayPal/Square viven en la tabla Setting (así ella las
 * gestiona sin tocar código ni redesplegar), pero un volcado de la base de datos
 * no debe regalarlas: se guardan cifradas con AES-256-GCM y una clave derivada
 * de SESSION_SECRET, que ya existe en el servidor y en Vercel. GCM autentica
 * además el contenido: un valor manipulado no descifra "a basura", falla.
 *
 * Si SESSION_SECRET cambia, lo guardado deja de descifrar. No es un desastre:
 * `descifrar` devuelve null y el panel pide volver a pegar las llaves.
 */

const PREFIJO = "enc1:";

function clave(): Buffer {
  const secreto = process.env.SESSION_SECRET;
  // En producción SIN secreto de verdad no se cifra nada: "bloom-dev-secret"
  // está publicado en este repo (que es público) y cifrar con él sería teatro.
  // Mejor un error visible al guardar que unas llaves de cobro descifrables.
  if (!secreto && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET no está configurado: no se pueden cifrar credenciales de pago.");
  }
  // El prefijo separa esta clave de otros usos de SESSION_SECRET (cookies HMAC):
  // comprometer un uso no debe regalar el otro.
  return createHash("sha256")
    .update(`bloom-pagos:${secreto || "bloom-dev-secret"}`)
    .digest();
}

export function cifrar(textoPlano: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", clave(), iv);
  const datos = Buffer.concat([cipher.update(textoPlano, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIJO + [iv, tag, datos].map((b) => b.toString("base64")).join(":");
}

/** null = no descifra (clave distinta, valor corrupto o formato desconocido). */
export function descifrar(guardado: string): string | null {
  if (!guardado.startsWith(PREFIJO)) return null;
  try {
    const [ivB64, tagB64, datosB64] = guardado.slice(PREFIJO.length).split(":");
    if (!ivB64 || !tagB64 || !datosB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", clave(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(datosB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
