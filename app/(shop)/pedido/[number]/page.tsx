import type { Metadata } from "next";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import {
  buildDmSummary,
  canViewOrder,
  fulfillStatusLabel,
  getOrderByNumber,
  normalizeOrderNumber,
  paymentMethodLabel,
  paymentStatusLabel,
  trackingUrl,
} from "@/lib/orders";
import { getSettings } from "@/lib/settings";
import { verifyOrderAccess } from "../../checkout/actions";
import { DmHandoff } from "../../checkout/CheckoutForm";
import "../../checkout.css";

/**
 * Confirmación y seguimiento de un pedido.
 *
 * PRIVACIDAD — por qué esta página "pública" pide llave:
 *
 * `Order.number` es correlativo (BLM-1001, BLM-1002…), o sea que se adivina contando.
 * Sin más control, cualquiera podría recorrer los números y leer el nombre, el
 * teléfono y la dirección de todas las clientas de Madeline. El esquema no se puede
 * tocar para meter un token aleatorio, así que la llave se genera aparte: al confirmar
 * el pedido se firma su número con HMAC y la firma va en una cookie httpOnly
 * (ver `lib/orders.ts`). Quien acaba de comprar entra directo; quien llegue por un
 * enlace tiene que escribir el email del pedido para desbloquearlo.
 *
 * El formulario responde igual si el pedido no existe que si el email no coincide,
 * para que tampoco sirva para averiguar qué números existen. Y el email nunca viaja
 * en la URL: se manda por POST y solo vuelve una bandera `?acceso=fallo`.
 */

export const metadata: Metadata = {
  title: "Tu pedido · Bloom by Madeline",
  // Un pedido no se indexa jamás: son datos de una persona, no escaparate.
  robots: { index: false, follow: false, nocache: true },
};

export default async function PedidoPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<{ acceso?: string }>;
}) {
  const { number: raw } = await params;
  const { acceso } = await searchParams;
  const number = normalizeOrderNumber(decodeURIComponent(raw));

  const permitido = await canViewOrder(number);
  if (!permitido) {
    return <Candado number={number} fallo={acceso === "fallo"} />;
  }

  const [order, settings] = await Promise.all([getOrderByNumber(number), getSettings()]);
  if (!order) {
    return (
      <div className="shop-page section">
        <div className="cp-empty">
          <h1 className="cp-title">
            No encontramos ese <em className="serif-it">pedido</em>
          </h1>
          <p>El número {number} ya no existe. Escríbenos por Instagram y lo miramos.</p>
          <Link className="btn btn-ink" href="/tienda">
            Volver a la tienda
          </Link>
        </div>
      </div>
    );
  }

  const esDm = order.paymentMethod === "dm";
  const esRecogida = order.paymentMethod === "pickup";
  const pendiente = order.paymentStatus === "pending";
  const rastreo = trackingUrl(order.trackingCarrier, order.trackingNumber);

  const resumenDm = buildDmSummary({
    lines: order.items.map((i) => ({
      title: i.title,
      variantTitle: i.variantTitle,
      quantity: i.quantity,
      lineTotalCents: i.priceCents * i.quantity,
    })),
    subtotalCents: order.subtotalCents,
    shippingCents: order.shippingCents,
    discountCents: order.discountCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    orderNumber: order.number,
  });

  return (
    <div className="shop-page section">
      <header className="op-head">
        <svg className="op-lotus" viewBox="0 0 120 104" aria-hidden="true">
          <use href="#lotus" />
        </svg>
        <p className="overline">Pedido {order.number}</p>
        <h1 className="cp-title">
          Gracias, <em className="serif-it">{primerNombre(order.name)}</em>
        </h1>
        <p className="op-sub">
          Guarda este número: <strong>{order.number}</strong>. Te mandamos la confirmación a{" "}
          {order.email}.
        </p>
      </header>

      <div className="op-grid">
        <section className="op-main">
          {/* Qué pasa ahora — lo primero que ella necesita saber, no los totales. */}
          <div className="op-next">
            <h2 className="co-h">
              Qué pasa <em className="serif-it">ahora</em>
            </h2>

            {esDm && pendiente ? (
              <>
                <p>
                  Tu pedido está <strong>apartado pero sin confirmar</strong>. Para cerrarlo,
                  mándale el resumen a Madeline por Instagram: el botón lo copia y abre el
                  chat. Ella te dice cómo pagar y cuándo sale.
                </p>
                <DmHandoff
                  dmUrl={settings.instagramDm}
                  summary={resumenDm}
                  label="Copiar resumen y abrir Instagram"
                  className="btn btn-ink op-cta"
                />
              </>
            ) : null}

            {esRecogida ? (
              <p>
                Lo preparamos y te avisamos por correo cuando esté listo. Se recoge en{" "}
                <strong>{settings.address}</strong>
                {settings.hours ? ` · ${settings.hours}` : ""}.
              </p>
            ) : null}

            {!esDm && !esRecogida ? (
              <p>
                Estamos procesando tu pedido. Te escribimos a {order.email} en cuanto haya
                novedades.
              </p>
            ) : null}

            {!esRecogida && settings.shippingNotice ? (
              <p className="co-note">{settings.shippingNotice}</p>
            ) : null}

            {order.trackingNumber ? (
              <p className="op-track">
                Seguimiento:{" "}
                {rastreo ? (
                  <a href={rastreo} target="_blank" rel="noopener">
                    {order.trackingNumber}
                  </a>
                ) : (
                  <strong>{order.trackingNumber}</strong>
                )}
                {order.trackingCarrier ? ` · ${order.trackingCarrier}` : ""}
              </p>
            ) : null}
          </div>

          <div className="op-estados">
            <div>
              <span className="op-estado-k">Pago</span>
              <span className="op-estado-v">{paymentStatusLabel(order.paymentStatus)}</span>
              <span className="op-estado-m">{paymentMethodLabel(order.paymentMethod)}</span>
            </div>
            <div>
              <span className="op-estado-k">Envío</span>
              <span className="op-estado-v">{fulfillStatusLabel(order.fulfillStatus)}</span>
              <span className="op-estado-m">
                {esRecogida ? "Recogida en boutique" : "A domicilio"}
              </span>
            </div>
          </div>

          <div className="op-dir">
            <h2 className="co-h">
              {esRecogida ? (
                <>
                  Dónde <em className="serif-it">recogerlo</em>
                </>
              ) : (
                <>
                  Dirección de <em className="serif-it">envío</em>
                </>
              )}
            </h2>
            {esRecogida ? (
              <address>
                {settings.address}
                {settings.hours ? (
                  <>
                    <br />
                    {settings.hours}
                  </>
                ) : null}
              </address>
            ) : (
              <address>
                {order.shipName || order.name}
                <br />
                {order.shipLine1}
                {order.shipLine2 ? (
                  <>
                    <br />
                    {order.shipLine2}
                  </>
                ) : null}
                <br />
                {order.shipCity}, {order.shipState} {order.shipZip}
                <br />
                {order.shipCountry}
              </address>
            )}
            {order.note ? <p className="co-note">Tu nota: {order.note}</p> : null}
          </div>
        </section>

        <aside className="op-resumen">
          <h2 className="co-h">
            Tu <em className="serif-it">pedido</em>
          </h2>

          <ul className="co-lines">
            {order.items.map((item) => (
              <li key={item.id}>
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- la foto se congeló al comprar
                  <img src={item.imageUrl} alt={item.title} />
                ) : (
                  <span className="cd-noimg" aria-hidden="true" />
                )}
                <span className="co-line-info">
                  <strong>{item.title}</strong>
                  <em>
                    {item.variantTitle ? `${item.variantTitle} · ` : ""}
                    {item.quantity} ud.
                  </em>
                </span>
                <span className="co-line-price">
                  {formatCents(item.priceCents * item.quantity)}
                </span>
              </li>
            ))}
          </ul>

          <div className="cd-row">
            <span>Subtotal</span>
            <span>{formatCents(order.subtotalCents)}</span>
          </div>
          {order.discountCents > 0 ? (
            <div className="cd-row">
              <span>Descuento</span>
              <span>−{formatCents(order.discountCents)}</span>
            </div>
          ) : null}
          <div className="cd-row">
            <span>{esRecogida ? "Recogida en boutique" : "Envío"}</span>
            <span>
              {order.shippingCents === 0 ? "Gratis" : formatCents(order.shippingCents)}
            </span>
          </div>
          {order.taxCents > 0 ? (
            <div className="cd-row">
              <span>Impuesto</span>
              <span>{formatCents(order.taxCents)}</span>
            </div>
          ) : null}
          <div className="cart-total">
            <span>Total</span>
            <strong>{formatCents(order.totalCents)}</strong>
          </div>

          <Link className="cp-seguir" href="/tienda">
            ← Seguir viendo la colección
          </Link>
        </aside>
      </div>
    </div>
  );
}

/** Solo el nombre de pila: "Gracias, María" se lee mejor que el nombre legal entero. */
function primerNombre(nombre: string): string {
  const trozo = nombre.trim().split(/\s+/)[0];
  return trozo || "gracias por tu compra";
}

/**
 * Puerta de acceso. No enseña ni un dato del pedido: solo el número que ya venía en
 * la URL y un campo para demostrar que es suyo.
 */
function Candado({ number, fallo }: { number: string; fallo: boolean }) {
  return (
    <div className="shop-page section">
      <div className="op-candado">
        <svg className="op-lotus" viewBox="0 0 120 104" aria-hidden="true">
          <use href="#lotus" />
        </svg>
        <p className="overline">Pedido {number}</p>
        <h1 className="cp-title">
          Confirma que es <em className="serif-it">tuyo</em>
        </h1>
        <p>
          Los pedidos llevan datos personales, así que solo se abren con el correo con el
          que se hizo la compra.
        </p>

        <form className="op-form" action={verifyOrderAccess}>
          <input type="hidden" name="number" value={number} />
          <label className="co-field">
            <span className="co-label">Correo del pedido</span>
            <input type="email" name="email" autoComplete="email" required />
          </label>
          {fallo ? (
            <p className="co-alert" role="alert">
              No pudimos abrir ese pedido con ese correo. Revísalo o escríbenos por
              Instagram.
            </p>
          ) : null}
          <button className="btn btn-ink" type="submit">
            Ver mi pedido
          </button>
        </form>
      </div>
    </div>
  );
}
