import type { Metadata } from "next";
import Link from "next/link";
import { getCart, readCartToken } from "@/lib/cart";
import { leerConfigPagos, metodosOnlineActivos } from "@/lib/payments";
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
  const [cart, settings, configPagos] = await Promise.all([
    getCart(token),
    getSettings(),
    leerConfigPagos(),
  ]);
  // Al formulario solo viajan booleanos: las credenciales se quedan en el servidor.
  const online = metodosOnlineActivos(configPagos);

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

  // Con algún cobro online activo se enseñan SOLO los métodos que cobran de
  // verdad; sin ninguno, una única tarjeta apagada con «Próximamente» — la
  // regla de la casa de enseñar lo que viene, sin llenar la caja de grises que
  // se contradigan («Próximamente» al lado de otra tarjeta que ya funciona).
  const hayOnline = online.stripe || online.paypal || online.square;
  const metodosOnline: CheckoutMethodOption[] = hayOnline
    ? [
        ...(online.stripe
          ? [
              {
                id: "stripe" as const,
                label: "Pagar con tarjeta",
                description:
                  "Pago seguro con tarjeta en la página de Stripe. Te devolvemos aquí al terminar.",
                enabled: true,
              },
            ]
          : []),
        ...(online.paypal
          ? [
              {
                id: "paypal" as const,
                label: "PayPal",
                description: "Paga con tu cuenta de PayPal o con tarjeta, en su página segura.",
                enabled: true,
              },
            ]
          : []),
        ...(online.square
          ? [
              {
                id: "square" as const,
                label: online.stripe ? "Pagar con tarjeta (Square)" : "Pagar con tarjeta",
                description:
                  "Pago seguro con tarjeta en la página de Square. Te devolvemos aquí al terminar.",
                enabled: true,
              },
            ]
          : []),
      ]
    : [
        {
          id: "stripe" as const,
          label: "Pagar con tarjeta",
          description:
            "Todavía no está activo. En cuanto la pasarela esté lista podrás pagar aquí mismo.",
          enabled: false,
          badge: "Próximamente",
        },
      ];
  const metodosManuales: CheckoutMethodOption[] = [
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
  ];
  // Con cobro online activo, la tarjeta va primero y es la opción por defecto:
  // el DM pasa a ser el plan B, no la caja principal.
  const methods: CheckoutMethodOption[] = hayOnline
    ? [...metodosOnline, ...metodosManuales]
    : [...metodosManuales, ...metodosOnline];

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
