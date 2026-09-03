import type { Metadata } from "next";
import Link from "next/link";
import { getCart, readCartToken } from "@/lib/cart";
import { leerConfigPagos, metodosOnlineActivos } from "@/lib/payments";
import { leerSalud } from "@/lib/payments/estado";
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
  // Con la salud delante: una pasarela que ya rechazo las llaves no se ofrece,
  // aunque siga encendida. Ofrecer una tarjeta que no cobra deja a la clienta
  // con el pedido hecho, su talla apartada y sin forma de pagar.
  const online = metodosOnlineActivos(configPagos, await leerSalud());

  // Las líneas agotadas siguen en el carrito para poder quitarlas (ver
  // lib/cart.ts), pero aquí no pintan nada: no se pueden comprar.
  const comprables = cart.lines.filter((l) => !l.soldOut);

  if (comprables.length === 0) {
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
  // Los métodos manuales apagados en el panel NO se enseñan: apagarlos es una
  // decisión ya tomada, y una tarjeta gris de «Instagram DM» solo estorba y
  // hace parecer artesanal una tienda que ya cobra con tarjeta. (La regla de
  // enseñar-apagado se queda para la tarjeta sin conectar, que sí promete algo
  // que viene: ver `metodosOnline`.)
  const metodosManuales: CheckoutMethodOption[] = [
    ...(settings.payDm
      ? [
          {
            id: "dm" as const,
            label: "Pedir por Instagram DM",
            description:
              "Registramos tu pedido y te copiamos el resumen para que lo pegues en el chat. Madeline te confirma el pago por ahí.",
            enabled: true,
          },
        ]
      : []),
    ...(settings.payPickup
      ? [
          {
            id: "pickup" as const,
            label: "Recoger en la boutique",
            description: "Sin envío: lo preparamos y lo recoges en la tienda cuando te avisemos.",
            enabled: true,
          },
        ]
      : []),
  ];
  // Con cobro online activo, la tarjeta va primero y es la opción por defecto:
  // el DM pasa a ser el plan B, no la caja principal.
  const methods: CheckoutMethodOption[] = hayOnline
    ? [...metodosOnline, ...metodosManuales]
    : [...metodosManuales, ...metodosOnline];

  const hayMetodo = methods.some((m) => m.enabled);
  /*
   * ¿Se puede comprar SIN venir a la boutique?
   *
   * «Recoger en la boutique» no es una forma de comprar para quien vive en otro
   * estado, y la portada promete envíos a todo el país. Si se apagan el DM y las
   * pasarelas, el checkout se queda solo con la recogida y una clienta de fuera
   * rellena su nombre y su correo para descubrir al final que no puede pedir.
   * Cuando pasa, se dice arriba y se le da una salida real.
   */
  const hayEnvio = methods.some((m) => m.enabled && m.id !== "pickup");

  return (
    <div className="shop-page section">
      <header className="cp-head">
        <p className="overline">Finalizar compra</p>
        <h1 className="cp-title">
          Casi <em className="serif-it">tuyo</em>
        </h1>
      </header>

      {hayMetodo && !hayEnvio ? (
        <p className="co-alert co-alert-envio">
          Ahora mismo solo se puede <strong>recoger en la boutique</strong> ({settings.address}).
          Si necesitas que te lo enviemos,{" "}
          <a href={settings.instagramDm} target="_blank" rel="noopener">
            escríbenos por Instagram
          </a>{" "}
          y lo cerramos por ahí.
        </p>
      ) : null}

      {hayMetodo ? (
        <CheckoutForm
          lines={comprables.map((l) => ({
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
