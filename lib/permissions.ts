import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Quién puede hacer qué dentro del panel.
 *
 * Solo hay dos roles, y son dos a propósito: la boutique la lleva Madeline y,
 * como mucho, una persona que le ayuda los jueves. Un sistema de permisos con
 * quince casillas sería más "completo" y absolutamente inútil aquí — nadie lo
 * configuraría bien y acabaría dándole todo a todo el mundo.
 *
 *  - **owner** (Madeline): manda en todo.
 *  - **staff** (quien ayuda): ve y gestiona pedidos, productos e inventario.
 *    No toca ajustes, ni el equipo, ni los descuentos, ni los informes de
 *    beneficio, ni borra nada de forma definitiva. El motivo no es desconfianza:
 *    es que esas cuatro cosas son las que no se pueden deshacer o revelan el
 *    margen real del negocio.
 *
 * Las funciones puras de este fichero (can, ownersActivosTras, permiteCambio)
 * no tocan la base de datos, así que se pueden probar con node:test sin montar
 * nada. Ver tests/permissions.test.ts.
 */

/* ─────────────────────────────── roles ─────────────────────────────── */

export const ROLES = ["owner", "staff"] as const;
export type Rol = (typeof ROLES)[number];

export const ETIQUETA_ROL: Record<Rol, string> = {
  owner: "Dueña",
  staff: "Ayudante",
};

export const DESCRIPCION_ROL: Record<Rol, string> = {
  owner: "Puede hacer todo: ajustes, equipo, descuentos, informes y borrar.",
  staff: "Pedidos, productos e inventario. Nada de ajustes, equipo, descuentos ni informes.",
};

export function esRol(valor: unknown): valor is Rol {
  return typeof valor === "string" && (ROLES as readonly string[]).includes(valor);
}

/**
 * Cualquier valor raro guardado en la columna `role` se trata como `staff`.
 * Es la opción prudente: ante la duda, menos permisos, nunca más.
 */
export function normalizarRol(valor: unknown): Rol {
  return esRol(valor) ? valor : "staff";
}

/* ───────────────────────────── acciones ───────────────────────────── */

export const ACCIONES = [
  // Trabajo del día a día — también para quien ayuda.
  "pedidos.ver",
  "pedidos.gestionar",
  "productos.ver",
  "productos.gestionar",
  "inventario.ver",
  "inventario.ajustar",
  "clientes.ver",
  "importar.usar",
  "carritos.gestionar",
  "resenas.moderar",
  "cuenta.propia",
  // Reservado a la dueña.
  "descuentos.gestionar",
  "informes.ver",
  "ajustes.gestionar",
  "contenido.gestionar",
  "equipo.gestionar",
  "actividad.ver",
  "borrar.definitivo",
] as const;

export type Accion = (typeof ACCIONES)[number];

/** Lo que puede hacer un ayudante. Todo lo que no esté aquí es solo de la dueña. */
const PERMISOS_STAFF: ReadonlySet<Accion> = new Set<Accion>([
  "pedidos.ver",
  "pedidos.gestionar",
  "productos.ver",
  "productos.gestionar",
  "inventario.ver",
  "inventario.ajustar",
  "clientes.ver",
  "importar.usar",
  "carritos.gestionar",
  "resenas.moderar",
  "cuenta.propia",
]);

/** Cualquier cosa con rol sirve: el AdminUser entero, o `{ role, isActive }` a mano. */
export type UsuarioPermisos = { role?: string | null; isActive?: boolean | null } | null | undefined;

/**
 * ¿Puede este usuario hacer esta acción?
 *
 * Sin usuario, o con la cuenta desactivada, la respuesta es siempre no: una
 * cuenta apagada tiene que dejar de valer al instante, no cuando caduque su
 * sesión.
 */
export function can(user: UsuarioPermisos, accion: Accion): boolean {
  if (!user) return false;
  if (user.isActive === false) return false;

  const rol = normalizarRol(user.role);
  if (rol === "owner") return true;
  return PERMISOS_STAFF.has(accion);
}

/** Todas las acciones permitidas a un rol. Útil para pintar la ayuda en pantalla. */
export function accionesDe(rol: Rol): Accion[] {
  return ACCIONES.filter((accion) => can({ role: rol, isActive: true }, accion));
}

/* ──────────────────── la tienda nunca sin dueña ──────────────────── */

export type CuentaBasica = { id: string; role: string; isActive: boolean };

/** Un cambio propuesto sobre una cuenta: cambiar rol, apagarla o encenderla. */
export type CambioCuenta = { id: string; role?: string; isActive?: boolean };

/** Cuántas cuentas owner activas quedarían si se aplicara `cambio`. */
export function ownersActivosTras(cuentas: CuentaBasica[], cambio?: CambioCuenta): number {
  return cuentas.filter((cuenta) => {
    const aplica = cambio && cambio.id === cuenta.id;
    const rol = normalizarRol(aplica && cambio.role !== undefined ? cambio.role : cuenta.role);
    const activa = aplica && cambio.isActive !== undefined ? cambio.isActive : cuenta.isActive;
    return rol === "owner" && activa;
  }).length;
}

export type Veredicto = { ok: true } | { ok: false; error: string };

/**
 * Portero del último owner.
 *
 * Si se deja degradar o desactivar a la última dueña activa, la tienda queda
 * sin nadie que pueda tocar ajustes, descuentos ni el propio equipo: no habría
 * forma de arreglarlo desde el panel, haría falta entrar en la base de datos a
 * mano. Por eso el cambio se rechaza aquí, con el motivo explicado.
 */
export function permiteCambioDeCuenta(cuentas: CuentaBasica[], cambio: CambioCuenta): Veredicto {
  const existe = cuentas.some((cuenta) => cuenta.id === cambio.id);
  if (!existe) return { ok: false, error: "Esa cuenta ya no existe." };

  if (ownersActivosTras(cuentas, cambio) > 0) return { ok: true };

  return {
    ok: false,
    error:
      "Esta es la última cuenta de dueña activa. Si la desactivas o la conviertes en ayudante, " +
      "nadie podría volver a entrar en Ajustes, Equipo ni Descuentos. Crea antes otra cuenta de dueña.",
  };
}

/* ──────────────────── sesión con rol ──────────────────── */

export type AdminConRol = {
  id: string;
  email: string;
  name: string;
  role: Rol;
  isActive: boolean;
};

/**
 * Como `getAdmin()`, pero trayendo además rol y estado.
 *
 * `getAdmin()` (lib/auth.ts) solo selecciona id, correo y nombre, y no se toca
 * porque lo usan todas las pantallas del panel. Aquí se completa con una
 * segunda consulta; es una lectura por índice primario, no duele.
 *
 * Devuelve null si la cuenta está desactivada: quien fue apagado deja de tener
 * sesión válida a efectos prácticos.
 */
export async function getAdminConRol(): Promise<AdminConRol | null> {
  const admin = await getAdmin();
  if (!admin) return null;

  const fila = await db.adminUser.findUnique({
    where: { id: admin.id },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });
  if (!fila || !fila.isActive) return null;

  return { id: fila.id, email: fila.email, name: fila.name, role: normalizarRol(fila.role), isActive: true };
}

/** Secciones que se pueden nombrar en el aviso de "esto no es para ti". */
export const ETIQUETA_SECCION: Record<string, string> = {
  equipo: "Equipo",
  actividad: "Actividad",
  ajustes: "Ajustes",
  descuentos: "Descuentos",
  informes: "Informes",
  contenido: "Contenido",
};

/** Sesión obligatoria. Sin ella, al login. */
export async function requireSesion(): Promise<AdminConRol> {
  const admin = await getAdminConRol();
  if (!admin) redirect("/admin/login");
  return admin;
}

/**
 * Pantalla reservada a la dueña.
 *
 * En vez de soltar un error feo (o un 403 en blanco, que a una persona no
 * técnica no le dice nada), manda a "Tu cuenta" con un aviso escrito en
 * castellano que explica qué sección era y por qué no se abre.
 */
export async function requireOwner(seccion?: string): Promise<AdminConRol> {
  const admin = await requireSesion();
  if (admin.role === "owner") return admin;

  const destino = seccion ? `/admin/cuenta?sinPermiso=${encodeURIComponent(seccion)}` : "/admin/cuenta?sinPermiso=1";
  redirect(destino);
}

/** Igual que requireOwner pero para una acción concreta del catálogo. */
export async function requirePermiso(accion: Accion, seccion?: string): Promise<AdminConRol> {
  const admin = await requireSesion();
  if (can(admin, accion)) return admin;

  const destino = seccion ? `/admin/cuenta?sinPermiso=${encodeURIComponent(seccion)}` : "/admin/cuenta?sinPermiso=1";
  redirect(destino);
}
