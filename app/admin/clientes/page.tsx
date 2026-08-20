import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { buscar } from "@/lib/search";
import { formatCents } from "@/lib/money";
import { Button, Card, DataTable, EmptyState, Money, PageHeader, type Column } from "../_components/ui";

/**
 * Clientas de la tienda. Solo hay lo que hay: nombre, correo, cuántos pedidos
 * hizo y cuánto ha pagado. Nada de segmentos, etiquetas ni "clientas VIP"
 * inventadas — si un dato no sale de la base de datos, aquí no aparece.
 */

export const dynamic = "force-dynamic";

const POR_PAGINA = 30;
const fecha = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

type Orden = "gasto" | "pedidos" | "nombre" | "reciente";
const ORDENES: Orden[] = ["gasto", "pedidos", "nombre", "reciente"];

type Fila = {
  id: string;
  name: string;
  email: string;
  phone: string;
  createdAt: Date;
  pedidos: number;
  gastadoCents: number;
  ultimo: Date | null;
};

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const uno = (key: string): string => {
    const raw = sp[key];
    return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  };

  const q = uno("q").slice(0, 80);
  const ordenPedida = uno("orden") as Orden;
  const orden: Orden = ORDENES.includes(ordenPedida) ? ordenPedida : "gasto";
  const paginaPedida = Number.parseInt(uno("pagina") || "1", 10);

  const [clientas, totalesPorEmail, cobradoPorEmail] = await Promise.all([
    db.customer.findMany({
      where: q ? { OR: [{ name: buscar(q) }, { email: buscar(q) }, { phone: buscar(q) }] } : undefined,
      select: { id: true, name: true, email: true, phone: true, createdAt: true },
      // Tope defensivo: una boutique no tiene 2000 clientas, y si algún día las
      // tiene esta pantalla se rehace con paginación en base de datos.
      take: 2000,
    }),
    db.order.groupBy({ by: ["email"], _count: { _all: true }, _max: { createdAt: true } }),
    // "Total gastado" es lo COBRADO. Contar pedidos pendientes o cancelados
    // como gasto haría creer a Madeline que entró dinero que no entró.
    db.order.groupBy({ by: ["email"], where: { paymentStatus: "paid" }, _sum: { totalCents: true } }),
  ]);

  // Los pedidos se cruzan por correo en minúsculas y no por customerId: un
  // pedido de invitada puede quedarse sin enlazar y su historial seguiría
  // siendo el de la misma persona.
  const totales = new Map(totalesPorEmail.map((f) => [f.email.toLowerCase(), f]));
  const cobrado = new Map(cobradoPorEmail.map((f) => [f.email.toLowerCase(), f._sum.totalCents ?? 0]));

  const filas: Fila[] = clientas.map((c) => {
    const clave = c.email.toLowerCase();
    const t = totales.get(clave);
    return {
      ...c,
      pedidos: t?._count._all ?? 0,
      gastadoCents: cobrado.get(clave) ?? 0,
      ultimo: t?._max.createdAt ?? null,
    };
  });

  ordenar(filas, orden);

  const total = filas.length;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const pagina = Math.min(Math.max(Number.isFinite(paginaPedida) ? paginaPedida : 1, 1), paginas);
  const visibles = filas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);

  // Correos con pedidos que no tienen ficha de clienta: existen de verdad y
  // callarlos daría un listado que miente sobre quién ha comprado.
  const conFicha = new Set(clientas.map((c) => c.email.toLowerCase()));
  const sueltos = totalesPorEmail.filter((f) => !conFicha.has(f.email.toLowerCase())).length;

  const gastadoTotal = filas.reduce((suma, f) => suma + f.gastadoCents, 0);

  const enlaceOrden = (valor: Orden): string => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    qs.set("orden", valor);
    return `/admin/clientes?${qs.toString()}`;
  };

  const columnas: Column<Fila>[] = [
    {
      key: "nombre",
      header: <OrdenLink href={enlaceOrden("nombre")} activo={orden === "nombre"} texto="Clienta" />,
      label: "Clienta",
      primary: true,
      render: (f) => (
        <span>
          <Link className="adm-link" href={`/admin/clientes/${f.id}`}>
            {f.name || "Sin nombre"}
          </Link>
          <br />
          <span className="adm-muted adm-small">{f.email}</span>
        </span>
      ),
    },
    {
      key: "telefono",
      header: "Teléfono",
      hideOnMobile: true,
      render: (f) => <span className="adm-muted">{f.phone || "—"}</span>,
    },
    {
      key: "pedidos",
      header: <OrdenLink href={enlaceOrden("pedidos")} activo={orden === "pedidos"} texto="Pedidos" />,
      label: "Pedidos",
      align: "right",
      render: (f) => <span>{f.pedidos}</span>,
    },
    {
      key: "ultimo",
      header: <OrdenLink href={enlaceOrden("reciente")} activo={orden === "reciente"} texto="Último pedido" />,
      label: "Último pedido",
      hideOnMobile: true,
      render: (f) => <span className="adm-muted">{f.ultimo ? fecha.format(f.ultimo) : "—"}</span>,
    },
    {
      key: "gastado",
      header: <OrdenLink href={enlaceOrden("gasto")} activo={orden === "gasto"} texto="Gastado" />,
      label: "Gastado",
      align: "right",
      render: (f) => <Money cents={f.gastadoCents} tone={f.gastadoCents > 0 ? "strong" : "muted"} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle={
          total === 0
            ? q
              ? "Ninguna clienta coincide con la búsqueda"
              : "Todavía no hay clientas registradas"
            : `${total} ${total === 1 ? "clienta" : "clientas"} · ${formatCents(gastadoTotal)} cobrado en total`
        }
      />

      <Card>
        <form method="get" className="adm-row" style={{ alignItems: "flex-end", gap: 12 }}>
          <label className="adm-field" style={{ flex: "1 1 240px", minWidth: 180 }}>
            <span className="adm-field-lbl">Buscar</span>
            <input type="search" name="q" defaultValue={q} placeholder="Nombre, correo o teléfono" autoComplete="off" />
          </label>
          <input type="hidden" name="orden" value={orden} />
          <div className="adm-row" style={{ paddingBottom: 2 }}>
            <button type="submit" className="adm-btn adm-btn-primary adm-btn-sm">
              Buscar
            </button>
            {q ? (
              <Link className="adm-btn adm-btn-ghost adm-btn-sm" href="/admin/clientes">
                Limpiar
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <Card
        title="Listado"
        flush
        footer={
          sueltos > 0 ? (
            <span className="adm-muted adm-small">
              Hay {sueltos} {sueltos === 1 ? "correo" : "correos"} con pedidos sin ficha de clienta.{" "}
              <Link className="adm-link" href="/admin/pedidos">
                Míralos en pedidos
              </Link>
              .
            </span>
          ) : undefined
        }
      >
        <DataTable<Fila>
          columns={columnas}
          rows={visibles}
          rowKey={(f) => f.id}
          empty={
            q ? (
              <EmptyState
                icon={<IconPersona />}
                title="Ninguna clienta con esa búsqueda"
                text="Prueba con solo una parte del correo o del nombre."
                action={
                  <Button href="/admin/clientes" variant="ghost">
                    Ver todas
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<IconPersona />}
                title="Todavía no hay clientas"
                text="Las fichas se crean solas con el primer pedido de cada persona. Cuando llegue uno, aparecerá aquí con su historial."
                action={
                  <Button href="/admin/pedidos" variant="ghost">
                    Ver pedidos
                  </Button>
                }
              />
            )
          }
        />
      </Card>

      {paginas > 1 ? (
        <div className="adm-row" style={{ justifyContent: "space-between" }}>
          <span className="adm-muted adm-small">
            Página {pagina} de {paginas}
          </span>
          <div className="adm-row">
            {pagina > 1 ? (
              <Link
                className="adm-btn adm-btn-ghost adm-btn-sm"
                href={`/admin/clientes?${new URLSearchParams({ q, orden, pagina: String(pagina - 1) }).toString()}`}
              >
                Anteriores
              </Link>
            ) : null}
            {pagina < paginas ? (
              <Link
                className="adm-btn adm-btn-ghost adm-btn-sm"
                href={`/admin/clientes?${new URLSearchParams({ q, orden, pagina: String(pagina + 1) }).toString()}`}
              >
                Siguientes
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ──────────────────────────── utilidades ──────────────────────────── */

/**
 * Se ordena en memoria y no en SQL porque "pedidos" y "gastado" son agregados
 * de otra tabla cruzados por correo: Prisma no puede ordenar por eso en una
 * sola consulta y el volumen de una boutique cabe de sobra en memoria.
 */
function ordenar(filas: Fila[], orden: Orden): void {
  switch (orden) {
    case "nombre":
      filas.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, "es"));
      break;
    case "pedidos":
      filas.sort((a, b) => b.pedidos - a.pedidos || b.gastadoCents - a.gastadoCents);
      break;
    case "reciente":
      filas.sort((a, b) => (b.ultimo?.getTime() ?? 0) - (a.ultimo?.getTime() ?? 0));
      break;
    default:
      filas.sort((a, b) => b.gastadoCents - a.gastadoCents || b.pedidos - a.pedidos);
  }
}

function OrdenLink({ href, activo, texto }: { href: string; activo: boolean; texto: string }) {
  return (
    <Link href={href} className={activo ? "adm-link" : undefined} aria-current={activo ? "true" : undefined}>
      {texto}
      {activo ? " ↓" : ""}
    </Link>
  );
}

function IconPersona() {
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
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}
