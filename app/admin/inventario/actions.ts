"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  adjustStock,
  bulkAdjust,
  REASON_LABELS,
  setStock,
  STOCK_REASONS,
  type StockChange,
  type StockReason,
} from "@/lib/inventory";

/**
 * Mutaciones del inventario.
 *
 * Aquí NO se toca `ProductVariant.stock` directamente: todo va por
 * `lib/inventory.ts`, que es quien garantiza que el cambio y su `StockMovement`
 * ocurren en la misma transacción. Este fichero solo hace tres cosas: comprobar
 * la sesión, validar lo que llegó del formulario, y contarle a Madeline en
 * cristiano lo que pasó.
 *
 * Ninguna acción lanza: todas devuelven un estado tipado. Un `throw` en un
 * Server Action se le enseña a la usuaria como "Application error", que no dice
 * nada y da miedo.
 */

/**
 * Un fichero "use server" solo puede exportar funciones asíncronas: cualquier
 * constante exportada de aquí hace que Next reviente al invocar CUALQUIER
 * acción del módulo ("A 'use server' file can only export async functions").
 * Por eso el estado inicial se declara en cada componente cliente y aquí solo
 * viaja el tipo, que TypeScript borra al compilar.
 */
export type EstadoInventario = {
  ok?: boolean;
  mensaje?: string;
  error?: string;
};

/* ───────────────────────────── validación ───────────────────────────── */

const RAZONES = z.enum(STOCK_REASONS);

const EsquemaAjuste = z.object({
  variantId: z.string().min(1, "Falta la variante."),
  modo: z.enum(["fijar", "sumar", "restar"]),
  // Tope defensivo: un cero de más al teclear no debe convertir el armario en
  // un almacén de 900 000 vestidos sin que nadie se entere.
  valor: z.number().int().min(0).max(100000),
  razon: RAZONES.optional(),
  nota: z.string().max(300).optional(),
});

const EsquemaLote = z.object({
  ids: z.array(z.string().min(1)).min(1, "No había ninguna fila seleccionada."),
  modo: z.enum(["fijar", "sumar", "restar"]),
  valor: z.number().int().min(0).max(100000),
  razon: RAZONES,
  nota: z.string().max(300).optional(),
});

/* ─────────────────────── ajuste de una variante ─────────────────────── */

/**
 * Edición en línea del listado: escribir el número (fijar) o los botones +1/−1.
 *
 * La razón por defecto depende del gesto, porque es lo que de verdad ocurrió:
 * escribir un número absoluto es un recuento (`count`), y sumar o restar de uno
 * en uno es una corrección a mano (`manual`). Quien quiera otra razón la manda
 * explícita en el formulario.
 */
export async function guardarStock(
  _prev: EstadoInventario,
  fd: FormData,
): Promise<EstadoInventario> {
  const admin = await getAdmin();
  if (!admin) return { error: "Tu sesión caducó. Vuelve a entrar y repite el ajuste." };

  const parseado = EsquemaAjuste.safeParse({
    variantId: String(fd.get("variantId") ?? "").trim(),
    modo: String(fd.get("modo") ?? "fijar"),
    valor: entero(fd.get("valor")),
    razon: textoONada(fd.get("razon")),
    nota: String(fd.get("nota") ?? "").trim(),
  });

  if (!parseado.success) {
    return { error: parseado.error.issues[0]?.message ?? "Ese ajuste no es válido." };
  }

  const { variantId, modo, valor, nota } = parseado.data;

  const ficha = await db.productVariant.findUnique({
    where: { id: variantId },
    select: {
      title: true,
      trackStock: true,
      product: { select: { slug: true, title: true } },
    },
  });
  if (!ficha) return { error: "Esa variante ya no existe: alguien la borró mientras la editabas." };

  // Cambiar el stock de una variante "sin control" no significa nada: el
  // escaparate la vende igual porque el inventario lo tiene el proveedor.
  // Mejor decirlo que guardar un número que nadie va a mirar.
  if (!ficha.trackStock) {
    return {
      error:
        "Esa variante se vende sin control de stock, así que su número no se usa para nada. Actívale el control en la ficha del producto si quieres llevarle la cuenta.",
    };
  }

  const razon: StockReason = parseado.data.razon ?? (modo === "fijar" ? "count" : "manual");
  const opciones = { reason: razon, note: nota ?? "", userId: admin.id };

  const resultado =
    modo === "fijar"
      ? await setStock(variantId, valor, opciones)
      : await adjustStock(variantId, modo === "restar" ? -valor : valor, opciones);

  if (!resultado.ok) return { error: resultado.error };

  const nombre = `${ficha.product.title} · ${ficha.title}`;
  await registrar(admin, "update", variantId, resumenCambio(nombre, resultado.change, razon), {
    variantId,
    before: resultado.change.before,
    after: resultado.change.after,
    delta: resultado.change.delta,
    reason: razon,
  });

  refrescar([ficha.product.slug]);

  if (resultado.change.delta === 0) {
    return { ok: true, mensaje: `«${nombre}» ya estaba en ${resultado.change.after}.` };
  }

  return {
    ok: true,
    mensaje: `«${nombre}»: ${resultado.change.before} → ${resultado.change.after} unidades.`,
  };
}

/* ─────────────────────────── ajuste en lote ─────────────────────────── */

/**
 * Aplica el mismo cambio a varias variantes con una razón común. Va todo en una
 * transacción (ver `bulkAdjust`): o cambian las N o no cambia ninguna.
 */
export async function aplicarLote(
  _prev: EstadoInventario,
  fd: FormData,
): Promise<EstadoInventario> {
  const admin = await getAdmin();
  if (!admin) return { error: "Tu sesión caducó. Vuelve a entrar y repite el ajuste." };

  const parseado = EsquemaLote.safeParse({
    ids: leerIds(fd),
    modo: String(fd.get("modo") ?? "sumar"),
    valor: entero(fd.get("valor")),
    razon: String(fd.get("razon") ?? "manual"),
    nota: String(fd.get("nota") ?? "").trim(),
  });

  if (!parseado.success) {
    return { error: parseado.error.issues[0]?.message ?? "Ese ajuste en lote no es válido." };
  }

  const { ids, modo, valor, razon, nota } = parseado.data;

  // Solo las que llevan la cuenta: meter aquí una variante de proveedor
  // escribiría un movimiento que no significa nada.
  const variantes = await db.productVariant.findMany({
    where: { id: { in: ids }, trackStock: true },
    select: { id: true, product: { select: { slug: true } } },
  });

  if (variantes.length === 0) {
    return {
      error:
        "Ninguna de las variantes seleccionadas lleva control de stock, así que no había nada que ajustar.",
    };
  }

  const entradas = variantes.map((v) =>
    modo === "fijar"
      ? { variantId: v.id, setTo: valor }
      : { variantId: v.id, delta: modo === "restar" ? -valor : valor },
  );

  const resultado = await bulkAdjust(entradas, { reason: razon, note: nota ?? "", userId: admin.id });
  if (!resultado.ok) return { error: resultado.error };

  const movidas = resultado.changes.filter((c) => c.delta !== 0).length;
  const gesto =
    modo === "fijar" ? `fijadas en ${valor}` : modo === "restar" ? `−${valor} unidades` : `+${valor} unidades`;

  await registrar(
    admin,
    "update",
    null,
    `Ajuste en lote de ${resultado.changes.length} variantes: ${gesto} (${REASON_LABELS[razon]}).`,
    { ids: resultado.changes.map((c) => c.variantId), modo, valor, reason: razon },
  );

  refrescar([...new Set(variantes.map((v) => v.product.slug))]);

  const ignoradas = ids.length - variantes.length;
  const cola = ignoradas > 0 ? ` ${ignoradas} sin control de stock quedaron fuera.` : "";

  return {
    ok: true,
    mensaje: `${resultado.changes.length} ${resultado.changes.length === 1 ? "variante ajustada" : "variantes ajustadas"} (${gesto}). ${movidas === resultado.changes.length ? "" : `${resultado.changes.length - movidas} ya estaban en ese número.`}${cola}`.trim(),
  };
}

/* ─────────────────────────── utilidades ─────────────────────────── */

function resumenCambio(nombre: string, cambio: StockChange, razon: StockReason): string {
  return `Stock de «${nombre}»: ${cambio.before} → ${cambio.after} (${REASON_LABELS[razon]}).`;
}

/**
 * Deja constancia de quién tocó el inventario. El `StockMovement` dice qué pasó
 * con la mercancía; esto dice quién estaba delante del teclado. Si falla, no se
 * tumba la operación: el stock ya está bien y perder una línea de auditoría no
 * justifica enseñar un error.
 */
async function registrar(
  admin: { id: string; email: string },
  action: string,
  entityId: string | null,
  summary: string,
  meta: Record<string, unknown>,
): Promise<void> {
  try {
    await db.activityLog.create({
      data: {
        userId: admin.id,
        userEmail: admin.email,
        action,
        entityType: "inventory",
        entityId,
        summary,
        metaJson: JSON.stringify(meta),
      },
    });
  } catch {
    // silencio deliberado: ver comentario de arriba
  }
}

/** Todo lo que enseña stock tiene que enterarse: panel, historial y escaparate. */
function refrescar(slugs: string[]): void {
  revalidatePath("/admin/inventario");
  revalidatePath("/admin/inventario/movimientos");
  revalidatePath("/admin/productos");
  revalidatePath("/admin");
  revalidatePath("/tienda");
  for (const slug of slugs) {
    if (slug) revalidatePath(`/producto/${slug}`);
  }
}

/**
 * La selección del lote viaja como JSON en un campo oculto (la construye el
 * componente cliente) y también se acepta como campos `ids` repetidos, que es
 * lo que llegaría si algún día el formulario se envía sin JavaScript.
 */
function leerIds(fd: FormData): string[] {
  const sueltos = fd.getAll("ids").map(String).filter(Boolean);
  const crudo = String(fd.get("idsJson") ?? "").trim();

  if (crudo) {
    try {
      const lista = JSON.parse(crudo);
      if (Array.isArray(lista)) {
        return [...new Set([...sueltos, ...lista.filter((x): x is string => typeof x === "string" && x.length > 0)])];
      }
    } catch {
      // JSON roto: nos quedamos con los sueltos y zod dirá que no hay nada.
    }
  }

  return [...new Set(sueltos)];
}

function entero(valor: FormDataEntryValue | null): number {
  const n = Number.parseInt(String(valor ?? "").trim(), 10);
  return Number.isFinite(n) ? n : Number.NaN;
}

function textoONada(valor: FormDataEntryValue | null): string | undefined {
  const texto = String(valor ?? "").trim();
  return texto ? texto : undefined;
}
