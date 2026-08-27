import Link from "next/link";
import { db } from "@/lib/db";
import { formatCents, parseToCents } from "@/lib/money";
import ProductCard, { type ProductCardItem } from "./ProductCard";
import "../catalogo.css";

/**
 * Motor del catálogo + panel de filtros.
 *
 * El motor (leer la URL, consultar, filtrar, contar y paginar) vive junto a los
 * filtros que lo exponen para que /tienda y /coleccion/[slug] compartan
 * EXACTAMENTE la misma lógica: dos copias de estas reglas se separan a la
 * primera corrección y la clienta acaba viendo dos catálogos distintos.
 *
 * Todo el estado va en la URL (searchParams). Es lo que hace que un filtro se
 * pueda mandar por DM, sobreviva a un refresco y salga bien en el botón atrás.
 * Por eso el panel de filtros no necesita JavaScript: las opciones discretas son
 * enlaces y el texto/precio un <form method="get">.
 */

export const POR_PAGINA = 24;

export type Orden = "novedad" | "precio-asc" | "precio-desc";

const ORDENES: { valor: Orden; etiqueta: string }[] = [
  { valor: "novedad", etiqueta: "Lo más nuevo" },
  { valor: "precio-asc", etiqueta: "Precio: menor a mayor" },
  { valor: "precio-desc", etiqueta: "Precio: mayor a menor" },
];

export type ParamsCatalogo = {
  q: string;
  /** Slug de colección elegido desde /tienda. En /coleccion/[slug] manda la ruta. */
  col: string;
  tallas: string[];
  colores: string[];
  minCents: number | null;
  maxCents: number | null;
  orden: Orden;
  pagina: number;
  /** Panel desplegado en móvil. Va en la URL porque el desplegable es HTML puro. */
  panel: boolean;
};

export type BusquedaEntrante = Record<string, string | string[] | undefined>;

// ─────────────────────────────── leer la URL ───────────────────────────────

function uno(valor: string | string[] | undefined): string {
  if (Array.isArray(valor)) return (valor[0] ?? "").trim();
  return (valor ?? "").trim();
}

/** Acepta `?talla=S&talla=M` y también `?talla=S,M` (URLs escritas a mano). */
function lista(valor: string | string[] | undefined): string[] {
  const crudo = Array.isArray(valor) ? valor : valor ? [valor] : [];
  const salida: string[] = [];
  for (const parte of crudo) {
    for (const trozo of parte.split(",")) {
      const limpio = trozo.trim();
      if (limpio && !salida.some((x) => igual(x, limpio))) salida.push(limpio);
    }
  }
  return salida;
}

export function leerParams(sp: BusquedaEntrante): ParamsCatalogo {
  const ordenCrudo = uno(sp.orden);
  const orden: Orden = ORDENES.some((o) => o.valor === ordenCrudo) ? (ordenCrudo as Orden) : "novedad";

  const paginaCruda = Number.parseInt(uno(sp.p), 10);

  return {
    q: uno(sp.q).slice(0, 80),
    col: uno(sp.col),
    tallas: lista(sp.talla),
    colores: lista(sp.color),
    // El precio viaja en dólares por legibilidad; a centavos con el único parser autorizado.
    minCents: parseToCents(uno(sp.min) || null),
    maxCents: parseToCents(uno(sp.max) || null),
    orden,
    pagina: Number.isFinite(paginaCruda) && paginaCruda > 1 ? paginaCruda : 1,
    panel: uno(sp.filtros) === "1",
  };
}

/** Dólares para la URL y para los <input type="number">: "$45.99" no vale ahí. */
function centsAUrl(cents: number): string {
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}

/**
 * Construye la URL del catálogo cambiando lo que se le pida. Cualquier cambio
 * que no sea de página devuelve a la página 1: filtrar y quedarse en la 3 es la
 * forma más rápida de enseñar un catálogo vacío que sí tiene resultados.
 */
export function urlCon(
  base: string,
  actual: ParamsCatalogo,
  cambios: Partial<ParamsCatalogo> = {},
): string {
  const p: ParamsCatalogo = { ...actual, ...cambios };
  if (cambios.pagina === undefined) p.pagina = 1;

  const qs = new URLSearchParams();
  if (p.q) qs.set("q", p.q);
  if (p.col) qs.set("col", p.col);
  for (const t of p.tallas) qs.append("talla", t);
  for (const c of p.colores) qs.append("color", c);
  if (p.minCents !== null) qs.set("min", centsAUrl(p.minCents));
  if (p.maxCents !== null) qs.set("max", centsAUrl(p.maxCents));
  if (p.orden !== "novedad") qs.set("orden", p.orden);
  if (p.pagina > 1) qs.set("p", String(p.pagina));
  if (p.panel) qs.set("filtros", "1");

  const cadena = qs.toString();
  return cadena ? `${base}?${cadena}` : base;
}

function alternar(valores: string[], valor: string): string[] {
  return valores.some((v) => igual(v, valor))
    ? valores.filter((v) => !igual(v, valor))
    : [...valores, valor];
}

export function hayFiltros(p: ParamsCatalogo): boolean {
  return Boolean(
    p.q || p.col || p.tallas.length || p.colores.length || p.minCents !== null || p.maxCents !== null,
  );
}

// ───────────────────────────── texto y opciones ─────────────────────────────

/** Sin tildes y en minúsculas: buscar "vestido coral" tiene que encontrar "Coral". */
function normalizar(texto: string): string {
  return (texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // marcas de acento sueltas tras el NFD
    .toLowerCase()
    .trim();
}

function igual(a: string, b: string): boolean {
  return normalizar(a) === normalizar(b);
}

function leerJsonLista(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const datos: unknown = JSON.parse(json);
    return Array.isArray(datos) ? datos.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // tagsJson/optionNamesJson escritos a mano en el admin: mejor sin opciones que reventar.
    return [];
  }
}

const ES_TALLA = /tall|size|medida/i;
const ES_COLOR = /color|colour|tono/i;

/** Escala de tallas de boutique; lo que no esté aquí se ordena después. */
const ESCALA_TALLAS = [
  "xxs", "xs", "s", "p", "ch", "m", "l", "g", "xl", "eg", "xxl", "2xl", "xxxl", "3xl",
  "1x", "2x", "3x", "unica", "talla unica", "u",
];

function ordenarTallas(valores: string[]): string[] {
  return [...valores].sort((a, b) => {
    const ia = ESCALA_TALLAS.indexOf(normalizar(a));
    const ib = ESCALA_TALLAS.indexOf(normalizar(b));
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    const na = Number.parseFloat(a);
    const nb = Number.parseFloat(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b, "es");
  });
}

// ────────────────────────────── carga de datos ──────────────────────────────

type VarianteFila = {
  option1: string | null;
  option2: string | null;
  option3: string | null;
  stock: number;
  trackStock: boolean;
  priceCents: number;
};

/** Lo mínimo para pintar una tarjeta. Lo comparten el catálogo y los relacionados. */
export type FilaTarjeta = {
  slug: string;
  title: string;
  productType: string;
  optionNamesJson: string;
  priceCents: number;
  compareAtCents: number | null;
  images: { url: string; alt: string }[];
  variants: VarianteFila[];
};

type ProductoFila = FilaTarjeta & {
  description: string;
  tagsJson: string;
  publishedAt: Date | null;
  createdAt: Date;
  collections: { collection: { slug: string; title: string; isVisible: boolean; position: number } }[];
};

type ProductoIndexado = ProductoFila & {
  tallas: string[];
  colores: string[];
  /** Texto ya normalizado para buscar sin recalcularlo por cada término. */
  indice: string;
  agotado: boolean;
};

export type Facetas = {
  colecciones: { slug: string; title: string; total: number }[];
  tallas: string[];
  colores: string[];
  precioMinCents: number | null;
  precioMaxCents: number | null;
};

export type ResultadoCatalogo = {
  items: ProductCardItem[];
  total: number;
  paginas: number;
  facetas: Facetas;
};

/** Talla y color de un producto, resueltos por el NOMBRE de la opción. */
export function opcionesDe(producto: {
  optionNamesJson: string;
  variants: VarianteFila[];
}): { tallas: string[]; colores: string[] } {
  const nombres = leerJsonLista(producto.optionNamesJson);
  const tallas: string[] = [];
  const colores: string[] = [];

  for (const v of producto.variants) {
    const valores = [v.option1, v.option2, v.option3];
    nombres.forEach((nombre, i) => {
      const valor = valores[i];
      if (!valor) return;
      // La posición no es fiable: en un producto "Talla" es option1 y en otro option2.
      const destino = ES_TALLA.test(nombre) ? tallas : ES_COLOR.test(nombre) ? colores : null;
      if (destino && !destino.some((x) => igual(x, valor))) destino.push(valor);
    });
  }

  return { tallas: ordenarTallas(tallas), colores };
}

function indexar(producto: ProductoFila): ProductoIndexado {
  const { tallas, colores } = opcionesDe(producto);
  const etiquetas = leerJsonLista(producto.tagsJson);
  return {
    ...producto,
    tallas,
    colores,
    indice: normalizar(
      [producto.title, producto.description, producto.productType, ...etiquetas, ...colores].join(" "),
    ),
    agotado: estaAgotado(producto.variants),
  };
}

/** Producto de la base de datos -> tarjeta de la rejilla. */
export function tarjetaDeProducto(p: FilaTarjeta): ProductCardItem {
  const { tallas, colores } = opcionesDe(p);
  const partes: string[] = [];
  if (colores.length) partes.push(colores.slice(0, 3).join(" · "));
  if (tallas.length) partes.push(tallas.join(" / "));

  return {
    slug: p.slug,
    title: p.title,
    priceCents: p.priceCents,
    compareAtCents: p.compareAtCents,
    imageUrl: p.images[0]?.url ?? null,
    imageAlt: p.images[0]?.alt || p.title,
    meta: partes.length ? partes.join(" — ") : p.productType || null,
    soldOut: estaAgotado(p.variants),
  };
}

/** trackStock false = dropshipping: el stock lo tiene el proveedor, nunca se agota. */
export function estaAgotado(variantes: VarianteFila[]): boolean {
  return variantes.length > 0 && variantes.every((v) => v.trackStock && v.stock <= 0);
}

/**
 * Trae el catálogo y lo filtra.
 *
 * El filtrado de talla/color y la búsqueda se hacen en memoria a propósito:
 *  - talla y color viven en columnas distintas según el producto (option1/2/3),
 *    así que no hay un WHERE que valga para todos;
 *  - SQLite no soporta `mode: "insensitive"` de Prisma y su LIKE ignora los
 *    acentos solo en ASCII, con lo que "Coral" no encontraría "coral" en otros
 *    idiomas ni "María" a "maria".
 * Es asumible con un catálogo de boutique (decenas/cientos de piezas). Si un día
 * pasa de unos pocos miles, esto pide una tabla de facetas o Postgres.
 */
export async function cargarCatalogo(
  params: ParamsCatalogo,
  opciones: { coleccionSlug?: string } = {},
): Promise<ResultadoCatalogo> {
  const filas = (await db.product.findMany({
    where: {
      // El escaparate solo enseña productos activos: draft/archived no existen aquí.
      status: "active",
      ...(opciones.coleccionSlug
        ? { collections: { some: { collection: { slug: opciones.coleccionSlug } } } }
        : {}),
    },
    select: {
      slug: true,
      title: true,
      description: true,
      productType: true,
      tagsJson: true,
      optionNamesJson: true,
      priceCents: true,
      compareAtCents: true,
      publishedAt: true,
      createdAt: true,
      images: { select: { url: true, alt: true }, orderBy: { position: "asc" }, take: 1 },
      variants: {
        select: { option1: true, option2: true, option3: true, stock: true, trackStock: true, priceCents: true },
        orderBy: { position: "asc" },
      },
      collections: {
        select: { collection: { select: { slug: true, title: true, isVisible: true, position: true } } },
      },
    },
  })) as ProductoFila[];

  const catalogo = filas.map(indexar);

  // Las colecciones se cuentan ANTES de aplicar `col`: si no, al elegir una
  // desaparecerían las demás y no habría forma de cambiar de idea.
  const colecciones = new Map<string, { slug: string; title: string; position: number; total: number }>();
  for (const p of catalogo) {
    for (const { collection } of p.collections) {
      if (!collection.isVisible) continue;
      const previa = colecciones.get(collection.slug);
      if (previa) previa.total++;
      else colecciones.set(collection.slug, { ...collection, total: 1 });
    }
  }

  const enColeccion = params.col
    ? catalogo.filter((p) => p.collections.some((c) => c.collection.slug === params.col && c.collection.isVisible))
    : catalogo;

  // Tallas, colores y precios salen de las variantes que existen de verdad,
  // nunca de una lista escrita a mano: si no hay una XL, no se ofrece filtrar por XL.
  const tallas = new Set<string>();
  const colores = new Set<string>();
  let precioMin: number | null = null;
  let precioMax: number | null = null;
  for (const p of enColeccion) {
    for (const t of p.tallas) if (![...tallas].some((x) => igual(x, t))) tallas.add(t);
    for (const c of p.colores) if (![...colores].some((x) => igual(x, c))) colores.add(c);
    if (p.priceCents > 0) {
      precioMin = precioMin === null ? p.priceCents : Math.min(precioMin, p.priceCents);
      precioMax = precioMax === null ? p.priceCents : Math.max(precioMax, p.priceCents);
    }
  }

  const terminos = normalizar(params.q).split(/\s+/).filter(Boolean);

  const filtrados = enColeccion.filter((p) => {
    if (terminos.length && !terminos.every((t) => p.indice.includes(t))) return false;
    if (params.tallas.length && !params.tallas.some((t) => p.tallas.some((x) => igual(x, t)))) return false;
    if (params.colores.length && !params.colores.some((c) => p.colores.some((x) => igual(x, c)))) return false;
    // Un producto sin precio ("por confirmar") no puede afirmar que entra en un rango.
    if (params.minCents !== null && (p.priceCents <= 0 || p.priceCents < params.minCents)) return false;
    if (params.maxCents !== null && (p.priceCents <= 0 || p.priceCents > params.maxCents)) return false;
    return true;
  });

  const cuando = (p: ProductoIndexado) => (p.publishedAt ?? p.createdAt).getTime();
  filtrados.sort((a, b) => {
    if (params.orden === "novedad") return cuando(b) - cuando(a);
    // Los que aún no tienen precio van al final en cualquier orden por precio:
    // arriba del todo un "$0.00" implícito sería mentira.
    const sinA = a.priceCents <= 0;
    const sinB = b.priceCents <= 0;
    if (sinA !== sinB) return sinA ? 1 : -1;
    return params.orden === "precio-asc" ? a.priceCents - b.priceCents : b.priceCents - a.priceCents;
  });

  const total = filtrados.length;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const pagina = Math.min(params.pagina, paginas);
  const desde = (pagina - 1) * POR_PAGINA;

  return {
    items: filtrados.slice(desde, desde + POR_PAGINA).map(tarjetaDeProducto),
    total,
    paginas,
    facetas: {
      colecciones: [...colecciones.values()]
        .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, "es"))
        .map(({ slug, title, total: t }) => ({ slug, title, total: t })),
      tallas: ordenarTallas([...tallas]),
      colores: [...colores].sort((a, b) => a.localeCompare(b, "es")),
      precioMinCents: precioMin,
      precioMaxCents: precioMax,
    },
  };
}

// ──────────────────────────────── interfaz ────────────────────────────────

type PropsFiltros = {
  /** Ruta sobre la que se construyen las URLs: "/tienda" o "/coleccion/vestidos". */
  base: string;
  params: ParamsCatalogo;
  facetas: Facetas;
  /** En una colección la ruta ya manda: no se ofrece cambiar de colección. */
  mostrarColecciones?: boolean;
};

export default function Filtros({ base, params, facetas, mostrarColecciones = true }: PropsFiltros) {
  const abierto = params.panel;
  const colecciones = mostrarColecciones ? facetas.colecciones : [];

  return (
    <aside className="cat-filtros">
      {/* El desplegable de móvil es un enlace, no un botón con estado: así el panel
          no necesita JavaScript y su estado también sobrevive al refresco. */}
      <Link
        className="cat-toggle"
        href={urlCon(base, params, { panel: !abierto, pagina: params.pagina })}
        aria-expanded={abierto}
      >
        <span>{abierto ? "Ocultar filtros" : "Filtrar y ordenar"}</span>
        <i aria-hidden="true">{abierto ? "−" : "+"}</i>
      </Link>

      <div className={abierto ? "cat-panel abierto" : "cat-panel"}>
        {/* Texto y precio en un <form> GET: es lo que un campo libre necesita. */}
        <form className="cat-bloque" action={base} method="get">
          <CamposOcultos params={params} omitir={["q", "min", "max", "p"]} />
          <p className="cat-titulo">Buscar</p>
          <div className="cat-buscar">
            <input
              type="search"
              name="q"
              defaultValue={params.q}
              placeholder="Vestido, coral, midi…"
              aria-label="Buscar en el catálogo"
            />
          </div>

          <p className="cat-titulo cat-titulo-sep">Precio</p>
          <div className="cat-precio">
            <input
              type="number"
              name="min"
              min={0}
              step={1}
              defaultValue={params.minCents !== null ? centsAUrl(params.minCents) : ""}
              placeholder="Mín."
              aria-label="Precio mínimo en dólares"
            />
            <span aria-hidden="true">—</span>
            <input
              type="number"
              name="max"
              min={0}
              step={1}
              defaultValue={params.maxCents !== null ? centsAUrl(params.maxCents) : ""}
              placeholder="Máx."
              aria-label="Precio máximo en dólares"
            />
          </div>
          {facetas.precioMinCents !== null && facetas.precioMaxCents !== null ? (
            <p className="cat-pista">
              En la tienda hay piezas de {formatCents(facetas.precioMinCents)} a{" "}
              {formatCents(facetas.precioMaxCents)}.
            </p>
          ) : null}

          <button className="btn btn-ink btn-sm cat-aplicar" type="submit">
            Aplicar
          </button>
        </form>

        {colecciones.length ? (
          <div className="cat-bloque">
            <p className="cat-titulo">Colección</p>
            <ul className="cat-lista">
              {colecciones.map((c) => {
                const activa = c.slug === params.col;
                return (
                  <li key={c.slug}>
                    <Link
                      className={activa ? "cat-op sel" : "cat-op"}
                      href={urlCon(base, params, { col: activa ? "" : c.slug })}
                      aria-current={activa ? "true" : undefined}
                    >
                      <span>{c.title}</span>
                      <em>{c.total}</em>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {facetas.tallas.length ? (
          <div className="cat-bloque">
            <p className="cat-titulo">Talla</p>
            <div className="cat-chips">
              {facetas.tallas.map((t) => {
                const activa = params.tallas.some((x) => igual(x, t));
                return (
                  <Link
                    key={t}
                    className={activa ? "talla-chip sel" : "talla-chip"}
                    href={urlCon(base, params, { tallas: alternar(params.tallas, t) })}
                    aria-current={activa ? "true" : undefined}
                  >
                    {t}
                  </Link>
                );
              })}
            </div>
          </div>
        ) : null}

        {facetas.colores.length ? (
          <div className="cat-bloque">
            <p className="cat-titulo">Color</p>
            <div className="cat-chips">
              {facetas.colores.map((c) => {
                const activa = params.colores.some((x) => igual(x, c));
                return (
                  <Link
                    key={c}
                    className={activa ? "talla-chip cat-chip-ancho sel" : "talla-chip cat-chip-ancho"}
                    href={urlCon(base, params, { colores: alternar(params.colores, c) })}
                    aria-current={activa ? "true" : undefined}
                  >
                    {c}
                  </Link>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="cat-bloque">
          <p className="cat-titulo">Ordenar por</p>
          <ul className="cat-lista">
            {ORDENES.map((o) => {
              const activa = o.valor === params.orden;
              return (
                <li key={o.valor}>
                  <Link
                    className={activa ? "cat-op sel" : "cat-op"}
                    href={urlCon(base, params, { orden: o.valor })}
                    aria-current={activa ? "true" : undefined}
                  >
                    <span>{o.etiqueta}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        {hayFiltros(params) ? (
          <Link className="cat-limpiar" href={base}>
            Limpiar filtros
          </Link>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * El <form> del buscador viaja solo: sin estos campos, escribir en la búsqueda
 * borraría la talla, el color y el orden que ya estaban elegidos.
 */
function CamposOcultos({
  params,
  omitir,
}: {
  params: ParamsCatalogo;
  omitir: string[];
}) {
  const campos: { nombre: string; valor: string }[] = [];
  if (params.q) campos.push({ nombre: "q", valor: params.q });
  if (params.col) campos.push({ nombre: "col", valor: params.col });
  for (const t of params.tallas) campos.push({ nombre: "talla", valor: t });
  for (const c of params.colores) campos.push({ nombre: "color", valor: c });
  if (params.minCents !== null) campos.push({ nombre: "min", valor: centsAUrl(params.minCents) });
  if (params.maxCents !== null) campos.push({ nombre: "max", valor: centsAUrl(params.maxCents) });
  if (params.orden !== "novedad") campos.push({ nombre: "orden", valor: params.orden });
  if (params.panel) campos.push({ nombre: "filtros", valor: "1" });

  return (
    <>
      {campos
        .filter((c) => !omitir.includes(c.nombre))
        .map((c, i) => (
          <input key={`${c.nombre}-${i}`} type="hidden" name={c.nombre} value={c.valor} />
        ))}
    </>
  );
}

// ──────────────────────── rejilla, conteo y paginación ────────────────────────

type PropsCatalogo = {
  base: string;
  params: ParamsCatalogo;
  datos: ResultadoCatalogo;
  mostrarColecciones?: boolean;
};

/** Filtros + conteo + rejilla + paginación. Lo que comparten /tienda y /coleccion. */
export function Catalogo({ base, params, datos, mostrarColecciones = true }: PropsCatalogo) {
  const { items, total, paginas, facetas } = datos;
  const pagina = Math.min(params.pagina, paginas);

  return (
    <div className="cat-layout">
      <Filtros base={base} params={params} facetas={facetas} mostrarColecciones={mostrarColecciones} />

      <section className="cat-resultados">
        <p className="cat-conteo">
          {total === 0 ? "Ninguna pieza" : total === 1 ? "1 pieza" : `${total} piezas`}
          {paginas > 1 ? <span> · página {pagina} de {paginas}</span> : null}
        </p>

        {items.length ? (
          <div className="product-grid">
            {items.map((item) => (
              <ProductCard key={item.slug} product={item} />
            ))}
          </div>
        ) : (
          <div className="cat-vacio">
            <svg className="cat-vacio-lotus" viewBox="0 0 120 110" aria-hidden="true">
              <use href="#lotus" />
            </svg>
            {hayFiltros(params) ? (
              <>
                <p className="cat-vacio-titulo">No encontramos nada con esos filtros</p>
                <p className="cat-vacio-sub">
                  Prueba con otra talla, amplía el rango de precio o mira el catálogo completo.
                </p>
                <Link className="btn btn-ink btn-sm" href={base}>
                  Limpiar filtros
                </Link>
              </>
            ) : (
              /* Sin filtros aplicados y sin piezas: la tienda está recién montada o
                 todo sigue en borrador. Culpar a «esos filtros» que ella no puso, y
                 ofrecerle «limpiar» lo que no existe, la deja perdida. */
              <>
                <p className="cat-vacio-titulo">Muy pronto habrá piezas nuevas aquí</p>
                <p className="cat-vacio-sub">
                  Estamos preparando la próxima llegada. Síguenos en Instagram para verla
                  antes que nadie.
                </p>
                <Link className="btn btn-ink btn-sm" href="/">
                  Volver a la portada
                </Link>
              </>
            )}
          </div>
        )}

        <Paginacion base={base} params={params} pagina={pagina} paginas={paginas} />
      </section>
    </div>
  );
}

function Paginacion({
  base,
  params,
  pagina,
  paginas,
}: {
  base: string;
  params: ParamsCatalogo;
  pagina: number;
  paginas: number;
}) {
  if (paginas <= 1) return null;

  // Ventana alrededor de la página actual: con 40 páginas no caben todos los números.
  const numeros: number[] = [];
  for (let i = 1; i <= paginas; i++) {
    if (i === 1 || i === paginas || Math.abs(i - pagina) <= 1) numeros.push(i);
  }

  return (
    <nav className="cat-pag" aria-label="Paginación del catálogo">
      {pagina > 1 ? (
        <Link className="cat-pag-flecha" href={urlCon(base, params, { pagina: pagina - 1 })} rel="prev">
          ← Anterior
        </Link>
      ) : (
        <span className="cat-pag-flecha off">← Anterior</span>
      )}

      <ol className="cat-pag-nums">
        {numeros.map((n, i) => (
          <li key={n}>
            {i > 0 && n - numeros[i - 1] > 1 ? <span className="cat-pag-hueco">…</span> : null}
            {n === pagina ? (
              <span className="cat-pag-num sel" aria-current="page">
                {n}
              </span>
            ) : (
              <Link className="cat-pag-num" href={urlCon(base, params, { pagina: n })}>
                {n}
              </Link>
            )}
          </li>
        ))}
      </ol>

      {pagina < paginas ? (
        <Link className="cat-pag-flecha" href={urlCon(base, params, { pagina: pagina + 1 })} rel="next">
          Siguiente →
        </Link>
      ) : (
        <span className="cat-pag-flecha off">Siguiente →</span>
      )}
    </nav>
  );
}
