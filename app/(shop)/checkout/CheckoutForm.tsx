"use client";

import { useEffect, useState, useActionState } from "react";
import { formatCents } from "@/lib/money";
import { submitCheckout, type CheckoutField, type CheckoutState } from "./actions";

/**
 * Capa cliente del checkout.
 *
 * Necesita navegador por dos motivos reales: elegir método de pago cambia lo que se
 * pide (recoger en la boutique no lleva dirección ni envío) y los errores del
 * servidor se pintan junto a cada campo sin perder lo escrito.
 *
 * Exporta además `DmHandoff`, el botón que copia el resumen y abre el DM de
 * Instagram. Vive aquí porque es la otra pieza cliente de este flujo y la reutilizan
 * /carrito y /pedido/[number]; el texto del resumen siempre llega ya armado desde el
 * servidor (`buildDmSummary`) para que ningún importe se formatee en el navegador.
 */

export type CheckoutMethodId = "dm" | "pickup" | "stripe";

/**
 * Estado inicial de la acción. Vive aquí y no en actions.ts porque un fichero
 * "use server" solo puede exportar funciones asíncronas.
 */
const ESTADO_INICIAL: CheckoutState = {
  fieldErrors: {},
  values: {
    name: "",
    email: "",
    phone: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    zip: "",
    note: "",
    paymentMethod: "",
  },
};

export type CheckoutMethodOption = {
  id: CheckoutMethodId;
  label: string;
  description: string;
  /** false = se enseña apagada con su etiqueta, no se esconde. */
  enabled: boolean;
  badge?: string;
};

export type CheckoutSummaryLine = {
  id: string;
  title: string;
  variantTitle: string;
  imageUrl: string | null;
  quantity: number;
  lineTotalCents: number;
};

export type CheckoutFormProps = {
  lines: CheckoutSummaryLine[];
  subtotalCents: number;
  /** Envío calculado por el servidor para envío a domicilio. En recogida es 0. */
  shippingCents: number;
  freeShippingMissingCents: number;
  methods: CheckoutMethodOption[];
  /** Dirección y horario de la boutique, de Ajustes: aquí no se inventa nada. */
  storeAddress: string;
  storeHours: string;
  shippingNotice: string;
};

export default function CheckoutForm({
  lines,
  subtotalCents,
  shippingCents,
  freeShippingMissingCents,
  methods,
  storeAddress,
  storeHours,
  shippingNotice,
}: CheckoutFormProps) {
  const [state, formAction, pending] = useActionState<CheckoutState, FormData>(
    submitCheckout,
    ESTADO_INICIAL,
  );

  const primerDisponible = methods.find((m) => m.enabled)?.id ?? "dm";
  const [metodo, setMetodo] = useState<CheckoutMethodId>(primerDisponible);
  const [campos, setCampos] = useState<Record<CheckoutField, string>>(ESTADO_INICIAL.values);

  /* Si el servidor rechaza algo, devuelve lo escrito y se vuelve a poner: React 19
     resetea los formularios al terminar una acción y sin esto ella tendría que
     teclear su dirección otra vez. */
  useEffect(() => {
    const devueltos = state.values;
    setCampos((previos) => {
      const fusion = { ...previos };
      let cambio = false;
      for (const clave of Object.keys(devueltos) as CheckoutField[]) {
        if (devueltos[clave] && devueltos[clave] !== previos[clave]) {
          fusion[clave] = devueltos[clave];
          cambio = true;
        }
      }
      return cambio ? fusion : previos;
    });
    if (devueltos.paymentMethod === "dm" || devueltos.paymentMethod === "pickup") {
      setMetodo(devueltos.paymentMethod);
    }
  }, [state]);

  const set = (campo: CheckoutField) => (ev: { target: { value: string } }) =>
    setCampos((prev) => ({ ...prev, [campo]: ev.target.value }));

  const recogida = metodo === "pickup";
  const envio = recogida ? 0 : shippingCents;
  const total = subtotalCents + envio;
  const faltaEnvioGratis = !recogida && freeShippingMissingCents > 0;

  const err = (campo: CheckoutField) => state.fieldErrors[campo];

  return (
    <div className="co-grid">
      <form className="co-form" action={formAction} noValidate>
        {state.formError ? (
          <p className="co-alert" role="alert">
            {state.formError}
          </p>
        ) : null}

        <section className="co-block">
          <h2 className="co-h">
            Tus <em className="serif-it">datos</em>
          </h2>

          <Campo
            campo="name"
            label="Nombre completo"
            autoComplete="name"
            value={campos.name}
            onChange={set("name")}
            error={err("name")}
          />
          <div className="co-row">
            <Campo
              campo="email"
              label="Correo electrónico"
              type="email"
              autoComplete="email"
              value={campos.email}
              onChange={set("email")}
              error={err("email")}
              hint="Ahí te mandamos la confirmación."
            />
            <Campo
              campo="phone"
              label="Teléfono (opcional)"
              type="tel"
              autoComplete="tel"
              value={campos.phone}
              onChange={set("phone")}
              error={err("phone")}
            />
          </div>
        </section>

        <section className="co-block">
          <h2 className="co-h">
            Cómo quieres <em className="serif-it">pagar</em>
          </h2>

          <div className="co-methods">
            {methods.map((m) => (
              <label
                key={m.id}
                className={
                  m.enabled
                    ? metodo === m.id
                      ? "co-method sel"
                      : "co-method"
                    : "co-method co-method-off"
                }
              >
                <input
                  type="radio"
                  name="paymentMethod"
                  value={m.id}
                  checked={metodo === m.id}
                  disabled={!m.enabled}
                  onChange={() => setMetodo(m.id)}
                />
                <span className="co-method-body">
                  <strong>
                    {m.label}
                    {m.badge ? <em className="co-badge">{m.badge}</em> : null}
                  </strong>
                  <span>{m.description}</span>
                </span>
              </label>
            ))}
          </div>
          {err("paymentMethod") ? <p className="co-err">{err("paymentMethod")}</p> : null}

          {recogida ? (
            <div className="co-pickup">
              <p className="co-pickup-line">{storeAddress}</p>
              <p className="co-pickup-line">{storeHours}</p>
              <p className="co-note">
                Te avisamos por correo cuando tu pedido esté listo para recoger.
              </p>
            </div>
          ) : null}
        </section>

        {/* En recogida no se pide dirección: sería fricción por gusto y un dato que
            nadie va a usar. Los campos se desmontan para que no viajen vacíos. */}
        {!recogida ? (
          <section className="co-block">
            <h2 className="co-h">
              Dirección de <em className="serif-it">envío</em>
            </h2>

            <Campo
              campo="line1"
              label="Dirección"
              autoComplete="address-line1"
              value={campos.line1}
              onChange={set("line1")}
              error={err("line1")}
            />
            <Campo
              campo="line2"
              label="Apartamento, suite (opcional)"
              autoComplete="address-line2"
              value={campos.line2}
              onChange={set("line2")}
              error={err("line2")}
            />
            <div className="co-row co-row-3">
              <Campo
                campo="city"
                label="Ciudad"
                autoComplete="address-level2"
                value={campos.city}
                onChange={set("city")}
                error={err("city")}
              />
              <Campo
                campo="state"
                label="Estado"
                autoComplete="address-level1"
                value={campos.state}
                onChange={set("state")}
                error={err("state")}
              />
              <Campo
                campo="zip"
                label="ZIP"
                inputMode="numeric"
                autoComplete="postal-code"
                value={campos.zip}
                onChange={set("zip")}
                error={err("zip")}
              />
            </div>
          </section>
        ) : null}

        <section className="co-block">
          <label className="co-field">
            <span className="co-label">Nota para Madeline (opcional)</span>
            <textarea
              name="note"
              rows={3}
              maxLength={500}
              value={campos.note}
              onChange={set("note")}
            />
          </label>
        </section>

        <button className="btn btn-ink co-submit" type="submit" disabled={pending}>
          {pending ? "Registrando tu pedido…" : "Confirmar pedido"}
        </button>

        <p className="co-note co-legal">
          Al confirmar se crea tu pedido como <strong>pendiente de pago</strong>. Nadie te
          cobra nada en este paso.
        </p>
      </form>

      <aside className="co-summary">
        <h2 className="co-h">
          Tu <em className="serif-it">pedido</em>
        </h2>

        <ul className="co-lines">
          {lines.map((l) => (
            <li key={l.id}>
              {l.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- las fotos viven en el CDN del proveedor
                <img src={l.imageUrl} alt={l.title} />
              ) : (
                <span className="cd-noimg" aria-hidden="true" />
              )}
              <span className="co-line-info">
                <strong>{l.title}</strong>
                <em>
                  {l.variantTitle ? `${l.variantTitle} · ` : ""}
                  {l.quantity} ud.
                </em>
              </span>
              <span className="co-line-price">{formatCents(l.lineTotalCents)}</span>
            </li>
          ))}
        </ul>

        <div className="cd-row">
          <span>Subtotal</span>
          <span>{formatCents(subtotalCents)}</span>
        </div>
        <div className="cd-row">
          <span>{recogida ? "Recogida en boutique" : "Envío"}</span>
          <span>{envio === 0 ? "Gratis" : formatCents(envio)}</span>
        </div>
        {faltaEnvioGratis ? (
          <p className="co-note">
            Te faltan <strong>{formatCents(freeShippingMissingCents)}</strong> para el envío
            gratis.
          </p>
        ) : null}

        <div className="cart-total">
          <span>Total</span>
          <strong>{formatCents(total)}</strong>
        </div>

        {!recogida && shippingNotice ? <p className="co-note">{shippingNotice}</p> : null}
      </aside>
    </div>
  );
}

/* ═══════════ campo de formulario ═══════════ */

function Campo({
  campo,
  label,
  value,
  onChange,
  error,
  hint,
  type = "text",
  autoComplete,
  inputMode,
}: {
  campo: CheckoutField;
  label: string;
  value: string;
  onChange: (ev: { target: { value: string } }) => void;
  error?: string;
  hint?: string;
  type?: string;
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "tel" | "email";
}) {
  const errorId = error ? `${campo}-error` : undefined;

  return (
    <label className={error ? "co-field co-field-bad" : "co-field"}>
      <span className="co-label">{label}</span>
      <input
        name={campo}
        type={type}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
      />
      {error ? (
        <em className="co-err" id={errorId}>
          {error}
        </em>
      ) : null}
      {!error && hint ? <em className="co-hint">{hint}</em> : null}
    </label>
  );
}

/* ═══════════ entrega por Instagram DM ═══════════ */

/**
 * Copia el resumen al portapapeles y abre el chat de Instagram.
 *
 * Va con un clic de la usuaria a propósito: `navigator.clipboard.writeText` y
 * `window.open` necesitan un gesto reciente, y hacerlo automáticamente tras una
 * navegación acaba en portapapeles vacío y ventana bloqueada.
 */
export function DmHandoff({
  dmUrl,
  summary,
  label = "Pedir por DM",
  className = "btn btn-ghost",
}: {
  dmUrl: string;
  summary: string;
  label?: string;
  className?: string;
}) {
  const [copiado, setCopiado] = useState(false);

  const enviar = () => {
    try {
      navigator.clipboard?.writeText(summary).catch(() => undefined);
    } catch {
      /* sin portapapeles se abre el DM igual y ella escribe el pedido a mano */
    }
    setCopiado(true);
    window.open(dmUrl, "_blank", "noopener");
  };

  return (
    <>
      <button className={className} type="button" onClick={enviar}>
        {label}
      </button>
      {copiado ? (
        <p className="cart-hint">✓ Resumen copiado — pégalo en el chat de Instagram</p>
      ) : null}
    </>
  );
}
