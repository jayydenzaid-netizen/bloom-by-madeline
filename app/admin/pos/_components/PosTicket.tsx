"use client";

import { useState } from "react";
import { formatCents } from "@/lib/money";
import { Button } from "../../_components/ui";
import type { TicketVenta } from "../actions";

/**
 * El ticket de la venta recién cerrada.
 *
 * Hace dos trabajos con el mismo marcado:
 *  - en pantalla, la confirmación que Madeline mira antes de seguir;
 *  - en papel, lo que se imprime (`@media print` en pos.css lo deja solo en la
 *    hoja, a 72 mm, que es lo que cabe en una impresora de tickets).
 *
 * No hay envío por correo porque la tienda todavía no tiene correo configurado:
 * prometer un email que no sale nunca es peor que no ofrecerlo. En su lugar se
 * copia el resumen al portapapeles y ella lo pega en el mensaje de Instagram o
 * de WhatsApp, que es como habla con sus clientas hoy.
 */

export type PosBoutique = {
  nombre: string;
  direccion: string;
  horario: string;
  instagram: string;
  telefono: string;
};

export function PosTicket({
  ticket,
  boutique,
  onNueva,
}: {
  ticket: TicketVenta;
  boutique: PosBoutique;
  /** Vaciar y volver al mostrador para la siguiente clienta. */
  onNueva: () => void;
}) {
  const [copiado, setCopiado] = useState<"no" | "si" | "falla">("no");

  const fecha = new Date(ticket.fechaISO);
  const cuando = fecha.toLocaleString("es-US", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const piezas = ticket.lineas.reduce((n, l) => n + l.cantidad, 0);

  async function copiar() {
    const texto = resumenTexto(ticket, boutique, cuando);
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado("si");
    } catch {
      // Sin permiso de portapapeles (o sin HTTPS): plan B con un textarea
      // temporal, que funciona hasta en el navegador del móvil más viejo.
      const area = document.createElement("textarea");
      area.value = texto;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      document.body.appendChild(area);
      area.select();
      const bien = document.execCommand("copy");
      document.body.removeChild(area);
      setCopiado(bien ? "si" : "falla");
    }
    setTimeout(() => setCopiado("no"), 4000);
  }

  return (
    <div className="pos-overlay" role="dialog" aria-modal="true" aria-label={`Venta ${ticket.numero} cerrada`}>
      <div className="pos-recibo-caja">
        <div className="pos-recibo">
          <header className="pos-recibo-cab">
            <strong>{boutique.nombre}</strong>
            {boutique.direccion ? <span>{boutique.direccion}</span> : null}
            {boutique.telefono ? <span>{boutique.telefono}</span> : null}
            {boutique.instagram ? <span>@{boutique.instagram}</span> : null}
          </header>

          <div className="pos-recibo-meta">
            <span>{ticket.numero}</span>
            <span>{cuando}</span>
          </div>

          {ticket.cliente ? <div className="pos-recibo-cliente">Clienta: {ticket.cliente}</div> : null}

          <table className="pos-recibo-tabla">
            <tbody>
              {ticket.lineas.map((l, i) => (
                <tr key={`${l.sku}-${i}`}>
                  <td>
                    <span className="pos-recibo-tit">{l.titulo}</span>
                    {l.variante ? <span className="pos-recibo-var">{l.variante}</span> : null}
                    <span className="pos-recibo-var">
                      {l.cantidad} × {formatCents(l.precioCents)}
                    </span>
                  </td>
                  <td className="pos-al-der">{formatCents(l.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pos-recibo-sumas">
            <div>
              <span>Subtotal ({piezas} {piezas === 1 ? "pieza" : "piezas"})</span>
              <span>{formatCents(ticket.subtotalCents)}</span>
            </div>
            {ticket.descuentoCents > 0 ? (
              <div>
                <span>Descuento{ticket.descuentoMotivo ? ` · ${ticket.descuentoMotivo}` : ""}</span>
                <span>−{formatCents(ticket.descuentoCents)}</span>
              </div>
            ) : null}
            <div className="pos-recibo-total">
              <span>Total</span>
              <span>{formatCents(ticket.totalCents)}</span>
            </div>
            <div>
              <span>Forma de pago</span>
              <span>{etiquetaMetodo(ticket.metodo)}</span>
            </div>
            {ticket.entregadoCents !== null ? (
              <>
                <div>
                  <span>Recibido</span>
                  <span>{formatCents(ticket.entregadoCents)}</span>
                </div>
                <div className="pos-recibo-total">
                  <span>Cambio</span>
                  <span>{formatCents(ticket.cambioCents ?? 0)}</span>
                </div>
              </>
            ) : null}
          </div>

          {!ticket.pagado ? (
            <p className="pos-recibo-aviso">PENDIENTE DE PAGO · {formatCents(ticket.totalCents)}</p>
          ) : null}

          <footer className="pos-recibo-pie">
            {boutique.horario ? <span>{boutique.horario}</span> : null}
            <span>¡Gracias por tu compra!</span>
          </footer>
        </div>
      </div>

      <div className="pos-recibo-acciones pos-noprint">
        <p className="pos-recibo-ok">
          Venta {ticket.numero} guardada · {formatCents(ticket.totalCents)}
          {ticket.pagado ? "" : " · queda apuntada, sin cobrar"}
        </p>

        {ticket.metodo === "card" ? (
          <p className="pos-recibo-nota">
            Recuerda: el cobro real lo hizo tu terminal de Square. Aquí solo quedó registrado.
          </p>
        ) : null}

        <div className="pos-recibo-botones">
          <Button variant="primary" onClick={onNueva}>
            Nueva venta
          </Button>
          <Button variant="ghost" onClick={() => window.print()}>
            Imprimir
          </Button>
          <Button variant="ghost" onClick={copiar}>
            {copiado === "si" ? "¡Copiado!" : copiado === "falla" ? "No se pudo copiar" : "Copiar resumen"}
          </Button>
          <Button variant="ghost" href={`/admin/pedidos/${ticket.orderId}`}>
            Ver el pedido
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── utilidades ─────────────────────────── */

export function etiquetaMetodo(metodo: TicketVenta["metodo"]): string {
  if (metodo === "cash") return "Efectivo";
  if (metodo === "card") return "Tarjeta (Square)";
  return "Apuntado · pendiente de pago";
}

/** Texto plano para pegar en un mensaje de Instagram o WhatsApp. */
function resumenTexto(ticket: TicketVenta, boutique: PosBoutique, cuando: string): string {
  const lineas = [
    boutique.nombre,
    `Ticket ${ticket.numero} · ${cuando}`,
    "",
    ...ticket.lineas.map(
      (l) =>
        `${l.cantidad} × ${l.titulo}${l.variante ? ` (${l.variante})` : ""} — ${formatCents(l.totalCents)}`,
    ),
    "",
    `Subtotal: ${formatCents(ticket.subtotalCents)}`,
  ];

  if (ticket.descuentoCents > 0) {
    lineas.push(
      `Descuento${ticket.descuentoMotivo ? ` (${ticket.descuentoMotivo})` : ""}: -${formatCents(ticket.descuentoCents)}`,
    );
  }

  lineas.push(`TOTAL: ${formatCents(ticket.totalCents)}`, `Pago: ${etiquetaMetodo(ticket.metodo)}`);

  if (ticket.entregadoCents !== null) {
    lineas.push(
      `Recibido: ${formatCents(ticket.entregadoCents)} · Cambio: ${formatCents(ticket.cambioCents ?? 0)}`,
    );
  }
  if (!ticket.pagado) lineas.push(`PENDIENTE DE PAGO: ${formatCents(ticket.totalCents)}`);
  lineas.push("", "¡Gracias por tu compra!");

  return lineas.join("\n");
}
