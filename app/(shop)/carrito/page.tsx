import type { Metadata } from "next";
import Link from "next/link";
import { getCart, readCartToken } from "@/lib/cart";
import { formatCents } from "@/lib/money";
import { buildDmSummary } from "@/lib/orders";
import { getSettings } from "@/lib/settings";
import { removeCartLine, updateCartLine } from "../cart-actions";
import { DmHandoff } from "../checkout/CheckoutForm";
import "../checkout.css";

export const metadata: Metadata = {
  title: "Tu carrito · Bloom by Madeline",
  description: "Revisa tus piezas antes de confirmar el pedido.",
};

/**
 * Carrito a página completa.
 *
 * El cajón del nav es para el vistazo rápido; esto es donde se revisa de verdad
 * antes de pagar, con fotos grandes y los totales desglosados.
 *
 * Los botones son formularios contra Server Actions en vez de un componente
 * cliente: así el carrito se puede editar aunque el JavaScript no haya cargado
 * (o falle), que es exactamente el momento en el que una compradora abandona.
 * Cada acción revalida el layout, así que el badge del nav y el cajón se enteran solos.
 */

async function subirUnidad(lineId: string, cantidad: number): Promise<void> {
  "use server";
  await updateCartLine(lineId, cantidad);
}

async function bajarUnidad(lineId: string, cantidad: number): Promise<void> {
  "use server";
  if (cantidad <= 0) {
    await removeCartLine(lineId);
    return;
  }
  await updateCartLine(lineId, cantidad);
}

async function quitarLinea(lineId: string): Promise<void> {
  "use server";
  await removeCartLine(lineId);
}

export default async function CarritoPage() {
  const token = await readCartToken();
  const [cart, settings] = await Promise.all([getCart(token), getSettings()]);

  if (cart.lines.length === 0) {
    return (
      <div className="shop-page section">
        <div className="cp-empty">
          <svg viewBox="0 0 120 104" aria-hidden="true">
            <use href="#lotus" />
          </svg>
          <h1 className="cp-title">
            Tu carrito aún está por <em className="serif-it">florecer</em>
          </h1>
          <p>Cuando encuentres tu pieza, aquí te esperará.</p>
          <Link className="btn btn-ink" href="/tienda">
            Ver la colección
          </Link>
        </div>
      </div>
    );
  }

  // Un carrito donde TODO se agotó no puede llevar al checkout: no hay nada
  // que comprar, solo líneas que quitar.
  const hayComprables = cart.lines.some((l) => !l.soldOut);
  const faltan = cart.freeShippingMissingCents;
  const progreso =
    faltan > 0 ? Math.round((cart.subtotalCents / (cart.subtotalCents + faltan)) * 100) : 100;

  // El resumen del DM se arma en el servidor: los importes salen de formatCents.
  const resumenDm = buildDmSummary({
    lines: cart.lines,
    subtotalCents: cart.subtotalCents,
    shippingCents: cart.shippingCents,
    totalCents: cart.totalCents,
  });

  return (
    <div className="shop-page section">
      <header className="cp-head">
        <p className="overline">Carrito</p>
        <h1 className="cp-title">
          Tus <em className="serif-it">piezas</em>
        </h1>
        <p className="cp-count">
          {cart.count === 1 ? "1 artículo" : `${cart.count} artículos`}
        </p>
      </header>

      <div className="cp-grid">
        <ul className="cp-lines">
          {cart.lines.map((line) => {
            const tope = line.available !== null && line.quantity >= line.available;
            // Se agotó mientras estaba aquí: se enseña apagada, con su botón de
            // quitar. Sin esto la línea desaparecía de la vista pero seguía en la
            // base, y el checkout rechazaba el pedido pidiendo «revisa tu
            // carrito» sin que hubiera nada visible que revisar: sin salida.
            if (line.soldOut) {
              return (
                <li className="cp-line cp-line-agotada" key={line.id}>
                  <Link className="cp-foto" href={`/producto/${line.slug}`}>
                    {line.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- las fotos viven en el CDN del proveedor
                      <img src={line.imageUrl} alt={line.title} />
                    ) : (
                      <span className="cd-noimg" aria-hidden="true" />
                    )}
                  </Link>
                  <div className="cp-info">
                    <h2>
                      <Link href={`/producto/${line.slug}`}>{line.title}</Link>
                    </h2>
                    {line.variantTitle ? <p className="ci-meta">{line.variantTitle}</p> : null}
                    <p className="cp-agotada-aviso">
                      Se agotó mientras lo tenías en el carrito. Quítalo para poder seguir con tu
                      compra.
                    </p>
                    <div className="cp-controls">
                      <form action={quitarLinea.bind(null, line.id)}>
                        <button className="cp-del" type="submit">
                          Quitar
                        </button>
                      </form>
                    </div>
                  </div>
                  <span className="cp-total">—</span>
                </li>
              );
            }
            return (
              <li className="cp-line" key={line.id}>
                <Link className="cp-foto" href={`/producto/${line.slug}`}>
                  {line.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- las fotos viven en el CDN del proveedor
                    <img src={line.imageUrl} alt={line.title} />
                  ) : (
                    <span className="cd-noimg" aria-hidden="true" />
                  )}
                </Link>

                <div className="cp-info">
                  <h2>
                    <Link href={`/producto/${line.slug}`}>{line.title}</Link>
                  </h2>
                  {line.variantTitle ? <p className="ci-meta">{line.variantTitle}</p> : null}
                  <p className="cp-unit">{formatCents(line.priceCents)} c/u</p>

                  <div className="cp-controls">
                    <div className="ci-qty">
                      <form action={bajarUnidad.bind(null, line.id, line.quantity - 1)}>
                        <button
                          type="submit"
                          aria-label={`Quitar una unidad de ${line.title}`}
                        >
                          −
                        </button>
                      </form>
                      <span>{line.quantity}</span>
                      <form action={subirUnidad.bind(null, line.id, line.quantity + 1)}>
                        <button
                          type="submit"
                          disabled={tope}
                          aria-label={`Añadir una unidad de ${line.title}`}
                        >
                          +
                        </button>
                      </form>
                    </div>

                    <form action={quitarLinea.bind(null, line.id)}>
                      <button className="cp-del" type="submit">
                        Eliminar
                      </button>
                    </form>
                  </div>

                  {tope ? (
                    <p className="cp-tope">
                      Es todo lo que queda de esta talla.
                    </p>
                  ) : null}
                </div>

                <span className="cp-total">{formatCents(line.lineTotalCents)}</span>
              </li>
            );
          })}
        </ul>

        <aside className="cp-resumen">
          <h2 className="co-h">
            Resumen del <em className="serif-it">pedido</em>
          </h2>

          {faltan > 0 ? (
            <div className="cd-ship">
              <p>
                Te faltan <strong>{formatCents(faltan)}</strong> para el envío gratis
              </p>
              <div className="cd-ship-bar">
                <span style={{ width: `${progreso}%` }} />
              </div>
            </div>
          ) : null}

          <div className="cd-row">
            <span>Subtotal</span>
            <span>{formatCents(cart.subtotalCents)}</span>
          </div>
          <div className="cd-row">
            <span>Envío</span>
            <span>{cart.shippingCents === 0 ? "Gratis" : formatCents(cart.shippingCents)}</span>
          </div>
          <div className="cart-total">
            <span>Total</span>
            <strong>{formatCents(cart.totalCents)}</strong>
          </div>

          {hayComprables ? (
            <Link className="btn btn-ink cp-cta" href="/checkout">
              Finalizar compra
            </Link>
          ) : (
            <p className="cp-agotada-aviso">
              Todo lo que queda en tu carrito se agotó. Quítalo y elige otra pieza para poder
              seguir.
            </p>
          )}
          {settings.payDm ? (
            <DmHandoff dmUrl={settings.instagramDm} summary={resumenDm} className="btn btn-ghost cp-cta" />
          ) : null}

          <Link className="cp-seguir" href="/tienda">
            ← Seguir viendo la colección
          </Link>

          {settings.shippingNotice ? (
            <p className="cart-note">{settings.shippingNotice}</p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
