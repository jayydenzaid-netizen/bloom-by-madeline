import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Money,
  PageHeader,
  StatCard,
  type BadgeTone,
  type Column,
} from "../../_components/ui";

/**
 * Ficha de una clienta: sus datos y todo lo que ha pedido.
 *
 * El historial se busca por id de clienta O por correo: un pedido hecho como
 * invitada puede haberse quedado sin enlazar, y esconderlo daría un historial
 * incompleto justo cuando Madeline lo mira para atender un reclamo.
 */

export const dynamic = "force-dynamic";

const fecha = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });
const fechaLarga = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "long", year: "numeric" });

const PAGO: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: "Por cobrar", tone: "warning" },
  paid: { label: "Pagado", tone: "success" },
  refunded: { label: "Reembolsado", tone: "info" },
  cancelled: { label: "Cancelado", tone: "danger" },
};

const ENVIO: Record<string, { label: string; tone: BadgeTone }> = {
  unfulfilled: { label: "Por enviar", tone: "neutral" },
  fulfilled: { label: "Enviado", tone: "success" },
  cancelled: { label: "Cancelado", tone: "danger" },
};

type PedidoFila = {
  id: string;
  number: string;
  totalCents: number;
  paymentStatus: string;
  fulfillStatus: string;
  createdAt: Date;
};

export default async function ClientaPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const { id } = await params;

  const clienta = await db.customer.findUnique({ where: { id } });
  if (!clienta) notFound();

  const pedidos = await db.order.findMany({
    where: { OR: [{ customerId: clienta.id }, { email: clienta.email }] },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      number: true,
      totalCents: true,
      paymentStatus: true,
      fulfillStatus: true,
      createdAt: true,
    },
  });

  const cobrados = pedidos.filter((p) => p.paymentStatus === "paid");
  const gastado = cobrados.reduce((suma, p) => suma + p.totalCents, 0);
  // Ticket medio solo sobre lo cobrado: promediar pedidos cancelados daría un
  // número más bonito y falso.
  const ticket = cobrados.length > 0 ? Math.round(gastado / cobrados.length) : 0;
  const porCobrar = pedidos.filter((p) => p.paymentStatus === "pending").length;

  return (
    <>
      <PageHeader
        title={clienta.name || "Clienta sin nombre"}
        subtitle={`Ficha creada el ${fechaLarga.format(clienta.createdAt)}`}
        actions={
          <>
            <Button href={`/admin/pedidos?q=${encodeURIComponent(clienta.email)}`} variant="ghost">
              Ver sus pedidos
            </Button>
            <Button href="/admin/clientes" variant="ghost">
              Volver a clientes
            </Button>
          </>
        }
      />

      <div className="adm-grid">
        <StatCard label="Pedidos" value={pedidos.length} hint={`${cobrados.length} cobrados`} />
        <StatCard label="Total gastado" value={<Money cents={gastado} />} hint="Solo pedidos cobrados" tone="accent" />
        <StatCard label="Ticket medio" value={<Money cents={ticket} />} hint={cobrados.length === 0 ? "Aún sin compras" : "Por pedido cobrado"} />
        <StatCard
          label="Por cobrar"
          value={porCobrar}
          hint={porCobrar > 0 ? "Pedidos pendientes de pago" : "Nada pendiente"}
          tone={porCobrar > 0 ? "warning" : "default"}
        />
      </div>

      <div className="adm-cols-2">
        <Card title="Datos">
          <dl className="cli-datos">
            <dt>Correo</dt>
            <dd>
              <a className="adm-link" href={`mailto:${clienta.email}`}>
                {clienta.email}
              </a>
            </dd>

            <dt>Teléfono</dt>
            <dd>
              {clienta.phone ? (
                <a className="adm-link" href={`tel:${clienta.phone.replace(/[^\d+]/g, "")}`}>
                  {clienta.phone}
                </a>
              ) : (
                <span className="adm-muted">Sin teléfono</span>
              )}
            </dd>

            <dt>Alta</dt>
            <dd>{fechaLarga.format(clienta.createdAt)}</dd>

            <dt>Nota</dt>
            <dd>{clienta.note ? <span className="cli-nota">{clienta.note}</span> : <span className="adm-muted">Sin notas</span>}</dd>
          </dl>
          <style dangerouslySetInnerHTML={{ __html: ESTILOS }} />
        </Card>

        <Card title="Historial" flush>
          <DataTable<PedidoFila>
            columns={COLUMNAS}
            rows={pedidos}
            rowKey={(p) => p.id}
            empty={
              <EmptyState
                title="Sin pedidos todavía"
                text="Esta clienta tiene ficha pero aún no ha completado ninguna compra."
                action={
                  <Button href="/admin/pedidos" variant="ghost">
                    Ver todos los pedidos
                  </Button>
                }
              />
            }
          />
        </Card>
      </div>
    </>
  );
}

const COLUMNAS: Column<PedidoFila>[] = [
  {
    key: "number",
    header: "Pedido",
    primary: true,
    render: (p) => (
      <Link className="adm-link" href={`/admin/pedidos/${p.id}`}>
        {p.number}
      </Link>
    ),
  },
  {
    key: "fecha",
    header: "Fecha",
    render: (p) => <span className="adm-muted">{fecha.format(p.createdAt)}</span>,
  },
  {
    key: "estado",
    header: "Estado",
    render: (p) => {
      const pago = PAGO[p.paymentStatus] ?? { label: p.paymentStatus, tone: "neutral" as BadgeTone };
      const envio = ENVIO[p.fulfillStatus] ?? { label: p.fulfillStatus, tone: "neutral" as BadgeTone };
      return (
        <span className="adm-row">
          <Badge tone={pago.tone}>{pago.label}</Badge>
          <Badge tone={envio.tone}>{envio.label}</Badge>
        </span>
      );
    },
  },
  {
    key: "total",
    header: "Total",
    align: "right",
    render: (p) => <Money cents={p.totalCents} tone="strong" />,
  },
];

// Estilo propio de esta pantalla: admin.css lo comparten cuatro pantallas y
// esta lista de datos no le sirve a ninguna otra.
const ESTILOS = `
.cli-datos { display: grid; grid-template-columns: auto 1fr; gap: 8px 18px; margin: 0; }
.cli-datos dt {
  font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--adm-muted); padding-top: 2px;
}
.cli-datos dd { margin: 0; }
.cli-nota { white-space: pre-wrap; }
`;
