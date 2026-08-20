"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdmin, type AdminIdentity } from "@/lib/auth";
import { db } from "@/lib/db";
import { AMBITOS_DESCUENTO, TIPOS_DESCUENTO, normalizarCodigo } from "@/lib/discounts";
import { parseToCents } from "@/lib/money";

/**
 * Mutaciones de descuentos y promociones.
 *
 * Todo lo que escribe en Discount pasa por aquí y por la misma puerta: sesión
 * válida, validación con zod y un resultado tipado de vuelta (nada de lanzar
 * excepciones a la cara de Madeline). Cada cambio queda anotado en ActivityLog:
 * un código de descuento es dinero que sale de la caja, y tiene que quedar
 * rastro de quién lo creó, quién lo apagó y cuándo.
 */

export type EstadoDescuento = {
  ok?: boolean;
  /** Mensaje de cabecera cuando algo impidió guardar. */
  error?: string;
  /** Mensaje de cabecera cuando sí se guardó. */
  mensaje?: string;
  /** Errores por campo, para pintarlos dentro de su Field. */
  errores?: Record<string, string>;
};

/* ─────────────────────────── validación ─────────────────────────── */

const Entrada = z
  .object({
    id: z.string().nullable(),
    code: z
      .string()
      .min(3, "El código necesita al menos 3 caracteres.")
      .max(40, "El código no puede pasar de 40 caracteres.")
      .regex(/^[A-Z0-9][A-Z0-9-]*$/, "Solo letras, números y guiones. Sin espacios ni acentos."),
    title: z.string().max(120, "El nombre interno no puede pasar de 120 caracteres."),
    type: z.enum(TIPOS_DESCUENTO),
    value: z.number().int().min(0),
    minSubtotalCents: z.number().int().min(0, "La compra mínima no puede ser negativa."),
    appliesTo: z.enum(AMBITOS_DESCUENTO),
    appliesToIds: z.array(z.string().min(1)),
    usageLimit: z.number().int().min(0, "El límite de usos no puede ser negativo."),
    oncePerCustomer: z.boolean(),
    startsAt: z.date().nullable(),
    endsAt: z.date().nullable(),
    isActive: z.boolean(),
  })
  .superRefine((v, ctx) => {
    // El valor significa cosas distintas según el tipo, así que se valida aquí y
    // no en el campo: un 0 % es un código que no descuenta nada, y eso es un
    // error silencioso que solo se descubre cuando la clienta reclama.
    if (v.type === "percentage" && (v.value < 1 || v.value > 100)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "El porcentaje va entre 1 y 100." });
    }
    if (v.type === "fixed" && v.value < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Escribe cuánto dinero se descuenta, por ejemplo 10.00",
      });
    }
    if (v.appliesTo !== "all" && v.appliesToIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appliesToIds"],
        message:
          v.appliesTo === "collection"
            ? "Elige al menos una colección, o el código no descontará nada."
            : "Elige al menos un producto, o el código no descontará nada.",
      });
    }
    if (v.startsAt && v.endsAt && v.endsAt.getTime() < v.startsAt.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endsAt"],
        message: "La fecha de fin es anterior a la de inicio: el código nunca llegaría a valer.",
      });
    }
  });

/** "2026-08-19" → Date local. El fin coge el día entero, hasta las 23:59:59. */
function fechaDesdeInput(valor: string, fin = false): Date | null {
  const limpio = valor.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(limpio)) return null;
  // Sin la hora, el navegador interpreta "2026-08-19" como UTC y en Ohio el
  // código empezaría (o caducaría) a las 8 de la tarde del día anterior.
  const fecha = new Date(`${limpio}T${fin ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

function booleano(fd: FormData, nombre: string): boolean {
  const valor = fd.get(nombre);
  return valor === "on" || valor === "true" || valor === "1";
}

function entero(valor: FormDataEntryValue | null): number {
  const n = Number.parseInt(String(valor ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/* ─────────────────────── guardar un descuento ─────────────────────── */

export async function guardarDescuento(_prev: EstadoDescuento, fd: FormData): Promise<EstadoDescuento> {
  const admin = await getAdmin();
  if (!admin) return { error: "Tu sesión caducó. Vuelve a entrar y repite el guardado." };

  const id = String(fd.get("id") ?? "").trim() || null;
  const type = String(fd.get("type") ?? "percentage");

  // El campo "valor" significa porcentaje o dólares según el tipo. Los dólares
  // pasan por parseToCents (nunca a mano: 19.99 * 100 no da 1999 en binario).
  let value = 0;
  if (type === "percentage") value = entero(fd.get("value"));
  else if (type === "fixed") value = parseToCents(String(fd.get("value") ?? "")) ?? 0;

  let appliesToIds: string[] = [];
  try {
    const bruto: unknown = JSON.parse(String(fd.get("appliesToIdsJson") ?? "[]"));
    if (Array.isArray(bruto)) appliesToIds = bruto.filter((x): x is string => typeof x === "string" && !!x);
  } catch {
    return { error: "El formulario llegó incompleto. Recarga la página y vuelve a intentarlo." };
  }

  const analisis = Entrada.safeParse({
    id,
    code: normalizarCodigo(String(fd.get("code") ?? "")),
    title: String(fd.get("title") ?? "").trim(),
    type,
    value,
    minSubtotalCents: parseToCents(String(fd.get("minSubtotal") ?? "")) ?? 0,
    appliesTo: String(fd.get("appliesTo") ?? "all"),
    appliesToIds,
    usageLimit: Math.max(0, entero(fd.get("usageLimit"))),
    oncePerCustomer: booleano(fd, "oncePerCustomer"),
    startsAt: fechaDesdeInput(String(fd.get("startsAt") ?? "")),
    endsAt: fechaDesdeInput(String(fd.get("endsAt") ?? ""), true),
    isActive: booleano(fd, "isActive"),
  });

  if (!analisis.success) {
    const errores: Record<string, string> = {};
    for (const issue of analisis.error.issues) {
      const campo = String(issue.path[0] ?? "general");
      if (!errores[campo]) errores[campo] = issue.message;
    }
    return { error: "Revisa lo que está marcado en rojo.", errores };
  }

  const datos = analisis.data;
  // Un código de "todo" que arrastrara ids viejos sería una bomba de relojería
  // el día que alguien cambie el ámbito y no revise la lista.
  const ids = datos.appliesTo === "all" ? [] : datos.appliesToIds;

  const campos = {
    code: datos.code,
    title: datos.title,
    type: datos.type,
    value: datos.value,
    minSubtotalCents: datos.minSubtotalCents,
    appliesTo: datos.appliesTo,
    appliesToIdsJson: JSON.stringify(ids),
    oncePerCustomer: datos.oncePerCustomer,
    usageLimit: datos.usageLimit,
    startsAt: datos.startsAt,
    endsAt: datos.endsAt,
    isActive: datos.isActive,
  };

  let creado = false;
  let descuentoId = id ?? "";

  try {
    if (id) {
      const anterior = await db.discount.findUnique({ where: { id }, select: { id: true } });
      if (!anterior) {
        return { error: "Ese código ya no existe: alguien lo borró mientras lo editabas." };
      }
      await db.discount.update({ where: { id }, data: campos });
    } else {
      const nuevo = await db.discount.create({ data: campos });
      descuentoId = nuevo.id;
      creado = true;
    }
  } catch (error) {
    // P2002 = choque de índice único, y aquí el único índice único es el código.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
      return {
        error: "Ya existe otro código con ese nombre.",
        errores: { code: `"${datos.code}" ya está en uso. Prueba otro o genera uno nuevo.` },
      };
    }
    return { error: `No se pudo guardar: ${error instanceof Error ? error.message : "error desconocido"}.` };
  }

  await registrar(admin, creado ? "create" : "update", descuentoId, `${creado ? "Creó" : "Editó"} el código ${datos.code}`);

  revalidatePath("/admin/descuentos");
  revalidatePath(`/admin/descuentos/${descuentoId}`);

  // redirect() lanza una excepción de control de Next: fuera de cualquier
  // try/catch, o la pantalla de edición no llegaría a abrirse nunca.
  if (creado) redirect(`/admin/descuentos/${descuentoId}?guardado=1`);

  return { ok: true, mensaje: "Cambios guardados." };
}

/* ──────────────────────── activar / apagar / borrar ──────────────────────── */

/**
 * Acciones sueltas del listado y de la ficha.
 *
 * Nada destructivo ocurre a un solo clic: apagar un código que ya se usó y
 * borrar cualquier código pasan antes por una pantalla de confirmación que dice
 * exactamente qué se pierde.
 */
export async function accionDescuento(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const accion = String(fd.get("accion") ?? "");
  const id = String(fd.get("id") ?? "").trim();
  const volver = String(fd.get("volver") ?? "/admin/descuentos") || "/admin/descuentos";

  if (!id) redirect(conParametros(volver, { hecho: "nada" }));

  const descuento = await db.discount.findUnique({
    where: { id },
    select: { id: true, code: true, isActive: true, usageCount: true },
  });
  if (!descuento) redirect(conParametros(volver, { hecho: "no-existe" }));

  switch (accion) {
    case "activar":
      await db.discount.update({ where: { id }, data: { isActive: true } });
      await registrar(admin, "update", id, `Activó el código ${descuento.code}`);
      break;

    case "desactivar":
      // Un código ya usado que se apaga afecta a lo que las clientas creen tener:
      // si alguien lo tiene guardado en una story, dejará de funcionar. Se avisa.
      if (descuento.usageCount > 0) {
        redirect(conParametros(volver, { desactivar: id }));
      }
      await db.discount.update({ where: { id }, data: { isActive: false } });
      await registrar(admin, "update", id, `Desactivó el código ${descuento.code}`);
      break;

    case "desactivar-confirmado":
      await db.discount.update({ where: { id }, data: { isActive: false } });
      await registrar(admin, "update", id, `Desactivó el código ${descuento.code} (usado ${descuento.usageCount} veces)`);
      break;

    case "borrar":
      redirect(conParametros(volver, { borrar: id }));
      break;

    case "borrar-confirmado":
      // El historial de usos se va con él (cascada en el esquema). Los pedidos NO:
      // cada pedido guarda su propio `discountCode` y su `discountCents`.
      await db.discount.delete({ where: { id } });
      await registrar(admin, "delete", id, `Borró el código ${descuento.code} (usado ${descuento.usageCount} veces)`);
      revalidatePath("/admin/descuentos");
      redirect(conParametros("/admin/descuentos", { hecho: "borrado", code: descuento.code }));
      break;

    default:
      redirect(conParametros(volver, { hecho: "nada" }));
  }

  revalidatePath("/admin/descuentos");
  revalidatePath(`/admin/descuentos/${id}`);
  redirect(conParametros(volver, { hecho: accion.startsWith("desactivar") ? "desactivado" : "activado" }));
}

/* ─────────────────────────── utilidades ─────────────────────────── */

/** Deja rastro en ActivityLog. Nunca tumba el guardado si falla. */
async function registrar(
  admin: AdminIdentity,
  action: string,
  entityId: string,
  summary: string,
): Promise<void> {
  await db.activityLog
    .create({
      data: {
        userId: admin.id,
        userEmail: admin.email,
        action,
        entityType: "discount",
        entityId,
        summary,
      },
    })
    .catch(() => {
      // El registro es para auditoría, no parte de la operación: si la tabla
      // está bloqueada no tiene sentido perder el cambio que sí se guardó.
    });
}

/**
 * Añade parámetros a una URL conservando los filtros que ya trae y limpiando
 * los del mensaje anterior.
 */
function conParametros(url: string, extra: Record<string, string>): string {
  const [ruta, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  for (const clave of ["hecho", "code", "borrar", "desactivar", "guardado"]) params.delete(clave);
  for (const [clave, valor] of Object.entries(extra)) {
    if (valor) params.set(clave, valor);
  }
  const cadena = params.toString();
  return cadena ? `${ruta}?${cadena}` : ruta;
}
