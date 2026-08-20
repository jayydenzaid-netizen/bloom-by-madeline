"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { parseToCents } from "@/lib/money";
import { nextOrderNumber } from "@/lib/orders";

/**
 * MOSTRADOR (POS) — cerrar una venta hecha en la boutique.
 *
 * Por qué existe: Madeline abre de jueves a sábado y cobra en mano. Si esas
 * ventas no entran aquí, el stock del panel y el del armario dejan de coincidir
 * a los dos días, y a partir de ahí ningún informe sirve. Una venta de mostrador
 * es un `Order` normal con `channel: "pos"`: misma base de datos que la tienda
 * web, mismos informes, mismo inventario.
 *
 * Tres reglas mandan sobre cualquier comodidad:
 *
 *  1. **Ni un centavo viene del navegador.** El cliente manda variantes y
 *     cantidades; los precios se leen de la base de datos dentro de la misma
 *     transacción que crea el pedido. Un importe en un campo oculto es la forma
 *     más rápida de vender un vestido por un centavo.
 *  2. **Todo o nada.** Pedido, líneas congeladas, descuento de stock y su
 *     `StockMovement` ocurren dentro de UNA transacción. Un pedido sin descuento
 *     de stock es exactamente el descuadre que este módulo viene a evitar.
 *  3. **Nada lanza.** Toda acción devuelve un resultado tipado. Un `throw` en un
 *     Server Action se le enseña a Madeline como "Application error", que no
 *     dice nada y da miedo con una clienta delante.
 *
 * NOTA SOBRE `lib/inventory.ts`: la puerta oficial del stock es `adjustStock`,
 * pero abre su PROPIA transacción (`db.$transaction`) y SQLite no admite
 * transacciones anidadas: llamarla desde aquí dentro rompería la atomicidad que
 * pide el punto 2 (o se bloquearía). Por eso el descuento se hace aquí a mano
 * respetando su contrato al pie de la letra: el `UPDATE` del stock y el
 * `StockMovement` con `before`/`after`/`reason: "sale"` se escriben juntos, en
 * la misma transacción, y nunca uno sin el otro.
 */

/* ─────────────────────────────── tipos ─────────────────────────────── */

/** Cómo se cobró en el mostrador. Ojo: "apuntado" = se lleva la pieza y paga después. */
export type MetodoPos = "cash" | "card" | "apuntado";

export type LineaTicket = {
  titulo: string;
  variante: string;
  sku: string;
  cantidad: number;
  precioCents: number;
  totalCents: number;
};

/** Lo que se imprime, se copia y se le enseña a la clienta al terminar. */
export type TicketVenta = {
  orderId: string;
  numero: string;
  /** ISO: el componente lo formatea con la zona del navegador de Madeline. */
  fechaISO: string;
  lineas: LineaTicket[];
  subtotalCents: number;
  descuentoCents: number;
  descuentoMotivo: string;
  totalCents: number;
  metodo: MetodoPos;
  /** false solo en "apuntado": la mercancía salió, el dinero no ha entrado. */
  pagado: boolean;
  /** Efectivo que puso la clienta sobre el mostrador. null si no fue efectivo. */
  entregadoCents: number | null;
  cambioCents: number | null;
  cliente: string;
  nota: string;
};

/**
 * Un fichero "use server" solo puede exportar funciones asíncronas: una
 * constante exportada de aquí revienta CUALQUIER acción del módulo. Los tipos sí
 * salen, porque TypeScript los borra al compilar; el estado inicial se declara
 * en el componente cliente.
 */
export type EstadoVenta = {
  ok?: boolean;
  error?: string;
  ticket?: TicketVenta;
};

/* ───────────────────────────── validación ───────────────────────────── */

/** Tope por línea: en una boutique nadie compra 100 unidades de la misma talla. */
const CANTIDAD_MAX = 99;
/** Reintentos si dos ventas piden el mismo número correlativo a la vez. */
const REINTENTOS_NUMERO = 4;

const EsquemaLinea = z.object({
  variantId: z.string().min(1),
  cantidad: z.number().int().min(1).max(CANTIDAD_MAX),
});

const EsquemaVenta = z
  .object({
    lineas: z.array(EsquemaLinea).min(1, "El ticket está vacío: añade al menos una pieza."),
    metodo: z.enum(["cash", "card", "apuntado"]),
    descuentoModo: z.enum(["none", "amount", "percent"]),
    /** Centavos si el modo es importe; porcentaje entero (0-100) si es porcentaje. */
    descuentoValor: z.number().int().min(0),
    descuentoMotivo: z.string().max(120),
    /** Efectivo recibido, solo informativo para calcular el cambio. */
    entregadoCents: z.number().int().min(0).nullable(),
    nombre: z.string().max(80),
    telefono: z.string().max(40),
    nota: z.string().max(300),
  })
  .refine((v) => v.descuentoModo !== "percent" || v.descuentoValor <= 100, {
    message: "El descuento en porcentaje no puede pasar de 100.",
    path: ["descuentoValor"],
  })
  .refine((v) => v.descuentoModo === "none" || v.descuentoValor > 0, {
    message: "Pusiste un descuento de 0: quítalo o escribe cuánto rebajas.",
    path: ["descuentoValor"],
  })
  .refine((v) => v.descuentoModo === "none" || v.descuentoMotivo.trim().length >= 2, {
    message: "Escribe el motivo del descuento: dentro de un mes nadie recuerda por qué se rebajó.",
    path: ["descuentoMotivo"],
  })
  .refine((v) => v.metodo !== "apuntado" || v.nombre.trim().length >= 2, {
    message: "Para apuntar una venta hace falta el nombre de la clienta: si no, no sabrás a quién cobrarle.",
    path: ["nombre"],
  });

/** Motivos de rechazo con el mensaje ya escrito en español. Abortan la transacción. */
class ProblemaVenta extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProblemaVenta";
  }
}

/* ──────────────────────────── cerrar la venta ──────────────────────────── */

export async function cobrarVenta(_prev: EstadoVenta, fd: FormData): Promise<EstadoVenta> {
  const admin = await getAdmin();
  if (!admin) return { error: "Tu sesión caducó. Vuelve a entrar; el ticket sigue en pantalla." };

  const lineasCrudas = leerLineas(fd.get("lineas"));
  if (!lineasCrudas) return { error: "No se entendió el ticket. Recarga la pantalla y vuelve a montarlo." };

  const modo = String(fd.get("descuentoModo") ?? "none");
  const textoDescuento = String(fd.get("descuentoValor") ?? "").trim();

  // El descuento se interpreta según el modo: en importe pasa por parseToCents
  // (única forma autorizada de convertir texto a centavos), en porcentaje es un
  // entero. Un texto ilegible NO se convierte en 0 en silencio.
  let descuentoValor = 0;
  if (modo === "amount") {
    const cents = parseToCents(textoDescuento);
    if (cents === null || cents < 0) return { error: "El descuento no se entiende. Escríbelo como 5 o 5.00." };
    descuentoValor = cents;
  } else if (modo === "percent") {
    const pct = Number.parseInt(textoDescuento, 10);
    if (!Number.isFinite(pct) || pct < 0) return { error: "El porcentaje de descuento no se entiende." };
    descuentoValor = pct;
  }

  const entregadoTexto = String(fd.get("entregadoCents") ?? "").trim();
  const entregadoCents = entregadoTexto ? parseToCents(entregadoTexto) : null;
  if (entregadoTexto && (entregadoCents === null || entregadoCents < 0)) {
    return { error: "El efectivo recibido no se entiende. Escríbelo como 40 o 40.00." };
  }

  const parseado = EsquemaVenta.safeParse({
    lineas: lineasCrudas,
    metodo: String(fd.get("metodo") ?? ""),
    descuentoModo: modo,
    descuentoValor,
    descuentoMotivo: String(fd.get("descuentoMotivo") ?? "").trim(),
    entregadoCents,
    nombre: String(fd.get("nombre") ?? "").trim(),
    telefono: String(fd.get("telefono") ?? "").trim(),
    nota: String(fd.get("nota") ?? "").trim(),
  });

  if (!parseado.success) {
    return { error: parseado.error.issues[0]?.message ?? "Revisa los datos de la venta." };
  }
  const datos = parseado.data;

  // Dos líneas de la misma variante descuadrarían la comprobación de stock
  // (cada una vería el stock completo). Se fusionan antes de tocar nada.
  const pedidas = new Map<string, number>();
  for (const l of datos.lineas) {
    pedidas.set(l.variantId, Math.min(CANTIDAD_MAX, (pedidas.get(l.variantId) ?? 0) + l.cantidad));
  }

  const ahora = new Date();
  const pagado = datos.metodo !== "apuntado";
  // El esquema solo admite stripe | dm | pickup | cash. "Tarjeta" se registra
  // como `stripe` porque es el mismo dinero de tarjeta en los informes (aquí la
  // pasa por su terminal de Square; esta pantalla NO cobra nada). "Apuntado" se
  // guarda como `dm`, que ya significa "se cobra fuera del sistema", y se queda
  // en `pending`: la pieza salió, el dinero no.
  const paymentMethod = datos.metodo === "cash" ? "cash" : datos.metodo === "card" ? "stripe" : "dm";

  for (let intento = 0; intento < REINTENTOS_NUMERO; intento++) {
    try {
      const resultado = await db.$transaction(async (tx) => {
        const variantes = await tx.productVariant.findMany({
          where: { id: { in: [...pedidas.keys()] } },
          select: {
            id: true,
            title: true,
            sku: true,
            priceCents: true,
            costCents: true,
            stock: true,
            trackStock: true,
            imageUrl: true,
            product: {
              select: {
                id: true,
                slug: true,
                title: true,
                status: true,
                costCents: true,
                images: { orderBy: { position: "asc" }, take: 1, select: { url: true } },
              },
            },
          },
        });

        const porId = new Map(variantes.map((v) => [v.id, v]));
        const lineas: {
          productId: string;
          variantId: string;
          slug: string;
          title: string;
          variantTitle: string;
          sku: string;
          imageUrl: string | null;
          priceCents: number;
          costCents: number | null;
          quantity: number;
          stockAntes: number;
          descontar: boolean;
        }[] = [];

        for (const [variantId, cantidad] of pedidas) {
          const v = porId.get(variantId);
          if (!v) throw new ProblemaVenta("Una de las piezas del ticket ya no existe en el catálogo. Quítala y repite.");
          if (v.product.status === "archived") {
            throw new ProblemaVenta(`«${v.product.title}» está archivado: actívalo antes de venderlo.`);
          }
          if (v.priceCents <= 0) {
            throw new ProblemaVenta(`«${v.product.title} · ${v.title}» todavía no tiene precio. Ponle precio y repite.`);
          }
          if (v.trackStock && v.stock < cantidad) {
            throw new ProblemaVenta(
              `De «${v.product.title} · ${v.title}» solo quedan ${v.stock} en el armario.`,
            );
          }

          lineas.push({
            productId: v.product.id,
            variantId: v.id,
            slug: v.product.slug,
            title: v.product.title,
            variantTitle: v.title,
            sku: v.sku,
            // La foto se congela con el pedido: si mañana cambia el catálogo, el
            // ticket viejo tiene que seguir enseñando lo que se vendió.
            imageUrl: v.imageUrl ?? v.product.images[0]?.url ?? null,
            priceCents: v.priceCents,
            costCents: v.costCents ?? v.product.costCents ?? null,
            quantity: cantidad,
            stockAntes: v.stock,
            descontar: v.trackStock,
          });
        }

        // ── Totales: se calculan aquí y solo aquí ──
        const subtotalCents = lineas.reduce((suma, l) => suma + l.priceCents * l.quantity, 0);
        const descuentoCents =
          datos.descuentoModo === "none"
            ? 0
            : datos.descuentoModo === "percent"
              ? Math.round((subtotalCents * datos.descuentoValor) / 100)
              : datos.descuentoValor;

        if (descuentoCents > subtotalCents) {
          throw new ProblemaVenta("El descuento es mayor que el ticket. Corrígelo: no se puede cobrar en negativo.");
        }
        const totalCents = subtotalCents - descuentoCents;
        if (totalCents < 0) throw new ProblemaVenta("El total salió negativo. Revisa el descuento.");

        const numero = await nextOrderNumber(tx);
        const nombre = datos.nombre.trim() || "Venta de mostrador";

        const order = await tx.order.create({
          data: {
            number: numero,
            // Sin correo: en el mostrador no se pide, y no se inventa uno.
            email: "",
            phone: datos.telefono,
            name: nombre,
            paymentStatus: pagado ? "paid" : "pending",
            // La clienta se lleva la ropa puesta en la bolsa: está entregado
            // aunque esté apuntado. Marcarlo "por enviar" llenaría la cola de
            // pedidos de fantasmas que nadie tiene que preparar.
            fulfillStatus: "fulfilled",
            paymentMethod,
            channel: "pos",
            subtotalCents,
            shippingCents: 0,
            taxCents: 0,
            discountCents: descuentoCents,
            totalCents,
            note: notaDelPedido(datos, descuentoCents, totalCents),
            paidAt: pagado ? ahora : null,
            items: {
              create: lineas.map((l) => ({
                productId: l.productId,
                variantId: l.variantId,
                title: l.title,
                variantTitle: l.variantTitle,
                sku: l.sku,
                imageUrl: l.imageUrl,
                priceCents: l.priceCents,
                costCents: l.costCents,
                quantity: l.quantity,
              })),
            },
          },
          select: { id: true, number: true, createdAt: true },
        });

        // ── Stock: mismo contrato que lib/inventory.ts, dentro de esta transacción ──
        for (const l of lineas) {
          if (!l.descontar) continue;

          // El `gte` del WHERE es la comprobación de verdad: si otra venta se
          // coló entre la lectura y este UPDATE, no descuenta nada y count sale 0.
          const res = await tx.productVariant.updateMany({
            where: { id: l.variantId, trackStock: true, stock: { gte: l.quantity } },
            data: { stock: { decrement: l.quantity } },
          });
          if (res.count !== 1) {
            throw new ProblemaVenta(
              `«${l.title} · ${l.variantTitle}» se agotó mientras cobrabas. Revisa el ticket.`,
            );
          }

          await tx.stockMovement.create({
            data: {
              variantId: l.variantId,
              reason: "sale",
              delta: -l.quantity,
              before: l.stockAntes,
              after: l.stockAntes - l.quantity,
              reference: order.number,
              note: "Venta en el mostrador",
              userId: admin.id,
            },
          });
        }

        const ticket: TicketVenta = {
          orderId: order.id,
          numero: order.number,
          fechaISO: order.createdAt.toISOString(),
          lineas: lineas.map((l) => ({
            titulo: l.title,
            variante: l.variantTitle,
            sku: l.sku,
            cantidad: l.quantity,
            precioCents: l.priceCents,
            totalCents: l.priceCents * l.quantity,
          })),
          subtotalCents,
          descuentoCents,
          descuentoMotivo: datos.descuentoMotivo,
          totalCents,
          metodo: datos.metodo,
          pagado,
          entregadoCents: datos.metodo === "cash" ? datos.entregadoCents : null,
          cambioCents:
            datos.metodo === "cash" && datos.entregadoCents !== null
              ? Math.max(0, datos.entregadoCents - totalCents)
              : null,
          cliente: datos.nombre.trim(),
          nota: datos.nota,
        };

        return { ticket, slugs: [...new Set(lineas.map((l) => l.slug))] };
      });

      await registrar(admin, resultado.ticket);
      refrescar(resultado.slugs);
      return { ok: true, ticket: resultado.ticket };
    } catch (error) {
      if (error instanceof ProblemaVenta) return { error: error.message };
      // Choque de número correlativo: dos ventas a la vez. Se reintenta.
      if (esNumeroDuplicado(error) && intento < REINTENTOS_NUMERO - 1) continue;

      console.error("[pos] no se pudo cerrar la venta:", error);
      return { error: "No se pudo guardar la venta. Vuelve a intentarlo; el ticket no se ha perdido." };
    }
  }

  return { error: "No se pudo guardar la venta. Vuelve a intentarlo; el ticket no se ha perdido." };
}

/* ─────────────────────────── utilidades ─────────────────────────── */

function leerLineas(valor: FormDataEntryValue | null): { variantId: string; cantidad: number }[] | null {
  if (typeof valor !== "string" || !valor) return null;
  try {
    const bruto: unknown = JSON.parse(valor);
    if (!Array.isArray(bruto)) return null;
    return bruto.map((item) => {
      const fila = item as { variantId?: unknown; cantidad?: unknown };
      return {
        variantId: String(fila.variantId ?? ""),
        cantidad: Math.trunc(Number(fila.cantidad ?? 0)),
      };
    });
  } catch {
    return null;
  }
}

/**
 * La nota del pedido es el único sitio donde queda por escrito lo que pasó en el
 * mostrador: cómo se cobró, por qué se rebajó y cuánto cambio se dio. Dentro de
 * un mes, "¿por qué este vestido salió a $30?" se responde abriendo el pedido.
 */
function notaDelPedido(
  datos: z.infer<typeof EsquemaVenta>,
  descuentoCents: number,
  totalCents: number,
): string {
  const partes: string[] = ["Venta en el mostrador."];

  if (datos.metodo === "cash") {
    partes.push("Cobrado en efectivo.");
    if (datos.entregadoCents !== null) {
      const cambio = Math.max(0, datos.entregadoCents - totalCents);
      partes.push(`Recibido ${dolares(datos.entregadoCents)}, cambio ${dolares(cambio)}.`);
    }
  } else if (datos.metodo === "card") {
    partes.push("Cobrado con tarjeta en el terminal de Square (aquí solo queda registrado).");
  } else {
    partes.push("APUNTADO: se llevó la mercancía y queda pendiente de pago.");
  }

  if (descuentoCents > 0) partes.push(`Descuento de mostrador: ${datos.descuentoMotivo}.`);
  if (datos.telefono) partes.push(`Teléfono: ${datos.telefono}.`);
  if (datos.nota) partes.push(datos.nota);

  return partes.join(" ");
}

/** Solo para el texto de la nota; en pantalla siempre manda formatCents(). */
function dolares(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Deja rastro de quién cobró qué. Si falla, la venta ya está guardada: no se tumba. */
async function registrar(admin: { id: string; email: string }, ticket: TicketVenta): Promise<void> {
  const comoSeCobro =
    ticket.metodo === "cash" ? "efectivo" : ticket.metodo === "card" ? "tarjeta (Square)" : "apuntado";

  await db.activityLog
    .create({
      data: {
        userId: admin.id,
        userEmail: admin.email,
        action: "create",
        entityType: "order",
        entityId: ticket.orderId,
        summary: `Venta en mostrador ${ticket.numero} · ${dolares(ticket.totalCents)} · ${comoSeCobro}`,
        metaJson: JSON.stringify({
          channel: "pos",
          metodo: ticket.metodo,
          piezas: ticket.lineas.reduce((n, l) => n + l.cantidad, 0),
          descuentoCents: ticket.descuentoCents,
          motivo: ticket.descuentoMotivo,
        }),
      },
    })
    .catch(() => {
      // La auditoría es un extra: perder una línea de log no justifica enseñar
      // un error por una venta que sí quedó guardada.
    });
}

/** Todo lo que enseña stock, ventas o pedidos tiene que enterarse de la venta. */
function refrescar(slugs: string[]): void {
  revalidatePath("/admin/pos");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/inventario");
  revalidatePath("/admin/informes");
  revalidatePath("/admin");
  revalidatePath("/tienda");
  for (const slug of slugs) revalidatePath(`/producto/${slug}`);
}

function esNumeroDuplicado(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
