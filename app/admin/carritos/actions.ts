"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { registrarActividad } from "@/lib/reviews";

/**
 * Acciones sobre carritos abandonados.
 *
 * Dos convenios que hay que conocer antes de tocar esto, porque el esquema no
 * tiene campos propios para ellos y no se puede migrar desde aquí:
 *
 * 1. **Recuperado sin pedido.** `Cart.recoveredOrderId` guarda el id real del
 *    pedido cuando Madeline indica cuál fue. Si lo recuperó por DM y aún no hay
 *    pedido en el sistema, se guarda el centinela `manual`. La pantalla
 *    distingue los dos casos: con id real enlaza a la ficha del pedido.
 *
 * 2. **Descartado.** No hay columna de estado, así que se marca con una línea
 *    `[descartado ...]` al principio de `Cart.note`. Es reversible desde la
 *    misma pantalla y no pisa lo que escribiera la clienta, que queda debajo.
 *
 * 3. **`updatedAt` se conserva a mano en cada `update`.** El campo es `@updatedAt`
 *    y Prisma lo pisaría con la hora actual, pero aquí significa "última vez que
 *    la clienta tocó su carrito": si anotar «ya le escribí» lo moviera, el
 *    carrito dejaría de contar como abandonado y desaparecería de la lista justo
 *    cuando Madeline lo está trabajando. Pasarle el valor anterior gana sobre el
 *    automático (comprobado).
 *
 * Lo que NO hace este módulo: mandar correos. No hay servicio de correo
 * configurado; prometerlo sería mentir. La acción real de hoy es que Madeline
 * escriba por DM, que es su canal. Ver el informe del módulo y la plantilla
 * `EmailTemplate` con clave `abandoned_cart`.
 */

export type Resultado = { ok: true; mensaje: string } | { ok: false; error: string };

export type EstadoFormulario =
  | { estado: "idle" }
  | { estado: "ok"; mensaje: string }
  | { estado: "error"; error: string };

const SIN_SESION = "Tu sesión ha caducado. Vuelve a entrar en el panel.";

const idSchema = z.string().trim().min(1, "Falta el carrito.").max(64);

const recuperadoSchema = z.object({
  id: idSchema,
  pedido: z.string().trim().max(40).optional().default(""),
});

/**
 * Ojo con el orden de las comprobaciones: `primerError` enseña el PRIMER problema,
 * así que la confirmación va antes que nada. Si no, alguien que se deja la casilla
 * sin marcar leería un error sobre los días y no entendería qué le falta.
 *
 * `dias` se valida solo en modo `antiguos` a propósito: en modo `vacios` el
 * desplegable de días está deshabilitado en la pantalla y **un control
 * deshabilitado no se envía en el FormData** — llegaría vacío. Exigirle un
 * mínimo de 7 dejaba el borrado de carritos vacíos permanentemente roto,
 * contestando "Por seguridad, mínimo 7 días" a un campo que ni se ve.
 */
const limpiezaSchema = z
  .object({
    modo: z.enum(["vacios", "antiguos"]),
    dias: z.number().int().max(3650),
    confirmar: z.boolean(),
  })
  .superRefine((valor, ctx) => {
    if (!valor.confirmar) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmar"],
        message: "Marca la casilla de confirmación para borrar.",
      });
    }
    if (valor.modo === "antiguos" && valor.dias < 7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dias"],
        message: "Por seguridad, mínimo 7 días.",
      });
    }
  });

function primerError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Revisa los datos del formulario.";
}

function refrescar(): void {
  revalidatePath("/admin/carritos");
  revalidatePath("/admin");
}

const selloFecha = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

/* ───────────────────────── recuperado / descartado ───────────────────────── */

/**
 * Marca un carrito como recuperado. Si Madeline escribe el número del pedido
 * que salió de ahí, se enlazan: así el "total recuperable" deja de contarlo y
 * queda constancia de que ese dinero sí entró.
 */
export async function marcarRecuperado(entrada: { id: string; pedido?: string }): Promise<Resultado> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: SIN_SESION };

  const datos = recuperadoSchema.safeParse(entrada);
  if (!datos.success) return { ok: false, error: primerError(datos.error) };

  const carrito = await db.cart.findUnique({
    where: { id: datos.data.id },
    select: { id: true, name: true, email: true, updatedAt: true },
  });
  if (!carrito) return { ok: false, error: "Ese carrito ya no existe." };

  let referencia = "manual";
  let detalle = "";

  const numero = datos.data.pedido.trim().toUpperCase();
  if (numero) {
    // Se acepta "BLM-1001" y también "1001": Madeline lee el número en el DM y
    // no tiene por qué escribir el prefijo.
    const candidatos = numero.startsWith("BLM-") ? [numero] : [`BLM-${numero}`, numero];
    const pedido = await db.order.findFirst({
      where: { number: { in: candidatos } },
      select: { id: true, number: true },
    });
    if (!pedido) {
      return { ok: false, error: `No encuentro ningún pedido con el número ${numero}. Déjalo vacío si aún no hay pedido.` };
    }
    referencia = pedido.id;
    detalle = ` Pedido ${pedido.number}.`;
  }

  await db.cart.update({
    where: { id: carrito.id },
    data: { recoveredOrderId: referencia, updatedAt: carrito.updatedAt },
  });

  await registrarActividad({
    admin,
    action: "update",
    entityType: "cart",
    entityId: carrito.id,
    summary: `Carrito de ${carrito.name || carrito.email || "una visitante"} marcado como recuperado.${detalle}`,
    meta: { recoveredOrderId: referencia },
  });

  refrescar();
  return { ok: true, mensaje: `Carrito marcado como recuperado.${detalle}` };
}

/** Deja el carrito fuera de la lista sin borrarlo. Reversible. */
export async function marcarDescartado(id: string): Promise<Resultado> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: SIN_SESION };

  const datos = idSchema.safeParse(id);
  if (!datos.success) return { ok: false, error: primerError(datos.error) };

  const carrito = await db.cart.findUnique({
    where: { id: datos.data },
    select: { id: true, note: true, name: true, email: true, updatedAt: true },
  });
  if (!carrito) return { ok: false, error: "Ese carrito ya no existe." };
  if (carrito.note.startsWith("[descartado")) return { ok: true, mensaje: "Ese carrito ya estaba descartado." };

  await db.cart.update({
    where: { id: carrito.id },
    data: {
      note: `[descartado ${selloFecha.format(new Date())}]\n${carrito.note}`.trimEnd(),
      updatedAt: carrito.updatedAt,
    },
  });

  await registrarActividad({
    admin,
    action: "update",
    entityType: "cart",
    entityId: carrito.id,
    summary: `Carrito de ${carrito.name || carrito.email || "una visitante"} descartado.`,
  });

  refrescar();
  return { ok: true, mensaje: "Carrito descartado. Puedes recuperarlo desde el filtro «Descartados»." };
}

/** Quita la marca de descartado y devuelve el carrito a la lista. */
export async function restaurarCarrito(id: string): Promise<Resultado> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: SIN_SESION };

  const datos = idSchema.safeParse(id);
  if (!datos.success) return { ok: false, error: primerError(datos.error) };

  const carrito = await db.cart.findUnique({ where: { id: datos.data }, select: { id: true, note: true, updatedAt: true } });
  if (!carrito) return { ok: false, error: "Ese carrito ya no existe." };

  // Solo se cae la primera línea, la del marcador: lo que escribió la clienta
  // vive debajo y no se toca.
  const limpio = carrito.note.replace(/^\[descartado[^\]]*\]\n?/, "");
  await db.cart.update({
    where: { id: carrito.id },
    data: { note: limpio, recoveredOrderId: null, updatedAt: carrito.updatedAt },
  });

  await registrarActividad({
    admin,
    action: "update",
    entityType: "cart",
    entityId: carrito.id,
    summary: "Carrito devuelto a la lista de abandonados.",
  });

  refrescar();
  return { ok: true, mensaje: "Carrito devuelto a la lista." };
}

/** Deja constancia de que ya le escribió, para no escribirle dos veces. */
export async function marcarAvisada(id: string): Promise<Resultado> {
  const admin = await getAdmin();
  if (!admin) return { ok: false, error: SIN_SESION };

  const datos = idSchema.safeParse(id);
  if (!datos.success) return { ok: false, error: primerError(datos.error) };

  const carrito = await db.cart.findUnique({
    where: { id: datos.data },
    select: { id: true, name: true, email: true, updatedAt: true },
  });
  if (!carrito) return { ok: false, error: "Ese carrito ya no existe." };

  await db.cart.update({
    where: { id: carrito.id },
    data: { reminderSentAt: new Date(), updatedAt: carrito.updatedAt },
  });

  await registrarActividad({
    admin,
    action: "update",
    entityType: "cart",
    entityId: carrito.id,
    summary: `Recordatorio enviado a mano a ${carrito.name || carrito.email || "una visitante"}.`,
  });

  refrescar();
  return { ok: true, mensaje: "Anotado: ya le escribiste." };
}

/* ─────────────────────────────── limpieza ─────────────────────────────── */

/**
 * Borrado en bloque de carritos que ya no sirven de nada. Dos modos:
 *  - `vacios`: carritos sin una sola línea dentro (los crea cualquier visita).
 *  - `antiguos`: carritos sin tocar desde hace más de N días.
 *
 * Nunca borra un carrito tocado en las últimas 24 h aunque el filtro lo pillara:
 * podría ser el de alguien que está comprando ahora mismo.
 */
export async function limpiarCarritos(_prev: EstadoFormulario, formData: FormData): Promise<EstadoFormulario> {
  const admin = await getAdmin();
  if (!admin) return { estado: "error", error: SIN_SESION };

  const diasCrudos = Number.parseInt(String(formData.get("dias") ?? ""), 10);
  const modo = String(formData.get("modo") ?? "");
  const datos = limpiezaSchema.safeParse({
    modo,
    // En modo `vacios` el desplegable viene deshabilitado y no llega nada: se
    // rellena con 0 porque ese modo no mira la antigüedad (salvo el freno de
    // las 24 h, que va más abajo y no es negociable).
    dias: Number.isFinite(diasCrudos) ? diasCrudos : 0,
    confirmar: formData.get("confirmar") === "on",
  });

  if (!datos.success) return { estado: "error", error: primerError(datos.error) };

  const hace24h = new Date(Date.now() - 24 * 3_600_000);
  const corte = new Date(Date.now() - datos.data.dias * 24 * 3_600_000);

  const where =
    datos.data.modo === "vacios"
      ? { items: { none: {} }, updatedAt: { lt: hace24h } }
      : { updatedAt: { lt: corte < hace24h ? corte : hace24h } };

  const borrados = await db.cart.deleteMany({ where });

  await registrarActividad({
    admin,
    action: "delete",
    entityType: "cart",
    summary:
      datos.data.modo === "vacios"
        ? `Limpieza: ${borrados.count} carritos vacíos borrados.`
        : `Limpieza: ${borrados.count} carritos de más de ${datos.data.dias} días borrados.`,
    meta: { modo: datos.data.modo, dias: datos.data.dias, borrados: borrados.count },
  });

  refrescar();

  if (borrados.count === 0) {
    return { estado: "ok", mensaje: "No había ningún carrito que borrar con ese criterio." };
  }
  return {
    estado: "ok",
    mensaje: `${borrados.count} ${borrados.count === 1 ? "carrito borrado" : "carritos borrados"}.`,
  };
}
