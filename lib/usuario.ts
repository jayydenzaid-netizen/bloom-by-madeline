/**
 * Nombre de usuario del panel.
 *
 * El panel se entra con usuario y contraseña, no con correo. El motivo es
 * práctico, no técnico: Madeline escribe «Madeline21» sin equivocarse, y un
 * correo largo en el teclado del móvil es una fuente constante de fallos.
 *
 * Aquí solo vive la lógica pura (normalizar, validar, sugerir) para que se
 * pueda probar sin base de datos y para que la use tanto el servidor como
 * cualquier script. Las consultas están en lib/auth.ts.
 *
 * Dos ideas que conviene no perder de vista:
 *
 *  - Se guarda tal y como se escribió («Madeline21»), pero se compara sin
 *    distinguir mayúsculas. Un teclado de móvil pone la primera en mayúscula
 *    cuando le apetece; dejar fuera a la dueña por eso sería absurdo.
 *  - Nada de espacios ni de acentos. Un usuario con un espacio invisible al
 *    final es un caso de soporte que nadie sabe diagnosticar por teléfono.
 */

export const USUARIO_MIN = 3;
export const USUARIO_MAX = 32;

/** Letras sin acento, números y los tres separadores de siempre. */
const FORMATO = /^[a-zA-Z0-9._-]+$/;

export const AYUDA_USUARIO =
  `Entre ${USUARIO_MIN} y ${USUARIO_MAX} caracteres: letras, números, punto, guion o guion bajo. Sin espacios.`;

/** Quita los espacios de los bordes y se traga cualquier cosa que no sea texto. */
export function normalizarUsuario(bruto: unknown): string {
  return String(bruto ?? "").trim();
}

/**
 * Forma con la que se compara y se busca: minúsculas.
 * Dos cuentas no pueden llamarse «Madeline21» y «madeline21».
 */
export function claveUsuario(bruto: unknown): string {
  return normalizarUsuario(bruto).toLowerCase();
}

export type ValidacionUsuario = { ok: true; usuario: string } | { ok: false; error: string };

/** Valida en el mismo orden en que una persona se equivoca. */
export function validarUsuario(bruto: unknown): ValidacionUsuario {
  const usuario = normalizarUsuario(bruto);

  if (!usuario) return { ok: false, error: "Escribe un nombre de usuario." };
  if (/\s/.test(usuario)) return { ok: false, error: "El usuario no puede llevar espacios." };
  if (usuario.length < USUARIO_MIN) {
    return { ok: false, error: `El usuario necesita al menos ${USUARIO_MIN} caracteres.` };
  }
  if (usuario.length > USUARIO_MAX) {
    return { ok: false, error: `El usuario no puede pasar de ${USUARIO_MAX} caracteres.` };
  }
  if (!FORMATO.test(usuario)) {
    return { ok: false, error: "Solo letras sin acento, números, punto, guion o guion bajo." };
  }

  return { ok: true, usuario };
}

/**
 * Usuario de partida para una cuenta que aún no tiene ninguno (las que existían
 * antes de que el panel dejara de entrar por correo). Se saca del correo, que es
 * lo que esa persona ya usaba para entrar, así que le resultará familiar.
 *
 * Si del correo no sale nada aprovechable, se devuelve una base genérica: quien
 * llama se encarga de resolver los choques añadiendo un número.
 */
export function usuarioDesdeCorreo(email: string): string {
  const local = String(email ?? "").split("@")[0] ?? "";

  const limpio = local
    .normalize("NFD") // separa la tilde de su letra; el filtro de abajo se lleva la tilde y deja la letra
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, USUARIO_MAX);

  return limpio.length >= USUARIO_MIN ? limpio : "cuenta";
}

/**
 * Devuelve un usuario libre a partir de uno deseado, añadiendo un número si hace
 * falta. `ocupados` son las claves ya tomadas (en minúsculas, ver claveUsuario).
 */
export function usuarioLibre(deseado: string, ocupados: Iterable<string>): string {
  const tomados = new Set([...ocupados].map((u) => claveUsuario(u)));
  const base = normalizarUsuario(deseado) || "cuenta";

  if (!tomados.has(claveUsuario(base))) return base;

  for (let n = 2; n < 1000; n += 1) {
    const sufijo = String(n);
    const raiz = base.slice(0, USUARIO_MAX - sufijo.length);
    const intento = `${raiz}${sufijo}`;
    if (!tomados.has(claveUsuario(intento))) return intento;
  }

  // Mil choques con el mismo nombre no va a pasar, pero devolver algo roto sí
  // sería un problema: se corta la coleta con marca de tiempo.
  return `${base.slice(0, USUARIO_MAX - 6)}${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
}
