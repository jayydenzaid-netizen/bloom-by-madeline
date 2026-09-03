import { explicarDiagnostico, haceCuanto } from "@/lib/payments/diagnostico";
import {
  ETIQUETA_PROVEEDOR,
  leerConfigPagosConMeta,
  metodosOnlineActivos,
  paypalConfigurado,
  squareConfigurado,
  stripeConfigurado,
  type ConfigPagos,
  type MetodoOnline,
} from "@/lib/payments/config";
import { diasDesde, leerSalud, type SaludProveedor } from "@/lib/payments/estado";
import { requireOwner } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";
import { Badge, Card, Field, PageHeader, StatCard, type BadgeTone } from "../_components/ui";
import {
  apagarProveedor,
  comprobarProveedor,
  comprobarTodas,
  conectarProveedor,
  desconectarProveedor,
  guardarManuales,
} from "./actions";
import "./pagos.css";

/**
 * Pagos: aquí Madeline conecta SUS cuentas de cobro y ve, de un vistazo, si la
 * tienda está cobrando de verdad.
 *
 * La idea que ordena toda la pantalla: **enseñar estado de CONEXIÓN, no estado
 * de guardado.** Antes las insignias salían de medir la longitud de una cadena
 * —ninguna había hablado nunca con la pasarela—, así que podía pintar «Sin
 * conectar» junto a «Guardado el 3 sept», o un verde «activo» con unas llaves ya
 * rechazadas. Ahora cada tarjeta dice con qué cuenta está conectada, cuándo se
 * comprobó y, si algo falla, qué hacer. Eso se guarda en `paymentsEstado`
 * (lib/payments/estado.ts) y sobrevive a recargar.
 *
 * ⚠️ Esta página NO sondea al pintarse, solo LEE lo guardado. Sondear en el
 * render haría que /admin/pagos tardase entre quince y cuarenta y cinco segundos
 * cada vez que una pasarela va lenta. Se comprueba pulsando.
 *
 * Las llaves se guardan cifradas y aquí solo se enseña su final: esta pantalla
 * se abre en la boutique con gente delante.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Pagos" };

/** Los mensajes viven aquí, no en la URL: nadie fabrica un cartel con un enlace. */
const HECHOS: Record<string, string> = {
  "stripe-activo": "Stripe conectado y ACTIVO: el checkout ya ofrece pagar con tarjeta.",
  "paypal-activo": "PayPal conectado y ACTIVO: el checkout ya lo ofrece.",
  "square-activo": "Square conectado y ACTIVO: el checkout ya ofrece pagar con tarjeta.",
  "stripe-guardado": "Stripe guardado y comprobado. Enciéndelo cuando quieras ofrecerlo.",
  "paypal-guardado": "PayPal guardado y comprobado. Enciéndelo cuando quieras ofrecerlo.",
  "square-guardado": "Square guardado y comprobado. Enciéndelo cuando quieras ofrecerlo.",
  "stripe-guardado-con-fallo": "Stripe guardado, pero la comprobación falló: mira el aviso de su tarjeta.",
  "paypal-guardado-con-fallo": "PayPal guardado, pero la comprobación falló: mira el aviso de su tarjeta.",
  "square-guardado-con-fallo": "Square guardado, pero la comprobación falló: mira el aviso de su tarjeta.",
  "stripe-conexion": "Conexión con Stripe comprobada: la llave funciona.",
  "paypal-conexion": "Conexión con PayPal comprobada: las credenciales funcionan.",
  "square-conexion": "Conexión con Square comprobada: el token funciona.",
  "square-local":
    "Conexión con Square comprobada. Tu cuenta tiene un solo local, así que el identificador se rellenó solo.",
  "stripe-apagado": "Stripe apagado: ya no se ofrece en el checkout. Sus llaves siguen guardadas.",
  "paypal-apagado": "PayPal apagado: ya no se ofrece en el checkout. Sus llaves siguen guardadas.",
  "square-apagado": "Square apagado: ya no se ofrece en el checkout. Sus llaves siguen guardadas.",
  "stripe-quitado": "Llaves de Stripe quitadas. El método desapareció del checkout.",
  "paypal-quitado": "Llaves de PayPal quitadas. El método desapareció del checkout.",
  "square-quitado": "Llaves de Square quitadas. El método desapareció del checkout.",
  "todas-bien": "Comprobadas todas tus pasarelas: las que tienes conectadas funcionan.",
  "todas-con-fallos": "Comprobadas todas tus pasarelas: alguna tiene un problema, mira su tarjeta.",
  manuales: "Métodos sin pasarela guardados.",
};

const ERRORES: Record<string, string> = {
  "stripe-clave":
    "Esa no parece la llave SECRETA de Stripe (empieza por sk_ o rk_). La que empieza por pk_ es la publicable y no puede cobrar.",
  "stripe-sin-llaves": "Para conectar Stripe primero pega su llave secreta.",
  "paypal-sin-llaves": "Para conectar PayPal hacen falta el Client ID y el Secret.",
  "square-sin-llaves": "Para conectar Square hace falta su token de acceso.",
  "stripe-fallo": "Stripe rechazó la llave. Mira el detalle en su tarjeta.",
  "paypal-fallo": "PayPal rechazó las credenciales. Mira el detalle en su tarjeta.",
  "square-fallo": "Square rechazó el token. Mira el detalle en su tarjeta.",
  // Un fallo de red NO es culpa de las llaves y no puede sonar como si lo fuera.
  "stripe-sin-respuesta":
    "No pudimos hablar con Stripe (puede estar de bajón). Tus llaves están guardadas y sin tocar: vuelve a comprobar en un rato.",
  "paypal-sin-respuesta":
    "No pudimos hablar con PayPal (puede estar de bajón). Tus credenciales están guardadas y sin tocar: vuelve a comprobar en un rato.",
  "square-sin-respuesta":
    "No pudimos hablar con Square (puede estar de bajón). Tu token está guardado y sin tocar: vuelve a comprobar en un rato.",
  // Se intentó ENCENDER un cobro que la pasarela rechaza. Se guarda apagado a
  // propósito: ofrecer una tarjeta que no cobra deja a la clienta con el pedido
  // hecho, su talla apartada y sin forma de pagar.
  "stripe-fallo-activar":
    "Stripe rechazó esa llave, así que NO se activó el cobro con tarjeta (se guardó apagado). Mira qué dice su tarjeta y vuelve a intentarlo.",
  "paypal-fallo-activar":
    "PayPal rechazó esas credenciales, así que NO se activó (se guardó apagado). Mira qué dice su tarjeta y vuelve a intentarlo.",
  "square-fallo-activar":
    "Square rechazó ese token, así que NO se activó el cobro con tarjeta (se guardó apagado). Mira qué dice su tarjeta y vuelve a intentarlo.",
  "sin-metodos":
    "No puedes apagar el DM y la recogida sin tener una pasarela activa: nadie podría terminar una compra.",
  "nada-que-comprobar": "Todavía no has conectado ninguna pasarela, así que no hay nada que comprobar.",
  desconocido: "No se pudo aplicar el cambio. Inténtalo otra vez.",
};

/** Cómo se enseña una credencial guardada: solo su final, nunca entera. */
function final(valor: string): string {
  if (!valor) return "";
  return `····${valor.slice(-4)}`;
}

const fecha = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

/* ═══════════════════════ estado de un proveedor ═══════════════════════ */

/**
 * En qué punto está cada pasarela. Un solo tipo para que la insignia, el texto y
 * los botones no puedan contradecirse — que es justo lo que pasaba antes.
 */
type Fase =
  /** Nunca se pegó nada. */
  | "sin-conectar"
  /** Hay llaves guardadas que este servidor NO puede descifrar. */
  | "ilegible"
  /** Guardadas y sin comprobar nunca. */
  | "sin-comprobar"
  /** La pasarela rechazó las llaves. */
  | "rechazada"
  /** No se pudo preguntar la última vez. */
  | "sin-respuesta"
  /** Comprobadas y funcionando, pero apagadas en el checkout. */
  | "lista"
  /** Comprobadas, encendidas y ofreciéndose. */
  | "cobrando";

type EstadoProveedor = {
  proveedor: MetodoOnline;
  fase: Fase;
  salud: SaludProveedor | undefined;
  /** Existen llaves guardadas (aunque no se puedan leer). */
  hayLlaves: boolean;
  completo: boolean;
  activo: boolean;
  guardadoEl: Date | null;
};

const INSIGNIA: Record<Fase, { texto: string; tono: BadgeTone }> = {
  "sin-conectar": { texto: "Sin conectar", tono: "neutral" },
  ilegible: { texto: "Llaves ilegibles", tono: "danger" },
  "sin-comprobar": { texto: "Sin comprobar", tono: "warning" },
  rechazada: { texto: "Rechazada", tono: "danger" },
  "sin-respuesta": { texto: "Sin respuesta", tono: "warning" },
  lista: { texto: "Lista, apagada", tono: "info" },
  cobrando: { texto: "Cobrando", tono: "success" },
};

function faseDe(
  proveedor: MetodoOnline,
  cfg: ConfigPagos,
  ilegible: boolean,
  salud: SaludProveedor | undefined,
  activoEnCheckout: boolean,
): Fase {
  if (ilegible) return "ilegible";
  const completo =
    proveedor === "stripe"
      ? stripeConfigurado(cfg.stripe)
      : proveedor === "paypal"
        ? paypalConfigurado(cfg.paypal)
        : squareConfigurado(cfg.square);
  if (!completo) return "sin-conectar";
  if (salud?.resultado === "rechazada") return "rechazada";
  if (salud?.resultado === "sin-respuesta") return "sin-respuesta";
  if (!salud) return "sin-comprobar";
  return activoEnCheckout ? "cobrando" : "lista";
}

/** La línea que dice con QUÉ cuenta está conectada y cuándo se comprobó. */
function LineaEstado({ e, ahora }: { e: EstadoProveedor; ahora: Date }) {
  const dias = diasDesde(e.salud, ahora);
  return (
    <div className="pag-estado">
      <Badge tone={INSIGNIA[e.fase].tono}>{INSIGNIA[e.fase].texto}</Badge>
      {e.salud?.cuenta ? <span className="pag-cuenta">{e.salud.cuenta}</span> : null}
      {e.salud?.entornoReal === "pruebas" ? <Badge tone="warning">En pruebas</Badge> : null}
      {e.salud ? (
        <span className="adm-muted adm-small">
          Comprobado {haceCuanto(e.salud.en, ahora)}
          {dias !== null && dias >= 7 ? " — conviene comprobarlo otra vez" : ""}
        </span>
      ) : e.guardadoEl ? (
        <span className="adm-muted adm-small">Guardado el {fecha.format(e.guardadoEl)}</span>
      ) : null}
    </div>
  );
}

/** El aviso con el diagnóstico y QUÉ HACER. Solo sale cuando hay algo que decir. */
function Diagnostico({ e }: { e: EstadoProveedor }) {
  if (e.fase === "ilegible") {
    return (
      <div className="pag-diag is-error">
        <strong>Tienes llaves guardadas que este servidor no puede leer.</strong>
        <span>
          Pasa cuando cambia la clave de seguridad del sitio o se restaura una copia hecha en otro
          entorno. Las llaves están ahí pero no sirven: pulsa «Desconectar» y vuelve a pegarlas.
        </span>
      </div>
    );
  }
  if (!e.salud || e.salud.resultado === "ok") return null;

  const d = explicarDiagnostico(e.proveedor, e.salud.codigo);
  return (
    <div className={`pag-diag ${d.urgente ? "is-error" : "is-aviso"}`}>
      <strong>{d.titulo}</strong>
      {d.queHacer ? <span>{d.queHacer}</span> : null}
    </div>
  );
}

/** Monograma de la marca. Texto, no logotipo: el nombre se puede usar, la marca no. */
function Marca({ proveedor }: { proveedor: MetodoOnline }) {
  const iniciales = { stripe: "S", paypal: "PP", square: "□" }[proveedor];
  return (
    <span className={`pag-marca pag-marca-${proveedor}`} aria-hidden="true">
      {iniciales}
    </span>
  );
}

function TituloProveedor({ proveedor, sub }: { proveedor: MetodoOnline; sub: string }) {
  return (
    <span className="pag-titulo">
      <Marca proveedor={proveedor} />
      <span>
        {ETIQUETA_PROVEEDOR[proveedor]}
        <span className="adm-muted adm-small">{sub}</span>
      </span>
    </span>
  );
}

/** Los dos botones de debajo de cada tarjeta. */
function Acciones({ e }: { e: EstadoProveedor }) {
  return (
    <div className="pag-acciones">
      <form action={comprobarProveedor}>
        <input type="hidden" name="proveedor" value={e.proveedor} />
        <button type="submit" className="adm-btn adm-btn-ghost adm-btn-sm" disabled={!e.completo}>
          Comprobar ahora
        </button>
      </form>
      {e.activo ? (
        <form action={apagarProveedor}>
          <input type="hidden" name="proveedor" value={e.proveedor} />
          <button type="submit" className="adm-btn adm-btn-ghost adm-btn-sm">
            Dejar de ofrecer
          </button>
        </form>
      ) : null}
      <form action={desconectarProveedor}>
        <input type="hidden" name="proveedor" value={e.proveedor} />
        {/* Habilitado si EXISTE la fila, no si se pudo descifrar: la fila
            ilegible es justo la que hay que poder limpiar. */}
        <button type="submit" className="adm-btn adm-btn-ghost adm-btn-sm" disabled={!e.hayLlaves}>
          Desconectar
        </button>
      </form>
    </div>
  );
}

/** La casilla de encender, con el mismo texto en las tres tarjetas. */
function Encender({ e, texto: descripcion }: { e: EstadoProveedor; texto: string }) {
  return (
    <label className="pag-check">
      <input type="checkbox" name="activo" defaultChecked={e.activo} />
      <span>
        Ofrecer en el checkout
        <span className="adm-muted adm-small">{descripcion}</span>
      </span>
    </label>
  );
}

/* ═══════════════════════════════ página ═══════════════════════════════ */

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

  const [{ config, actualizado, ilegible }, settings, salud] = await Promise.all([
    leerConfigPagosConMeta(),
    getSettings(),
    leerSalud(),
  ]);
  const online = metodosOnlineActivos(config, salud);
  const ahora = new Date();

  const estado = (proveedor: MetodoOnline): EstadoProveedor => {
    const completo =
      proveedor === "stripe"
        ? stripeConfigurado(config.stripe)
        : proveedor === "paypal"
          ? paypalConfigurado(config.paypal)
          : squareConfigurado(config.square);
    const activo =
      proveedor === "stripe"
        ? config.stripe.activo
        : proveedor === "paypal"
          ? config.paypal.activo
          : config.square.activo;
    const algoPegado =
      proveedor === "stripe"
        ? config.stripe.secretKey.length > 0
        : proveedor === "paypal"
          ? config.paypal.clientId.length > 0 || config.paypal.clientSecret.length > 0
          : config.square.accessToken.length > 0;
    return {
      proveedor,
      fase: faseDe(proveedor, config, ilegible[proveedor], salud[proveedor], online[proveedor]),
      salud: salud[proveedor],
      hayLlaves: algoPegado || ilegible[proveedor],
      completo,
      activo,
      guardadoEl: actualizado[proveedor],
    };
  };

  const eStripe = estado("stripe");
  const ePaypal = estado("paypal");
  const eSquare = estado("square");
  const todos = [eStripe, ePaypal, eSquare];

  const activos = todos.filter((e) => online[e.proveedor]);
  const conProblema = todos.filter((e) => e.fase === "rechazada" || e.fase === "ilegible");
  const comprobaciones = todos.map((e) => e.salud?.en).filter((x): x is string => !!x);
  const ultima = comprobaciones.sort().at(-1);

  // Lo que puede pagar una clienta AHORA MISMO, que es la pregunta de verdad.
  const formas: string[] = [
    ...activos.map((e) => ETIQUETA_PROVEEDOR[e.proveedor]),
    ...(settings.payDm ? ["por DM"] : []),
    ...(settings.payPickup ? ["al recoger"] : []),
  ];

  return (
    <>
      <PageHeader
        title="Pagos"
        subtitle={
          activos.length > 0
            ? `Con tarjeta vía ${activos.map((e) => ETIQUETA_PROVEEDOR[e.proveedor]).join(" y ")} — el dinero entra en tu cuenta`
            : "Conecta tu cuenta de Stripe, PayPal o Square para cobrar online"
        }
        actions={
          <form action={comprobarTodas}>
            <button type="submit" className="adm-btn adm-btn-ghost adm-btn-md">
              Comprobar todas
            </button>
          </form>
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

      {/* El resumen contesta de un vistazo «¿está cobrando mi tienda?». */}
      <div className="pag-resumen">
        <StatCard
          label="Puede pagar con"
          value={formas.length > 0 ? formas.join(" · ") : "Nada"}
          hint={formas.length > 0 ? "Lo que ve una clienta en el checkout" : "Nadie puede terminar una compra"}
          tone={formas.length > 0 ? "success" : "danger"}
        />
        <StatCard
          label="Cobro con tarjeta"
          value={activos.length > 0 ? "Activo" : "Sin activar"}
          hint={
            activos.length > 0
              ? "Los pedidos se marcan pagados solos"
              : "Hoy los cobras a mano, uno por uno"
          }
          tone={activos.length > 0 ? "success" : "warning"}
        />
        <StatCard
          label="Última comprobación"
          value={ultima ? haceCuanto(ultima, ahora) : "Nunca"}
          hint={
            conProblema.length > 0
              ? `${conProblema.length} ${conProblema.length === 1 ? "pasarela" : "pasarelas"} con problemas`
              : ultima
                ? "Todo lo conectado respondía bien"
                : "Pulsa «Comprobar todas»"
          }
          tone={conProblema.length > 0 ? "danger" : "default"}
        />
      </div>

      {/* Aviso de tienda coja: sin pasarela y sin DM, lo único que queda es la
          recogida en la boutique, o sea que NADIE de fuera de Hamilton puede
          comprar aunque la portada prometa envíos a todo el país. */}
      {activos.length === 0 && !settings.payDm ? (
        <p className="pag-aviso is-error" role="alert">
          <strong>Tu tienda solo permite recoger en la boutique.</strong> Sin una pasarela
          activa y con el DM apagado, quien viva fuera de Hamilton no puede comprar. Conecta
          una cuenta de cobro aquí abajo, o vuelve a encender el DM en «Sin pasarela» mientras
          tanto.
        </p>
      ) : null}

      <div className="pag-grid">
        {/* ─────────────────────────── Stripe ─────────────────────────── */}
        <Card title={<TituloProveedor proveedor="stripe" sub="Tarjeta, Apple Pay y Google Pay" />}>
          <LineaEstado e={eStripe} ahora={ahora} />
          <Diagnostico e={eStripe} />
          <form action={conectarProveedor}>
            <input type="hidden" name="proveedor" value="stripe" />
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
              <Encender
                e={eStripe}
                texto="La clienta paga con tarjeta en la página segura de Stripe y el dinero entra en tu cuenta."
              />
            </div>
            <div className="pag-acciones">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Conectar y comprobar
              </button>
            </div>
          </form>
          <Acciones e={eStripe} />
        </Card>

        {/* ─────────────────────────── Square ─────────────────────────── */}
        <Card title={<TituloProveedor proveedor="square" sub="La misma cuenta que tu lector de mostrador" />}>
          <LineaEstado e={eSquare} ahora={ahora} />
          <Diagnostico e={eSquare} />
          <form action={conectarProveedor}>
            <input type="hidden" name="proveedor" value="square" />
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
                label="Local"
                htmlFor="sq-location"
                hint={
                  config.square.locationId
                    ? `Tu local: ${config.square.locationId}. Bórralo y comprueba para que se rellene solo.`
                    : "Déjalo vacío: al comprobar se rellena solo si tu cuenta tiene un único local."
                }
              >
                <input
                  type="text"
                  id="sq-location"
                  name="locationId"
                  autoComplete="off"
                  defaultValue={config.square.locationId}
                  placeholder="se rellena solo"
                />
              </Field>
              <Field
                label="Entorno"
                htmlFor="sq-entorno"
                hint="«Real» cobra de verdad; «Pruebas» usa el sandbox de Square y no mueve dinero."
              >
                <select id="sq-entorno" name="entorno" defaultValue={config.square.entorno}>
                  <option value="production">Real (production)</option>
                  <option value="sandbox">Pruebas (sandbox)</option>
                </select>
              </Field>
              <Encender
                e={eSquare}
                texto="La clienta paga con tarjeta en la página segura de Square — la misma cuenta que tu lector."
              />
            </div>
            <div className="pag-acciones">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Conectar y comprobar
              </button>
            </div>
          </form>
          <Acciones e={eSquare} />
        </Card>

        {/* ─────────────────────────── PayPal ─────────────────────────── */}
        <Card title={<TituloProveedor proveedor="paypal" sub="Cuenta de PayPal o tarjeta, sin registrarse" />}>
          <LineaEstado e={ePaypal} ahora={ahora} />
          <Diagnostico e={ePaypal} />
          <form action={conectarProveedor}>
            <input type="hidden" name="proveedor" value="paypal" />
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
              <Encender
                e={ePaypal}
                texto="La clienta paga con su cuenta de PayPal o con tarjeta, sin crear cuenta."
              />
            </div>
            <div className="pag-acciones">
              <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                Conectar y comprobar
              </button>
            </div>
          </form>
          <Acciones e={ePaypal} />
        </Card>

        {/* ───────────────────── métodos sin pasarela ───────────────────── */}
        <Card title="Sin pasarela" className="pag-manuales">
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

      {/* La guía solo sale si queda algo por conectar: cuando ya está todo
          hecho, un muro de instrucciones solo estorba. */}
      {todos.some((e) => e.fase === "sin-conectar") ? (
        <Card title="Cómo conectar una cuenta de cobro">
          <div className="pag-guia">
            <p>
              Pega la credencial del método que quieras y pulsa <strong>«Conectar y comprobar»</strong>.
              Ese botón hace las tres cosas: guarda, le pregunta a la pasarela si funciona y solo lo
              enciende si dice que sí. Si algo falla, su tarjeta te dice qué pasa y qué hacer.
            </p>
            {eStripe.fase === "sin-conectar" ? (
              <p>
                <strong>Stripe</strong> — entra en <strong>dashboard.stripe.com</strong>, ve a{" "}
                <em>Desarrolladores → Claves de API</em> y copia la <em>clave secreta</em> (empieza por{" "}
                <code>sk_live_</code>).
              </p>
            ) : null}
            {eSquare.fase === "sin-conectar" ? (
              <p>
                <strong>Square</strong> — entra en <strong>developer.squareup.com</strong> con tu cuenta
                de Square, abre (o crea) una aplicación, pestaña <em>Production</em>, y copia el{" "}
                <em>Access token</em>. El local se rellena solo al comprobar.
              </p>
            ) : null}
            {ePaypal.fase === "sin-conectar" ? (
              <p>
                <strong>PayPal</strong> — entra en <strong>developer.paypal.com</strong> con tu cuenta de
                PayPal Business, ve a <em>Apps &amp; Credentials</em>, pestaña <em>Live</em>, crea una app
                si no tienes y copia su <em>Client ID</em> y su <em>Secret</em>.
              </p>
            ) : null}
            <p className="adm-muted adm-small">
              Las llaves se guardan cifradas y aquí solo se enseña su final. Un pedido pagado online se
              marca «Pagado» él solo en cuanto la pasarela confirma el cobro; si una clienta abandona el
              pago, su pedido queda «Por cobrar» y puedes cancelarlo para liberar el stock.
            </p>
          </div>
        </Card>
      ) : null}
    </>
  );
}
