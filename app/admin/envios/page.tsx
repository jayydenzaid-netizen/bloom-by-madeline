import Link from "next/link";
import { requireOwner } from "@/lib/permissions";
import { formatCents, parseToCents } from "@/lib/money";
import {
  cargarAjustesEnvio,
  cargarZonas,
  describirRegiones,
  ESTADOS_US,
  formatearTipo,
  getTaxConfig,
  resolverEnvio,
  resolverImpuesto,
  REGION_RECOGIDA,
  type TarifaEnvio,
  type ZonaEnvio,
} from "@/lib/shipping";
import { Badge, Button, Card, EmptyState, Field, Money, PageHeader, StatCard } from "../_components/ui";
import {
  borrarTarifa,
  borrarZona,
  crearConfiguracionInicial,
  guardarImpuestos,
  guardarTarifa,
  guardarZona,
  moverZona,
} from "./actions";
import { SelectorRegiones } from "./_components/ZoneEditor";
import "./envios.css";

export const dynamic = "force-dynamic";

export const metadata = { title: "Envíos e impuestos" };

/** Los mensajes viven aquí, no en la URL: así nadie puede fabricar un cartel. */
const HECHOS: Record<string, { texto: string; tono: "ok" | "aviso" }> = {
  "zona-guardada": { texto: "Zona guardada.", tono: "ok" },
  "zona-borrada": { texto: "Zona borrada con sus tarifas.", tono: "ok" },
  "tarifa-guardada": { texto: "Tarifa guardada.", tono: "ok" },
  "tarifa-borrada": { texto: "Tarifa borrada.", tono: "ok" },
  "inicial-creada": { texto: "Configuración inicial creada. Revísala y ajusta los precios.", tono: "ok" },
  "impuestos-guardados": { texto: "Ajustes de impuesto guardados.", tono: "ok" },
  "ya-hay-zonas": { texto: "Ya había zonas configuradas, no se ha tocado nada.", tono: "aviso" },
  "no-existe": { texto: "Eso ya no existe: alguien lo borró antes.", tono: "aviso" },
};

const ERRORES: Record<string, string> = {
  nombre: "Hace falta un nombre.",
  regiones: "Elige al menos una región para la zona.",
  negativo: "Los importes no pueden ser negativos.",
  tramo: "El tope del tramo no puede ser menor que el mínimo.",
  tipo: "El tipo de impuesto no se entiende. Escríbelo como 7.8",
  "tipo-alto": "Ese tipo es demasiado alto para ser real. Compruébalo.",
  "sin-confirmar":
    "Para cobrar impuesto hace falta un tipo mayor que cero y escribir quién lo confirmó.",
};

type Params = Promise<Record<string, string | string[] | undefined>>;

export default async function EnviosPage({ searchParams }: { searchParams: Params }) {
  const admin = await requireOwner("envios");

  const sp = await searchParams;
  const uno = (k: string) => (Array.isArray(sp[k]) ? sp[k]?.[0] : sp[k]) ?? "";

  const [zonas, ajustes, impuestos] = await Promise.all([
    cargarZonas(),
    cargarAjustesEnvio(),
    getTaxConfig(),
  ]);

  const hecho = HECHOS[uno("hecho")];
  const error = ERRORES[uno("error")];

  const zonaAbierta = uno("zona"); // id de zona o "nueva"
  const tarifaAbierta = uno("tarifa"); // id de tarifa o "nueva-<zoneId>"
  const zonaABorrar = uno("borrarZona");

  const totalTarifas = zonas.reduce((s, z) => s + z.rates.length, 0);

  /* ── simulador: todo por la URL, así el resultado se puede compartir ── */
  const simSubtotal = uno("sub");
  const simEstado = uno("est") || "OH";
  const hayConsulta = simSubtotal !== "";
  const subtotalCents = hayConsulta ? parseToCents(simSubtotal) ?? 0 : 5000;

  const simulacion = resolverEnvio(subtotalCents, { state: simEstado, country: "US" }, { zonas, ajustes });
  const simImpuesto = resolverImpuesto(subtotalCents, { state: simEstado, country: "US" }, impuestos);

  return (
    <>
      <PageHeader
        title="Envíos e impuestos"
        subtitle={
          zonas.length === 0
            ? "Sin zonas configuradas — la tienda usa los importes de Ajustes"
            : `${zonas.length} ${zonas.length === 1 ? "zona" : "zonas"} · ${totalTarifas} ${totalTarifas === 1 ? "tarifa" : "tarifas"}`
        }
        actions={
          <Button href="/admin/envios?zona=nueva" variant={zonas.length === 0 ? "ghost" : "primary"}>
            Nueva zona
          </Button>
        }
      />

      {hecho ? <p className={`env-aviso ${hecho.tono === "ok" ? "is-ok" : "is-aviso"}`}>{hecho.texto}</p> : null}
      {error ? <p className="env-aviso is-error">{error}</p> : null}

      <div className="adm-grid env-stats">
        <StatCard
          label="Zonas configuradas"
          value={String(zonas.length)}
          hint={zonas.length === 0 ? "Se usan los ajustes generales" : "De la más concreta a la más amplia"}
          tone={zonas.length === 0 ? "warning" : "default"}
        />
        <StatCard label="Tarifas" value={String(totalTarifas)} hint="Opciones que puede elegir la clienta" />
        <StatCard
          label="Envío gratis desde"
          value={ajustes.freeShippingOverCents > 0 ? formatCents(ajustes.freeShippingOverCents) : "—"}
          hint="Se cambia en Ajustes"
        />
        <StatCard
          label="Impuesto"
          value={impuestos.activo ? formatearTipo(impuestos.rateBps) : "No se cobra"}
          hint={impuestos.activo ? impuestos.etiqueta : "Pendiente de confirmar con tu contable"}
          tone={impuestos.activo ? "success" : "warning"}
        />
      </div>

      {/* ─────────────── formulario de zona ─────────────── */}
      {zonaAbierta ? (
        <FormularioZona
          zona={zonaAbierta === "nueva" ? null : zonas.find((z) => z.id === zonaAbierta) ?? null}
        />
      ) : null}

      {/* ─────────────── confirmación de borrado ─────────────── */}
      {zonaABorrar ? (
        <ConfirmarBorradoZona zona={zonas.find((z) => z.id === zonaABorrar) ?? null} />
      ) : null}

      {/* ─────────────── listado de zonas ─────────────── */}
      {zonas.length === 0 ? (
        <Card title="Todavía no hay zonas">
          <EmptyState
            title="La tienda está cobrando el envío de los Ajustes generales"
            text={
              <>
                Ahora mismo se cobra{" "}
                <strong>{formatCents(ajustes.flatShippingCents)}</strong> de envío
                {ajustes.freeShippingOverCents > 0 ? (
                  <>
                    , gratis a partir de <strong>{formatCents(ajustes.freeShippingOverCents)}</strong>
                  </>
                ) : null}
                {ajustes.localPickup ? ", y se ofrece recoger en la boutique" : ""}. Eso funciona,
                pero no distingue entre Ohio y el resto del país. Las zonas te dejan cobrar distinto
                según a dónde va el paquete.
              </>
            }
            action={
              <form action={crearConfiguracionInicial}>
                <Button type="submit">Crear la configuración inicial</Button>
              </form>
            }
          />
          <p className="adm-muted adm-small env-nota">
            Crea tres zonas con lo que ya cobras hoy: <strong>Ohio</strong>, <strong>Estados
            Unidos</strong> y <strong>recogida en la boutique</strong>. No se inventa ningún precio:
            salen de tus ajustes. Después las ajustas a mano.
          </p>
        </Card>
      ) : (
        zonas.map((zona, i) => (
          <TarjetaZona
            key={zona.id}
            zona={zona}
            esPrimera={i === 0}
            esUltima={i === zonas.length - 1}
            tarifaAbierta={tarifaAbierta}
          />
        ))
      )}

      {/* ─────────────── simulador ─────────────── */}
      <Card
        title="Simulador"
        actions={<span className="adm-muted adm-small">Lo que vería tu clienta</span>}
      >
        <p className="adm-small env-nota">
          Antes de fiarte de lo que has configurado, compruébalo: escribe un importe y un estado y
          mira exactamente qué opciones le saldrían al pagar.
        </p>

        <form method="get" className="env-sim-form">
          <Field label="Subtotal del pedido" htmlFor="sub">
            <input
              id="sub"
              name="sub"
              type="text"
              inputMode="decimal"
              placeholder="50.00"
              defaultValue={simSubtotal}
            />
          </Field>
          <Field label="Estado de destino" htmlFor="est">
            <select id="est" name="est" defaultValue={simEstado}>
              {ESTADOS_US.map((e) => (
                <option key={e.code} value={e.code}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="env-sim-accion">
            <Button type="submit" variant="ghost">
              Calcular
            </Button>
          </div>
        </form>

        <div className="env-sim-res">
          <p className="env-sim-cab">
            Para un pedido de <strong>{formatCents(subtotalCents)}</strong> con destino{" "}
            <strong>{ESTADOS_US.find((e) => e.code === simEstado)?.name ?? simEstado}</strong>:
          </p>

          <ul className="env-sim-lista">
            {simulacion.opciones.map((op) => (
              <li key={op.id}>
                <span className="env-sim-nombre">
                  {op.name}
                  {op.esRecogida ? <Badge tone="info">Recogida</Badge> : null}
                </span>
                <span className="env-sim-precio">
                  {op.priceCents === 0 ? <strong>Gratis</strong> : <Money cents={op.priceCents} />}
                </span>
                <span className="env-sim-eta">{op.etaLabel || op.nota || "—"}</span>
              </li>
            ))}
          </ul>

          <p className="adm-small env-sim-pie">
            {simulacion.origen === "zonas" ? (
              <>
                Sale de la zona <strong>{simulacion.zona?.name}</strong>.
              </>
            ) : (
              <>Sale de los ajustes generales, porque ninguna zona cubre ese destino.</>
            )}{" "}
            {simImpuesto.aplicado ? (
              <>
                Se añadirían <Money cents={simImpuesto.taxCents} /> de {simImpuesto.etiqueta}.
              </>
            ) : (
              simImpuesto.nota
            )}
          </p>

          {simulacion.notas.length > 0 ? (
            <ul className="env-sim-notas">
              {simulacion.notas.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>

      {/* ─────────────── impuestos ─────────────── */}
      <div id="impuestos">
        <Card title="Impuesto sobre ventas">
          <div className="env-tax-aviso">
            <strong>Esto no se puede rellenar a ojo.</strong> Hamilton está en el condado de Butler,
            que suma su propio recargo al tipo del estado de Ohio, y el tipo aplicable depende
            además de qué vendes y de dónde lo mandas. Pregúntaselo a tu contable, escribe aquí el
            número que te diga y anota su nombre. Mientras no lo hagas, la tienda{" "}
            <strong>no cobra impuesto</strong>, que es preferible a cobrarlo mal.
          </div>

          <form action={guardarImpuestos} className="env-tax-form">
            <Field label="Tipo aplicable" htmlFor="rate" hint="Escríbelo en porcentaje. Por ejemplo: 7.8">
              <input
                id="rate"
                name="rate"
                type="text"
                inputMode="decimal"
                placeholder="0"
                defaultValue={impuestos.rateBps > 0 ? (impuestos.rateBps / 100).toFixed(2) : ""}
              />
            </Field>

            <Field label="Cómo se llama en el recibo" htmlFor="etiqueta">
              <input id="etiqueta" name="etiqueta" type="text" defaultValue={impuestos.etiqueta} />
            </Field>

            <Field
              label="Quién te confirmó este tipo"
              htmlFor="confirmadoPor"
              hint="El nombre de tu contable o asesor, y la fecha si quieres. Queda anotado aquí."
            >
              <input
                id="confirmadoPor"
                name="confirmadoPor"
                type="text"
                placeholder="Sin confirmar"
                defaultValue={impuestos.confirmadoPor}
              />
            </Field>

            <Field label="Dónde se cobra" hint="Normalmente solo tu propio estado.">
              <SelectorRegiones seleccion={impuestos.estados} nombre="estados" />
            </Field>

            <label className="env-check">
              <input type="checkbox" name="activo" defaultChecked={impuestos.activo} />
              <span>
                Cobrar este impuesto en los pedidos
                <em>Solo se puede activar con un tipo escrito y confirmado.</em>
              </span>
            </label>

            <Button type="submit">Guardar impuestos</Button>
          </form>
        </Card>
      </div>
    </>
  );
}

/* ─────────────────────────── piezas de la pantalla ─────────────────────────── */

function TarjetaZona({
  zona,
  esPrimera,
  esUltima,
  tarifaAbierta,
}: {
  zona: ZonaEnvio;
  esPrimera: boolean;
  esUltima: boolean;
  tarifaAbierta: string;
}) {
  const esRecogida = zona.regions.includes(REGION_RECOGIDA);

  return (
    <Card
      title={
        <span className="env-zona-tit">
          {zona.name}
          {esRecogida ? <Badge tone="info">Recogida</Badge> : null}
        </span>
      }
      actions={
        <span className="adm-row">
          <form action={moverZona}>
            <input type="hidden" name="id" value={zona.id} />
            <input type="hidden" name="direccion" value="arriba" />
            <Button type="submit" variant="ghost" size="sm" disabled={esPrimera} aria-label="Subir zona">
              ↑
            </Button>
          </form>
          <form action={moverZona}>
            <input type="hidden" name="id" value={zona.id} />
            <input type="hidden" name="direccion" value="abajo" />
            <Button type="submit" variant="ghost" size="sm" disabled={esUltima} aria-label="Bajar zona">
              ↓
            </Button>
          </form>
          <Button href={`/admin/envios?zona=${zona.id}`} variant="ghost" size="sm">
            Editar
          </Button>
          <Button href={`/admin/envios?borrarZona=${zona.id}`} variant="danger" size="sm">
            Borrar
          </Button>
        </span>
      }
    >
      <p className="env-zona-reg">{describirRegiones(zona.regions)}</p>

      {zona.rates.length === 0 ? (
        <p className="env-zona-vacia">
          Esta zona no tiene ninguna tarifa, así que <strong>no se ofrece</strong> a la clienta.
          Añádele al menos una.
        </p>
      ) : (
        <ul className="env-tarifas">
          {zona.rates.map((t) => (
            <FilaTarifa key={t.id} tarifa={t} zoneId={zona.id} abierta={tarifaAbierta === t.id} />
          ))}
        </ul>
      )}

      {tarifaAbierta === `nueva-${zona.id}` ? (
        <FormularioTarifa zoneId={zona.id} tarifa={null} />
      ) : (
        <Button href={`/admin/envios?tarifa=nueva-${zona.id}`} variant="ghost" size="sm">
          Añadir tarifa
        </Button>
      )}
    </Card>
  );
}

function FilaTarifa({
  tarifa,
  zoneId,
  abierta,
}: {
  tarifa: TarifaEnvio;
  zoneId: string;
  abierta: boolean;
}) {
  if (abierta) {
    return (
      <li className="env-tarifa is-editando">
        <FormularioTarifa zoneId={zoneId} tarifa={tarifa} />
      </li>
    );
  }

  const tramo =
    tarifa.minSubtotalCents === 0 && tarifa.maxSubtotalCents === 0
      ? "Cualquier importe"
      : tarifa.maxSubtotalCents === 0
        ? `Desde ${formatCents(tarifa.minSubtotalCents)}`
        : `De ${formatCents(tarifa.minSubtotalCents)} a ${formatCents(tarifa.maxSubtotalCents)}`;

  return (
    <li className="env-tarifa">
      <span className="env-tarifa-nombre">{tarifa.name}</span>
      <span className="env-tarifa-precio">
        {tarifa.priceCents === 0 ? <strong>Gratis</strong> : <Money cents={tarifa.priceCents} />}
      </span>
      <span className="env-tarifa-tramo">{tramo}</span>
      <span className="env-tarifa-eta">{tarifa.etaLabel || "—"}</span>
      <span className="env-tarifa-acc">
        <Link className="adm-link" href={`/admin/envios?tarifa=${tarifa.id}`}>
          Editar
        </Link>
        <form action={borrarTarifa}>
          <input type="hidden" name="id" value={tarifa.id} />
          <Button type="submit" variant="ghost" size="sm">
            Borrar
          </Button>
        </form>
      </span>
    </li>
  );
}

function FormularioTarifa({ zoneId, tarifa }: { zoneId: string; tarifa: TarifaEnvio | null }) {
  return (
    <form action={guardarTarifa} className="env-tarifa-form">
      <input type="hidden" name="zoneId" value={zoneId} />
      {tarifa ? <input type="hidden" name="id" value={tarifa.id} /> : null}

      <Field label="Nombre" htmlFor={`t-name-${tarifa?.id ?? "nueva"}`} required>
        <input
          id={`t-name-${tarifa?.id ?? "nueva"}`}
          name="name"
          type="text"
          placeholder="Envío estándar"
          defaultValue={tarifa?.name ?? ""}
          required
        />
      </Field>

      <Field label="Precio" htmlFor={`t-price-${tarifa?.id ?? "nueva"}`} hint="Escribe 0 para envío gratis.">
        <input
          id={`t-price-${tarifa?.id ?? "nueva"}`}
          name="price"
          type="text"
          inputMode="decimal"
          placeholder="6.95"
          defaultValue={tarifa ? (tarifa.priceCents / 100).toFixed(2) : ""}
        />
      </Field>

      <Field label="Desde este subtotal" htmlFor={`t-min-${tarifa?.id ?? "nueva"}`} hint="0 = sin mínimo.">
        <input
          id={`t-min-${tarifa?.id ?? "nueva"}`}
          name="min"
          type="text"
          inputMode="decimal"
          defaultValue={tarifa ? (tarifa.minSubtotalCents / 100).toFixed(2) : "0"}
        />
      </Field>

      <Field label="Hasta este subtotal" htmlFor={`t-max-${tarifa?.id ?? "nueva"}`} hint="0 = sin tope.">
        <input
          id={`t-max-${tarifa?.id ?? "nueva"}`}
          name="max"
          type="text"
          inputMode="decimal"
          defaultValue={tarifa ? (tarifa.maxSubtotalCents / 100).toFixed(2) : "0"}
        />
      </Field>

      <Field
        label="Plazo estimado"
        htmlFor={`t-eta-${tarifa?.id ?? "nueva"}`}
        hint="Lo lee tu clienta tal cual. Por ejemplo: 3 a 5 días hábiles."
      >
        <input
          id={`t-eta-${tarifa?.id ?? "nueva"}`}
          name="eta"
          type="text"
          placeholder="3 a 5 días hábiles"
          defaultValue={tarifa?.etaLabel ?? ""}
        />
      </Field>

      <div className="adm-row env-form-acc">
        <Button type="submit">{tarifa ? "Guardar tarifa" : "Añadir tarifa"}</Button>
        <Link className="adm-link" href="/admin/envios">
          Cancelar
        </Link>
      </div>
    </form>
  );
}

function FormularioZona({ zona }: { zona: ZonaEnvio | null }) {
  return (
    <Card title={zona ? `Editar «${zona.name}»` : "Nueva zona"}>
      <form action={guardarZona} className="env-zona-form">
        {zona ? <input type="hidden" name="id" value={zona.id} /> : null}

        <Field label="Nombre de la zona" htmlFor="z-name" required hint="Solo lo ves tú.">
          <input
            id="z-name"
            name="name"
            type="text"
            placeholder="Ohio"
            defaultValue={zona?.name ?? ""}
            required
          />
        </Field>

        <Field
          label="Qué cubre"
          hint="La zona más concreta gana: si tienes Ohio y Estados Unidos, una clienta de Ohio verá las tarifas de Ohio."
        >
          <SelectorRegiones seleccion={zona?.regions ?? []} />
        </Field>

        <div className="adm-row env-form-acc">
          <Button type="submit">{zona ? "Guardar zona" : "Crear zona"}</Button>
          <Link className="adm-link" href="/admin/envios">
            Cancelar
          </Link>
        </div>
      </form>
    </Card>
  );
}

function ConfirmarBorradoZona({ zona }: { zona: ZonaEnvio | null }) {
  if (!zona) return null;

  return (
    <Card title="Confirmar el borrado">
      <p className="env-borrar-txt">
        Vas a borrar la zona <strong>{zona.name}</strong>
        {zona.rates.length > 0 ? (
          <>
            {" "}
            y sus <strong>{zona.rates.length}</strong>{" "}
            {zona.rates.length === 1 ? "tarifa" : "tarifas"}
          </>
        ) : null}
        . Los pedidos que ya se hicieron con ella no cambian: guardan su envío cobrado.
      </p>
      <form action={borrarZona} className="adm-row">
        <input type="hidden" name="id" value={zona.id} />
        <input type="hidden" name="confirmado" value="si" />
        <Button type="submit" variant="danger">
          Sí, borrar la zona
        </Button>
        <Link className="adm-link" href="/admin/envios">
          Cancelar
        </Link>
      </form>
    </Card>
  );
}
