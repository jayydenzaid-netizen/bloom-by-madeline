import type { Metadata } from "next";
import Link from "next/link";
import { getCart, readCartToken } from "@/lib/cart";
import { getSettings } from "@/lib/settings";
import CheckoutForm, { type CheckoutMethodOption } from "./CheckoutForm";
import "../checkout.css";

export const metadata: Metadata = {
  title: "Finalizar compra · Bloom by Madeline",
  description: "Datos de envío y forma de pago.",
  robots: { index: false, follow: false },
};

/**
 * Checkout.
 *
 * Aquí no se cobra: se registra el pedido. Los tres canales posibles salen de
 * Ajustes, así que Madeline enciende y apaga cada uno sin tocar código, y el que
 * no esté disponible se enseña apagado en vez de desaparecer — que la clienta vea
 * que la tarjeta llegará, sin creer que ya puede pagarla.
 */
export default async function CheckoutPage() {
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
            No hay nada que <em className="serif-it">confirmar</em>
          </h1>
          <p>Tu carrito está vacío, así que no hay pedido que registrar.</p>
          <Link className="btn btn-ink" href="/tienda">
            Ver la colección
          </Link>
        </div>
      </div>
    );
  }

  const methods: CheckoutMethodOption[] = [
    {
      id: "dm",
      label: "Pedir por Instagram DM",
      description:
        "Registramos tu pedido y te copiamos el resumen para que lo pegues en el chat. Madeline te confirma el pago por ahí.",
      enabled: settings.payDm,
    },
    {
      id: "pickup",
      label: "Recoger en la boutique",
      description: "Sin envío: lo preparamos y lo recoges en la tienda cuando te avisemos.",
      enabled: settings.payPickup,
    },
    {
      id: "stripe",
      label: "Pagar con tarjeta",
      description: settings.payStripe
        ? "Pago seguro con tarjeta."
        : "Todavía no está activo. En cuanto la pasarela esté lista podrás pagar aquí mismo.",
      enabled: settings.payStripe,
      badge: settings.payStripe ? undefined : "Próximamente",
    },
  ];

  const hayMetodo = methods.some((m) => m.enabled);

  return (
    <div className="shop-page section">
      <header className="cp-head">
        <p className="overline">Finalizar compra</p>
        <h1 className="cp-title">
          Casi <em className="serif-it">tuyo</em>
        </h1>
      </header>

      {hayMetodo ? (
        <CheckoutForm
          lines={cart.lines.map((l) => ({
            id: l.id,
            title: l.title,
            variantTitle: l.variantTitle,
            imageUrl: l.imageUrl,
            quantity: l.quantity,
            lineTotalCents: l.lineTotalCents,
          }))}
          subtotalCents={cart.subtotalCents}
          shippingCents={cart.shippingCents}
          freeShippingMissingCents={cart.freeShippingMissingCents}
          methods={methods}
          storeAddress={settings.address}
          storeHours={settings.hours}
          shippingNotice={settings.shippingNotice}
        />
      ) : (
        <p className="co-alert">
          Ahora mismo no hay ninguna forma de pago activa. Escríbenos por Instagram y
          cerramos tu pedido por ahí.
        </p>
      )}
    </div>
  );
}
