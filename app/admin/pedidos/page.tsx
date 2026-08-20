import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { buscar } from "@/lib/search";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Money,
  PageHeader,
  type BadgeTone,
  type Column,
} from "../_components/ui";

/**
 * Listado de pedidos: la pantalla que Madeline abre cada mañana para ver qué
 * hay que cobrar y qué hay que meter en una caja.
 *
 * Todos los filtros viajan en la URL (formulario GET, cero JavaScript): así un
 * filtro concreto se puede guardar en marcadores o enlazar desde el dashboard,
 * y la pantalla sigue funcionando aunque el JS no cargue.
 */

export const dynamic = "force-dynamic";

const POR_PAGINA = 25;

const fecha = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

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

const METODO: Record<string, string> = {
  stripe: "Tarjeta",
  dm: "DM de Instagram",
  pickup: "Recogida en tienda",
  cash: "Efectivo",
};

/**
 * Filtros de estado. Las claves `pendiente` y `por-enviar` las enlaza el
 * dashboard desde sus avisos (ver _ADMIN_UI.md §6): si se renombran, hay que
 * cambiarlas también allí.
 */
const FILTROS: { key: string; label: string; where: Prisma.OrderWhereInput }[] = [
  { key: "todos", label: "Todos", where: {} },
  { key: "pendiente", label: "Por cobrar", where: { paymentStatus: "pending" } },
  { key: "por-enviar", label: "Por enviar", where: { paymentStatus: "paid", fulfillStatus: "unfulfilled" } },
  { key: "pagado", label: "Pagados", where: { paymentStatus: "paid" } },
  { key: "enviado", label: "Enviados", where: { fulfillStatus: "fulfilled" } },
  { key: "reembolsado", label: "Reembolsados", where: { paymentStatus: "refunded" } },
  {
    key: "cancelado",
    label: "Cancelados",
    where: { OR: [{ paymentStatus: "cancelled" }, { fulfillStatus: "cancelled" }] },
  },
];

type PedidoFila = {
  id: string;
  number: string;
  name: string;
  email: string;
  totalCents: number;
  paymentStatus: string;
  fulfillStatus: string;
  paymentMethod: string;
  createdAt: Date;
};

type Busqueda = { estado: string; metodo: string; q: string; pagina: number };

function leerBusqueda(params: Record<string, string | string[] | undefined>): Busqueda {
  const uno = (key: string): string => {
    const raw = params[key];
    return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  };
  const estado = uno("estado");
  const metodo = uno("metodo");
  const pagina = Number.parseInt(uno("pagina") || "1", 10);

  return {
    estado: FILTROS.some((f) => f.key === estado) ? estado : "todos",
    metodo: METODO[metodo] ? metodo : "",
    q: uno("q").slice(0, 80),
    pagina: Number.isFinite(pagina) && pagina > 0 ? pagina : 1,
  };
}

/** Enlace que conserva los filtros vigentes y cambia solo lo que se le pide. */
function enlace(base: Busqueda, cambios: Partial<Busqueda>): string {
  const b = { ...base, ...cambios };
  const qs = new URLSearchParams();
  if (b.estado !== "todos") qs.set("estado", b.estado);
  if (b.metodo) qs.set("metodo", b.metodo);
  if (b.q) qs.set("q", b.q);
  if (b.pagina > 1) qs.set("pagina", String(b.pagina));
  const s = qs.toString();
  return s ? `/admin/pedidos?${s}` : "/admin/pedidos";
}

export default async function PedidosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Defensa en profundidad: aquí se leen correos y direcciones de clientas.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const busqueda = leerBusqueda(await searchParams);
  const filtro = FILTROS.find((f) => f.key === busqueda.estado) ?? FILTROS[0];

  const where: Prisma.OrderWhereInput = { ...filtro.where };
  if (busqueda.metodo) where.paymentMethod = busqueda.metodo;
  if (busqueda.q) {
    // SQLite hace LIKE insensible a mayúsculas en ASCII, así que no hace falta
    // `mode: "insensitive"` (que además Prisma no soporta sobre SQLite).
    where.AND = [
      {
        OR: [
          { number: buscar(busqueda.q) },
          { email: buscar(busqueda.q) },
          { name: buscar(busqueda.q) },
          { trackingNumber: buscar(busqueda.q) },
        ],
      },
    ];
  }

  const [total, pedidos, porCobrar, porEnviar] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (busqueda.pagina - 1) * POR_PAGINA,
      take: POR_PAGINA,
      select: {
        id: true,
        number: true,
        name: true,
        email: true,
        totalCents: true,
        paymentStatus: true,
        fulfillStatus: true,
        paymentMethod: true,
        createdAt: true,
      },
    }),
    db.order.count({ where: { paymentStatus: "pending" } }),
    db.order.count({ where: { paymentStatus: "paid", fulfillStatus: "unfulfilled" } }),
  ]);

  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const pagina = Math.min(busqueda.pagina, paginas);
  const desde = total === 0 ? 0 : (pagina - 1) * POR_PAGINA + 1;
  const hasta = Math.min(pagina * POR_PAGINA, total);

  const hayFiltro = busqueda.estado !== "todos" || busqueda.metodo !== "" || busqueda.q !== "";

  return (
    <>
      <PageHeader
        title="Pedidos"
        subtitle={
          total === 0
            ? hayFiltro
              ? "Ningún pedido coincide con el filtro"
              : "Todavía no hay pedidos"
            : `${total} ${total === 1 ? "pedido" : "pedidos"} · mostrando ${desde}–${hasta}`
        }
        actions={
          <>
            {porCobrar > 0 ? (
              <Button href="/admin/pedidos?estado=pendiente" variant="ghost" size="sm">
                {porCobrar} por cobrar
              </Button>
            ) : null}
            {porEnviar > 0 ? (
              <Button href="/admin/pedidos?estado=por-enviar" variant="ghost" size="sm">
                {porEnviar} por enviar
              </Button>
            ) : null}
          </>
        }
      />

      <Card>
        {/* Formulario GET: los filtros quedan en la URL y no hace falta JS. */}
        <form method="get" className="adm-row" style={{ alignItems: "flex-end", gap: 12 }}>
          <label className="adm-field" style={{ flex: "1 1 220px", minWidth: 180 }}>
            <span className="adm-field-lbl">Buscar</span>
            <input
              type="search"
              name="q"
              defaultValue={busqueda.q}
              placeholder="Número BLM, correo o nombre"
              autoComplete="off"
            />
          </label>

          <label className="adm-field" style={{ flex: "0 1 190px" }}>
            <span className="adm-field-lbl">Estado</span>
            <select name="estado" defaultValue={busqueda.estado}>
              {FILTROS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <label className="adm-field" style={{ flex: "0 1 190px" }}>
            <span className="adm-field-lbl">Método</span>
            <select name="metodo" defaultValue={busqueda.metodo}>
              <option value="">Cualquiera</option>
              {Object.entries(METODO).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <div className="adm-row" style={{ paddingBottom: 2 }}>
            <button type="submit" className="adm-btn adm-btn-primary adm-btn-sm">
              Filtrar
            </button>
            {hayFiltro ? (
              <Link className="adm-btn adm-btn-ghost adm-btn-sm" href="/admin/pedidos">
                Limpiar
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <Card title={filtro.label === "Todos" ? "Todos los pedidos" : filtro.label} flush>
        <DataTable<PedidoFila>
          columns={COLUMNAS}
          rows={pedidos}
          rowKey={(p) => p.id}
          empty={
            hayFiltro ? (
              <EmptyState
                icon={<IconLupa />}
                title="Ningún pedido con ese filtro"
                text="Prueba a quitar el filtro de estado, o a buscar solo por el número de pedido."
                action={
                  <Button href="/admin/pedidos" variant="ghost">
                    Ver todos los pedidos
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<IconBolsa />}
                title="Todavía no hay pedidos"
                text="Cuando alguien compre en la tienda, el pedido aparecerá aquí con su número BLM y podrás cobrarlo y prepararlo desde esta pantalla."
                action={
                  <Button href="/admin/productos" variant="ghost">
                    Revisar el catálogo
                  </Button>
                }
              />
            )
          }
        />
      </Card>

      {paginas > 1 ? (
        <div className="adm-row" style={{ justifyContent: "space-between", marginTop: 4 }}>
          <span className="adm-muted adm-small">
            Página {pagina} de {paginas}
          </span>
          <div className="adm-row">
            {pagina > 1 ? (
              <Link className="adm-btn adm-btn-ghost adm-btn-sm" href={enlace(busqueda, { pagina: pagina - 1 })}>
                Anteriores
              </Link>
            ) : null}
            {pagina < paginas ? (
              <Link className="adm-btn adm-btn-ghost adm-btn-sm" href={enlace(busqueda, { pagina: pagina + 1 })}>
                Siguientes
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ───────────────────────────── columnas ───────────────────────────── */

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
    key: "cliente",
    header: "Clienta",
    render: (p) => (
      <span>
        {p.name || "—"}
        <br />
        <span className="adm-muted adm-small">{p.email}</span>
      </span>
    ),
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
    key: "metodo",
    header: "Método",
    hideOnMobile: true,
    render: (p) => <span className="adm-muted">{METODO[p.paymentMethod] ?? p.paymentMethod}</span>,
  },
  {
    key: "fecha",
    header: "Fecha",
    hideOnMobile: true,
    render: (p) => <span className="adm-muted">{fecha.format(p.createdAt)}</span>,
  },
  {
    key: "total",
    header: "Total",
    align: "right",
    render: (p) => <Money cents={p.totalCents} tone="strong" />,
  },
];

/* ─────────────────────────────── iconos ───────────────────────────── */

function IconBolsa() {
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
      <path d="M6 7h12l1.2 12.2a1.5 1.5 0 0 1-1.5 1.8H6.3a1.5 1.5 0 0 1-1.5-1.8Z" />
      <path d="M9 10V6.5a3 3 0 0 1 6 0V10" />
    </svg>
  );
}

function IconLupa() {
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
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}
