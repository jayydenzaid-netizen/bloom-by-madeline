import Link from "next/link";
import { z } from "zod";
import { getAdminConRol, requireOwner } from "@/lib/permissions";
import { db } from "@/lib/db";
import {
  ATAJOS,
  byPaymentMethod,
  claveDia,
  csvDelInforme,
  customerStats,
  diasDelRango,
  etiquetaDiaCorta,
  etiquetaDiaLarga,
  etiquetaRango,
  hayVentasAlgunaVez,
  inicioDelDia,
  profitReport,
  resolverRango,
  salesByChannel,
  salesByDay,
  summary,
  textoVariacion,
  topProducts,
  type ClientaTop,
  type ProductoTop,
  type Reparto,
  type Variacion,
} from "@/lib/reports";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Money,
  PageHeader,
  StatCard,
  type Column,
} from "../_components/ui";
import { Grafica, type PuntoGrafica } from "./_components/Grafica";
import { BotonCSV, RangoFechas } from "./_components/RangoFechas";
import "./informes.css";

/**
 * Informes y analítica.
 *
 * Qué tiene que poder responder esta pantalla, en este orden: cuánto he vendido,
 * si voy mejor o peor que antes, qué se vende, cuánto me queda limpio, por dónde
 * entra el dinero y quién compra. Nada más.
 *
 * Todos los números salen de `lib/reports.ts`, que solo cuenta pedidos cobrados.
 * Si algo aparece a cero es porque de verdad está a cero: aquí no hay ni un dato
 * de ejemplo, ni una media inventada, ni un margen calculado sobre costes que
 * nadie rellenó.
 */

export const dynamic = "force-dynamic";

/* ─────────────────────── registro de la exportación ─────────────────────── */

const EsquemaExportacion = z.object({
  etiqueta: z.string().min(1).max(160),
  filas: z.number().int().min(0).max(5000),
});

/**
 * Deja constancia de que alguien se llevó las ventas de la tienda en un fichero.
 * Es la única acción con efecto de esta pantalla, y conviene que quede rastro
 * en cuanto haya más de una persona con acceso al panel.
 *
 * Devuelve un resultado tipado en vez de lanzar: si el registro falla, la
 * descarga ya ocurrió y no tiene sentido reventarle la pantalla a Madeline.
 * No lleva `revalidatePath` a propósito: no cambia nada de lo que se está viendo.
 */
async function registrarExportacion(datos: { etiqueta: string; filas: number }): Promise<{
  ok: boolean;
  error?: string;
}> {
  "use server";

  const validado = EsquemaExportacion.safeParse(datos);
  if (!validado.success) return { ok: false, error: "Datos de la exportación no válidos." };

  const admin = await getAdminConRol();
  if (!admin || admin.role !== "owner") {
    return { ok: false, error: "Solo la dueña puede exportar informes." };
  }

  try {
    await db.activityLog.create({
      data: {
        userId: admin.id,
        userEmail: admin.email,
        action: "export",
        entityType: "report",
        summary: `Exportó el informe de ventas (${validado.data.etiqueta})`,
        metaJson: JSON.stringify({ formato: "csv", dias: validado.data.filas }),
      },
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "No se pudo guardar el registro de la descarga." };
  }
}

/* ─────────────────────────────── pantalla ─────────────────────────────── */

export default async function InformesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Defensa en profundidad (ver _ADMIN_UI.md §1): esta pantalla resume la
  // facturación entera de la tienda, no puede filtrarse en un payload RSC.
  const admin = await requireOwner("informes");

  const params = await searchParams;
  const uno = (clave: string): string => {
    const crudo = params[clave];
    return (Array.isArray(crudo) ? crudo[0] : crudo)?.trim() ?? "";
  };

  const { key, rango } = resolverRango({ rango: uno("rango"), desde: uno("desde"), hasta: uno("hasta") });
  const ordenTop = uno("orden") === "ingresos" ? "ingresos" : "unidades";
  const etiqueta = etiquetaRango(rango);
  const dias = diasDelRango(rango);

  // Antes de nada: ¿ha cobrado la tienda algo alguna vez? Si no, un panel lleno
  // de ceros y gráficas planas no informa de nada; lo útil es explicar qué va a
  // aparecer aquí y cómo llega el primer pedido.
  if (!(await hayVentasAlgunaVez())) {
    return (
      <>
        <PageHeader
          title="Informes"
          subtitle="Cuánto vendes, qué se vende y cuánto te queda limpio."
        />
        <Card>
          <EmptyState
            icon={<IconGrafica />}
            title="Todavía no hay ventas que contar"
            text="En cuanto cobres el primer pedido, esta pantalla se llena sola: ventas de cada día, comparación con el periodo anterior, productos más vendidos, margen, y cuánto entra por la web frente al mostrador. Solo cuenta los pedidos marcados como pagados, así que recuerda marcarlos al cobrar."
            action={
              <>
                <Button href="/admin/pedidos">Ver pedidos</Button>
                <Button href="/admin/productos" variant="ghost">
                  Revisar el catálogo
                </Button>
              </>
            }
          />
        </Card>
      </>
    );
  }

  const [resumen, serie, tops, beneficio, canales, metodos, clientas] = await Promise.all([
    summary(rango.desde, rango.hasta),
    salesByDay(rango.desde, rango.hasta),
    topProducts(rango.desde, rango.hasta, 10),
    profitReport(rango.desde, rango.hasta),
    salesByChannel(rango.desde, rango.hasta),
    byPaymentMethod(rango.desde, rango.hasta),
    customerStats(rango.desde, rango.hasta, 8),
  ]);

  const productos = ordenTop === "ingresos" ? tops.porIngresos : tops.porUnidades;
  const hayDatos = resumen.actual.pedidos > 0;

  const puntos: PuntoGrafica[] = serie.map((p) => ({
    dia: p.dia,
    // Las etiquetas se formatean aquí, en el servidor: así el componente cliente
    // no depende de qué idiomas tenga instalados el navegador de Madeline.
    etiqueta: etiquetaDiaCorta(p.fecha),
    etiquetaLarga: etiquetaDiaLarga(p.fecha),
    ingresosCents: p.ingresosCents,
    pedidos: p.pedidos,
  }));

  const csv = csvDelInforme({
    etiqueta,
    resumen,
    serie,
    productos: tops.porIngresos,
    beneficio,
    canales,
    metodos,
    clientas,
  });
  const ultimoDia = inicioDelDia(new Date(rango.hasta.getTime() - 1));
  const nombreCsv = `bloom-informe-${claveDia(rango.desde)}_${claveDia(ultimoDia)}.csv`;

  // Enlace que cambia el orden del top sin perder el periodo elegido.
  const enlaceOrden = (orden: "unidades" | "ingresos"): string => {
    const qs = new URLSearchParams();
    if (key === "personalizado") {
      qs.set("desde", claveDia(rango.desde));
      qs.set("hasta", claveDia(ultimoDia));
    } else {
      qs.set("rango", key);
    }
    if (orden !== "unidades") qs.set("orden", orden);
    return `/admin/informes?${qs.toString()}`;
  };

  const etiquetaAtajo = ATAJOS.find((a) => a.key === key)?.label ?? "Periodo a medida";

  return (
    <>
      <PageHeader
        title="Informes"
        subtitle={`${etiquetaAtajo} · ${etiqueta} · solo pedidos cobrados`}
        actions={
          <BotonCSV csv={csv} nombre={nombreCsv} etiqueta={etiqueta} filas={serie.length} registrar={registrarExportacion} />
        }
      />

      <Card title="Periodo">
        <RangoFechas
          atajos={ATAJOS}
          activo={key}
          desde={claveDia(rango.desde)}
          hasta={claveDia(ultimoDia)}
          hoy={claveDia(new Date())}
        />
        <p className="inf-nota inf-sep">
          El periodo viaja en la dirección de la página: puedes guardar este informe en tus marcadores o
          copiar el enlace y mandarlo tal cual.
        </p>
      </Card>

      <div className="adm-grid">
        <StatCard
          label="Ingresos"
          value={<Money cents={resumen.actual.ingresosCents} />}
          tone="accent"
          hint={<VariacionTexto v={resumen.variacion.ingresos} />}
        />
        <StatCard
          label="Pedidos"
          value={resumen.actual.pedidos}
          hint={<VariacionTexto v={resumen.variacion.pedidos} />}
        />
        <StatCard
          label="Ticket medio"
          value={resumen.actual.ticketMedioCents === null ? "—" : <Money cents={resumen.actual.ticketMedioCents} />}
          hint={
            resumen.actual.ticketMedioCents === null ? (
              "Sin pedidos que promediar"
            ) : (
              <VariacionTexto v={resumen.variacion.ticketMedio} />
            )
          }
        />
        <StatCard
          label="Unidades vendidas"
          value={resumen.actual.unidades}
          hint={<VariacionTexto v={resumen.variacion.unidades} />}
        />
      </div>

      <Card
        title="Ventas por día"
        actions={
          <span className="adm-muted adm-small">
            {dias} {dias === 1 ? "día" : "días"} · comparado con los {dias} anteriores
          </span>
        }
      >
        {hayDatos ? (
          <>
            <Grafica puntos={puntos} />
            <p className="inf-nota inf-sep">
              Pasa el dedo o el ratón por encima para ver el día. Cada punto es lo cobrado ese día, con el
              envío incluido.
            </p>
          </>
        ) : (
          <EmptyState
            icon={<IconGrafica />}
            title="Sin ventas en este periodo"
            text="No hay ningún pedido cobrado entre estas fechas. Prueba con un periodo más amplio, o comprueba en Pedidos si alguno se quedó sin marcar como pagado."
            action={
              <>
                <Button href="/admin/informes?rango=ano" variant="ghost">
                  Ver todo el año
                </Button>
                <Button href="/admin/pedidos?estado=pendiente" variant="ghost">
                  Pedidos por cobrar
                </Button>
              </>
            }
          />
        )}
      </Card>

      {hayDatos ? (
        <>
          <Card
            title="Productos más vendidos"
            flush
            actions={
              <>
                <Link
                  href={enlaceOrden("unidades")}
                  className={`inf-atajo${ordenTop === "unidades" ? " is-activo" : ""}`}
                >
                  Por unidades
                </Link>
                <Link
                  href={enlaceOrden("ingresos")}
                  className={`inf-atajo${ordenTop === "ingresos" ? " is-activo" : ""}`}
                >
                  Por ingresos
                </Link>
              </>
            }
          >
            <DataTable<ProductoTop>
              columns={COLUMNAS_PRODUCTOS}
              rows={productos}
              rowKey={(p) => p.productId ?? `titulo:${p.titulo}`}
              empty="Ningún producto vendido en este periodo."
            />
          </Card>

          <div className="adm-cols-2">
            <Card title="Beneficio bruto">
              <div className="inf-cifras">
                <div className="inf-cifra">
                  <span className="inf-cifra-etq">Venta de producto</span>
                  <Money cents={beneficio.ingresosCents} />
                </div>
                <div className="inf-cifra">
                  <span className="inf-cifra-etq">Coste de producto</span>
                  <Money cents={beneficio.costeCents} tone="muted" />
                </div>
                <div className="inf-cifra is-total">
                  <span className="inf-cifra-etq">
                    Beneficio bruto
                    {beneficio.margenPct !== null ? (
                      <span className="adm-muted adm-small"> · margen {beneficio.margenPct}%</span>
                    ) : null}
                  </span>
                  {beneficio.beneficioCents === null ? (
                    <span className="adm-muted">Sin datos</span>
                  ) : (
                    <Money cents={beneficio.beneficioCents} tone="strong" />
                  )}
                </div>
              </div>

              {beneficio.lineasSinCoste > 0 ? (
                <div className="inf-aviso inf-sep">
                  <IconAviso />
                  <span>
                    {beneficio.lineasSinCoste === beneficio.lineasTotales ? (
                      <>
                        Ninguna de las {beneficio.lineasTotales} líneas vendidas tiene coste apuntado, así que
                        no se puede calcular el margen. Rellena el coste en cada producto y esta cifra
                        aparecerá sola.
                      </>
                    ) : (
                      <>
                        {beneficio.lineasSinCoste} de {beneficio.lineasTotales} líneas vendidas (
                        {beneficio.unidadesSinCoste}{" "}
                        {beneficio.unidadesSinCoste === 1 ? "unidad" : "unidades"}) no tienen coste apuntado.
                        El margen de arriba solo cubre las {beneficio.lineasConCoste} que sí lo tienen: el
                        beneficio real es distinto.
                      </>
                    )}{" "}
                    <Link href="/admin/productos" className="adm-link">
                      Revisar costes
                    </Link>
                  </span>
                </div>
              ) : (
                <p className="inf-nota inf-sep">
                  Todas las líneas vendidas tienen coste apuntado, así que el margen es real. No incluye el
                  envío cobrado: eso no es beneficio, es un gasto que se repercute.
                </p>
              )}
            </Card>

            <Card title="Clientas del periodo">
              <div className="inf-cifras inf-sep-abajo">
                <div className="inf-cifra">
                  <span className="inf-cifra-etq">Compraron</span>
                  <span>
                    {clientas.compradoras} {clientas.compradoras === 1 ? "persona" : "personas"}
                  </span>
                </div>
                <div className="inf-cifra">
                  <span className="inf-cifra-etq">Primera compra</span>
                  <span className="adm-row inf-par">
                    <Badge tone="success">{clientas.nuevas} nuevas</Badge>
                    <Money cents={clientas.ingresosNuevasCents} tone="muted" />
                  </span>
                </div>
                <div className="inf-cifra">
                  <span className="inf-cifra-etq">Ya habían comprado</span>
                  <span className="adm-row inf-par">
                    <Badge tone="info">{clientas.recurrentes} recurrentes</Badge>
                    <Money cents={clientas.ingresosRecurrentesCents} tone="muted" />
                  </span>
                </div>
              </div>

              <DataTable<ClientaTop>
                columns={COLUMNAS_CLIENTAS}
                rows={clientas.top}
                rowKey={(c) => c.email}
                empty="Ninguna compra con correo en este periodo."
              />

              {clientas.pedidosSinCorreo > 0 ? (
                <p className="inf-nota inf-sep">
                  Además hay {clientas.pedidosSinCorreo}{" "}
                  {clientas.pedidosSinCorreo === 1 ? "venta cobrada" : "ventas cobradas"} sin correo (
                  <Money cents={clientas.ingresosSinCorreoCents} tone="muted" />) — normalmente mostrador. Cuentan
                  en los ingresos, pero no se pueden atribuir a nadie: si apuntas el correo al cobrar, aparecerán
                  aquí y sabrás quién repite.
                </p>
              ) : null}
            </Card>
          </div>

          <div className="adm-cols-2">
            <Card title="Por dónde se vende">
              <Barras filas={canales} vacio="Sin ventas en este periodo." />
              <p className="inf-nota inf-sep">
                «Tienda web» son los pedidos que entran solos por la página; «mostrador» los que apuntas tú
                al vender en la boutique.
              </p>
            </Card>

            <Card title="Cómo se paga">
              <Barras filas={metodos} vacio="Sin cobros registrados en este periodo." />
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}

/* ─────────────────────────── piezas de la pantalla ─────────────────────────── */

/** Variación frente al periodo anterior: flecha, color y porcentaje. */
function VariacionTexto({ v }: { v: Variacion }) {
  const flecha = v.direccion === "sube" ? "▲" : v.direccion === "baja" ? "▼" : "";
  return (
    <span className={`inf-var inf-var-${v.direccion}`}>
      {flecha ? (
        <span className="inf-var-flecha" aria-hidden="true">
          {flecha}
        </span>
      ) : null}
      {textoVariacion(v)}
      {v.direccion === "nuevo" ? null : <span className="adm-muted"> vs. periodo anterior</span>}
    </span>
  );
}

/** Barras horizontales de reparto. El ancho es el % sobre el total del periodo. */
function Barras({ filas, vacio }: { filas: Reparto[]; vacio: string }) {
  if (filas.length === 0 || filas.every((f) => f.ingresosCents === 0)) {
    return <p className="inf-nota">{vacio}</p>;
  }

  return (
    <div className="inf-barras">
      {filas.map((f) => (
        <div key={f.clave}>
          <div className="inf-barra-cab">
            <span className="inf-barra-nombre">{f.etiqueta}</span>
            <span className="inf-barra-cifra">
              <Money cents={f.ingresosCents} tone="strong" />
              <span className="inf-barra-pct">{f.pct}%</span>
            </span>
          </div>
          <div
            className="inf-barra-pista"
            role="img"
            aria-label={`${f.etiqueta}: ${f.pct}% de los ingresos del periodo`}
          >
            <span
              className={`inf-barra-valor${f.ingresosCents === 0 ? " is-cero" : ""}`}
              style={{ width: `${Math.max(f.pct, f.ingresosCents > 0 ? 1 : 0)}%` }}
            />
          </div>
          <div className="inf-barra-nota">
            {f.pedidos} {f.pedidos === 1 ? "pedido" : "pedidos"}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────── columnas ─────────────────────────────── */

const COLUMNAS_PRODUCTOS: Column<ProductoTop>[] = [
  {
    key: "foto",
    header: "",
    label: "",
    width: "56px",
    render: (p) =>
      p.imagenUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- la foto viene congelada en la línea del pedido; puede apuntar a un dominio de proveedor
        <img className="adm-thumb" src={p.imagenUrl} alt="" loading="lazy" />
      ) : (
        <span className="adm-thumb" aria-hidden="true" />
      ),
  },
  {
    key: "producto",
    header: "Producto",
    primary: true,
    render: (p) =>
      p.productId ? (
        <Link className="adm-link" href={`/admin/productos/${p.productId}`}>
          {p.titulo}
        </Link>
      ) : (
        <span>
          {p.titulo}
          <br />
          <span className="adm-muted adm-small">ya no está en el catálogo</span>
        </span>
      ),
  },
  {
    key: "unidades",
    header: "Unidades",
    align: "right",
    render: (p) => <span className="inf-num">{p.unidades}</span>,
  },
  {
    key: "ingresos",
    header: "Ingresos",
    align: "right",
    render: (p) => <Money cents={p.ingresosCents} tone="strong" />,
  },
  {
    key: "margen",
    header: "Margen",
    align: "right",
    render: (p) =>
      p.margenPct === null ? (
        <Badge tone="warning">Sin coste</Badge>
      ) : (
        <span className="inf-num">
          {p.margenPct}%
          {p.lineasSinCoste > 0 ? (
            <>
              <br />
              <span className="adm-muted adm-small">{p.lineasSinCoste} sin coste</span>
            </>
          ) : null}
        </span>
      ),
  },
];

const COLUMNAS_CLIENTAS: Column<ClientaTop>[] = [
  {
    key: "clienta",
    header: "Clienta",
    primary: true,
    render: (c) =>
      c.customerId ? (
        <Link className="adm-link" href={`/admin/clientes/${c.customerId}`}>
          {c.nombre}
        </Link>
      ) : (
        <span>{c.nombre}</span>
      ),
  },
  {
    key: "tipo",
    header: "Tipo",
    hideOnMobile: true,
    render: (c) => (c.esNueva ? <Badge tone="success">Nueva</Badge> : <Badge tone="info">Recurrente</Badge>),
  },
  {
    key: "pedidos",
    header: "Pedidos",
    align: "right",
    render: (c) => <span className="inf-num">{c.pedidos}</span>,
  },
  {
    key: "gastado",
    header: "Gastado",
    align: "right",
    render: (c) => <Money cents={c.gastadoCents} tone="strong" />,
  },
];

/* ─────────────────────────────── iconos ─────────────────────────────── */

function IconGrafica() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="m7 15 3.5-4 3 2.5L18 7" />
    </svg>
  );
}

function IconAviso() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4.5 2.8 20h18.4Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.4h.01" />
    </svg>
  );
}
