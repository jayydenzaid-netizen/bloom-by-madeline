import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { getBookmarklet } from "@/lib/importers/bookmarklet";
import { findProductBySource, getImportJob, readDraft } from "@/lib/importers/pipeline";
import { getSettings } from "@/lib/settings";

import { Button, Card, PageHeader } from "../_components/ui";
import DraftEditor, { type BorradorVista } from "./_components/DraftEditor";
import ImportForm, { type PaqueteMarcador } from "./_components/ImportForm";
import JobList, { type JobVista } from "./_components/JobList";
import "./importar.css";

/**
 * EL IMPORTADOR — la pantalla estrella del panel.
 *
 * Tres pasos, como el importador de cualquier herramienta seria de dropshipping:
 *
 *   1. TRAER   — cuatro vías (enlace, HTML pegado, marcador, CSV)
 *   2. REVISAR — título, fotos, variantes, precios y margen  ← aquí se gana el dinero
 *   3. PUBLICAR— crea el producto, por defecto en borrador
 *
 * La pantalla es Server Component: monta los datos y reparte. Lo único que corre
 * en el navegador es lo que de verdad necesita interacción (el formulario de las
 * cuatro vías y el editor del borrador). El historial, que solo lee, no manda ni
 * un byte de JavaScript.
 *
 * `?job=` es el estado de la pantalla: con él se está revisando esa importación,
 * sin él se está trayendo una nueva. Así el aviso del bookmarklet puede enlazar
 * directamente a la revisión, y recargar la página no pierde el trabajo.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Importar productos",
};

/* ───────────────────────────── utilidades ───────────────────────────── */

/**
 * Título de un borrador sin deserializar el JSON entero.
 *
 * Un borrador puede pesar cientos de kilobytes (el volcado crudo del proveedor),
 * y el historial enseña veinticinco. Parsear los veinticinco para leer una línea
 * de cada uno sería tirar memoria por gusto: `title` es una clave de primer nivel
 * y aparece siempre en los primeros caracteres.
 */
function tituloDeBorrador(draftJson: string | null): string | null {
  if (!draftJson) return null;
  const encontrado = /"title":"((?:[^"\\]|\\.)*)"/.exec(draftJson.slice(0, 8000));
  if (!encontrado) return null;
  try {
    return JSON.parse(`"${encontrado[1]}"`) as string;
  } catch {
    return null;
  }
}

/** Mismo criterio que el pipeline al nombrar variantes, para que la tabla no mienta. */
function nombreVariante(titulo: string | undefined, opciones: string[], indice: number): string {
  const deOpciones = opciones.filter(Boolean).join(" / ");
  return titulo?.trim() || deOpciones || (indice === 0 ? "Único" : `Opción ${indice + 1}`);
}

const PROVEEDORES: Record<string, string> = {
  aliexpress: "AliExpress",
  alibaba: "Alibaba",
  csv: "CSV",
  manual: "Manual",
};

const METODOS: Record<string, string> = {
  url: "Traído por enlace",
  html: "HTML pegado",
  api: "API oficial",
  bookmarklet: "Marcador",
  csv: "Fichero CSV",
};

/** El marcador tiene que apuntar al dominio que la usuaria está usando ahora mismo. */
async function origenPublico(): Promise<string> {
  const cabeceras = await headers();
  const host = cabeceras.get("x-forwarded-host") ?? cabeceras.get("host") ?? "";
  const protocolo = cabeceras.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return host ? `${protocolo}://${host}` : "";
}

const AVISOS: Record<string, string> = {
  "sin-enlace": "Esa importación no guardó ningún enlace (entró por HTML pegado o por CSV), así que no se puede repetir sola: vuelve a traer el producto desde arriba.",
  "reintento-fallido": "El reintento tampoco funcionó. Mira el historial para ver qué contestó el proveedor y prueba con el marcador o con el HTML pegado.",
};

/* ─────────────────────────────── la página ─────────────────────────────── */

export default async function ImportarPage({
  searchParams,
}: {
  // En Next 15 searchParams es una promesa.
  searchParams: Promise<{ job?: string; url?: string; tab?: string; aviso?: string }>;
}) {
  // Cada pantalla comprueba su sesión: una Server Action o un render parcial no
  // pasan necesariamente por el layout, y aquí se leen datos del negocio.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const params = await searchParams;
  const jobId = typeof params.job === "string" ? params.job : "";

  const [ajustes, colecciones, jobs] = await Promise.all([
    getSettings(),
    db.collection.findMany({ select: { id: true, title: true }, orderBy: { position: "asc" } }),
    db.importJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        provider: true,
        method: true,
        status: true,
        sourceUrl: true,
        error: true,
        createdAt: true,
        productId: true,
        draftJson: true,
      },
    }),
  ]);

  // Los productos de los jobs ya publicados, en una sola consulta.
  const idsProducto = jobs.map((job) => job.productId).filter((id): id is string => Boolean(id));
  const productos = idsProducto.length
    ? await db.product.findMany({ where: { id: { in: idsProducto } }, select: { id: true, slug: true, title: true } })
    : [];
  const porId = new Map(productos.map((producto) => [producto.id, producto]));

  const filasHistorial: JobVista[] = jobs.map((job) => ({
    id: job.id,
    provider: job.provider,
    method: job.method,
    status: job.status,
    sourceUrl: job.sourceUrl,
    error: job.error,
    createdAt: job.createdAt,
    titulo: tituloDeBorrador(job.draftJson),
    producto: job.productId ? (porId.get(job.productId) ?? null) : null,
  }));

  /* ── el marcador ── */
  let marcador: PaqueteMarcador | null = null;
  let errorMarcador: string | null = null;
  try {
    const paquete = await getBookmarklet(await origenPublico());
    marcador = { href: paquete.href, code: paquete.code, token: paquete.token, endpoint: paquete.endpoint };
  } catch (error) {
    errorMarcador = error instanceof Error ? error.message : String(error);
  }

  /* ── ¿estamos revisando una importación? ── */
  const job = jobId ? await getImportJob(jobId) : null;
  const borradorCrudo = job ? readDraft(job.draftJson) : null;

  const productoDelJob = job?.productId ? await db.product.findUnique({
    where: { id: job.productId },
    select: { id: true, slug: true, title: true },
  }) : null;

  const existente =
    borradorCrudo && job?.status !== "imported"
      ? await findProductBySource(borradorCrudo.provider, borradorCrudo.sourceProductId).catch(() => null)
      : null;

  const borrador: BorradorVista | null =
    borradorCrudo && job
      ? {
          jobId: job.id,
          proveedorLabel: PROVEEDORES[borradorCrudo.provider] ?? borradorCrudo.provider,
          metodoLabel: METODOS[borradorCrudo.method] ?? borradorCrudo.method,
          sourceUrl: borradorCrudo.sourceUrl,
          titulo: borradorCrudo.title,
          descripcion: borradorCrudo.description,
          avisos: borradorCrudo.warnings ?? [],
          // La ficha técnica del proveedor puede traer cincuenta líneas; se
          // enseñan las primeras veinte, plegadas, como contexto y no como ruido.
          atributos: Object.entries(borradorCrudo.attributes ?? {}).slice(0, 20),
          imagenes: borradorCrudo.images.map((imagen) => ({ url: imagen.url, alt: imagen.alt ?? "" })),
          variantes: borradorCrudo.variants.map((variante, indice) => ({
            indice,
            titulo: nombreVariante(variante.title, variante.optionValues ?? [], indice),
            sku: variante.sku ?? "",
            costCents: variante.costCents ?? null,
            priceCents: variante.priceCents ?? null,
          })),
          costeMin: borradorCrudo.costCentsMin,
        }
      : null;

  const revisando = Boolean(borrador) && job?.status !== "imported";
  const yaPublicado = Boolean(job) && job?.status === "imported";
  const aviso = params.aviso ? AVISOS[params.aviso] : null;

  const pestanaInicial = (["url", "html", "bookmarklet", "csv"] as const).find((tab) => tab === params.tab) ?? "url";

  return (
    <>
      <PageHeader
        title="Importar productos"
        subtitle="Trae fichas de AliExpress y Alibaba, ajústalas y publícalas en tu tienda."
        actions={
          <Button variant="ghost" href="/admin/productos">
            Ver el catálogo
          </Button>
        }
      />

      {/* El mapa del recorrido: en qué paso estamos y qué falta. */}
      <div className="imp-flujo">
        <div className={`imp-paso${revisando || yaPublicado ? " is-hecho" : " is-activo"}`}>
          <span className="imp-paso-num">1</span>
          <span className="imp-paso-txt">
            <b>Traer el producto</b>
            <span>Por enlace, HTML, marcador o CSV</span>
          </span>
        </div>
        <div className={`imp-paso${revisando ? " is-activo" : yaPublicado ? " is-hecho" : ""}`}>
          <span className="imp-paso-num">2</span>
          <span className="imp-paso-txt">
            <b>Revisar y ajustar</b>
            <span>Título, fotos, precios y margen</span>
          </span>
        </div>
        <div className={`imp-paso${yaPublicado ? " is-hecho" : ""}`}>
          <span className="imp-paso-num">3</span>
          <span className="imp-paso-txt">
            <b>Publicar</b>
            <span>Sale en borrador salvo que digas lo contrario</span>
          </span>
        </div>
      </div>

      {aviso ? (
        <div className="imp-aviso imp-aviso-warning">
          <div className="imp-aviso-cuerpo">{aviso}</div>
        </div>
      ) : null}

      {/* Un job pedido que ya no existe: se dice, en vez de enseñar el formulario
          como si nada y dejar a la usuaria pensando que perdió el producto. */}
      {jobId && !job ? (
        <div className="imp-aviso imp-aviso-danger">
          <div className="imp-aviso-cuerpo">
            <b>Esa importación ya no existe.</b>
            <p>Puede que se borrara al reiniciar los datos de prueba. Vuelve a traer el producto desde abajo.</p>
          </div>
        </div>
      ) : null}

      {jobId && job && !borradorCrudo && job.status === "failed" ? (
        <div className="imp-aviso imp-aviso-danger">
          <div className="imp-aviso-cuerpo">
            <b>Aquella importación falló y no llegó a guardar ninguna ficha.</b>
            <p>{job.error ?? "El proveedor no devolvió datos legibles."}</p>
          </div>
        </div>
      ) : null}

      {yaPublicado && productoDelJob ? (
        <Card title="Esta importación ya está publicada">
          <div className="imp-resultado">
            <h3>«{productoDelJob.title}»</h3>
            <p>Ya se creó el producto a partir de esta importación. Para cambiar algo, edítalo en su ficha.</p>
            <div className="imp-resultado-acciones">
              <Button href={`/admin/productos/${productoDelJob.id}`}>Abrir la ficha</Button>
              <a
                className="adm-btn adm-btn-ghost adm-btn-md"
                href={`/producto/${productoDelJob.slug}`}
                target="_blank"
                rel="noreferrer"
              >
                Ver en la tienda
              </a>
              <Button variant="ghost" href="/admin/importar">
                Importar otro
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {/* PASO 2 y 3: revisar lo traído. Va arriba porque, cuando hay algo que
          revisar, es lo único que importa de esta pantalla. */}
      {revisando && borrador ? (
        <DraftEditor
          borrador={borrador}
          reglaInicial={ajustes.pricing}
          colecciones={colecciones}
          existente={
            existente
              ? { productId: existente.id, slug: existente.slug, title: existente.title, status: existente.status }
              : null
          }
        />
      ) : null}

      {/* PASO 1 */}
      <ImportForm
        marcador={marcador}
        errorMarcador={errorMarcador}
        pestanaInicial={pestanaInicial}
        urlInicial={typeof params.url === "string" ? params.url : ""}
      />

      <JobList jobs={filasHistorial} />
    </>
  );
}
