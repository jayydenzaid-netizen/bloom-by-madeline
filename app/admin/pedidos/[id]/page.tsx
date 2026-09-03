import Link from "next/link";
import Script from "next/script";
import { notFound, redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { Badge, Button, Card, Field, Money, PageHeader, type BadgeTone } from "../../_components/ui";
import {
  anadirNota,
  marcarCancelado,
  marcarEnviado,
  marcarPagado,
  marcarPendiente,
  marcarReembolsado,
  verificarPagoAdmin,
} from "../actions";

/**
 * Ficha de un pedido: cobrar, preparar, enviar y anotar, todo desde una sola
 * pantalla porque Madeline la usa con el teléfono en una mano y la caja en la otra.
 *
 * El albarán no reutiliza el marcado de pantalla: se pinta aparte (`.ped-albaran`),
 * oculto en pantalla y visible al imprimir. Reaprovechar la vista completa metía
 * tarjetas, botones y bitácora en el papel y se iba a tres hojas.
 */

export const dynamic = "force-dynamic";

const fechaLarga = new Intl.DateTimeFormat("es-US", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const fechaCorta = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

const PAGO: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: "Por cobrar", tone: "warning" },
  paid: { label: "Pagado", tone: "success" },
  refunded: { label: "Reembolsado", tone: "info" },
  cancelled: { label: "Cancelado", tone: "danger" },
};

const ENVIO: Record<string, { label: string; tone: BadgeTone }> = {
  unfulfilled: { label: "Por enviar", tone: "neutral" },
  fulfilled: { label: "Enviado", tone: "success" },
  cancelled: { label: "Cancelado", tone: "danger" },
};

const METODO: Record<string, string> = {
  stripe: "Tarjeta (Stripe)",
  paypal: "PayPal",
  square: "Tarjeta (Square)",
  dm: "DM de Instagram",
  pickup: "Recogida en tienda",
  cash: "Efectivo",
};

/** Métodos cobrados por pasarela: tienen botón «Verificar pago» y referencia. */
const METODOS_ONLINE = ["stripe", "paypal", "square"];

/** Transportistas que usa una boutique de Ohio. La lista es una ayuda, no una jaula. */
const TRANSPORTISTAS = ["USPS", "UPS", "FedEx", "DHL", "Entrega en mano"];

const AVISOS: Record<string, { tone: BadgeTone; label: string; texto: string }> = {
  pagado: { tone: "success", label: "Cobro", texto: "El pedido queda marcado como pagado." },
  pendiente: { tone: "warning", label: "Cobro", texto: "El pedido vuelve a estar pendiente de cobro." },
  reembolsado: { tone: "info", label: "Cobro", texto: "El pedido queda marcado como reembolsado." },
  cancelado: {
    tone: "danger",
    label: "Cancelado",
    texto: "Pedido cancelado. El stock de las variantes con control de inventario se devolvió al catálogo.",
  },
  "ya-cancelado": {
    tone: "neutral",
    label: "Sin cambios",
    texto: "Este pedido ya estaba cancelado, así que no se tocó el inventario otra vez.",
  },
  enviado: { tone: "success", label: "Envío", texto: "Pedido marcado como enviado con su número de seguimiento." },
  nota: { tone: "neutral", label: "Nota", texto: "Nota añadida a la bitácora del pedido." },
  "falta-seguimiento": {
    tone: "danger",
    label: "Falta un dato",
    texto: "Para marcar el envío hacen falta el transportista y el número de seguimiento.",
  },
  "nota-vacia": { tone: "danger", label: "Nota vacía", texto: "Escribe algo antes de guardar la nota." },
  "no-existe": { tone: "danger", label: "Error", texto: "No se encontró el pedido al aplicar el cambio." },
  "pago-verificado": {
    tone: "success",
    label: "Cobro",
    texto: "La pasarela confirma el cobro: el pedido queda marcado como pagado.",
  },
  "pago-sin-cobro": {
    tone: "warning",
    label: "Cobro",
    texto: "La pasarela todavía no registra ningún cobro de este pedido.",
  },
  "pago-revisar": {
    tone: "danger",
    label: "Revisar",
    texto:
      "La pasarela registra un cobro que NO cuadra con el pedido (importe o moneda). El detalle quedó en la bitácora: revísalo antes de marcar nada.",
  },
  "pago-sin-intentos": {
    tone: "neutral",
    label: "Cobro",
    texto: "Este pedido no tiene ninguna sesión de pago online que verificar.",
  },
  // Distinto de «no hay cobro»: aquí NO SE PUDO PREGUNTAR. Decir lo primero
  // llevaría a cancelar un pedido que a lo mejor está cobrado.
  "pago-sin-respuesta": {
    tone: "warning",
    label: "Sin respuesta",
    texto:
      "No pudimos preguntarle a la pasarela si este pedido se cobró (puede estar caída, o las llaves de la tienda ya no valen). NO significa que la clienta no haya pagado: revisa Pagos en el panel y vuelve a intentarlo antes de cancelar nada.",
  },
};

/**
 * Separa lo que escribió la clienta de la bitácora que añaden las acciones.
 * Las líneas de bitácora empiezan por "[dd mmm aaaa, hh:mm]" (ver actions.ts).
 */
function separarNota(note: string): { clienta: string; bitacora: string[] } {
  const lineas = (note || "").split("\n");
  const clienta: string[] = [];
  const bitacora: string[] = [];
  for (const linea of lineas) {
    if (/^\[\d{2}\s/.test(linea.trim())) bitacora.push(linea.trim());
    else if (linea.trim()) clienta.push(linea);
  }
  return { clienta: clienta.join("\n"), bitacora };
}

/** Busca un @usuario dentro del nombre o la nota para enlazar el DM directo. */
function detectarInstagram(...textos: string[]): string | null {
  for (const texto of textos) {
    const encontrado = /@([A-Za-z0-9._]{2,30})/.exec(texto || "");
    if (encontrado) return encontrado[1];
  }
  return null;
}

export default async function PedidoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const { id } = await params;
  const sp = await searchParams;
  const avisoKey = (Array.isArray(sp.estado) ? sp.estado[0] : sp.estado) ?? "";
  const aviso = AVISOS[avisoKey];

  const [pedido, settings] = await Promise.all([
    db.order.findUnique({
      where: { id },
      include: {
        items: true,
        customer: { select: { id: true, name: true, email: true, phone: true, note: true } },
      },
    }),
    getSettings(),
  ]);

  if (!pedido) notFound();

  const pago = PAGO[pedido.paymentStatus] ?? { label: pedido.paymentStatus, tone: "neutral" as BadgeTone };
  const envio = ENVIO[pedido.fulfillStatus] ?? { label: pedido.fulfillStatus, tone: "neutral" as BadgeTone };
  const metodo = METODO[pedido.paymentMethod] ?? pedido.paymentMethod;
  const cancelado = pedido.paymentStatus === "cancelled" && pedido.fulfillStatus === "cancelled";

  const { clienta: notaClienta, bitacora } = separarNota(pedido.note);

  const direccion = [
    pedido.shipName || pedido.name,
    pedido.shipLine1,
    pedido.shipLine2,
    [pedido.shipCity, pedido.shipState].filter(Boolean).join(", ") +
      (pedido.shipZip ? ` ${pedido.shipZip}` : ""),
    pedido.shipCountry,
  ]
    .map((linea) => linea.trim())
    .filter(Boolean);
  const hayDireccion = Boolean(pedido.shipLine1.trim() || pedido.shipCity.trim());

  const handle = pedido.paymentMethod === "dm" ? detectarInstagram(pedido.name, pedido.customer?.note ?? "") : null;

  // El coste solo se enseña si TODAS las líneas lo traen: un beneficio a medias
  // es un número que engaña, y aquí se toman decisiones de precio con él.
  const costeConocido = pedido.items.length > 0 && pedido.items.every((i) => i.costCents !== null);
  const costeTotal = costeConocido
    ? pedido.items.reduce((suma, i) => suma + (i.costCents ?? 0) * i.quantity, 0)
    : null;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: ESTILOS_IMPRESION }} />

      <div className="ped-noprint">
        <PageHeader
          title={`Pedido ${pedido.number}`}
          subtitle={`${fechaLarga.format(pedido.createdAt)} · ${metodo}`}
          actions={
            <>
              <button type="button" className="adm-btn adm-btn-primary adm-btn-md" data-imprimir="1">
                Imprimir albarán
              </button>
              <Button href="/admin/pedidos" variant="ghost">
                Volver a pedidos
              </Button>
            </>
          }
        />

        {aviso ? (
          <Card flush>
            <div className="adm-alerts">
              <div className="adm-alert">
                <span className="adm-alert-text">
                  <Badge tone={aviso.tone}>{aviso.label}</Badge>
                  {aviso.texto}
                </span>
              </div>
            </div>
          </Card>
        ) : null}

        <div className="adm-cols-2">
          {/* ── columna izquierda: qué se vendió ── */}
          <div>
            <Card title="Artículos" flush>
              <div className="ped-lineas">
                {pedido.items.map((item) => (
                  <div className="ped-linea" key={item.id}>
                    {/* <img> a pelo y no next/image: la foto puede venir congelada
                        de AliExpress y no queremos configurar dominios remotos
                        para una miniatura de 44 px del panel. */}
                    {item.imageUrl ? (
                      <img className="adm-thumb" src={item.imageUrl} alt="" />
                    ) : (
                      <span className="adm-thumb" aria-hidden="true" />
                    )}
                    <span className="ped-linea-txt">
                      {item.productId ? (
                        <Link className="adm-link" href={`/admin/productos/${item.productId}`}>
                          {item.title}
                        </Link>
                      ) : (
                        <b>{item.title}</b>
                      )}
                      <span className="adm-muted adm-small">
                        {[item.variantTitle, item.sku ? `SKU ${item.sku}` : ""].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </span>
                    <span className="ped-linea-cant adm-muted">
                      {item.quantity} × <Money cents={item.priceCents} tone="muted" />
                    </span>
                    <span className="ped-linea-total">
                      <Money cents={item.priceCents * item.quantity} tone="strong" />
                    </span>
                  </div>
                ))}
                {pedido.items.length === 0 ? (
                  <div className="ped-linea adm-muted">Este pedido no tiene líneas.</div>
                ) : null}
              </div>

              <div className="ped-totales">
                <div>
                  <span>Subtotal</span>
                  <Money cents={pedido.subtotalCents} />
                </div>
                {pedido.discountCents > 0 ? (
                  <div>
                    <span>Descuento</span>
                    <span>−{formatCents(pedido.discountCents)}</span>
                  </div>
                ) : null}
                <div>
                  <span>Envío</span>
                  {pedido.shippingCents > 0 ? <Money cents={pedido.shippingCents} /> : <span>Gratis</span>}
                </div>
                {pedido.taxCents > 0 ? (
                  <div>
                    <span>Impuestos</span>
                    <Money cents={pedido.taxCents} />
                  </div>
                ) : null}
                <div className="is-total">
                  <span>Total</span>
                  <Money cents={pedido.totalCents} tone="strong" />
                </div>
                {costeTotal !== null ? (
                  <div className="adm-small adm-muted">
                    <span>Coste del proveedor</span>
                    <span>
                      {formatCents(costeTotal)} · margen {formatCents(pedido.subtotalCents - costeTotal)}
                    </span>
                  </div>
                ) : null}
              </div>
            </Card>

            <Card title="Notas">
              {notaClienta ? (
                <>
                  <p className="adm-field-lbl">Nota de la clienta</p>
                  <p className="ped-nota">{notaClienta}</p>
                </>
              ) : (
                <p className="adm-muted adm-small">La clienta no dejó ninguna nota al comprar.</p>
              )}

              <form action={anadirNota} className="ped-form">
                <input type="hidden" name="id" value={pedido.id} />
                <Field
                  label="Nota interna"
                  htmlFor="nota-texto"
                  hint="Solo la ves tú. Queda fechada en la bitácora de abajo."
                >
                  <textarea id="nota-texto" name="texto" rows={2} placeholder="Pidió que se lo envolviera para regalo…" />
                </Field>
                <button type="submit" className="adm-btn adm-btn-ghost adm-btn-sm">
                  Añadir nota
                </button>
              </form>

              {bitacora.length > 0 ? (
                <>
                  <p className="adm-field-lbl" style={{ marginTop: 18 }}>
                    Bitácora
                  </p>
                  <ul className="ped-bitacora">
                    {bitacora.map((linea, i) => (
                      <li key={`${i}-${linea.slice(0, 12)}`}>{linea}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </Card>
          </div>

          {/* ── columna derecha: qué hay que hacer con él ── */}
          <div>
            <Card title="Estado">
              <div className="adm-row" style={{ marginBottom: 14 }}>
                <Badge tone={pago.tone}>{pago.label}</Badge>
                <Badge tone={envio.tone}>{envio.label}</Badge>
                <span className="adm-muted adm-small">{metodo}</span>
              </div>

              {pedido.paidAt ? (
                <p className="adm-muted adm-small">Cobrado el {fechaLarga.format(pedido.paidAt)}.</p>
              ) : null}

              {METODOS_ONLINE.includes(pedido.paymentMethod) && pedido.paymentRef ? (
                <p className="adm-muted adm-small">
                  Referencia de la pasarela: <code>{pedido.paymentRef}</code>
                </p>
              ) : null}

              {cancelado ? (
                <p className="adm-muted adm-small">
                  Pedido cancelado. No quedan acciones de cobro ni de envío; el inventario ya se devolvió.
                </p>
              ) : (
                <div className="ped-acciones">
                  {pedido.paymentStatus === "pending" && METODOS_ONLINE.includes(pedido.paymentMethod) ? (
                    // Pregunta a la pasarela por el cobro real: si la clienta pagó
                    // y cerró la pestaña antes de volver, esto lo pone al día.
                    <form action={verificarPagoAdmin}>
                      <input type="hidden" name="id" value={pedido.id} />
                      <button type="submit" className="adm-btn adm-btn-primary adm-btn-sm">
                        Verificar pago
                      </button>
                    </form>
                  ) : null}

                  {pedido.paymentStatus !== "paid" ? (
                    <form action={marcarPagado}>
                      <input type="hidden" name="id" value={pedido.id} />
                      <button type="submit" className="adm-btn adm-btn-primary adm-btn-sm">
                        Marcar pagado
                      </button>
                    </form>
                  ) : (
                    <form action={marcarPendiente}>
                      <input type="hidden" name="id" value={pedido.id} />
                      <button type="submit" className="adm-btn adm-btn-ghost adm-btn-sm">
                        Volver a por cobrar
                      </button>
                    </form>
                  )}

                  {pedido.paymentStatus === "paid" ? (
                    <form action={marcarReembolsado}>
                      <input type="hidden" name="id" value={pedido.id} />
                      <button
                        type="submit"
                        className="adm-btn adm-btn-ghost adm-btn-sm"
                        data-confirmar="¿Marcar este pedido como reembolsado? El dinero se devuelve por fuera, esto solo lo registra."
                      >
                        Marcar reembolsado
                      </button>
                    </form>
                  ) : null}

                  <form action={marcarCancelado}>
                    <input type="hidden" name="id" value={pedido.id} />
                    <button
                      type="submit"
                      className="adm-btn adm-btn-danger adm-btn-sm"
                      data-confirmar="¿Cancelar el pedido? Se devolverá al inventario el stock de las variantes con control de existencias."
                    >
                      Cancelar pedido
                    </button>
                  </form>
                </div>
              )}
            </Card>

            {!cancelado ? (
              <Card title="Envío">
                {pedido.fulfillStatus === "fulfilled" ? (
                  <p className="adm-small" style={{ marginBottom: 12 }}>
                    Enviado por <b>{pedido.trackingCarrier || "—"}</b> · seguimiento{" "}
                    <b>{pedido.trackingNumber || "—"}</b>.
                  </p>
                ) : null}

                <form action={marcarEnviado} className="ped-form">
                  <input type="hidden" name="id" value={pedido.id} />
                  <Field label="Transportista" htmlFor="transportista" required>
                    <input
                      type="text"
                      id="transportista"
                      name="transportista"
                      list="ped-transportistas"
                      defaultValue={pedido.trackingCarrier ?? ""}
                      placeholder="USPS"
                      autoComplete="off"
                    />
                  </Field>
                  <datalist id="ped-transportistas">
                    {TRANSPORTISTAS.map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                  <Field
                    label="Número de seguimiento"
                    htmlFor="seguimiento"
                    required
                    hint="Sin número no se marca enviado: la clienta se quedaría esperando."
                  >
                    <input
                      type="text"
                      id="seguimiento"
                      name="seguimiento"
                      defaultValue={pedido.trackingNumber ?? ""}
                      placeholder="9400 1000 0000 0000 0000 00"
                      autoComplete="off"
                    />
                  </Field>
                  <button type="submit" className="adm-btn adm-btn-primary adm-btn-sm">
                    {pedido.fulfillStatus === "fulfilled" ? "Actualizar seguimiento" : "Marcar enviado"}
                  </button>
                </form>
              </Card>
            ) : null}

            <Card title="Contacto">
              <p className="ped-dato">
                <b>{pedido.name || "Sin nombre"}</b>
                <a className="adm-link" href={`mailto:${pedido.email}`}>
                  {pedido.email}
                </a>
                {pedido.phone ? (
                  <a className="adm-link" href={`tel:${pedido.phone.replace(/[^\d+]/g, "")}`}>
                    {pedido.phone}
                  </a>
                ) : null}
              </p>

              <div className="adm-row" style={{ marginTop: 12 }}>
                {pedido.customer ? (
                  <Link className="adm-btn adm-btn-ghost adm-btn-sm" href={`/admin/clientes/${pedido.customer.id}`}>
                    Ver ficha de la clienta
                  </Link>
                ) : null}

                {/* Vía 'dm': el pedido se cerró por Instagram, así que el sitio
                    donde se sigue hablando con ella es el buzón, no el correo. */}
                {pedido.paymentMethod === "dm" ? (
                  <>
                    <a
                      className="adm-btn adm-btn-ghost adm-btn-sm"
                      href={handle ? `https://ig.me/m/${handle}` : "https://www.instagram.com/direct/inbox/"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {handle ? `Escribir a @${handle}` : "Abrir el buzón de Instagram"}
                    </a>
                    {!handle ? (
                      <span className="adm-muted adm-small">
                        No hay ningún @usuario guardado en este pedido, así que se abre el buzón.
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
            </Card>

            <Card
              title="Dirección de envío"
              actions={
                hayDireccion ? (
                  <button type="button" className="adm-btn adm-btn-ghost adm-btn-sm" data-copiar="ped-direccion">
                    Copiar
                  </button>
                ) : null
              }
            >
              {hayDireccion ? (
                <div className="ped-direccion" id="ped-direccion">
                  {direccion.map((linea, i) => (
                    <div key={`${i}-${linea}`}>{linea}</div>
                  ))}
                </div>
              ) : (
                <p className="adm-muted adm-small">
                  {pedido.paymentMethod === "pickup"
                    ? "Recogida en tienda: no hay dirección de envío."
                    : "Este pedido no trae dirección de envío."}
                </p>
              )}
            </Card>
          </div>
        </div>
      </div>

      {/* ─────────── albarán: invisible en pantalla, es lo único que se imprime ─────────── */}
      <div className="ped-albaran" aria-hidden="true">
        <div className="ped-alb-head">
          <div>
            <b>{settings.storeName}</b>
            <div>{settings.address}</div>
            {settings.instagram ? <div>@{settings.instagram}</div> : null}
            {settings.email ? <div>{settings.email}</div> : null}
          </div>
          <div className="ped-alb-num">
            <b>{pedido.number}</b>
            <div>{fechaCorta.format(pedido.createdAt)}</div>
            <div>{metodo}</div>
          </div>
        </div>

        <div className="ped-alb-cols">
          <div>
            <span className="ped-alb-lbl">Enviar a</span>
            {hayDireccion ? (
              direccion.map((linea, i) => <div key={`alb-${i}-${linea}`}>{linea}</div>)
            ) : (
              <div>Recogida en tienda</div>
            )}
          </div>
          <div>
            <span className="ped-alb-lbl">Contacto</span>
            <div>{pedido.name}</div>
            <div>{pedido.email}</div>
            {pedido.phone ? <div>{pedido.phone}</div> : null}
          </div>
        </div>

        <table className="ped-alb-tabla">
          <thead>
            <tr>
              <th>Artículo</th>
              <th>Cant.</th>
              <th>Precio</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {pedido.items.map((item) => (
              <tr key={`alb-${item.id}`}>
                <td>
                  {item.title}
                  {item.variantTitle ? <div className="ped-alb-var">{item.variantTitle}</div> : null}
                </td>
                <td>{item.quantity}</td>
                <td>{formatCents(item.priceCents)}</td>
                <td>{formatCents(item.priceCents * item.quantity)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Subtotal</td>
              <td>{formatCents(pedido.subtotalCents)}</td>
            </tr>
            {pedido.discountCents > 0 ? (
              <tr>
                <td colSpan={3}>Descuento</td>
                <td>−{formatCents(pedido.discountCents)}</td>
              </tr>
            ) : null}
            <tr>
              <td colSpan={3}>Envío</td>
              <td>{pedido.shippingCents > 0 ? formatCents(pedido.shippingCents) : "Gratis"}</td>
            </tr>
            {pedido.taxCents > 0 ? (
              <tr>
                <td colSpan={3}>Impuestos</td>
                <td>{formatCents(pedido.taxCents)}</td>
              </tr>
            ) : null}
            <tr className="ped-alb-total">
              <td colSpan={3}>Total</td>
              <td>{formatCents(pedido.totalCents)}</td>
            </tr>
          </tfoot>
        </table>

        {notaClienta ? (
          <p className="ped-alb-nota">
            <span className="ped-alb-lbl">Nota de la clienta</span>
            {notaClienta}
          </p>
        ) : null}

        <p className="ped-alb-pie">{settings.shippingNotice}</p>
      </div>

      {/*
        Interacciones mínimas (copiar, imprimir, confirmar) sin convertir la
        pantalla en cliente: un único listener delegado en document, que sobrevive
        a las navegaciones del App Router y no re-renderiza nada.
      */}
      <Script id="ped-ui" strategy="afterInteractive">
        {SCRIPT_UI}
      </Script>
    </>
  );
}

/* ─────────────────────────── estilos propios ─────────────────────────── */

// Van en la propia página en vez de en admin.css: ese fichero lo comparten
// todas las pantallas del panel y esto solo sirve aquí. No se toca [hidden]:
// el albarán se oculta por clase, nunca anulando esa regla.
const ESTILOS_IMPRESION = `
.ped-albaran { display: none; }

.ped-lineas { padding: 4px 0; }
.ped-linea {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 18px; border-bottom: 1px solid var(--adm-line-soft);
}
.ped-linea:last-child { border-bottom: 0; }
.ped-linea-txt { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; }
.ped-linea-cant { flex: 0 0 auto; font-size: 13px; }
.ped-linea-total { flex: 0 0 auto; min-width: 78px; text-align: right; }

.ped-totales { border-top: 1px solid var(--adm-line); padding: 12px 18px 4px; }
.ped-totales > div { display: flex; justify-content: space-between; gap: 16px; padding: 4px 0; }
.ped-totales > div.is-total {
  border-top: 1px solid var(--adm-line); margin-top: 6px; padding-top: 10px; font-size: 16px;
}

.ped-form { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
.ped-acciones { display: flex; flex-wrap: wrap; gap: 8px; }
.ped-acciones form { display: contents; }

.ped-dato { display: flex; flex-direction: column; gap: 3px; }
.ped-nota { white-space: pre-wrap; margin: 2px 0 0; }
.ped-direccion { line-height: 1.7; font-size: 15px; }
.ped-bitacora { list-style: none; padding: 0; margin: 6px 0 0; }
.ped-bitacora li {
  font-size: 12.5px; color: var(--adm-muted);
  padding: 5px 0; border-bottom: 1px solid var(--adm-line-soft);
}
.ped-bitacora li:last-child { border-bottom: 0; }

@media (max-width: 560px) {
  .ped-linea { flex-wrap: wrap; }
  .ped-linea-total { margin-left: auto; }
}

/* ── albarán ── */
@media print {
  @page { margin: 14mm; size: auto; }
  .ped-noprint, .adm-side, .adm-topbar, .adm-sheet, .adm-sheet-back { display: none !important; }
  .adm-shell { display: block !important; background: #fff; }
  .adm-main, .adm-content { display: block !important; padding: 0 !important; }
  .ped-albaran { display: block; color: #000; font-size: 11.5px; line-height: 1.45; }
  .ped-alb-head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 1.5px solid #000; padding-bottom: 8px; }
  .ped-alb-head b { font-size: 15px; }
  .ped-alb-num { text-align: right; }
  .ped-alb-num b { font-size: 17px; letter-spacing: 0.04em; }
  .ped-alb-cols { display: flex; gap: 32px; margin: 12px 0 14px; }
  .ped-alb-cols > div { flex: 1 1 0; }
  .ped-alb-lbl { display: block; font-size: 8.5px; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 3px; }
  .ped-alb-tabla { width: 100%; border-collapse: collapse; }
  .ped-alb-tabla th { text-align: left; font-size: 8.5px; letter-spacing: 0.16em; text-transform: uppercase; border-bottom: 1px solid #000; padding: 4px 6px 4px 0; }
  .ped-alb-tabla th:not(:first-child), .ped-alb-tabla td:not(:first-child) { text-align: right; width: 68px; }
  .ped-alb-tabla td { padding: 5px 6px 5px 0; border-bottom: 1px solid #ccc; vertical-align: top; }
  .ped-alb-tabla tfoot td { border-bottom: 0; padding: 2px 6px 2px 0; }
  .ped-alb-tabla tfoot tr.ped-alb-total td { border-top: 1px solid #000; font-weight: 700; padding-top: 6px; }
  .ped-alb-var { font-size: 10px; color: #444; }
  .ped-alb-nota { margin-top: 14px; white-space: pre-wrap; }
  .ped-alb-pie { margin-top: 18px; font-size: 10px; border-top: 1px solid #ccc; padding-top: 6px; }
}
`;

/* ──────────────────────────── script delegado ──────────────────────────── */

// Sin plantillas ni sustituciones: este texto viaja tal cual al navegador, así
// que aquí no puede haber sintaxis de TypeScript ni interpolaciones.
const SCRIPT_UI = `
(function () {
  if (window.__bloomPedidoUI) return;
  window.__bloomPedidoUI = true;

  document.addEventListener("click", function (ev) {
    var origen = ev.target;
    if (!origen || !origen.closest) return;

    var confirmar = origen.closest("[data-confirmar]");
    if (confirmar) {
      if (!window.confirm(confirmar.getAttribute("data-confirmar") || "¿Seguro?")) {
        ev.preventDefault();
        return;
      }
    }

    var imprimir = origen.closest("[data-imprimir]");
    if (imprimir) {
      ev.preventDefault();
      window.print();
      return;
    }

    var copiar = origen.closest("[data-copiar]");
    if (copiar) {
      ev.preventDefault();
      var caja = document.getElementById(copiar.getAttribute("data-copiar") || "");
      if (!caja) return;
      var texto = (caja.innerText || caja.textContent || "").trim();
      var avisar = function () {
        var previo = copiar.getAttribute("data-previo") || copiar.textContent;
        copiar.setAttribute("data-previo", previo);
        copiar.textContent = "Copiada";
        window.setTimeout(function () { copiar.textContent = previo; }, 1800);
      };
      var aMano = function () { window.prompt("Copia la dirección a mano:", texto); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto).then(avisar, aMano);
      } else {
        aMano();
      }
    }
  });
})();
`;
