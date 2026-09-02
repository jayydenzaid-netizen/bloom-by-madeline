import {
  leerConfigPagosConMeta,
  metodosOnlineActivos,
  paypalConfigurado,
  squareConfigurado,
  stripeConfigurado,
} from "@/lib/payments/config";
import { requireOwner } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";
import { Badge, Card, Field, PageHeader } from "../_components/ui";
import {
  guardarManuales,
  guardarPaypal,
  guardarSquare,
  guardarStripe,
  probarConexion,
  quitarProveedor,
} from "./actions";
import "./pagos.css";

/**
 * Pagos: aquí Madeline conecta SUS cuentas de Stripe, PayPal y Square pegando
 * las credenciales de cada una. En cuanto un método queda activo, el checkout
 * lo ofrece y el dinero va directo a su cuenta — la tienda deja de depender del
 * DM de Instagram para cobrar.
 *
 * Las llaves se guardan cifradas en la base de datos (lib/payments) y aquí solo
 * se enseña el final de cada una: esta pantalla se abre en la boutique con
 * gente delante.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Pagos" };

/** Los mensajes viven aquí, no en la URL: nadie fabrica un cartel con un enlace. */
const HECHOS: Record<string, string> = {
  "stripe-activo": "Stripe guardado y ACTIVO: el checkout ya ofrece pagar con tarjeta.",
  "stripe-guardado": "Stripe guardado. Actívalo cuando quieras ofrecerlo en el checkout.",
  "stripe-conexion": "Conexión con Stripe verificada: la llave funciona.",
  "paypal-activo": "PayPal guardado y ACTIVO: el checkout ya lo ofrece.",
  "paypal-guardado": "PayPal guardado. Actívalo cuando quieras ofrecerlo en el checkout.",
  "paypal-conexion": "Conexión con PayPal verificada: las credenciales funcionan.",
  "square-activo": "Square guardado y ACTIVO: el checkout ya lo ofrece.",
  "square-guardado": "Square guardado. Actívalo cuando quieras ofrecerlo en el checkout.",
  "square-conexion": "Conexión con Square verificada: el token funciona.",
  "square-local": "Conexión con Square verificada. Tu cuenta tiene un solo local, así que el Location ID se rellenó solo.",
  "stripe-quitado": "Llaves de Stripe quitadas. El método desapareció del checkout.",
  "paypal-quitado": "Llaves de PayPal quitadas. El método desapareció del checkout.",
  "square-quitado": "Llaves de Square quitadas. El método desapareció del checkout.",
  manuales: "Métodos sin pasarela guardados.",
};

const ERRORES: Record<string, string> = {
  "stripe-clave":
    "Esa no parece la llave SECRETA de Stripe (empieza por sk_ o rk_). La que empieza por pk_ es la publicable y no puede cobrar.",
  "stripe-sin-llave": "Para activar Stripe primero pega su llave secreta.",
  "stripe-fallo": "Stripe rechazó la llave. Revisa que sea la secreta y que esté completa.",
  "paypal-sin-llaves": "Para activar PayPal hacen falta el Client ID y el Secret.",
  "paypal-fallo": "PayPal rechazó las credenciales. Revisa Client ID, Secret y el entorno (real o pruebas).",
  "square-sin-llaves": "Para activar Square hacen falta el token de acceso y el Location ID.",
  "square-fallo": "Square rechazó el token. Revisa que sea de producción (o cambia el entorno a pruebas).",
  "sin-metodos":
    "No puedes apagar el DM y la recogida sin tener una pasarela activa: nadie podría terminar una compra.",
  // Se intentó ENCENDER un cobro que la pasarela rechaza. Se guarda apagado a
  // propósito: ofrecer una tarjeta que no cobra deja a la clienta con el pedido
  // hecho, su talla apartada y sin forma de pagar.
  "stripe-fallo-activar":
    "Stripe rechazó esa llave, así que NO se activó el cobro con tarjeta (se guardó apagado). Comprueba que sea la clave secreta correcta y vuelve a intentarlo.",
  "paypal-fallo-activar":
    "PayPal rechazó esas credenciales, así que NO se activó (se guardó apagado). Revisa el Client ID, el Secret y si son de «Real» o de «Pruebas».",
  "square-fallo-activar":
    "Square rechazó ese token, así que NO se activó el cobro con tarjeta (se guardó apagado). Lo más común: el token es de «Sandbox» y el entorno está en «Real» (o al revés). Revísalo y vuelve a intentarlo.",
  desconocido: "No se pudo aplicar el cambio. Inténtalo otra vez.",
};

/** Cómo se enseña una credencial guardada: solo su final, nunca entera. */
function final(valor: string): string {
  if (!valor) return "";
  return `····${valor.slice(-4)}`;
}

const fecha = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

function EstadoProveedor({
  activo,
  configurado,
  guardadoEl,
}: {
  activo: boolean;
  configurado: boolean;
  guardadoEl: Date | null;
}) {
  return (
    <div className="pag-estado">
      {activo && configurado ? (
        <Badge tone="success">Activo en el checkout</Badge>
      ) : configurado ? (
        <Badge tone="warning">Guardado, sin activar</Badge>
      ) : (
        <Badge tone="neutral">Sin conectar</Badge>
      )}
      {guardadoEl ? (
        <span className="adm-muted adm-small">Guardado el {fecha.format(guardadoEl)}</span>
      ) : null}
    </div>
  );
}

export default async function PagosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwner("pagos");

  const sp = await searchParams;
  const uno = (k: string) => ((Array.isArray(sp[k]) ? sp[k]?.[0] : sp[k]) ?? "").trim();
  const hecho = HECHOS[uno("hecho")];
  const error = ERRORES[uno("error")];

  const [{ config, actualizado }, settings] = await Promise.all([
    leerConfigPagosConMeta(),
    getSettings(),
  ]);
  const online = metodosOnlineActivos(config);
  const activos = [online.stripe, online.paypal, online.square].filter(Boolean).length;
  // «Probar conexión» se habilita con el MISMO criterio que usa la action: si
  // el botón se enciende con menos, el clic acaba en un error confuso.
  const listo = {
    stripe: stripeConfigurado(config.stripe),
    paypal: paypalConfigurado(config.paypal),
    square: config.square.accessToken.length >= 10,
  };

  return (
    <>
      <PageHeader
        title="Pagos"
        subtitle={
          activos > 0
            ? `${activos} ${activos === 1 ? "pasarela activa" : "pasarelas activas"} — el checkout cobra online`
            : "Conecta tu cuenta de Stripe, PayPal o Square para cobrar online"
        }
      />

      {hecho ? (
        <p className="pag-aviso is-ok" role="status">
          {hecho}
        </p>
      ) : null}
      {error ? (
        <p className="pag-aviso is-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="pag-grid">
        {/* ─────────────────────────── Stripe ─────────────────────────── */}
        <Card title="Tarjeta · Stripe">
          <EstadoProveedor
            activo={config.stripe.activo}
            configurado={config.stripe.secretKey.length > 0}
            guardadoEl={actualizado.stripe}
          />
          <form action={guardarStripe}>
            <div className="pag-cols">
              <Field
                label="Llave secreta"
                htmlFor="stripe-key"
                hint={
                  config.stripe.secretKey
                    ? `Guardada (${final(config.stripe.secretKey)}). Déjalo vacío para conservarla.`
                    : "En dashboard.stripe.com → Desarrolladores → Claves de API → «Clave secreta» (empieza por sk_live_)."
                }
              >
                <input
                  type="password"
                  id="stripe-key"
                  name="secretKey"
                  autoComplete="off"
                  placeholder={config.stripe.secretKey ? final(config.stripe.secretKey) : "sk_live_…"}
                />
              </Field>
              <label className="pag-check">
                <input type="checkbox" name="activo" defaultChecked={config.stripe.activo} />
                <span>
                  Ofrecer en el checkout
                  <span className="adm-muted adm-small">
                    La clienta paga con tarjeta en la página segura de Stripe y el dinero entra en tu cuenta.
                  </span>
                </span>
              </label>
            </div>
            <div className="pag-acciones">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Guardar Stripe
              </button>
            </div>
          </form>
          <div className="pag-acciones">
            <form action={probarConexion}>
              <input type="hidden" name="proveedor" value="stripe" />
              <button type="submit" className="adm-btn adm-btn-ghost adm-btn-sm" disabled={!listo.stripe}>
                Probar conexión
              </button>
            </form>
            <form action={quitarProveedor}>
              <input type="hidden" name="proveedor" value="stripe" />
              <button type="submit" className="adm-btn adm-btn-ghost adm-btn-sm" disabled={!config.stripe.secretKey}>
                Quitar llaves
              </button>
            </form>
          </div>
        </Card>

        {/* ─────────────────────────── PayPal ─────────────────────────── */}
        <Card title="PayPal">
          <EstadoProveedor
            activo={config.paypal.activo}
            configurado={config.paypal.clientId.length > 0 && config.paypal.clientSecret.length > 0}
            guardadoEl={actualizado.paypal}
          />
          <form action={guardarPaypal}>
            <div className="pag-cols">
              <Field
                label="Client ID"
                htmlFor="pp-id"
                hint="En developer.paypal.com → Apps & Credentials (pestaña Live) → tu app → Client ID."
              >
                <input
                  type="text"
                  id="pp-id"
                  name="clientId"
                  autoComplete="off"
                  defaultValue={config.paypal.clientId}
                  placeholder="A21…"
                />
              </Field>
              <Field
                label="Secret"
                htmlFor="pp-secret"
                hint={
                  config.paypal.clientSecret
                    ? `Guardado (${final(config.paypal.clientSecret)}). Déjalo vacío para conservarlo.`
                    : "El «Secret key» de la misma app."
                }
              >
                <input
                  type="password"
                  id="pp-secret"
                  name="clientSecret"
                  autoComplete="off"
                  placeholder={config.paypal.clientSecret ? final(config.paypal.clientSecret) : "EL…"}
                />
              </Field>
              <Field
                label="Entorno"
                htmlFor="pp-entorno"
                hint="«Real» cobra de verdad. «Pruebas» (sandbox) es solo para ensayar con cuentas falsas."
              >
                <select id="pp-entorno" name="entorno" defaultValue={config.paypal.entorno}>
                  <option value="live">Real (live)</option>
                  <option value="sandbox">Pruebas (sandbox)</option>
                </select>
              </Field>
              <label className="pag-check">
                <input type="checkbox" name="activo" defaultChecked={config.paypal.activo} />
                <span>
                  Ofrecer en el checkout
                  <span className="adm-muted adm-small">
                    La clienta paga con su cuenta de PayPal o con tarjeta, sin crear cuenta.
                  </span>
                </span>
              </label>
            </div>
            <div className="pag-acciones">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Guardar PayPal
              </button>
            </div>
          </form>
          <div className="pag-acciones">
            <form action={probarConexion}>
              <input type="hidden" name="proveedor" value="paypal" />
              <button
                type="submit"
                className="adm-btn adm-btn-ghost adm-btn-sm"
                disabled={!listo.paypal}
              >
                Probar conexión
              </button>
            </form>
            <form action={quitarProveedor}>
              <input type="hidden" name="proveedor" value="paypal" />
              <button
                type="submit"
                className="adm-btn adm-btn-ghost adm-btn-sm"
                disabled={!config.paypal.clientId && !config.paypal.clientSecret}
              >
                Quitar llaves
              </button>
            </form>
          </div>
        </Card>

        {/* ─────────────────────────── Square ─────────────────────────── */}
        <Card title="Tarjeta · Square">
          <EstadoProveedor
            activo={config.square.activo}
            configurado={config.square.accessToken.length > 0 && config.square.locationId.length > 0}
            guardadoEl={actualizado.square}
          />
          <form action={guardarSquare}>
            <div className="pag-cols">
              <Field
                label="Token de acceso"
                htmlFor="sq-token"
                hint={
                  config.square.accessToken
                    ? `Guardado (${final(config.square.accessToken)}). Déjalo vacío para conservarlo.`
                    : "En developer.squareup.com → tu aplicación → Production → Access token."
                }
              >
                <input
                  type="password"
                  id="sq-token"
                  name="accessToken"
                  autoComplete="off"
                  placeholder={config.square.accessToken ? final(config.square.accessToken) : "EAAA…"}
                />
              </Field>
              <Field
                label="Location ID"
                htmlFor="sq-location"
                hint="Identifica tu local en Square. Si lo dejas vacío, «Probar conexión» lo rellena solo cuando la cuenta tiene un único local."
              >
                <input
                  type="text"
                  id="sq-location"
                  name="locationId"
                  autoComplete="off"
                  defaultValue={config.square.locationId}
                  placeholder="L…"
                />
              </Field>
              <Field label="Entorno" htmlFor="sq-entorno" hint="«Real» cobra de verdad; «Pruebas» usa el sandbox de Square.">
                <select id="sq-entorno" name="entorno" defaultValue={config.square.entorno}>
                  <option value="production">Real (production)</option>
                  <option value="sandbox">Pruebas (sandbox)</option>
                </select>
              </Field>
              <label className="pag-check">
                <input type="checkbox" name="activo" defaultChecked={config.square.activo} />
                <span>
                  Ofrecer en el checkout
                  <span className="adm-muted adm-small">
                    La clienta paga con tarjeta en la página segura de Square — la misma cuenta que un lector de mostrador.
                  </span>
                </span>
              </label>
            </div>
            <div className="pag-acciones">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Guardar Square
              </button>
            </div>
          </form>
          <div className="pag-acciones">
            <form action={probarConexion}>
              <input type="hidden" name="proveedor" value="square" />
              <button
                type="submit"
                className="adm-btn adm-btn-ghost adm-btn-sm"
                disabled={!listo.square}
              >
                Probar conexión
              </button>
            </form>
            <form action={quitarProveedor}>
              <input type="hidden" name="proveedor" value="square" />
              <button
                type="submit"
                className="adm-btn adm-btn-ghost adm-btn-sm"
                disabled={!config.square.accessToken && !config.square.locationId}
              >
                Quitar llaves
              </button>
            </form>
          </div>
        </Card>

        {/* ───────────────────── métodos sin pasarela ───────────────────── */}
        <Card title="Sin pasarela">
          <form action={guardarManuales}>
            <label className="pag-check">
              <input type="checkbox" name="payDm" defaultChecked={settings.payDm} />
              <span>
                Acordar el pago por DM de Instagram
                <span className="adm-muted adm-small">
                  El pedido se guarda como pendiente y tú lo cobras a mano. Con una pasarela activa
                  puedes apagarlo: los cobros dejan de depender del chat.
                </span>
              </span>
            </label>
            <label className="pag-check">
              <input type="checkbox" name="payPickup" defaultChecked={settings.payPickup} />
              <span>
                Pagar al recoger en la boutique
                <span className="adm-muted adm-small">Efectivo o tarjeta en el local, sin cobro online.</span>
              </span>
            </label>
            <div className="pag-acciones">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Guardar
              </button>
            </div>
          </form>
        </Card>
      </div>

      {/* ───────────────────────────── guía ───────────────────────────── */}
      <Card title="Cómo conectar tu cuenta (5 minutos)">
        <div className="pag-guia">
          <p>
            <strong>Stripe</strong> — entra en <strong>dashboard.stripe.com</strong> con tu cuenta,
            ve a <em>Desarrolladores → Claves de API</em>, copia la <em>clave secreta</em> (empieza
            por <code>sk_live_</code>), pégala arriba, marca «Ofrecer en el checkout» y guarda.
            Con «Probar conexión» confirmas que la llave funciona sin cobrar nada.
          </p>
          <p>
            <strong>PayPal</strong> — entra en <strong>developer.paypal.com</strong> con tu cuenta
            de PayPal Business, ve a <em>Apps &amp; Credentials</em>, pestaña <em>Live</em>, crea
            una app si no tienes y copia su <em>Client ID</em> y su <em>Secret</em>.
          </p>
          <p>
            <strong>Square</strong> — entra en <strong>developer.squareup.com</strong> con tu cuenta
            de Square, abre (o crea) una aplicación, pestaña <em>Production</em>, y copia el{" "}
            <em>Access token</em>. El Location ID se rellena solo al probar la conexión.
          </p>
          <ol>
            <li>Pega las credenciales del método que quieras y pulsa «Guardar».</li>
            <li>Pulsa «Probar conexión» para confirmar que funcionan.</li>
            <li>Marca «Ofrecer en el checkout» y vuelve a guardar: ya estás cobrando online.</li>
            <li>
              Cuando la tarjeta funcione, puedes apagar el DM en «Sin pasarela» — los pedidos
              nuevos se cobrarán solos y aparecerán como «Pagado» en Pedidos.
            </li>
          </ol>
          <p className="adm-muted adm-small">
            Las llaves se guardan cifradas y aquí solo se enseña su final. Un pedido pagado online
            se marca «Pagado» él solo en cuanto la pasarela confirma el cobro; si una clienta
            abandona el pago, su pedido queda «Por cobrar» y puedes cancelarlo para liberar el
            stock.
          </p>
        </div>
      </Card>
    </>
  );
}
