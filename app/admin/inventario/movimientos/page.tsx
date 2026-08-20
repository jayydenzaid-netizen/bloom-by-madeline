import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { isStockReason, REASON_LABELS, STOCK_REASONS, type StockReason } from "@/lib/inventory";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  type BadgeTone,
  type Column,
} from "../../_components/ui";
import "../inventario.css";

/**
 * Historial de movimientos de stock. Es la pantalla a la que se acude cuando
 * los números no cuadran: dice qué pasó, cuándo, cuánto había antes, cuánto
 * quedó después, con qué pedido o caja tiene que ver y quién lo hizo.
 *
 * Es de solo lectura a propósito. Un historial que se puede editar no sirve
 * para nada: si el rastro se puede retocar, deja de ser prueba de nada.
 */

export const dynamic = "force-dynamic";

const POR_PAGINA = 50;

const TONO_RAZON: Record<StockReason, BadgeTone> = {
  sale: "info",
  return: "warning",
  manual: "neutral",
  restock: "success",
  cancel: "warning",
  import: "info",
  count: "neutral",
};

type Busqueda = Record<string, string | string[] | undefined>;

type FilaMovimiento = {
  id: string;
  createdAt: Date;
  variantId: string;
  productId: string | null;
  nombre: string;
  reason: string;
  delta: number;
  before: number;
  after: number;
  reference: string | null;
  note: string;
  quien: string;
};

const fecha = new Intl.DateTimeFormat("es-US", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function MovimientosPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const q = uno(sp.q).trim();
  const razon = uno(sp.razon);
  const desde = uno(sp.desde);
  const hasta = uno(sp.hasta);
  const varianteId = uno(sp.variante);
  const pagina = Math.max(1, Number.parseInt(uno(sp.pagina), 10) || 1);

  const where = await construirFiltro({ q, razon, desde, hasta, varianteId });

  const [total, movimientos, totalAbsoluto] = await Promise.all([
    db.stockMovement.count({ where }),
    db.stockMovement.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (pagina - 1) * POR_PAGINA,
      take: POR_PAGINA,
    }),
    db.stockMovement.count(),
  ]);

  // StockMovement guarda `variantId` sin relación de Prisma (así el movimiento
  // sobrevive aunque la variante se borre). El nombre hay que buscarlo aparte y
  // cruzarlo aquí; si la variante ya no existe, se dice, en vez de esconder la
  // línea: el movimiento sigue explicando dónde se fue la mercancía.
  const idsVariante = [...new Set(movimientos.map((m) => m.variantId))];
  const idsUsuario = [...new Set(movimientos.map((m) => m.userId).filter((x): x is string => Boolean(x)))];

  const [variantes, usuarios] = await Promise.all([
    idsVariante.length > 0
      ? db.productVariant.findMany({
          where: { id: { in: idsVariante } },
          select: { id: true, title: true, sku: true, product: { select: { id: true, title: true } } },
        })
      : Promise.resolve([]),
    idsUsuario.length > 0
      ? db.adminUser.findMany({ where: { id: { in: idsUsuario } }, select: { id: true, name: true, email: true } })
      : Promise.resolve([]),
  ]);

  const porVariante = new Map(variantes.map((v) => [v.id, v]));
  const porUsuario = new Map(usuarios.map((u) => [u.id, u.name || u.email]));

  const filas: FilaMovimiento[] = movimientos.map((m) => {
    const v = porVariante.get(m.variantId);
    return {
      id: m.id,
      createdAt: m.createdAt,
      variantId: m.variantId,
      productId: v?.product.id ?? null,
      nombre: v ? `${v.product.title} · ${v.title}` : "Variante borrada",
      reason: m.reason,
      delta: m.delta,
      before: m.before,
      after: m.after,
      reference: m.reference,
      note: m.note,
      quien: m.userId ? porUsuario.get(m.userId) ?? "Cuenta borrada" : "La tienda",
    };
  });

  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const hayFiltro = Boolean(q || razon || desde || hasta || varianteId);

  const columnas: Column<FilaMovimiento>[] = [
    {
      key: "fecha",
      header: "Cuándo",
      render: (m) => <span className="adm-small">{fecha.format(m.createdAt)}</span>,
    },
    {
      key: "variante",
      header: "Variante",
      primary: true,
      render: (m) =>
        m.productId ? (
          <Link className="adm-link" href={`/admin/productos/${m.productId}`}>
            {m.nombre}
          </Link>
        ) : (
          <span className="adm-muted">{m.nombre}</span>
        ),
    },
    {
      key: "razon",
      header: "Motivo",
      render: (m) => {
        const clave = isStockReason(m.reason) ? m.reason : null;
        return (
          <Badge tone={clave ? TONO_RAZON[clave] : "neutral"}>{clave ? REASON_LABELS[clave] : m.reason}</Badge>
        );
      },
    },
    {
      key: "delta",
      header: "Cambio",
      align: "right",
      render: (m) => (
        <span className={`inv-delta ${m.delta > 0 ? "inv-delta-mas" : m.delta < 0 ? "inv-delta-menos" : ""}`}>
          {m.delta > 0 ? `+${m.delta}` : m.delta}
        </span>
      ),
    },
    {
      key: "salto",
      header: "Antes → Después",
      align: "right",
      render: (m) => (
        <span className="inv-salto">
          {m.before} → {m.after}
        </span>
      ),
    },
    {
      key: "referencia",
      header: "Referencia",
      hideOnMobile: true,
      render: (m) => (m.reference ? <span className="inv-sku">{m.reference}</span> : <span className="adm-muted">—</span>),
    },
    {
      key: "nota",
      header: "Nota",
      hideOnMobile: true,
      render: (m) => (m.note ? <span className="inv-nota-texto">{m.note}</span> : <span className="adm-muted">—</span>),
    },
    {
      key: "quien",
      header: "Quién",
      hideOnMobile: true,
      render: (m) => <span className="adm-muted adm-small">{m.quien}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Movimientos de stock"
        subtitle="Todo lo que ha entrado y salido, con el antes y el después de cada cambio."
        actions={
          <Button href="/admin/inventario" variant="ghost">
            Volver al inventario
          </Button>
        }
      />

      <Card title="Filtros">
        <form method="get" action="/admin/inventario/movimientos" className="inv-filtros">
          <div className="adm-field inv-filtros-busca">
            <label className="adm-field-lbl" htmlFor="q">
              Buscar
            </label>
            <input id="q" name="q" type="search" defaultValue={q} placeholder="Producto, talla, SKU…" />
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="razon">
              Motivo
            </label>
            <select id="razon" name="razon" defaultValue={razon}>
              <option value="">Todos</option>
              {STOCK_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="desde">
              Desde
            </label>
            <input id="desde" name="desde" type="date" defaultValue={desde} />
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="hasta">
              Hasta
            </label>
            <input id="hasta" name="hasta" type="date" defaultValue={hasta} />
          </div>

          {varianteId ? <input type="hidden" name="variante" value={varianteId} /> : null}

          <Button type="submit" variant="ghost">
            Aplicar
          </Button>
          <Button href="/admin/inventario/movimientos" variant="ghost">
            Limpiar
          </Button>
        </form>
      </Card>

      <Card
        title="Historial"
        flush
        footer={
          <div className="inv-pag">
            <span className="adm-muted adm-small">
              {paginas > 1
                ? `Página ${pagina} de ${paginas} · ${total} ${total === 1 ? "movimiento" : "movimientos"}`
                : `${total} ${total === 1 ? "movimiento" : "movimientos"}`}
            </span>
            {paginas > 1 ? (
              <span className="adm-row">
                <Button href={urlPagina(sp, pagina - 1)} variant="ghost" size="sm" aria-disabled={pagina <= 1}>
                  Anterior
                </Button>
                <Button href={urlPagina(sp, pagina + 1)} variant="ghost" size="sm" aria-disabled={pagina >= paginas}>
                  Siguiente
                </Button>
              </span>
            ) : null}
          </div>
        }
      >
        <DataTable<FilaMovimiento>
          columns={columnas}
          rows={filas}
          rowKey={(m) => m.id}
          empty={
            totalAbsoluto === 0 ? (
              <EmptyState
                icon={<IconReloj />}
                title="Todavía no se ha movido nada"
                text="Esta lista se llena sola: cada vez que ajustes el stock, entre un pedido o canceles uno, aparece aquí una línea con el antes y el después. No hay nada que configurar."
                action={<Button href="/admin/inventario">Ir al inventario</Button>}
              />
            ) : hayFiltro ? (
              <EmptyState
                icon={<IconReloj />}
                title="Ningún movimiento con ese filtro"
                text="Prueba a ampliar el rango de fechas o a quitar el motivo."
                action={
                  <Button href="/admin/inventario/movimientos" variant="ghost">
                    Ver todo el historial
                  </Button>
                }
              />
            ) : (
              "No hay movimientos que mostrar."
            )
          }
        />
      </Card>
    </>
  );
}

/* ─────────────────────────── consulta ─────────────────────────── */

async function construirFiltro(f: {
  q: string;
  razon: string;
  desde: string;
  hasta: string;
  varianteId: string;
}): Promise<Prisma.StockMovementWhereInput> {
  const where: Prisma.StockMovementWhereInput = {};

  if (isStockReason(f.razon)) where.reason = f.razon;
  if (f.varianteId) where.variantId = f.varianteId;

  const rango: Prisma.DateTimeFilter = {};
  const desde = aFechaLocal(f.desde, "inicio");
  const hasta = aFechaLocal(f.hasta, "fin");
  if (desde) rango.gte = desde;
  if (hasta) rango.lte = hasta;
  if (rango.gte || rango.lte) where.createdAt = rango;

  // Buscar por nombre de producto obliga a resolver primero qué variantes
  // encajan: el movimiento guarda el id "suelto", sin relación de Prisma.
  if (f.q) {
    const encajan = await db.productVariant.findMany({
      where: {
        OR: [{ title: { contains: f.q } }, { sku: { contains: f.q } }, { product: { title: { contains: f.q } } }],
      },
      select: { id: true },
      take: 500,
    });
    const ids = encajan.map((v) => v.id);
    // Lista vacía = ninguna coincidencia, y eso tiene que dar cero resultados,
    // no todos: `in: []` es exactamente eso.
    where.variantId = f.varianteId ? (ids.includes(f.varianteId) ? f.varianteId : "__ninguna__") : { in: ids };
  }

  return where;
}

/**
 * "2026-03-14" del `<input type="date">` a un Date del huso de la boutique.
 * `new Date("2026-03-14")` sería medianoche UTC, que en Ohio es el día
 * anterior a las 8 de la tarde: el filtro se comería un día entero.
 */
function aFechaLocal(valor: string, borde: "inicio" | "fin"): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;
  const fecha = new Date(`${valor}T${borde === "inicio" ? "00:00:00.000" : "23:59:59.999"}`);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/* ─────────────────────────── utilidades ─────────────────────────── */

function uno(valor: string | string[] | undefined): string {
  if (Array.isArray(valor)) return valor[0] ?? "";
  return valor ?? "";
}

function urlPagina(sp: Busqueda, pagina: number): string {
  const params = new URLSearchParams();
  for (const [clave, valor] of Object.entries(sp)) {
    if (clave === "pagina") continue;
    const texto = uno(valor);
    if (texto) params.set(clave, texto);
  }
  if (pagina > 1) params.set("pagina", String(pagina));
  const cadena = params.toString();
  return cadena ? `/admin/inventario/movimientos?${cadena}` : "/admin/inventario/movimientos";
}

function IconReloj() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
