import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  ESTADOS_RESENA,
  ETIQUETA_ESTADO,
  ETIQUETA_ORIGEN,
  esEstadoResena,
  mediaPuntuaciones,
  type EstadoResena,
  type OrigenResena,
} from "@/lib/reviews";
import Estrellas from "@/app/(shop)/_components/Estrellas";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  StatCard,
  type BadgeTone,
  type Column,
} from "../_components/ui";
import { AccionesResena, BarraLote, CasillaResena, CasillaTodas, ReviewForm } from "./_components/ReviewForm";
import "./resenas.css";

/**
 * Reseñas. Esta pantalla NO fabrica opiniones: es el sitio donde Madeline pasa
 * al sitio las que ya tiene en su destacado de Instagram, y donde modera lo que
 * llegue por el formulario de la tienda.
 *
 * Los filtros viajan por la URL (formulario GET, sin JavaScript) para que
 * "pendientes de aprobar" sea un enlace que se puede guardar o compartir.
 */

export const dynamic = "force-dynamic";

const POR_PAGINA = 30;

const fecha = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

const TONO_ESTADO: Record<EstadoResena, BadgeTone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
};

type ResenaFila = {
  id: string;
  authorName: string;
  rating: number;
  title: string;
  body: string;
  status: string;
  source: string;
  isVerified: boolean;
  createdAt: Date;
  productId: string | null;
  productoTitulo: string | null;
  productoSlug: string | null;
};

type Busqueda = { estado: string; producto: string; pagina: number };

function leerBusqueda(params: Record<string, string | string[] | undefined>): Busqueda {
  const uno = (key: string): string => {
    const raw = params[key];
    return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  };
  const estado = uno("estado");
  const pagina = Number.parseInt(uno("pagina") || "1", 10);

  return {
    estado: esEstadoResena(estado) ? estado : "todas",
    // "boutique" = reseñas que no cuelgan de ningún producto.
    producto: uno("producto").slice(0, 64),
    pagina: Number.isFinite(pagina) && pagina > 0 ? pagina : 1,
  };
}

function enlace(base: Busqueda, cambios: Partial<Busqueda>): string {
  const b = { ...base, ...cambios };
  const qs = new URLSearchParams();
  if (b.estado !== "todas") qs.set("estado", b.estado);
  if (b.producto) qs.set("producto", b.producto);
  if (b.pagina > 1) qs.set("pagina", String(b.pagina));
  const s = qs.toString();
  return s ? `/admin/resenas?${s}` : "/admin/resenas";
}

export default async function ResenasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Defensa en profundidad: aquí se leen nombres de clientas.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const busqueda = leerBusqueda(await searchParams);

  const where: Prisma.ReviewWhereInput = {};
  if (busqueda.estado !== "todas") where.status = busqueda.estado;
  if (busqueda.producto === "boutique") where.productId = null;
  else if (busqueda.producto) where.productId = busqueda.producto;

  const [total, filas, porEstado, aprobadas, productos, conResenas] = await Promise.all([
    db.review.count({ where }),
    db.review.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      skip: (busqueda.pagina - 1) * POR_PAGINA,
      take: POR_PAGINA,
      select: {
        id: true,
        authorName: true,
        rating: true,
        title: true,
        body: true,
        status: true,
        source: true,
        isVerified: true,
        createdAt: true,
        productId: true,
      },
    }),
    db.review.groupBy({ by: ["status"], _count: { _all: true } }),
    // La media se calcula solo con las aprobadas: es la que ve la clienta.
    db.review.findMany({ where: { status: "approved" }, select: { rating: true } }),
    db.product.findMany({
      where: { status: { not: "archived" } },
      orderBy: { title: "asc" },
      take: 300,
      select: { id: true, title: true },
    }),
    db.review.groupBy({ by: ["productId"], _count: { _all: true } }),
  ]);

  // Títulos de los productos citados en las filas de esta página.
  const idsProducto = [...new Set(filas.map((f) => f.productId).filter((id): id is string => Boolean(id)))];
  const fichas = idsProducto.length
    ? await db.product.findMany({ where: { id: { in: idsProducto } }, select: { id: true, title: true, slug: true } })
    : [];
  const porId = new Map(fichas.map((p) => [p.id, p]));

  const resenas: ResenaFila[] = filas.map((f) => ({
    ...f,
    productoTitulo: f.productId ? (porId.get(f.productId)?.title ?? "Producto borrado") : null,
    productoSlug: f.productId ? (porId.get(f.productId)?.slug ?? null) : null,
  }));

  const cuenta = (estado: EstadoResena): number =>
    porEstado.find((g) => g.status === estado)?._count._all ?? 0;

  const media = mediaPuntuaciones(aprobadas.map((a) => a.rating));
  const totalGeneral = porEstado.reduce((acc, g) => acc + g._count._all, 0);
  const hayFiltro = busqueda.estado !== "todas" || busqueda.producto !== "";

  // Solo se ofrecen en el filtro los productos que de verdad tienen reseñas.
  const idsConResenas = new Set(conResenas.map((g) => g.productId).filter(Boolean) as string[]);
  const productosFiltro = productos.filter((p) => idsConResenas.has(p.id));
  const hayGenerales = conResenas.some((g) => g.productId === null);

  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const pagina = Math.min(busqueda.pagina, paginas);

  return (
    <>
      <PageHeader
        title="Reseñas"
        subtitle="Lo que dicen tus clientas. Solo las aprobadas se ven en la tienda."
        actions={
          cuenta("pending") > 0 ? (
            <Button href="/admin/resenas?estado=pending" variant="ghost" size="sm">
              {cuenta("pending")} por revisar
            </Button>
          ) : null
        }
      />

      <div className="adm-grid">
        <StatCard label="Reseñas en total" value={totalGeneral} hint="Contando todas, aprobadas o no" />
        <StatCard
          label="Por revisar"
          value={cuenta("pending")}
          tone={cuenta("pending") > 0 ? "warning" : "default"}
          hint="Nadie las ve hasta que las apruebes"
        />
        <StatCard label="Publicadas" value={cuenta("approved")} tone="success" hint="Visibles en la tienda" />
        <StatCard
          label="Nota media"
          value={media > 0 ? media.toFixed(1) : "—"}
          tone="accent"
          hint={media > 0 ? `Sobre ${cuenta("approved")} reseñas publicadas` : "Aún sin reseñas publicadas"}
        />
      </div>

      <ReviewForm productos={productos} />

      <Card>
        <form method="get" className="adm-row" style={{ alignItems: "flex-end", gap: 12 }}>
          <label className="adm-field" style={{ flex: "0 1 200px" }}>
            <span className="adm-field-lbl">Estado</span>
            <select name="estado" defaultValue={busqueda.estado}>
              <option value="todas">Todas</option>
              {ESTADOS_RESENA.map((e) => (
                <option key={e} value={e}>
                  {ETIQUETA_ESTADO[e]}
                </option>
              ))}
            </select>
          </label>

          <label className="adm-field" style={{ flex: "1 1 240px", minWidth: 180 }}>
            <span className="adm-field-lbl">Producto</span>
            <select name="producto" defaultValue={busqueda.producto}>
              <option value="">Cualquiera</option>
              {hayGenerales ? <option value="boutique">De la boutique en general</option> : null}
              {productosFiltro.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>

          <div className="adm-row" style={{ paddingBottom: 2 }}>
            <button type="submit" className="adm-btn adm-btn-primary adm-btn-sm">
              Filtrar
            </button>
            {hayFiltro ? (
              <Link className="adm-btn adm-btn-ghost adm-btn-sm" href="/admin/resenas">
                Limpiar
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      <Card
        title={busqueda.estado === "todas" ? "Todas las reseñas" : ETIQUETA_ESTADO[busqueda.estado as EstadoResena]}
        actions={<span className="adm-muted adm-small">{total === 1 ? "1 reseña" : `${total} reseñas`}</span>}
      >
        {/* El formulario de lote envuelve la tabla; la tabla se sigue pintando
            en el servidor y llega como children. */}
        <BarraLote>
          <DataTable<ResenaFila>
            columns={COLUMNAS}
            rows={resenas}
            rowKey={(r) => r.id}
            empty={
              hayFiltro ? (
                <EmptyState
                  icon={<IconLupa />}
                  title="Ninguna reseña con ese filtro"
                  text="Prueba a poner el estado en «Todas»."
                  action={
                    <Button href="/admin/resenas" variant="ghost">
                      Ver todas
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<IconEstrella />}
                  title="Todavía no hay reseñas aquí"
                  text="Abre tu destacado de Instagram, copia lo que te escribió una clienta y pégalo con «Añadir una reseña», aquí arriba. Con tres o cuatro reales ya se nota en la tienda."
                />
              )
            }
          />
        </BarraLote>
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

const COLUMNAS: Column<ResenaFila>[] = [
  {
    key: "sel",
    header: <CasillaTodas />,
    label: "Seleccionar",
    width: "36px",
    render: (r) => <CasillaResena id={r.id} autora={r.authorName} />,
  },
  {
    key: "resena",
    header: "Reseña",
    primary: true,
    render: (r) => (
      <div>
        <div className="adm-row" style={{ gap: 8, alignItems: "center" }}>
          <span className="rev-autora">{r.authorName}</span>
          <Estrellas valor={r.rating} tamano="sm" mostrarNumero={false} />
          {r.isVerified ? <Badge tone="info">Compra verificada</Badge> : null}
        </div>
        {r.title ? <div style={{ fontWeight: 500, marginTop: 2 }}>{r.title}</div> : null}
        <p className="rev-texto">{r.body}</p>
      </div>
    ),
  },
  {
    key: "producto",
    header: "Producto",
    hideOnMobile: true,
    render: (r) =>
      r.productId ? (
        r.productoSlug ? (
          <Link className="adm-link" href={`/admin/productos/${r.productId}`}>
            {r.productoTitulo}
          </Link>
        ) : (
          <span className="adm-muted">{r.productoTitulo}</span>
        )
      ) : (
        <span className="adm-muted">La boutique</span>
      ),
  },
  {
    key: "estado",
    header: "Estado",
    render: (r) => {
      const estado = esEstadoResena(r.status) ? r.status : null;
      return (
        <Badge tone={estado ? TONO_ESTADO[estado] : "neutral"}>
          {estado ? ETIQUETA_ESTADO[estado] : r.status}
        </Badge>
      );
    },
  },
  {
    key: "origen",
    header: "Origen",
    hideOnMobile: true,
    render: (r) => (
      <span className="adm-muted adm-small">
        {ETIQUETA_ORIGEN[r.source as OrigenResena] ?? r.source}
        <br />
        {fecha.format(r.createdAt)}
      </span>
    ),
  },
  {
    key: "acciones",
    header: "Acciones",
    align: "right",
    render: (r) => <AccionesResena id={r.id} estado={r.status} autora={r.authorName} />,
  },
];

/* ─────────────────────────────── iconos ───────────────────────────── */

function IconEstrella() {
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
      <path d="M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.8L12 16.85 6.75 19.6l1-5.8L3.5 9.65l5.9-.85z" />
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
