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
import { accionEnLote } from "./actions";
import { PrecioRapido, StockRapido } from "./_components/EdicionRapida";
import "./catalogo.css";

/**
 * Listado del catálogo. Es la pantalla donde Madeline pasa el rato, así que
 * manda una idea: lo que le está costando dinero tiene que saltar a la vista.
 * Un producto activo sin precio o sin foto no es un detalle de mantenimiento,
 * es una venta que no ocurre.
 *
 * Todo funciona sin JavaScript: los filtros son un formulario GET y las
 * acciones en lote un formulario POST a un Server Action. Si el móvil de la
 * boutique tiene mala cobertura, el panel sigue respondiendo.
 */

export const dynamic = "force-dynamic";

const POR_PAGINA = 25;

const ESTADO_ETIQUETA: Record<string, { label: string; tone: BadgeTone }> = {
  draft: { label: "Borrador", tone: "neutral" },
  active: { label: "Activo", tone: "success" },
  archived: { label: "Archivado", tone: "neutral" },
};

const ORIGEN_ETIQUETA: Record<string, string> = {
  manual: "Manual",
  aliexpress: "AliExpress",
  alibaba: "Alibaba",
  csv: "CSV",
};

const ORDENES: Record<string, Prisma.ProductOrderByWithRelationInput> = {
  reciente: { createdAt: "desc" },
  antiguo: { createdAt: "asc" },
  actualizado: { updatedAt: "desc" },
  titulo: { title: "asc" },
  "precio-asc": { priceCents: "asc" },
  "precio-desc": { priceCents: "desc" },
};

type Busqueda = Record<string, string | string[] | undefined>;

type FilaProducto = {
  id: string;
  slug: string;
  title: string;
  status: string;
  priceCents: number;
  sourceProvider: string | null;
  portada: string | null;
  colecciones: string[];
  stockTotal: number;
  controlaStock: boolean;
  agotado: boolean;
  sinFoto: boolean;
  numVariantes: number;
};

export default async function ProductosPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  // Cada pantalla del panel comprueba la sesión por su cuenta: en App Router una
  // página se renderiza aunque el layout no la pinte, y el resultado viaja en el
  // payload RSC. Solo redirect() aborta el render de verdad.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const q = uno(sp.q).trim();
  const estado = uno(sp.estado);
  const coleccionId = uno(sp.coleccion);
  const aviso = uno(sp.aviso);
  const orden = ORDENES[uno(sp.orden)] ? uno(sp.orden) : "reciente";
  const pagina = Math.max(1, Number.parseInt(uno(sp.pagina), 10) || 1);
  const idsBorrar = uno(sp.borrar).split(",").map((s) => s.trim()).filter(Boolean);

  const colecciones = await db.collection.findMany({
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: { id: true, title: true },
  });

  /* ── pantalla de confirmación de borrado ────────────────────────────── */

  if (idsBorrar.length > 0) {
    const condenados = await db.product.findMany({
      where: { id: { in: idsBorrar } },
      orderBy: { title: "asc" },
      select: { id: true, title: true, status: true, priceCents: true },
    });

    return (
      <>
        <PageHeader
          title="Confirmar el borrado"
          subtitle="Borrar un producto es definitivo: no hay papelera."
        />
        <form action={accionEnLote}>
          <input type="hidden" name="accion" value="borrar-confirmado" />
          <input type="hidden" name="volver" value={urlConFiltros(sp)} />
          {condenados.map((p) => (
            <input key={p.id} type="hidden" name="ids" value={p.id} />
          ))}

          <Card
            title={`Se van a borrar ${condenados.length} ${condenados.length === 1 ? "producto" : "productos"}`}
            footer={
              <div className="adm-row">
                <Button type="submit" variant="danger">
                  Sí, borrar {condenados.length} {condenados.length === 1 ? "producto" : "productos"}
                </Button>
                <Button href={urlConFiltros(sp)} variant="ghost">
                  Cancelar
                </Button>
              </div>
            }
          >
            {condenados.length === 0 ? (
              <p className="adm-muted">Esos productos ya no existen.</p>
            ) : (
              <>
                <ul style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {condenados.map((p) => (
                    <li key={p.id} className="adm-row">
                      <Badge tone={ESTADO_ETIQUETA[p.status]?.tone ?? "neutral"}>
                        {ESTADO_ETIQUETA[p.status]?.label ?? p.status}
                      </Badge>
                      <b>{p.title}</b>
                      <Money cents={p.priceCents} tone="muted" />
                    </li>
                  ))}
                </ul>
                <p className="adm-muted adm-small" style={{ marginTop: 14 }}>
                  Sus fotos y variantes se van con ellos. Los pedidos ya hechos siguen siendo legibles porque cada
                  línea guarda su propia copia del título y del precio.
                </p>
              </>
            )}
          </Card>
        </form>
      </>
    );
  }

  /* ── consulta del listado ───────────────────────────────────────────── */

  const where = construirFiltro({ q, estado, coleccionId, aviso });

  const [total, productos, resumen] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      orderBy: ORDENES[orden],
      skip: (pagina - 1) * POR_PAGINA,
      take: POR_PAGINA,
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        priceCents: true,
        sourceProvider: true,
        images: { orderBy: { position: "asc" }, take: 1, select: { url: true } },
        variants: { select: { stock: true, trackStock: true } },
        collections: { select: { collection: { select: { title: true } } } },
      },
    }),
    cargarResumen(),
  ]);

  const filas: FilaProducto[] = productos.map((p) => {
    const controlaStock = p.variants.some((v) => v.trackStock);
    const stockTotal = p.variants.filter((v) => v.trackStock).reduce((suma, v) => suma + v.stock, 0);
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      status: p.status,
      priceCents: p.priceCents,
      sourceProvider: p.sourceProvider,
      portada: p.images[0]?.url ?? null,
      colecciones: p.collections.map((c) => c.collection.title),
      stockTotal,
      controlaStock,
      agotado: p.variants.some((v) => v.trackStock && v.stock <= 0),
      sinFoto: p.images.length === 0,
      numVariantes: p.variants.length,
    };
  });

  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const urlActual = urlConFiltros(sp);
  const mensaje = construirMensaje(uno(sp.hecho), Number(uno(sp.n)) || 0, Number(uno(sp.m)) || 0);

  const columnas: Column<FilaProducto>[] = [
    {
      key: "sel",
      header: "",
      label: "Seleccionar",
      width: "34px",
      render: (p) => (
        // El formulario vive fuera de la tabla; el atributo form los conecta sin
        // tener que meter la tabla dentro del <form>.
        <input
          className="cat-check"
          type="checkbox"
          name="ids"
          value={p.id}
          form="lote"
          aria-label={`Seleccionar ${p.title}`}
        />
      ),
    },
    {
      key: "producto",
      header: "Producto",
      primary: true,
      render: (p) => (
        <span className="cat-prod">
          {p.portada ? (
            /* eslint-disable-next-line @next/next/no-img-element -- las fotos de
               proveedor viven en CDNs que no están declaradas en next.config. */
            <img className="adm-thumb" src={p.portada} alt="" />
          ) : (
            <span className="cat-thumb-vacio">SIN FOTO</span>
          )}
          <span className="cat-prod-txt">
            <Link className="adm-link" href={`/admin/productos/${p.id}`}>
              {p.title || "Producto sin título"}
            </Link>
            <span className="cat-flags">
              {p.priceCents <= 0 && p.status !== "archived" ? <Badge tone="danger">Sin precio</Badge> : null}
              {p.sinFoto ? <Badge tone="warning">Sin foto</Badge> : null}
              {p.agotado ? <Badge tone="danger">Agotado</Badge> : null}
            </span>
          </span>
        </span>
      ),
    },
    {
      key: "estado",
      header: "Estado",
      render: (p) => {
        const et = ESTADO_ETIQUETA[p.status] ?? { label: p.status, tone: "neutral" as BadgeTone };
        return <Badge tone={et.tone}>{et.label}</Badge>;
      },
    },
    {
      key: "coleccion",
      header: "Colección",
      hideOnMobile: true,
      render: (p) =>
        p.colecciones.length === 0 ? (
          <span className="adm-muted">—</span>
        ) : (
          <span className="adm-small">{p.colecciones.join(", ")}</span>
        ),
    },
    {
      key: "origen",
      header: "Origen",
      hideOnMobile: true,
      render: (p) => (
        <span className="adm-muted adm-small">
          {ORIGEN_ETIQUETA[p.sourceProvider ?? "manual"] ?? p.sourceProvider ?? "Manual"}
        </span>
      ),
    },
    {
      key: "stock",
      header: "Stock",
      align: "right",
      render: (p) => (
        <StockRapido
          id={p.id}
          stockTotal={p.stockTotal}
          controlaStock={p.controlaStock}
          variantes={p.numVariantes}
        />
      ),
    },
    {
      key: "precio",
      header: "Precio",
      align: "right",
      render: (p) => <PrecioRapido id={p.id} priceCents={p.priceCents} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Productos"
        subtitle={resumenTexto(resumen, total, Boolean(q || estado || coleccionId || aviso))}
        actions={
          <>
            <Button href="/admin/productos/nuevo">Nuevo producto</Button>
            <Button href="/admin/importar" variant="ghost">
              Importar de proveedor
            </Button>
          </>
        }
      />

      {mensaje ? <div className={`cat-aviso cat-aviso-${mensaje.tono}`}>{mensaje.texto}</div> : null}

      {resumen.total > 0 && (resumen.sinPrecio > 0 || resumen.sinFoto > 0 || resumen.agotados > 0) ? (
        <Card title="Lo que está frenando ventas" flush>
          <div className="adm-alerts">
            {resumen.sinPrecio > 0 ? (
              <div className="adm-alert">
                <span className="adm-alert-text">
                  <Badge tone="danger">Precio</Badge>
                  {resumen.sinPrecio === 1
                    ? "1 producto no archivado está a $0.00."
                    : `${resumen.sinPrecio} productos no archivados están a $0.00.`}
                </span>
                <Link className="adm-alert-cta" href="/admin/productos?aviso=sin-precio">
                  Ponerles precio
                </Link>
              </div>
            ) : null}
            {resumen.sinFoto > 0 ? (
              <div className="adm-alert">
                <span className="adm-alert-text">
                  <Badge tone="warning">Foto</Badge>
                  {resumen.sinFoto === 1
                    ? "1 producto no tiene ninguna foto."
                    : `${resumen.sinFoto} productos no tienen ninguna foto.`}
                </span>
                <Link className="adm-alert-cta" href="/admin/productos?aviso=sin-imagen">
                  Ver cuáles
                </Link>
              </div>
            ) : null}
            {resumen.agotados > 0 ? (
              <div className="adm-alert">
                <span className="adm-alert-text">
                  <Badge tone="danger">Stock</Badge>
                  {resumen.agotados === 1
                    ? "1 producto tiene una variante controlada a cero."
                    : `${resumen.agotados} productos tienen variantes controladas a cero.`}
                </span>
                <Link className="adm-alert-cta" href="/admin/productos?aviso=sin-stock">
                  Ver agotados
                </Link>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card title="Filtros">
        <form method="get" action="/admin/productos" className="cat-filtros">
          <div className="adm-field cat-filtros-busca">
            <label className="adm-field-lbl" htmlFor="q">
              Buscar
            </label>
            <input id="q" name="q" type="search" defaultValue={q} placeholder="Título, etiqueta, tipo…" />
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="estado">
              Estado
            </label>
            <select id="estado" name="estado" defaultValue={estado}>
              <option value="">Todos</option>
              <option value="draft">Borrador</option>
              <option value="active">Activo</option>
              <option value="archived">Archivado</option>
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
            <label className="adm-field-lbl" htmlFor="aviso">
              Problemas
            </label>
            <select id="aviso" name="aviso" defaultValue={aviso}>
              <option value="">Sin filtrar</option>
              <option value="sin-precio">Sin precio</option>
              <option value="sin-imagen">Sin foto</option>
              <option value="sin-stock">Agotados</option>
            </select>
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="orden">
              Orden
            </label>
            <select id="orden" name="orden" defaultValue={orden}>
              <option value="reciente">Más recientes</option>
              <option value="antiguo">Más antiguos</option>
              <option value="actualizado">Editados hace poco</option>
              <option value="titulo">Título (A–Z)</option>
              <option value="precio-asc">Precio (barato primero)</option>
              <option value="precio-desc">Precio (caro primero)</option>
            </select>
          </div>

          <Button type="submit" variant="ghost">
            Aplicar
          </Button>
          <Button href="/admin/productos" variant="ghost">
            Limpiar
          </Button>
        </form>
      </Card>

      {filas.length > 0 ? (
        <form id="lote" action={accionEnLote} className="cat-lote">
          <input type="hidden" name="volver" value={urlActual} />
          <input type="hidden" name="idsPagina" value={filas.map((f) => f.id).join(",")} />

          <span className="cat-lote-etiqueta">En lote</span>
          <label className="cat-lote-todos">
            <input className="cat-check" type="checkbox" name="todos" />
            Los {filas.length} de esta página
          </label>

          <Button type="submit" name="accion" value="activar" variant="ghost" size="sm">
            Activar
          </Button>
          <Button type="submit" name="accion" value="borrador" variant="ghost" size="sm">
            Pasar a borrador
          </Button>
          <Button type="submit" name="accion" value="archivar" variant="ghost" size="sm">
            Archivar
          </Button>

          {colecciones.length > 0 ? (
            <>
              <select name="coleccionId" aria-label="Colección a la que añadir" defaultValue="">
                <option value="">Añadir a la colección…</option>
                {colecciones.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
              <Button type="submit" name="accion" value="coleccion" variant="ghost" size="sm">
                Añadir
              </Button>
            </>
          ) : null}

          <span className="cat-bulk-sep" />
          <Button type="submit" name="accion" value="borrar" variant="danger" size="sm">
            Borrar…
          </Button>
        </form>
      ) : null}

      <Card
        title="Catálogo"
        flush
        footer={
          paginas > 1 ? (
            <div className="cat-pag">
              <span className="adm-muted adm-small">
                Página {pagina} de {paginas} · {total} {total === 1 ? "producto" : "productos"}
              </span>
              <span className="adm-row">
                <Button href={urlPagina(sp, pagina - 1)} variant="ghost" size="sm" aria-disabled={pagina <= 1}>
                  Anterior
                </Button>
                <Button href={urlPagina(sp, pagina + 1)} variant="ghost" size="sm" aria-disabled={pagina >= paginas}>
                  Siguiente
                </Button>
              </span>
            </div>
          ) : (
            <span className="adm-muted adm-small">
              {total} {total === 1 ? "producto" : "productos"}
            </span>
          )
        }
      >
        <DataTable<FilaProducto>
          columns={columnas}
          rows={filas}
          rowKey={(p) => p.id}
          empty={
            resumen.total === 0 ? (
              <EmptyState
                icon={<IconCaja />}
                title="El catálogo está vacío"
                text="Sin productos el escaparate no enseña nada. Trae el primero de AliExpress o Alibaba, o créalo a mano."
                action={
                  <>
                    <Button href="/admin/importar">Importar el primero</Button>
                    <Button href="/admin/productos/nuevo" variant="ghost">
                      Crearlo a mano
                    </Button>
                  </>
                }
              />
            ) : (
              <EmptyState
                icon={<IconLupa />}
                title="Ningún producto con ese filtro"
                text="Prueba a quitar el filtro o a buscar otra cosa."
                action={
                  <Button href="/admin/productos" variant="ghost">
                    Ver todo el catálogo
                  </Button>
                }
              />
            )
          }
        />
      </Card>
    </>
  );
}

/* ─────────────────────────── consultas ─────────────────────────── */

function construirFiltro(f: {
  q: string;
  estado: string;
  coleccionId: string;
  aviso: string;
}): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = {};

  if (f.q) {
    // SQLite compara LIKE sin distinguir mayúsculas para ASCII, así que no hace
    // falta (ni existe) el `mode: "insensitive"` de Postgres.
    where.OR = [
      { title: buscar(f.q) },
      { slug: buscar(f.q) },
      { vendor: buscar(f.q) },
      { productType: buscar(f.q) },
      { tagsJson: buscar(f.q) },
    ];
  }

  if (f.estado === "draft" || f.estado === "active" || f.estado === "archived") {
    where.status = f.estado;
  }

  if (f.coleccionId) {
    where.collections = { some: { collectionId: f.coleccionId } };
  }

  switch (f.aviso) {
    case "sin-precio":
      where.status = where.status ?? { not: "archived" };
      where.priceCents = { lte: 0 };
      break;
    case "sin-imagen":
      where.images = { none: {} };
      break;
    case "sin-stock":
      where.variants = { some: { trackStock: true, stock: { lte: 0 } } };
      break;
    default:
      break;
  }

  return where;
}

async function cargarResumen() {
  const [total, activos, borradores, archivados, sinPrecio, sinFoto, agotados] = await Promise.all([
    db.product.count(),
    db.product.count({ where: { status: "active" } }),
    db.product.count({ where: { status: "draft" } }),
    db.product.count({ where: { status: "archived" } }),
    db.product.count({ where: { status: { not: "archived" }, priceCents: { lte: 0 } } }),
    db.product.count({ where: { status: { not: "archived" }, images: { none: {} } } }),
    db.product.count({ where: { variants: { some: { trackStock: true, stock: { lte: 0 } } } } }),
  ]);
  return { total, activos, borradores, archivados, sinPrecio, sinFoto, agotados };
}

type Resumen = Awaited<ReturnType<typeof cargarResumen>>;

function resumenTexto(r: Resumen, total: number, filtrando: boolean): string {
  const base = `${r.total} en total · ${r.activos} activos · ${r.borradores} en borrador · ${r.archivados} archivados`;
  return filtrando ? `${total} con el filtro actual · ${base}` : base;
}

/* ─────────────────────────── utilidades ─────────────────────────── */

function uno(valor: string | string[] | undefined): string {
  if (Array.isArray(valor)) return valor[0] ?? "";
  return valor ?? "";
}

/** Reconstruye la URL del listado con los filtros puestos, sin los mensajes. */
function urlConFiltros(sp: Busqueda, cambios: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const clave of ["q", "estado", "coleccion", "aviso", "orden", "pagina"]) {
    const valor = uno(sp[clave]);
    if (valor) params.set(clave, valor);
  }
  for (const [clave, valor] of Object.entries(cambios)) {
    if (valor) params.set(clave, valor);
    else params.delete(clave);
  }
  const cadena = params.toString();
  return cadena ? `/admin/productos?${cadena}` : "/admin/productos";
}

function urlPagina(sp: Busqueda, pagina: number): string {
  return urlConFiltros(sp, { pagina: pagina > 1 ? String(pagina) : "" });
}

function construirMensaje(
  hecho: string,
  n: number,
  m: number,
): { texto: string; tono: "ok" | "warn" | "info" | "error" } | null {
  switch (hecho) {
    case "activados":
      return m > 0
        ? {
            texto: `${n} ${n === 1 ? "producto activado" : "productos activados"}. ${m} se quedaron sin activar porque no tienen precio o no tienen foto.`,
            tono: "warn",
          }
        : { texto: `${n} ${n === 1 ? "producto activado" : "productos activados"}.`, tono: "ok" };
    case "borradores":
      return { texto: `${n} ${n === 1 ? "producto pasado" : "productos pasados"} a borrador.`, tono: "ok" };
    case "archivados":
      return { texto: `${n} ${n === 1 ? "producto archivado" : "productos archivados"}.`, tono: "ok" };
    case "coleccion":
      return { texto: `${n} ${n === 1 ? "producto añadido" : "productos añadidos"} a la colección.`, tono: "ok" };
    case "borrados":
      return { texto: `${n} ${n === 1 ? "producto borrado" : "productos borrados"}.`, tono: "ok" };
    case "sin-coleccion":
      return { texto: "Elige primero a qué colección añadirlos.", tono: "error" };
    case "nada":
      return { texto: "No había ningún producto seleccionado.", tono: "info" };
    default:
      return null;
  }
}

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

function IconLupa() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}
