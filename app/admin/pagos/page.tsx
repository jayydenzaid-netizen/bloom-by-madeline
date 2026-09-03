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
import { PROVEEDORES, type CampoProveedor, type DefProveedor } from "@/lib/payments/proveedores";
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
  pegarCredencial,
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

/**
 * Margen para las Server Actions de esta ruta.
 *
 * Preguntarle a una pasarela puede costar hasta 15 s (es el timeout de los
 * adaptadores) y hay acciones que encadenan varias: «Comprobar todas» toca las
 * tres, y conectar Square puede sondear los dos entornos. Sin esto, Vercel corta
 * la función a los 10-15 s por defecto y la dueña ve un error en mitad de una
 * comprobación que en realidad iba bien. 60 s es el techo del plan más básico.
 */
export const maxDuration = 60;

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
    "No pudimos hablar con Stripe (puede estar de bajón). No se ha tocado nada: ni tus llaves ni si se ofrece o no. Vuelve a comprobar en un rato.",
  "paypal-sin-respuesta":
    "No pudimos hablar con PayPal (puede estar de bajón). No se ha tocado nada: ni tus credenciales ni si se ofrece o no. Vuelve a comprobar en un rato.",
  "square-sin-respuesta":
    "No pudimos hablar con Square (puede estar de bajón). No se ha tocado nada: ni tu token ni si se ofrece o no. Vuelve a comprobar en un rato.",
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
  "pegado-vacio": "No pegaste nada. Copia la credencial de tu procesador y pégala en la caja.",
  "pegado-desconocido":
    "Eso no se parece a ninguna credencial que reconozcamos. Copia el valor completo (sin recortarlo) de Stripe, Square o PayPal, o rellena los campos de su tarjeta a mano.",
  "pegado-mezclado":
    "Pegaste credenciales de dos procesadores distintos a la vez. Hazlo de uno en uno para que no quede nada a medias.",
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
  /** Se guardó algo pero falta otra credencial para poder cobrar. */
  | "incompleto"
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
  /**
   * Lo que el checkout ofrece DE VERDAD (interruptor + credenciales completas +
   * el veto por salud). El interruptor crudo no vale para la pantalla: con la
   * insignia en «Rechazada» seguía saliendo «Dejar de ofrecer» para un método
   * que ya no se ofrecía.
   */
  seOfrece: boolean;
  completo: boolean;
  activo: boolean;
  guardadoEl: Date | null;
};

const INSIGNIA: Record<Fase, { texto: string; tono: BadgeTone }> = {
  "sin-conectar": { texto: "Sin conectar", tono: "neutral" },
  ilegible: { texto: "Llaves ilegibles", tono: "danger" },
  incompleto: { texto: "Falta un dato", tono: "warning" },
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
  hayAlgo: boolean,
): Fase {
  if (ilegible) return "ilegible";
  const completo =
    proveedor === "stripe"
      ? stripeConfigurado(cfg.stripe)
      : proveedor === "paypal"
        ? paypalConfigurado(cfg.paypal)
        : squareConfigurado(cfg.square);
  // Hay algo guardado pero falta una credencial: ni «sin conectar» (que niega lo
  // que se ve al lado: «Guardado el 3 sept») ni «rechazada» (nadie rechazó nada).
  if (!completo) return hayAlgo ? "incompleto" : "sin-conectar";
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
  if (e.fase === "incompleto") {
    const def = PROVEEDORES.find((d) => d.id === e.proveedor);
    return (
      <div className="pag-diag is-aviso">
        <strong>Falta una credencial para poder cobrar.</strong>
        <span>
          Lo que pegaste se guardó, pero {def?.etiqueta} necesita{" "}
          {def?.campos.map((c) => c.etiqueta).join(" y ")}. Pega lo que falte y vuelve a conectar.
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
function TituloProveedor({ def }: { def: DefProveedor }) {
  return (
    <span className="pag-titulo">
      <span className={`pag-marca pag-marca-${def.id}`} aria-hidden="true">
        {def.monograma}
      </span>
      <span>
        {def.etiqueta}
        <span className="adm-muted adm-small">{def.paraQue}</span>
      </span>
    </span>
  );
}

/** Lo que promete cada método en la casilla de encender. */
const TEXTO_ENCENDER: Record<MetodoOnline, string> = {
  stripe: "La clienta paga con tarjeta en la página segura de Stripe y el dinero entra en tu cuenta.",
  square: "La clienta paga con tarjeta en la página segura de Square — la misma cuenta que tu lector.",
  paypal: "La clienta paga con su cuenta de PayPal o con tarjeta, sin crear cuenta.",
};

/** El valor guardado de un campo, sea del proveedor que sea. */
function valorGuardado(config: ConfigPagos, proveedor: MetodoOnline, campo: string): string {
  const fuente = config[proveedor] as unknown as Record<string, unknown>;
  const v = fuente?.[campo];
  return typeof v === "string" ? v : "";
}

/**
 * Un campo de credencial, pintado desde el registro.
 *
 * Los secretos van como contraseña y no se rellenan con lo guardado: se enseña
 * solo su final y dejarlo vacío lo conserva. Los que no son secretos (el local
 * de Square, el Client ID de PayPal) sí se rellenan, porque hay que poder verlos
 * y corregirlos.
 */
function CampoCredencial({
  def,
  campo,
  config,
}: {
  def: DefProveedor;
  campo: CampoProveedor;
  config: ConfigPagos;
}) {
  const guardado = valorGuardado(config, def.id, campo.nombre);
  const pista = campo.secreto
    ? guardado
      ? `Guardado (${final(guardado)}). Déjalo vacío para conservarlo.`
      : `${campo.ayuda} Lo encuentras en ${def.donde}.`
    : guardado
      ? campo.ayuda
      : `${campo.ayuda}`;
  return (
    <Field label={campo.etiqueta} htmlFor={campo.id} hint={pista}>
      <input
        type={campo.secreto ? "password" : "text"}
        id={campo.id}
        name={campo.nombre}
        autoComplete="off"
        {...(campo.secreto ? {} : { defaultValue: guardado })}
        placeholder={campo.secreto && guardado ? final(guardado) : campo.ejemplo}
      />
    </Field>
  );
}

/**
 * La caja de pegar: UNA credencial (o las dos de PayPal) y el sistema decide de
 * quién son, en qué campo van y de qué entorno son.
 *
 * Va arriba y es lo primero que se ve a propósito. El camino largo —ir a la
 * tarjeta del procesador correcto, acertar el campo, elegir el entorno— sigue
 * existiendo debajo para el caso raro, pero ya no es el camino por defecto.
 */
function CajaPegar() {
  return (
    <Card title="Pega aquí lo que te dio tu procesador">
      <form action={pegarCredencial}>
        <div className="pag-pegar">
          <textarea
            id="pegar-credencial"
            name="pegado"
            rows={3}
            autoComplete="off"
            spellCheck={false}
            placeholder="Pega la llave, el token o las dos credenciales de PayPal. Da igual el orden y da igual si arrastras la etiqueta."
          />
          <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
            Reconocer y conectar
          </button>
        </div>
        <p className="adm-muted adm-small">
          Reconoce Stripe, Square y PayPal por la forma de la credencial, la guarda en su sitio, le
          pregunta al procesador si funciona y —si dice que sí— la deja cobrando. No hace falta que
          sepas qué campo es ni si es de pruebas o real: eso se averigua preguntando.
        </p>
      </form>
    </Card>
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
      {/* Solo si de verdad hay algo que dejar de ofrecer: «apagar» junto a una
          insignia de «Sin conectar» es la clase de contradicción que tenía esta
          pantalla y que este rediseño existe para quitar. */}
      {e.seOfrece ? (
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
      <input type="checkbox" name="activo" defaultChecked={e.seOfrece} />
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
      fase: faseDe(proveedor, config, ilegible[proveedor], salud[proveedor], online[proveedor], algoPegado),
      salud: salud[proveedor],
      hayLlaves: algoPegado || ilegible[proveedor],
      seOfrece: online[proveedor],
      completo,
      activo,
      guardadoEl: actualizado[proveedor],
    };
  };

  // Un estado por procesador, indexado por id: la pantalla se recorre el
  // registro y busca aquí, sin nombrar a ninguno.
  const todos = PROVEEDORES.map((def) => estado(def.id));
  const porId = Object.fromEntries(todos.map((e) => [e.proveedor, e])) as Record<
    MetodoOnline,
    EstadoProveedor
  >;

  const activos = todos.filter((e) => online[e.proveedor]);
  // Una pasarela en PRUEBAS activa es el estado más caro que existe: el panel
  // dice «cobrando» y la clienta llega a una página donde toda tarjeta real se
  // rechaza. Se saca del verde y se avisa aparte.
  const enPruebas = activos.filter((e) => e.salud?.entornoReal === "pruebas");
  const cobranDeVerdad = activos.filter((e) => e.salud?.entornoReal !== "pruebas");
  // «sin-respuesta» también es un problema: sin contarlo, el resumen decía
  // «todo lo conectado respondía bien» justo cuando ninguna había respondido,
  // contradiciendo al banner de la misma pantalla.
  const conProblema = todos.filter(
    (e) => e.fase === "rechazada" || e.fase === "ilegible" || e.fase === "sin-respuesta",
  );
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
          value={enPruebas.length > 0 && cobranDeVerdad.length === 0 ? "En pruebas" : activos.length > 0 ? "Activo" : "Sin activar"}
          hint={
            enPruebas.length > 0 && cobranDeVerdad.length === 0
              ? "No entra dinero: es una cuenta de pruebas"
              : activos.length > 0
                ? "Los pedidos se marcan pagados solos"
                : "Hoy los cobras a mano, uno por uno"
          }
          tone={enPruebas.length > 0 && cobranDeVerdad.length === 0 ? "danger" : activos.length > 0 ? "success" : "warning"}
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

      {enPruebas.length > 0 ? (
        <p className="pag-aviso is-error" role="alert">
          <strong>
            {enPruebas.map((e) => ETIQUETA_PROVEEDOR[e.proveedor]).join(" y ")}{" "}
            {enPruebas.length === 1 ? "está conectada en PRUEBAS" : "están conectadas en PRUEBAS"}.
          </strong>{" "}
          Eso no cobra dinero: a tus clientas les rechazarán la tarjeta. Pega la credencial de
          producción (la que NO lleva «test») y vuelve a comprobar.
        </p>
      ) : null}

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

      {/* La caja de pegar va ANTES de las tarjetas: es el camino corto y tiene
          que ser lo primero que se vea. Las tarjetas quedan debajo para
          corregir un campo suelto o apagar un método. */}
      <CajaPegar />

      <div className="pag-grid">
        {/* Una tarjeta por procesador, generada desde el registro: añadir uno
            nuevo no toca esta pantalla. Antes eran tres bloques de JSX casi
            idénticos y cualquier cambio había que hacerlo tres veces. */}
        {PROVEEDORES.map((def) => {
          const e = porId[def.id];
          return (
            <Card key={def.id} title={<TituloProveedor def={def} />}>
              <LineaEstado e={e} ahora={ahora} />
              <Diagnostico e={e} />
              <form action={conectarProveedor}>
                <input type="hidden" name="proveedor" value={def.id} />
                <div className="pag-cols">
                  {def.campos.map((campo) => (
                    <CampoCredencial key={campo.nombre} def={def} campo={campo} config={config} />
                  ))}
                  <Encender e={e} texto={TEXTO_ENCENDER[def.id]} />
                </div>
                <div className="pag-acciones">
                  <button type="submit" className="adm-btn adm-btn-primary adm-btn-md">
                    Conectar y comprobar
                  </button>
                </div>
              </form>
              <Acciones e={e} />
            </Card>
          );
        })}
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

      {/* La guía solo sale si queda algo por conectar, y solo los pasos de LO
          QUE FALTA: cuando ya está todo hecho, un muro de instrucciones estorba.
          Los textos salen del registro, así que un procesador nuevo trae su
          propia ayuda sin tocar esta pantalla. */}
      {todos.some((e) => e.fase === "sin-conectar") ? (
        <Card title="De dónde sacar la credencial">
          <div className="pag-guia">
            <p>
              Entra en el sitio de tu procesador, copia lo que te dé y pégalo en la caja de arriba.
              No hace falta saber qué campo es: se reconoce por su forma, se comprueba con el
              procesador y se enciende solo si funciona. Si algo falla, su tarjeta te dice qué pasa
              y qué hacer.
            </p>
            <ul className="pag-donde">
              {PROVEEDORES.filter((def) => porId[def.id].fase === "sin-conectar").map((def) => (
                <li key={def.id}>
                  <strong>{def.etiqueta}</strong> — {def.donde}
                  <span className="adm-muted adm-small">
                    {def.campos.map((c) => c.etiqueta).join(" + ")}
                  </span>
                </li>
              ))}
            </ul>
            <p className="adm-muted adm-small">
              Las llaves se guardan cifradas y aquí solo se enseña su final. Un pedido pagado online
              se marca «Pagado» él solo en cuanto el procesador confirma el cobro; si una clienta
              abandona el pago, su pedido queda «Por cobrar» y puedes cancelarlo para liberar el
              stock.
            </p>
          </div>
        </Card>
      ) : null}
    </>
  );
}
