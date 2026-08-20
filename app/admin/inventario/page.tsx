import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { stockValue } from "@/lib/inventory";
import { formatCents } from "@/lib/money";
import { Button, Card, PageHeader, StatCard } from "../_components/ui";
import { StockTable, type FilaInventario } from "./_components/StockTable";
import "./inventario.css";

/**
 * Inventario: una fila por variante, con el stock editable en la propia fila.
 *
 * La idea que manda en esta pantalla: el inventario es dinero parado. Por eso
 * arriba no van "unidades" a secas sino cuánto valen, a coste y a venta — el
 * número que casi ningún dueño de tienda sabe de memoria. Y por eso lo que está
 * a cero se pinta en rojo: cada variante agotada es una venta que no ocurre.
 *
 * Todos los filtros son un formulario GET, así que la URL se puede guardar en
 * favoritos y funcionan sin JavaScript. La edición del stock sí es cliente,
 * porque teclear un número y ver "Guardado" es interacción de verdad.
 */

export const dynamic = "force-dynamic";

const POR_PAGINA = 25;
const UMBRAL_POR_DEFECTO = 3;

const ORDENES: Record<string, Prisma.ProductVariantOrderByWithRelationInput[]> = {
  producto: [{ product: { title: "asc" } }, { position: "asc" }],
  "stock-asc": [{ stock: "asc" }, { product: { title: "asc" } }],
  "stock-desc": [{ stock: "desc" }, { product: { title: "asc" } }],
  reciente: [{ updatedAt: "desc" }],
};

type Busqueda = Record<string, string | string[] | undefined>;

export default async function InventarioPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  // Cada pantalla comprueba la sesión por su cuenta: en App Router la página se
  // renderiza aunque el layout no la pinte, y el resultado viaja en el payload
  // RSC. Solo redirect() aborta el render de verdad.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const q = uno(sp.q).trim();
  const productoId = uno(sp.producto);
  const coleccionId = uno(sp.coleccion);
  const filtro = uno(sp.filtro);
  const orden = ORDENES[uno(sp.orden)] ? uno(sp.orden) : "producto";
  const pagina = Math.max(1, Number.parseInt(uno(sp.pagina), 10) || 1);
  const umbral = Math.max(0, Number.parseInt(uno(sp.umbral), 10) || UMBRAL_POR_DEFECTO);

  const where = construirFiltro({ q, productoId, coleccionId, filtro, umbral });

  const seleccion = {
    id: true,
    title: true,
    sku: true,
    stock: true,
    trackStock: true,
    costCents: true,
    priceCents: true,
    imageUrl: true,
    product: {
      select: {
        id: true,
        title: true,
        status: true,
        costCents: true,
        images: { orderBy: { position: "asc" as const }, take: 1, select: { url: true } },
      },
    },
  };

  const [total, variantes, todas, productos, colecciones, valor, bajoMinimo, agotadas, totalVariantes] =
    await Promise.all([
      db.productVariant.count({ where }),
      db.productVariant.findMany({
        where,
        orderBy: ORDENES[orden],
        skip: (pagina - 1) * POR_PAGINA,
        take: POR_PAGINA,
        select: seleccion,
      }),
      // El CSV se lleva TODO lo filtrado, no solo la página que se ve: exportar
      // 25 de 200 filas sin avisar es la forma más rápida de tomar una decisión
      // con datos incompletos.
      db.productVariant.findMany({ where, orderBy: ORDENES[orden], select: seleccion }),
      db.product.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } }),
      db.collection.findMany({
        orderBy: [{ position: "asc" }, { title: "asc" }],
        select: { id: true, title: true },
      }),
      stockValue(),
      db.productVariant.count({ where: { trackStock: true, stock: { gt: 0, lte: umbral } } }),
      db.productVariant.count({ where: { trackStock: true, stock: { lte: 0 } } }),
      db.productVariant.count(),
    ]);

  const filas = variantes.map(aFila);
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const hayFiltro = Boolean(q || productoId || coleccionId || filtro);

  return (
    <>
      <PageHeader
        title="Inventario"
        subtitle="Cuántas unidades hay de cada talla y cuánto dinero tienes parado en el armario."
        actions={
          <Button href="/admin/inventario/movimientos" variant="ghost">
            Ver el historial
          </Button>
        }
      />

      <div className="adm-grid">
        <StatCard
          label="Unidades en el armario"
          value={valor.units.toLocaleString("es-US")}
          hint={`${valor.trackedVariants} ${valor.trackedVariants === 1 ? "variante con control" : "variantes con control"}`}
        />
        <StatCard
          label="Valor a coste"
          value={formatCents(valor.costCents)}
          tone="accent"
          hint={
            valor.variantsWithoutCost > 0
              ? `Faltan ${valor.unitsWithoutCost} unidades sin coste puesto: el valor real es mayor.`
              : "Lo que costó comprar lo que hay."
          }
        />
        <StatCard
          label="Valor a precio de venta"
          value={formatCents(valor.retailCents)}
          tone="success"
          hint="Lo que entraría si se vendiera todo."
        />
        <StatCard
          label="Bajo mínimo"
          value={bajoMinimo}
          tone={bajoMinimo > 0 ? "warning" : "default"}
          hint={`Variantes con ${umbral} o menos, sin llegar a cero.`}
        />
        <StatCard
          label="Agotadas"
          value={agotadas}
          tone={agotadas > 0 ? "danger" : "default"}
          hint="Con control de stock y a cero unidades."
        />
      </div>

      <Card title="Por qué hay variantes que no se cuentan">
        <div className="inv-explica">
          <div>
            <p>
              Una variante marcada como <b>«Del proveedor»</b> se vende sin control de stock: la mercancía no está
              en la boutique, la manda el proveedor cuando llega el pedido. Su número de unidades no significa
              nada, así que <b>no suma en ninguna de las cifras de arriba</b> ni se puede ajustar desde aquí.
            </p>
            <p className="adm-small adm-muted">
              Lo que sí se cuenta es lo que está físicamente en el mostrador o en tu armario. Si quieres llevarle
              la cuenta a una variante de proveedor, activa «Controlar stock» en la ficha del producto y a partir
              de ese momento aparecerá aquí con todo lo demás. Ahora mismo hay {valor.untrackedVariants}{" "}
              {valor.untrackedVariants === 1 ? "variante sin control" : "variantes sin control"}.
            </p>
          </div>
        </div>
      </Card>

      <Card title="Filtros">
        <form method="get" action="/admin/inventario" className="inv-filtros">
          <div className="adm-field inv-filtros-busca">
            <label className="adm-field-lbl" htmlFor="q">
              Buscar
            </label>
            <input id="q" name="q" type="search" defaultValue={q} placeholder="Producto, talla, SKU…" />
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="producto">
              Producto
            </label>
            <select id="producto" name="producto" defaultValue={productoId}>
              <option value="">Todos</option>
              {productos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title || "Sin título"}
                </option>
              ))}
            </select>
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="coleccion">
              Colección
            </label>
            <select id="coleccion" name="coleccion" defaultValue={coleccionId}>
              <option value="">Todas</option>
              {colecciones.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="filtro">
              Ver solo
            </label>
            <select id="filtro" name="filtro" defaultValue={filtro}>
              <option value="">Todo</option>
              <option value="bajo">Bajo stock (1 a {umbral})</option>
              <option value="agotado">Agotadas (0)</option>
              <option value="sin-control">Sin control de stock</option>
            </select>
          </div>

          <div className="adm-field inv-filtros-umbral">
            <label className="adm-field-lbl" htmlFor="umbral">
              Mínimo
            </label>
            <input id="umbral" name="umbral" type="number" min={0} step={1} defaultValue={umbral} inputMode="numeric" />
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="orden">
              Orden
            </label>
            <select id="orden" name="orden" defaultValue={orden}>
              <option value="producto">Por producto (A–Z)</option>
              <option value="stock-asc">Menos unidades primero</option>
              <option value="stock-desc">Más unidades primero</option>
              <option value="reciente">Movidas hace poco</option>
            </select>
          </div>

          <Button type="submit" variant="ghost">
            Aplicar
          </Button>
          <Button href="/admin/inventario" variant="ghost">
            Limpiar
          </Button>
        </form>
      </Card>

      <Card
        title="Variantes"
        flush
        footer={
          <div className="inv-pag">
            <span className="adm-muted adm-small">
              {paginas > 1
                ? `Página ${pagina} de ${paginas} · ${total} ${total === 1 ? "variante" : "variantes"}`
                : `${total} ${total === 1 ? "variante" : "variantes"}`}
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
            ) : (
              <Link className="adm-link adm-small" href="/admin/inventario/movimientos">
                ¿No cuadra algo? Mira el historial de movimientos
              </Link>
            )}
          </div>
        }
      >
        <StockTable
          filas={filas}
          umbral={umbral}
          csv={construirCsv(todas.map(aFila))}
          nombreCsv={`inventario-${new Date().toISOString().slice(0, 10)}.csv`}
          hayFiltro={hayFiltro}
          sinInventario={totalVariantes === 0}
        />
      </Card>
    </>
  );
}

/* ─────────────────────────── consulta ─────────────────────────── */

function construirFiltro(f: {
  q: string;
  productoId: string;
  coleccionId: string;
  filtro: string;
  umbral: number;
}): Prisma.ProductVariantWhereInput {
  const where: Prisma.ProductVariantWhereInput = {};

  if (f.q) {
    // SQLite compara LIKE sin distinguir mayúsculas para ASCII, así que no hace
    // falta (ni existe) el `mode: "insensitive"` de Postgres.
    where.OR = [
      { title: { contains: f.q } },
      { sku: { contains: f.q } },
      { product: { title: { contains: f.q } } },
    ];
  }

  if (f.productoId) where.productId = f.productoId;
  if (f.coleccionId) where.product = { collections: { some: { collectionId: f.coleccionId } } };

  switch (f.filtro) {
    case "bajo":
      // Bajo mínimo y agotadas son listas distintas a propósito: una pide
      // reponer y la otra ya está costando ventas.
      where.trackStock = true;
      where.stock = { gt: 0, lte: f.umbral };
      break;
    case "agotado":
      where.trackStock = true;
      where.stock = { lte: 0 };
      break;
    case "sin-control":
      where.trackStock = false;
      break;
    default:
      break;
  }

  return where;
}

type VarianteConsultada = {
  id: string;
  title: string;
  sku: string;
  stock: number;
  trackStock: boolean;
  costCents: number | null;
  priceCents: number;
  imageUrl: string | null;
  product: {
    id: string;
    title: string;
    status: string;
    costCents: number | null;
    images: { url: string }[];
  };
};

/** El coste de la variante manda; si no lo tiene, sirve el del producto. */
function aFila(v: VarianteConsultada): FilaInventario {
  return {
    variantId: v.id,
    productId: v.product.id,
    productTitle: v.product.title,
    productStatus: v.product.status,
    variantTitle: v.title,
    sku: v.sku,
    stock: v.stock,
    trackStock: v.trackStock,
    costCents: v.costCents ?? v.product.costCents ?? null,
    priceCents: v.priceCents,
    imagen: v.imageUrl ?? v.product.images[0]?.url ?? null,
  };
}

/* ─────────────────────────── CSV ─────────────────────────── */

const CABECERAS_CSV = [
  "Producto",
  "Variante",
  "SKU",
  "Estado del producto",
  "Se cuenta",
  "Stock",
  "Coste",
  "Coste (centavos)",
  "Precio",
  "Precio (centavos)",
  "Valor a coste (centavos)",
  "Valor a venta (centavos)",
];

/**
 * El CSV lleva cada importe dos veces: formateado para leerlo y en centavos
 * enteros para calcular. Una hoja de cálculo que recibe "$45.99" no puede sumar
 * la columna, y si convirtiéramos a 45.99 volveríamos a los decimales flotantes
 * que esta tienda tiene prohibidos.
 */
function construirCsv(filas: FilaInventario[]): string {
  const lineas = [CABECERAS_CSV.map(celda).join(",")];

  for (const f of filas) {
    const valorCoste = f.trackStock && f.costCents !== null ? f.stock * f.costCents : "";
    const valorVenta = f.trackStock ? f.stock * f.priceCents : "";
    lineas.push(
      [
        celda(f.productTitle),
        celda(f.variantTitle),
        celda(f.sku),
        celda(f.productStatus),
        celda(f.trackStock ? "sí" : "no (del proveedor)"),
        celda(f.trackStock ? String(f.stock) : ""),
        celda(f.costCents === null ? "" : formatCents(f.costCents)),
        celda(f.costCents === null ? "" : String(f.costCents)),
        celda(formatCents(f.priceCents)),
        celda(String(f.priceCents)),
        celda(String(valorCoste)),
        celda(String(valorVenta)),
      ].join(","),
    );
  }

  return lineas.join("\r\n");
}

/**
 * Una celda de CSV siempre entrecomillada. El prefijo con apóstrofo cuando el
 * texto empieza por = + - @ evita que Excel interprete el título de un producto
 * como una fórmula: es una vía real de ejecución de código al abrir el fichero.
 */
function celda(valor: string): string {
  const texto = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
  return `"${texto.replace(/"/g, '""')}"`;
}

/* ─────────────────────────── utilidades ─────────────────────────── */

function uno(valor: string | string[] | undefined): string {
  if (Array.isArray(valor)) return valor[0] ?? "";
  return valor ?? "";
}

/** Cambia de página conservando todos los filtros que ya estaban puestos. */
function urlPagina(sp: Busqueda, pagina: number): string {
  const params = new URLSearchParams();
  for (const [clave, valor] of Object.entries(sp)) {
    if (clave === "pagina") continue;
    const texto = uno(valor);
    if (texto) params.set(clave, texto);
  }
  if (pagina > 1) params.set("pagina", String(pagina));
  const cadena = params.toString();
  return cadena ? `/admin/inventario?${cadena}` : "/admin/inventario";
}
