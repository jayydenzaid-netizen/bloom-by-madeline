"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { aplicarStockEnTx } from "@/lib/inventory";
import { anularSesionesPago, verificarPagoPedido } from "@/lib/payments";

/**
 * Acciones sobre un pedido: cobrar, reembolsar, cancelar, enviar y anotar.
 *
 * Dos decisiones que conviene entender antes de tocar esto:
 *
 * 1. **Bitácora dentro de `Order.note`.** El esquema no tiene tabla de eventos,
 *    y añadir una es cosa de una migración que aquí no toca. Cada cambio de
 *    estado deja una línea con fecha al final de `note`, y lo que la clienta
 *    escribió al comprar se queda intacto arriba. Así "cuándo se cobró esto"
 *    tiene respuesta sin inventar un historial que no existe.
 *
 * 2. **Cancelar devuelve el stock.** Solo de las variantes con `trackStock`:
 *    en dropshipping el inventario lo tiene el proveedor y sumar ahí sería
 *    inventarse existencias. Si no se devolviera, el catálogo diría que quedan
 *    menos prendas de las que hay y Madeline dejaría de vender lo que sí tiene.
 */

const idSchema = z.string().trim().min(1, "Falta el pedido.");

const envioSchema = z.object({
  id: idSchema,
  transportista: z.string().trim().min(2, "Escribe el transportista.").max(60),
  seguimiento: z.string().trim().min(3, "Escribe el número de seguimiento.").max(80),
});

const notaSchema = z.object({
  id: idSchema,
  texto: z.string().trim().min(1, "La nota está vacía.").max(1000),
});

const motivoSchema = z.object({
  id: idSchema,
  motivo: z.string().trim().max(200).optional(),
});

const selloFecha = new Intl.DateTimeFormat("es-US", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "19 ago 2026, 03:24 PM · Marcado como pagado" al final de la nota. */
function anotar(notaActual: string, texto: string): string {
  const linea = `[${selloFecha.format(new Date())}] ${texto}`;
  const previo = (notaActual || "").trimEnd();
  return previo ? `${previo}\n${linea}` : linea;
}

/** Todas las acciones pasan por aquí: sin sesión no se toca ningún pedido.
 *  Devuelve la cuenta para que quien cambie stock deje su nombre en el rastro. */
async function exigirSesion() {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");
  return admin;
}

function volver(id: string, estado: string): never {
  revalidatePath(`/admin/pedidos/${id}`);
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin");
  // redirect() lanza una excepción de control de Next: va siempre al final y
  // nunca dentro de un try/catch, o la navegación se traga a sí misma.
  redirect(`/admin/pedidos/${id}?estado=${estado}`);
}

/* ───────────────────────────── cobro ───────────────────────────── */

/**
 * Pregunta a la pasarela (Stripe/PayPal/Square) si el pedido ya se cobró de
 * verdad y, si cuadra, lo marca pagado. Es el mismo verificador que usa la
 * vuelta de la pasarela: aquí sirve para el caso «la clienta pagó y cerró la
 * pestaña antes de volver a la tienda».
 */
export async function verificarPagoAdmin(formData: FormData): Promise<void> {
  await exigirSesion();
  const id = idSchema.parse(String(formData.get("id") ?? ""));

  const resultado = await verificarPagoPedido(id);

  if (resultado.estado === "pagado") volver(id, "pago-verificado");
  if (resultado.estado === "revisar") volver(id, "pago-revisar");
  if (resultado.estado === "sin-verificar") volver(id, "pago-sin-intentos");
  volver(id, "pago-sin-cobro");
}

export async function marcarPagado(formData: FormData): Promise<void> {
  await exigirSesion();
  const id = idSchema.parse(String(formData.get("id") ?? ""));

  const pedido = await db.order.findUnique({ where: { id }, select: { note: true, paidAt: true } });
  if (!pedido) volver(id, "no-existe");

  await db.order.update({
    where: { id },
    data: {
      paymentStatus: "paid",
      // La fecha de cobro solo se pone la primera vez: si el pedido pasó por
      // reembolso y vuelve a cobrarse, la venta original sigue siendo aquella.
      paidAt: pedido.paidAt ?? new Date(),
      note: anotar(pedido.note, "Marcado como pagado."),
    },
  });

  volver(id, "pagado");
}

export async function marcarPendiente(formData: FormData): Promise<void> {
  await exigirSesion();
  const id = idSchema.parse(String(formData.get("id") ?? ""));

  const pedido = await db.order.findUnique({ where: { id }, select: { note: true } });
  if (!pedido) volver(id, "no-existe");

  // Marcar pagado por error no debe ser un callejón sin salida: sin esta vuelta
  // atrás, las ventas del mes quedarían infladas para siempre.
  await db.order.update({
    where: { id },
    data: { paymentStatus: "pending", note: anotar(pedido.note, "Devuelto a pendiente de cobro.") },
  });

  volver(id, "pendiente");
}

export async function marcarReembolsado(formData: FormData): Promise<void> {
  await exigirSesion();
  const datos = motivoSchema.parse({
    id: String(formData.get("id") ?? ""),
    motivo: String(formData.get("motivo") ?? ""),
  });

  const pedido = await db.order.findUnique({ where: { id: datos.id }, select: { note: true } });
  if (!pedido) volver(datos.id, "no-existe");

  const motivo = datos.motivo ? ` Motivo: ${datos.motivo}.` : "";
  await db.order.update({
    where: { id: datos.id },
    data: { paymentStatus: "refunded", note: anotar(pedido.note, `Marcado como reembolsado.${motivo}`) },
  });

  volver(datos.id, "reembolsado");
}

/* ──────────────────────────── cancelación ──────────────────────────── */

export async function marcarCancelado(formData: FormData): Promise<void> {
  const admin = await exigirSesion();
  const datos = motivoSchema.parse({
    id: String(formData.get("id") ?? ""),
    motivo: String(formData.get("motivo") ?? ""),
  });

  const resultado = await db.$transaction(async (tx) => {
    const pedido = await tx.order.findUnique({
      where: { id: datos.id },
      include: { items: { select: { variantId: true, quantity: true } } },
      // El número identifica la devolución en el historial de movimientos.
    });
    if (!pedido) return "no-existe" as const;

    // Ya cancelado: salir sin tocar nada. Devolver el stock dos veces por un
    // doble clic sería peor que no devolverlo.
    if (pedido.paymentStatus === "cancelled" && pedido.fulfillStatus === "cancelled") {
      return "ya-cancelado" as const;
    }

    let unidades = 0;
    for (const item of pedido.items) {
      if (!item.variantId || item.quantity <= 0) continue;
      const variante = await tx.productVariant.findUnique({
        where: { id: item.variantId },
        select: { id: true, trackStock: true },
      });
      // Sin variante (producto borrado) o sin control de stock no hay nada que
      // devolver: el inventario de dropshipping no es nuestro.
      if (!variante || !variante.trackStock) continue;
      // Por la puerta oficial: el stock vuelve Y queda su línea en el historial
      // (razón `cancel`), dentro de esta misma transacción.
      await aplicarStockEnTx(tx, variante.id, { delta: item.quantity }, {
        reason: "cancel",
        reference: pedido.number,
        userId: admin.id,
        note: datos.motivo ? `Cancelación: ${datos.motivo}` : "Pedido cancelado",
      });
      unidades += item.quantity;
    }

    const motivo = datos.motivo ? ` Motivo: ${datos.motivo}.` : "";
    const stock = unidades > 0 ? ` Se devolvieron ${unidades} unidades al inventario.` : "";
    await tx.order.update({
      where: { id: datos.id },
      data: {
        paymentStatus: "cancelled",
        fulfillStatus: "cancelled",
        note: anotar(pedido.note, `Pedido cancelado.${motivo}${stock}`),
      },
    });

    return "cancelado" as const;
  });

  // Un pedido cancelado no puede dejar una página de pago viva en la pasarela:
  // sería un cobro fantasma esperando a que alguien reencuentre la pestaña.
  // Best-effort fuera de la transacción (es red, no datos).
  if (resultado === "cancelado") {
    await anularSesionesPago(datos.id);
  }

  volver(datos.id, resultado);
}

/* ───────────────────────────── envío ───────────────────────────── */

export async function marcarEnviado(formData: FormData): Promise<void> {
  await exigirSesion();

  const datos = envioSchema.safeParse({
    id: String(formData.get("id") ?? ""),
    transportista: String(formData.get("transportista") ?? ""),
    seguimiento: String(formData.get("seguimiento") ?? ""),
  });

  if (!datos.success) {
    const id = String(formData.get("id") ?? "");
    // Sin número de seguimiento el pedido no se marca enviado: la clienta se
    // quedaría esperando un correo de seguimiento que nunca llegaría.
    volver(id, "falta-seguimiento");
  }

  const pedido = await db.order.findUnique({ where: { id: datos.data.id }, select: { note: true } });
  if (!pedido) volver(datos.data.id, "no-existe");

  await db.order.update({
    where: { id: datos.data.id },
    data: {
      fulfillStatus: "fulfilled",
      trackingCarrier: datos.data.transportista,
      trackingNumber: datos.data.seguimiento,
      note: anotar(pedido.note, `Enviado por ${datos.data.transportista}, seguimiento ${datos.data.seguimiento}.`),
    },
  });

  volver(datos.data.id, "enviado");
}

/* ───────────────────────────── notas ───────────────────────────── */

export async function anadirNota(formData: FormData): Promise<void> {
  await exigirSesion();

  const datos = notaSchema.safeParse({
    id: String(formData.get("id") ?? ""),
    texto: String(formData.get("texto") ?? ""),
  });

  if (!datos.success) {
    volver(String(formData.get("id") ?? ""), "nota-vacia");
  }

  const pedido = await db.order.findUnique({ where: { id: datos.data.id }, select: { note: true } });
  if (!pedido) volver(datos.data.id, "no-existe");

  await db.order.update({
    where: { id: datos.data.id },
    data: { note: anotar(pedido.note, datos.data.texto) },
  });

  volver(datos.data.id, "nota");
}
