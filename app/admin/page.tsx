import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge, Button, Card, DataTable, EmptyState, Money, PageHeader, StatCard, type BadgeTone, type Column } from "./_components/ui";

/**
 * Dashboard del panel: la foto de la tienda al abrir por la mañana.
 * Todo sale de la base de datos — aquí no hay ni un número simulado. Si algo
 * está a cero es porque de verdad está a cero.
 */

export const dynamic = "force-dynamic";

type LatestOrder = {
  id: string;
  number: string;
  name: string;
  email: string;
  totalCents: number;
  paymentStatus: string;
  fulfillStatus: string;
  createdAt: Date;
};

type Aviso = {
  key: string;
  tone: BadgeTone;
  label: string;
  text: string;
  href: string;
  cta: string;
};

const fechaCorta = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short" });
const mesLargo = new Intl.DateTimeFormat("es-US", { month: "long", year: "numeric" });

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

export default async function AdminDashboard() {
  // Defensa en profundidad: el layout ya corta el paso, pero en App Router una
  // página se renderiza aunque su layout no la pinte (y viaja en el payload
  // RSC). Cada pantalla del panel comprueba la sesión por su cuenta: es una
  // sola consulta y es la diferencia entre proteger y aparentar que se protege.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const ahora = new Date();
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

  let datos;
  try {
    datos = await cargarDatos(inicioMes);
  } catch (error) {
    // Repo recién clonado sin `npm run db:push`: mejor decirlo que soltar un
    // stack de Prisma en la cara de Madeline.
    return (
      <>
        <PageHeader title="Panel" subtitle="Resumen de la tienda" />
        <Card>
          <EmptyState
            icon={<IconAviso />}
            title="La base de datos todavía no responde"
            text={
              <>
                Ejecuta <code>npm run db:push</code> y luego <code>npm run db:seed</code> en la carpeta del proyecto.
                Detalle técnico: {error instanceof Error ? error.message : "error desconocido"}.
              </>
            }
          />
        </Card>
      </>
    );
  }

  const {
    ventasMes,
    pedidosMes,
    porCobrar,
    porEnviar,
    activos,
    borradores,
    archivados,
    totalProductos,
    sinStock,
    sinPrecio,
    importesListos,
    ultimos,
  } = datos;

  const avisos = construirAvisos({ sinPrecio, sinStock, borradores, porCobrar, porEnviar, importesListos });

  const acciones = (
    <>
      <Button href="/admin/productos/nuevo">Nuevo producto</Button>
      <Button href="/admin/importar" variant="ghost">
        Importar de proveedor
      </Button>
    </>
  );

  // Tienda vacía: en vez de una parrilla de ceros, el camino para empezar.
  if (totalProductos === 0) {
    return (
      <>
        <PageHeader title="Panel" subtitle={`Resumen de ${mesLargo.format(ahora)}`} actions={acciones} />
        <Card>
          <EmptyState
            icon={<IconCaja />}
            title="Aún no hay productos en la tienda"
            text="El catálogo está vacío, así que el escaparate no muestra nada. Puedes sembrar los productos que ya existen en el sitio antiguo con npm run db:seed, o traer el primero directamente de AliExpress o Alibaba."
            action={
              <>
                <Button href="/admin/importar">Importar el primero</Button>
                <Button href="/admin/productos/nuevo" variant="ghost">
                  Crearlo a mano
                </Button>
              </>
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Panel" subtitle={`Resumen de ${mesLargo.format(ahora)}`} actions={acciones} />

      <div className="adm-grid">
        <StatCard
          label="Ventas del mes"
          value={<Money cents={ventasMes} />}
          hint={`${pedidosMes} ${pedidosMes === 1 ? "pedido cobrado" : "pedidos cobrados"}`}
          tone="accent"
        />
        <StatCard
          label="Por cobrar"
          value={porCobrar}
          hint={porCobrar > 0 ? "Pedidos pendientes de pago" : "Nada pendiente de cobro"}
          tone={porCobrar > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Por enviar"
          value={porEnviar}
          hint={porEnviar > 0 ? "Pagados y sin preparar" : "Todo lo pagado está enviado"}
          tone={porEnviar > 0 ? "warning" : "success"}
        />
        <StatCard
          label="Catálogo activo"
          value={activos}
          hint={`${borradores} en borrador · ${archivados} archivados`}
        />
      </div>

      {avisos.length > 0 ? (
        <Card title="Requiere tu atención" flush>
          <div className="adm-alerts">
            {avisos.map((aviso) => (
              <div className="adm-alert" key={aviso.key}>
                <span className="adm-alert-text">
                  <Badge tone={aviso.tone}>{aviso.label}</Badge>
                  {aviso.text}
                </span>
                <Link className="adm-alert-cta" href={aviso.href}>
                  {aviso.cta}
                </Link>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card
        title="Últimos pedidos"
        flush
        actions={
          <Button href="/admin/pedidos" variant="ghost" size="sm">
            Ver todos
          </Button>
        }
      >
        <DataTable<LatestOrder>
          columns={COLUMNAS_PEDIDOS}
          rows={ultimos}
          rowKey={(pedido) => pedido.id}
          empty={
            <EmptyState
              icon={<IconBolsa />}
              title="Todavía no hay pedidos"
              text="Cuando alguien compre en la tienda, el pedido aparecerá aquí con su número BLM."
            />
          }
        />
      </Card>
    </>
  );
}

/* ─────────────────────────── datos ─────────────────────────── */

async function cargarDatos(inicioMes: Date) {
  const [mes, porCobrar, porEnviar, porEstado, sinStock, sinPrecio, importesListos, ultimos, totalProductos] =
    await Promise.all([
      // Solo cuenta lo cobrado: un pedido "pendiente" no es una venta todavía.
      db.order.aggregate({
        _sum: { totalCents: true },
        _count: { _all: true },
        where: { paymentStatus: "paid", createdAt: { gte: inicioMes } },
      }),
      db.order.count({ where: { paymentStatus: "pending" } }),
      db.order.count({ where: { paymentStatus: "paid", fulfillStatus: "unfulfilled" } }),
      db.product.groupBy({ by: ["status"], _count: { _all: true } }),
      // Solo molesta el stock de lo que se controla: en dropshipping casi todo
      // va con trackStock=false porque el inventario lo tiene el proveedor.
      db.productVariant.count({ where: { trackStock: true, stock: { lte: 0 } } }),
      db.product.count({ where: { status: { not: "archived" }, priceCents: { lte: 0 } } }),
      db.importJob.count({ where: { status: "ready" } }),
      db.order.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          number: true,
          name: true,
          email: true,
          totalCents: true,
          paymentStatus: true,
          fulfillStatus: true,
          createdAt: true,
        },
      }),
      db.product.count(),
    ]);

  const cuenta = (estado: string) => porEstado.find((fila) => fila.status === estado)?._count._all ?? 0;

  return {
    ventasMes: mes._sum.totalCents ?? 0,
    pedidosMes: mes._count._all,
    porCobrar,
    porEnviar,
    activos: cuenta("active"),
    borradores: cuenta("draft"),
    archivados: cuenta("archived"),
    totalProductos,
    sinStock,
    sinPrecio,
    importesListos,
    ultimos: ultimos as LatestOrder[],
  };
}

function construirAvisos(n: {
  sinPrecio: number;
  sinStock: number;
  borradores: number;
  porCobrar: number;
  porEnviar: number;
  importesListos: number;
}): Aviso[] {
  const avisos: Aviso[] = [];

  if (n.sinPrecio > 0) {
    avisos.push({
      key: "sin-precio",
      tone: "danger",
      label: "Precio",
      text:
        n.sinPrecio === 1
          ? "1 producto está sin precio y no se puede vender."
          : `${n.sinPrecio} productos están sin precio y no se pueden vender.`,
      href: "/admin/productos?aviso=sin-precio",
      cta: "Ponerles precio",
    });
  }

  if (n.porCobrar > 0) {
    avisos.push({
      key: "por-cobrar",
      tone: "warning",
      label: "Cobro",
      text:
        n.porCobrar === 1
          ? "1 pedido sigue pendiente de pago."
          : `${n.porCobrar} pedidos siguen pendientes de pago.`,
      href: "/admin/pedidos?estado=pendiente",
      cta: "Revisar pedidos",
    });
  }

  if (n.porEnviar > 0) {
    avisos.push({
      key: "por-enviar",
      tone: "warning",
      label: "Envío",
      text:
        n.porEnviar === 1
          ? "1 pedido pagado está sin preparar."
          : `${n.porEnviar} pedidos pagados están sin preparar.`,
      href: "/admin/pedidos?estado=por-enviar",
      cta: "Prepararlos",
    });
  }

  if (n.importesListos > 0) {
    avisos.push({
      key: "importaciones",
      tone: "info",
      label: "Importador",
      text:
        n.importesListos === 1
          ? "1 producto importado espera tu revisión antes de publicarse."
          : `${n.importesListos} productos importados esperan tu revisión antes de publicarse.`,
      href: "/admin/importar",
      cta: "Revisarlos",
    });
  }

  if (n.sinStock > 0) {
    avisos.push({
      key: "sin-stock",
      tone: "danger",
      label: "Stock",
      text:
        n.sinStock === 1
          ? "1 variante con control de stock está agotada."
          : `${n.sinStock} variantes con control de stock están agotadas.`,
      href: "/admin/productos?aviso=sin-stock",
      cta: "Ver agotados",
    });
  }

  if (n.borradores > 0) {
    avisos.push({
      key: "borradores",
      tone: "neutral",
      label: "Borradores",
      text:
        n.borradores === 1
          ? "1 producto sigue en borrador y no se ve en la tienda."
          : `${n.borradores} productos siguen en borrador y no se ven en la tienda.`,
      href: "/admin/productos?estado=draft",
      cta: "Publicarlos",
    });
  }

  return avisos;
}

/* ─────────────────────── tabla de pedidos ─────────────────────── */

const COLUMNAS_PEDIDOS: Column<LatestOrder>[] = [
  {
    key: "number",
    header: "Pedido",
    primary: true,
    render: (pedido) => (
      <Link className="adm-link" href={`/admin/pedidos/${pedido.id}`}>
        {pedido.number}
      </Link>
    ),
  },
  {
    key: "cliente",
    header: "Clienta",
    render: (pedido) => (
      <span>
        {pedido.name || "—"}
        <br />
        <span className="adm-muted adm-small">{pedido.email}</span>
      </span>
    ),
  },
  {
    key: "estado",
    header: "Estado",
    render: (pedido) => {
      const pago = PAGO[pedido.paymentStatus] ?? { label: pedido.paymentStatus, tone: "neutral" as BadgeTone };
      const envio = ENVIO[pedido.fulfillStatus] ?? { label: pedido.fulfillStatus, tone: "neutral" as BadgeTone };
      return (
        <span className="adm-row">
          <Badge tone={pago.tone}>{pago.label}</Badge>
          <Badge tone={envio.tone}>{envio.label}</Badge>
        </span>
      );
    },
  },
  {
    key: "fecha",
    header: "Fecha",
    hideOnMobile: true,
    render: (pedido) => <span className="adm-muted">{fechaCorta.format(pedido.createdAt)}</span>,
  },
  {
    key: "total",
    header: "Total",
    align: "right",
    render: (pedido) => <Money cents={pedido.totalCents} tone="strong" />,
  },
];

/* ─────────────────────────── iconos ─────────────────────────── */

function IconCaja() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 4 7v10l8 4 8-4V7Z" />
      <path d="m4 7 8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  );
}

function IconBolsa() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 7h12l1.2 12.2a1.5 1.5 0 0 1-1.5 1.8H6.3a1.5 1.5 0 0 1-1.5-1.8Z" />
      <path d="M9 10V6.5a3 3 0 0 1 6 0V10" />
    </svg>
  );
}

function IconAviso() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4 2.5 20h19Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.4h.01" />
    </svg>
  );
}
