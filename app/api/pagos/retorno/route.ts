import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { normalizeOrderNumber } from "@/lib/orders";
import { verificarPagoPedido } from "@/lib/payments";

/**
 * Vuelta de la pasarela (Stripe / PayPal / Square redirigen aquí tras el pago).
 *
 * Esta URL la puede escribir CUALQUIERA, así que aquí no se cree nada de la
 * query: se verifica el cobro contra la API del proveedor con la llave secreta
 * (lib/payments) y solo eso decide el estado. Tampoco se concede acceso a la
 * página del pedido: la compradora ya tiene su cookie HMAC de cuando confirmó,
 * y quien llegue sin ella se encuentra el candado que pide el email — como
 * siempre.
 */
export async function GET(req: NextRequest) {
  const numero = normalizeOrderNumber(req.nextUrl.searchParams.get("pedido") ?? "");
  if (!numero) {
    return NextResponse.redirect(new URL("/tienda", req.nextUrl));
  }

  const destino = new URL(`/pedido/${encodeURIComponent(numero)}`, req.nextUrl);

  const order = await db.order.findUnique({ where: { number: numero }, select: { id: true } });
  if (!order) {
    // La página del pedido ya sabe explicar un número que no existe.
    return NextResponse.redirect(destino);
  }

  const resultado = await verificarPagoPedido(order.id);
  if (resultado.estado === "pagado") {
    destino.searchParams.set("pago", "confirmado");
    // El pedido acaba de entrar en la cola «por enviar» del panel.
    revalidatePath("/admin/pedidos");
    revalidatePath("/admin");
  } else if (resultado.estado === "revisar") {
    destino.searchParams.set("pago", "revision");
  } else if (resultado.estado === "pendiente" || resultado.estado === "sin-respuesta") {
    // «No pudimos preguntar» viaja como «procesando» a propósito: el mensaje que
    // ya existe («vuelve a abrir esta página en unos minutos») es exactamente lo
    // que hay que decirle a alguien que quizá acaba de pagar. Lo que NO se puede
    // hacer es mandarla a pagar otra vez.
    destino.searchParams.set("pago", "procesando");
  }

  return NextResponse.redirect(destino);
}
