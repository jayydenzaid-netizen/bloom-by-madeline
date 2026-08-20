import { db } from "@/lib/db";

/**
 * Bitácora del panel: quién hizo qué, cuándo y sobre qué.
 *
 * Existe por una pregunta muy concreta que aparece en cuanto hay más de una
 * persona con acceso: «¿quién cambió este precio?». Sin rastro, la respuesta es
 * una discusión; con rastro, es una fila.
 *
 * Regla número uno de este fichero: **registrar nunca puede tumbar la acción
 * que se estaba haciendo**. Si la escritura falla (base de datos ocupada, tabla
 * que aún no existe, JSON imposible de serializar), se traga el error y se
 * sigue. Perder una línea de bitácora es molesto; perder el pedido que Madeline
 * acababa de marcar como enviado, no.
 */

/* ─────────────────────────────── tipos ─────────────────────────────── */

/** Acciones con etiqueta propia. Se admiten otras: la lista no es una cárcel. */
export const ACCIONES_CONOCIDAS = [
  "create",
  "update",
  "delete",
  "login",
  "login_failed",
  "logout",
  "publish",
  "import",
  "refund",
  "restore",
  "security",
] as const;

export type AccionConocida = (typeof ACCIONES_CONOCIDAS)[number];
/** El `(string & {})` mantiene el autocompletado de las conocidas sin cerrar la puerta a otras. */
export type AccionActividad = AccionConocida | (string & {});

export type EntradaActividad = {
  /** Id del AdminUser que la provocó. `null` = la hizo el sistema. */
  userId?: string | null;
  /** Se guarda además del id porque el correo sigue siendo legible aunque la cuenta se borre. */
  userEmail?: string | null;
  action: AccionActividad;
  /** product | order | discount | admin_user | setting | ... */
  entityType: string;
  entityId?: string | null;
  summary?: string;
  meta?: Record<string, unknown>;
};

/** Lo mínimo que hace falta saber de quien actúa. Encaja con lo que devuelve `getAdmin()`. */
export type ActorActividad = { id: string; email: string } | null | undefined;

/* ───────────────────────────── escritura ───────────────────────────── */

const MAX_RESUMEN = 400;
const MAX_META = 4000;

/** Normaliza espacios y recorta, para que la tabla no se llene de párrafos. */
function recortar(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  return limpio.length <= max ? limpio : `${limpio.slice(0, max - 1)}…`;
}

/**
 * Serializa `meta` de forma defensiva: un objeto circular o un BigInt harían
 * reventar JSON.stringify, y eso no puede llevarse por delante la acción.
 */
function serializarMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "{}";
  try {
    const json = JSON.stringify(meta, (_clave, valor) => (typeof valor === "bigint" ? valor.toString() : valor));
    if (!json) return "{}";
    return json.length > MAX_META ? JSON.stringify({ truncado: true, bytes: json.length }) : json;
  } catch {
    return JSON.stringify({ error: "meta no serializable" });
  }
}

/**
 * Escribe una línea en la bitácora. **Nunca lanza.**
 *
 * ```ts
 * await logActivity({
 *   userId: admin.id,
 *   userEmail: admin.email,
 *   action: "update",
 *   entityType: "product",
 *   entityId: producto.id,
 *   summary: `Precio de «${producto.title}»: $29.99 → $34.99`,
 *   meta: { antes: 2999, despues: 3499 },
 * });
 * ```
 */
export async function logActivity(entrada: EntradaActividad): Promise<void> {
  try {
    await db.activityLog.create({
      data: {
        userId: entrada.userId ?? null,
        userEmail: (entrada.userEmail ?? "").toLowerCase().slice(0, 160),
        action: String(entrada.action).slice(0, 40),
        entityType: String(entrada.entityType).slice(0, 40),
        entityId: entrada.entityId ?? null,
        summary: recortar(entrada.summary ?? "", MAX_RESUMEN),
        metaJson: serializarMeta(entrada.meta),
      },
    });
  } catch {
    // Silencio deliberado, ver la cabecera del fichero.
  }
}

/**
 * Atajo para el caso normal del panel: ya tienes el admin de la sesión y no
 * quieres repetir `userId` / `userEmail` en cada llamada.
 *
 * ```ts
 * const admin = await getAdmin();
 * await registrarActividad({ admin, action: "delete", entityType: "discount", entityId: id, summary: "Borró BLOOM20" });
 * ```
 */
export async function registrarActividad(
  entrada: Omit<EntradaActividad, "userId" | "userEmail"> & { admin?: ActorActividad },
): Promise<void> {
  const { admin, ...resto } = entrada;
  await logActivity({ ...resto, userId: admin?.id ?? null, userEmail: admin?.email ?? "" });
}

/* ───────────────────────────── lectura ───────────────────────────── */

export type TonoActividad = "neutral" | "success" | "warning" | "danger" | "info";

const ETIQUETA_ACCION: Record<string, string> = {
  create: "Creó",
  update: "Cambió",
  delete: "Borró",
  login: "Entró",
  login_failed: "Intento fallido",
  logout: "Salió",
  publish: "Publicó",
  import: "Importó",
  refund: "Reembolsó",
  restore: "Restauró",
  security: "Seguridad",
};

const TONO_ACCION: Record<string, TonoActividad> = {
  create: "success",
  update: "info",
  delete: "danger",
  login: "neutral",
  login_failed: "warning",
  logout: "neutral",
  publish: "success",
  import: "info",
  refund: "warning",
  restore: "info",
  security: "danger",
};

export function etiquetaAccion(action: string): string {
  return ETIQUETA_ACCION[action] ?? action;
}

export function tonoAccion(action: string): TonoActividad {
  return TONO_ACCION[action] ?? "neutral";
}

/**
 * Catálogo de entidades: cómo se llama cada una en cristiano y dónde vive su
 * ficha. `ruta: null` = esa entidad no tiene pantalla propia; en ese caso la
 * bitácora enseña el texto sin enlace, que es mejor que un enlace a un 404.
 */
const ENTIDADES: Record<string, { etiqueta: string; ruta: ((id: string) => string) | null }> = {
  product: { etiqueta: "Producto", ruta: (id) => `/admin/productos/${id}` },
  order: { etiqueta: "Pedido", ruta: (id) => `/admin/pedidos/${id}` },
  discount: { etiqueta: "Descuento", ruta: (id) => `/admin/descuentos/${id}` },
  page: { etiqueta: "Página", ruta: (id) => `/admin/paginas/${id}` },
  customer: { etiqueta: "Clienta", ruta: (id) => `/admin/clientes/${id}` },
  collection: { etiqueta: "Colección", ruta: () => "/admin/colecciones" },
  inventory: { etiqueta: "Inventario", ruta: () => "/admin/inventario" },
  variant: { etiqueta: "Variante", ruta: () => "/admin/inventario" },
  review: { etiqueta: "Reseña", ruta: () => "/admin/resenas" },
  cart: { etiqueta: "Carrito", ruta: () => "/admin/carritos" },
  media: { etiqueta: "Imagen", ruta: () => "/admin/medios" },
  menu: { etiqueta: "Menú", ruta: () => "/admin/menus" },
  home_block: { etiqueta: "Portada", ruta: () => "/admin/contenido" },
  content: { etiqueta: "Contenido", ruta: () => "/admin/contenido" },
  setting: { etiqueta: "Ajustes", ruta: () => "/admin/ajustes" },
  report: { etiqueta: "Informe", ruta: () => "/admin/informes" },
  admin_user: { etiqueta: "Cuenta del equipo", ruta: () => "/admin/equipo" },
  session: { etiqueta: "Sesión", ruta: null },
  import_job: { etiqueta: "Importación", ruta: null },
};

export function etiquetaEntidad(entityType: string): string {
  return ENTIDADES[entityType]?.etiqueta ?? entityType;
}

/** Enlace a la ficha afectada, o null si esa entidad no tiene pantalla propia. */
export function enlaceEntidad(entityType: string, entityId: string | null | undefined): string | null {
  const entidad = ENTIDADES[entityType];
  if (!entidad || !entidad.ruta) return null;
  if (!entityId) return null;
  return entidad.ruta(entityId);
}

/** Lee `metaJson` sin riesgo: si está corrupto devuelve un objeto vacío. */
export function leerMeta(metaJson: string | null | undefined): Record<string, unknown> {
  if (!metaJson) return {};
  try {
    const valor: unknown = JSON.parse(metaJson);
    return valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
