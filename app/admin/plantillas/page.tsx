import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "../_components/ui";
import { BotonCopiar } from "../herramientas/_components/SeoPanel";
import { crearPlantillasQueFaltan, guardarPlantilla, restaurarPlantilla } from "./actions";
import "../herramientas/herramientas.css";

/**
 * Plantillas de los mensajes que Madeline manda a sus clientas.
 *
 * La pantalla dice la verdad desde el primer párrafo: hoy NO hay servicio de
 * correo conectado, así que esto no envía nada solo. Sirve para tener el
 * mensaje escrito una vez, con los datos del pedido ya puestos, y copiarlo al
 * DM de Instagram, que es por donde Bloom vende de verdad.
 *
 * Prometer un envío automático que no existe sería la forma más rápida de que
 * una clienta se quede esperando un correo que nunca sale.
 */
export const dynamic = "force-dynamic";

/* ─────────────────────────── catálogo de plantillas ─────────────────────────── */

type Variable = { nombre: string; explicacion: string };

const COMUNES: Variable[] = [
  { nombre: "nombre", explicacion: "Nombre de la clienta" },
  { nombre: "tienda", explicacion: "Bloom by Madeline" },
  { nombre: "instagram", explicacion: "Tu Instagram" },
];

const DEL_PEDIDO: Variable[] = [
  { nombre: "numero", explicacion: "Número del pedido" },
  { nombre: "fecha", explicacion: "Fecha del pedido" },
  { nombre: "articulos", explicacion: "Lista de prendas" },
  { nombre: "total", explicacion: "Total a pagar" },
];

/** Metadatos de pantalla. Las claves tienen que coincidir con las de actions.ts. */
const PLANTILLAS: {
  key: string;
  titulo: string;
  cuando: string;
  variables: Variable[];
  /** Aviso extra cuando otra pantalla del panel ya usa esta plantilla. */
  nota?: string;
}[] = [
  {
    key: "order_confirmation",
    titulo: "Confirmación de pedido",
    cuando: "Nada más recibir un pedido, para que la clienta sepa que lo tienes y qué pidió.",
    variables: [...COMUNES, ...DEL_PEDIDO],
  },
  {
    key: "order_shipped",
    titulo: "Pedido enviado",
    cuando: "Cuando el paquete sale, con el transportista y el número de seguimiento.",
    variables: [
      ...COMUNES,
      ...DEL_PEDIDO,
      { nombre: "transportista", explicacion: "USPS, UPS…" },
      { nombre: "seguimiento", explicacion: "Número de seguimiento" },
    ],
  },
  {
    key: "abandoned_cart",
    titulo: "Carrito abandonado",
    cuando: "Para quien llenó el carrito y no terminó. Es el mensaje que más ventas recupera.",
    // Esta plantilla no se queda aquí: la pantalla de Carritos la lee y rellena
    // sola. Por eso la lista de variables es la que ESA pantalla sustituye de
    // verdad, no la que a mí me gustaría que existiera.
    nota: "Esta es la que usa la pantalla de Carritos: allí sale ya rellenada con el carrito de cada clienta, lista para copiar.",
    variables: [
      { nombre: "saludo", explicacion: "«Hola Ana» (o «Hola» si no sabemos el nombre)" },
      ...COMUNES,
      { nombre: "articulos", explicacion: "Lo que se dejó" },
      { nombre: "total", explicacion: "Total del carrito" },
      { nombre: "horario", explicacion: "Tu horario de la boutique" },
      { nombre: "enlace", explicacion: "Enlace para terminar" },
    ],
  },
];

/* ─────────────────────────── vista previa ─────────────────────────── */

/**
 * Sustituye `{{variable}}` por su valor.
 *
 * Lo que no reconoce lo deja tal cual, a propósito: si Madeline escribe
 * `{{nombrre}}`, tiene que VERLO en la vista previa en vez de encontrarse un
 * hueco vacío en el mensaje que ya mandó.
 */
function rellenar(texto: string, datos: Record<string, string>): string {
  return texto.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (original, clave: string) => datos[clave] ?? original);
}

export default async function PlantillasPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const [ajustes, guardadas] = await Promise.all([
    getSettings(),
    db.emailTemplate.findMany({ orderBy: { key: "asc" } }),
  ]);

  const porClave = new Map(guardadas.map((p) => [p.key, p]));
  const faltan = PLANTILLAS.filter((p) => !porClave.has(p.key));

  /**
   * Datos de EJEMPLO para la vista previa. No son un pedido real ni datos de
   * ninguna clienta: son un pedido de mentira para ver cómo queda el mensaje.
   * Lo único real es lo que sale de los ajustes de la tienda.
   */
  const ejemplo: Record<string, string> = {
    nombre: "Ana",
    saludo: "Hola Ana",
    horario: ajustes.hours,
    tienda: ajustes.storeName,
    instagram: ajustes.instagram ? `@${ajustes.instagram}` : "",
    numero: "BLM-1001",
    fecha: new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "long", year: "numeric" }).format(new Date()),
    articulos: "· 1 × Vestido de ejemplo (talla M) — " + formatCents(4599),
    total: formatCents(4599),
    transportista: "USPS",
    seguimiento: "9400 1111 2222 3333 4444 55",
    enlace: "https://…/carrito",
  };

  return (
    <>
      <PageHeader
        title="Plantillas de mensajes"
        subtitle="Los mensajes que le mandas a la clienta, escritos una vez y listos para copiar."
      />

      {sp.ok ? <div className="hrr-aviso hrr-aviso-ok">{sp.ok}</div> : null}
      {sp.error ? <div className="hrr-aviso hrr-aviso-mal">{sp.error}</div> : null}

      {/* El aviso honesto. Va antes que nada: nadie debe irse de esta pantalla
          creyendo que la tienda ya escribe sola a las clientas. */}
      <div className="hrr-honesto">
        <b>Estos mensajes todavía NO se envían solos</b>
        <p>
          La tienda no tiene ningún servicio de correo conectado, así que guardar aquí un mensaje no manda nada a nadie.
          Lo que hace esta pantalla es tenerlo escrito y listo: le das a <strong>Copiar mensaje</strong>, lo pegas en el
          DM de Instagram —que es por donde vendes de verdad— y solo cambias el nombre y el número del pedido.
        </p>
        <p>
          Cuando quieras que salgan solos, hay que contratar un proveedor de correo y poner su clave en la
          configuración. Los textos que escribas hoy se aprovechan tal cual ese día; no habría que volver a escribirlos.
        </p>
      </div>

      {faltan.length === PLANTILLAS.length ? (
        <Card title="Empieza por aquí">
          <EmptyState
            title="Todavía no hay mensajes escritos"
            text="Te preparo los tres del ciclo de una venta (confirmación, envío y carrito abandonado) con un texto de partida. Luego los cambias a tu manera de escribir."
            action={
              <form action={crearPlantillasQueFaltan}>
                <Button type="submit">Crear los tres mensajes</Button>
              </form>
            }
          />
        </Card>
      ) : null}

      {faltan.length > 0 && faltan.length < PLANTILLAS.length ? (
        <Card title="Te faltan mensajes">
          <p className="hrr-pista">
            Faltan {faltan.length} de los tres mensajes del ciclo de una venta: {faltan.map((f) => f.titulo).join(", ")}.
          </p>
          <form action={crearPlantillasQueFaltan}>
            <Button type="submit" variant="ghost">
              Crear los que faltan
            </Button>
          </form>
        </Card>
      ) : null}

      {PLANTILLAS.map((meta) => {
        const guardada = porClave.get(meta.key);
        if (!guardada) return null;

        const asuntoPrevio = rellenar(guardada.subject, ejemplo);
        const cuerpoPrevio = rellenar(guardada.body, ejemplo);

        return (
          <Card
            key={meta.key}
            title={meta.titulo}
            actions={guardada.isActive ? <Badge tone="success">En uso</Badge> : <Badge tone="neutral">Apagado</Badge>}
          >
            <p className="hrr-pista">{meta.cuando}</p>
            {meta.nota ? <p className="hrr-nota">{meta.nota}</p> : null}

            <ul className="hrr-vars">
              {meta.variables.map((v) => (
                <li className="hrr-var" key={`${meta.key}-${v.nombre}`}>
                  <code>{`{{${v.nombre}}}`}</code>
                  <span>{v.explicacion}</span>
                </li>
              ))}
            </ul>

            <div className="hrr-plantilla-cols">
              <form action={guardarPlantilla} className="hrr-plantilla-form">
                <input type="hidden" name="key" value={meta.key} />

                <Field label="Asunto" htmlFor={`s-${meta.key}`} required hint="En Instagram es la primera línea del mensaje.">
                  <input id={`s-${meta.key}`} name="subject" type="text" defaultValue={guardada.subject} required />
                </Field>

                <Field label="Mensaje" htmlFor={`b-${meta.key}`} required>
                  <textarea id={`b-${meta.key}`} name="body" defaultValue={guardada.body} required />
                </Field>

                <Field label="¿Lo usas?" htmlFor={`a-${meta.key}`}>
                  <select id={`a-${meta.key}`} name="isActive" defaultValue={guardada.isActive ? "1" : "0"}>
                    <option value="1">Sí, lo uso</option>
                    <option value="0">No, guardado pero apagado</option>
                  </select>
                </Field>

                <div className="adm-row">
                  <Button type="submit">Guardar</Button>
                  <Button type="submit" variant="ghost" formAction={restaurarPlantilla}>
                    Volver al texto de partida
                  </Button>
                </div>
              </form>

              <div>
                <p className="adm-small adm-muted">
                  Así queda con un pedido de ejemplo (nombre, número y precio inventados solo para la vista previa):
                </p>
                <div className="hrr-vista">
                  <div className="hrr-vista-asunto">{asuntoPrevio}</div>
                  <p className="hrr-vista-cuerpo">{cuerpoPrevio}</p>
                </div>
                <div className="hrr-copiar">
                  <BotonCopiar texto={`${asuntoPrevio}\n\n${cuerpoPrevio}`} />
                </div>
              </div>
            </div>
          </Card>
        );
      })}

      <p className="hrr-pie">
        Las copias de seguridad, el SEO y la limpieza están en{" "}
        <Link className="adm-link" href="/admin/herramientas">
          Herramientas
        </Link>
        .
      </p>
    </>
  );
}
