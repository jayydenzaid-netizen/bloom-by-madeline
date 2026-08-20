import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { contarLimpiables, DIAS_CARRITO_VIEJO, PALABRA_REEMPLAZAR } from "@/lib/backup";
import { db } from "@/lib/db";
import { LIMITES_SEO, resumenSitemap, urlBase } from "@/lib/seo";
import { getSettings } from "@/lib/settings";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  PageHeader,
  StatCard,
  type Column,
} from "../_components/ui";
import { BotonDescarga, SeoPanel, type ItemSeo } from "./_components/SeoPanel";
import { crearRedireccion, ejecutarLimpieza, eliminarRedireccion, generarCopia, generarCsvShopify, restaurarCopia } from "./actions";
import "./herramientas.css";

/**
 * Herramientas de la tienda: copia de seguridad, restauración, exportación a
 * Shopify, SEO, redirecciones y limpieza.
 *
 * Es la pantalla con las acciones más peligrosas del panel, así que la norma es
 * al revés que en el resto: aquí lo destructivo está SIEMPRE a dos gestos, y el
 * segundo gesto dice en números exactos qué se va a borrar. El botón rojo no
 * existe hasta que se ha leído el aviso.
 */
export const dynamic = "force-dynamic";

const fecha = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

type FilaRedireccion = {
  id: string;
  fromPath: string;
  toPath: string;
  hits: number;
  createdAt: Date;
};

type Props = {
  searchParams: Promise<{
    ok?: string;
    error?: string;
    pista?: string;
    limpiar?: string;
    borrarRedir?: string;
  }>;
};

export default async function HerramientasPage({ searchParams }: Props) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;

  const [
    ajustes,
    sitemap,
    limpiables,
    redirecciones,
    productos,
    paginas,
    nProductos,
    nColecciones,
    nPedidos,
    nClientas,
    nPaginas,
    nMedios,
  ] = await Promise.all([
    getSettings(),
    resumenSitemap(),
    contarLimpiables(),
    db.redirect.findMany({ orderBy: { createdAt: "desc" } }),
    db.product.findMany({
      where: { status: { not: "archived" } },
      select: { id: true, slug: true, title: true, status: true, seoTitle: true, seoDescription: true },
      orderBy: [{ status: "asc" }, { title: "asc" }],
    }),
    db.page.findMany({
      select: { id: true, slug: true, title: true, status: true, seoTitle: true, seoDescription: true },
      orderBy: { position: "asc" },
    }),
    db.product.count(),
    db.collection.count(),
    db.order.count(),
    db.customer.count(),
    db.page.count(),
    db.mediaAsset.count(),
  ]);

  const itemsSeo: ItemSeo[] = [
    ...productos.map<ItemSeo>((p) => ({
      tipo: "producto",
      id: p.id,
      titulo: p.title,
      ruta: `/producto/${p.slug}`,
      seoTitle: p.seoTitle ?? "",
      seoDescription: p.seoDescription ?? "",
      publico: p.status === "active",
      etiquetaEstado: p.status === "active" ? "Activo" : "Borrador",
    })),
    ...paginas.map<ItemSeo>((p) => ({
      tipo: "pagina",
      id: p.id,
      titulo: p.title,
      ruta: `/pagina/${p.slug}`,
      seoTitle: p.seoTitle ?? "",
      seoDescription: p.seoDescription ?? "",
      publico: p.status === "published",
      etiquetaEstado: p.status === "published" ? "Publicada" : "Borrador",
    })),
  ];

  const columnasRedir: Column<FilaRedireccion>[] = [
    {
      key: "desde",
      header: "Dirección vieja",
      primary: true,
      render: (r) => <span className="hrr-ruta">{r.fromPath}</span>,
    },
    {
      key: "hacia",
      header: "Lleva a",
      render: (r) => (
        <span className="hrr-ruta">
          → {r.toPath}
        </span>
      ),
    },
    {
      key: "usos",
      header: "Usos",
      align: "right",
      render: (r) => (r.hits > 0 ? <Badge tone="info">{r.hits}</Badge> : <span className="adm-muted">0</span>),
    },
    {
      key: "creada",
      header: "Creada",
      hideOnMobile: true,
      render: (r) => <span className="adm-muted">{fecha.format(r.createdAt)}</span>,
    },
    {
      key: "acciones",
      header: "",
      align: "right",
      render: (r) =>
        sp.borrarRedir === r.id ? (
          <form action={eliminarRedireccion} className="hrr-linea">
            <input type="hidden" name="id" value={r.id} />
            <span className="adm-small">¿Seguro?</span>
            <Button type="submit" variant="danger" size="sm">
              Sí, borrar
            </Button>
            <Button href="/admin/herramientas" variant="ghost" size="sm">
              No
            </Button>
          </form>
        ) : (
          <Button href={`/admin/herramientas?borrarRedir=${r.id}`} variant="ghost" size="sm">
            Borrar
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Herramientas"
        subtitle="Guarda una copia de tu tienda, revisa cómo te ve Google y tira lo que ya no sirve."
      />

      {sp.ok ? <div className="hrr-aviso hrr-aviso-ok">{sp.ok}</div> : null}
      {sp.error ? (
        <div className="hrr-aviso hrr-aviso-mal">
          {sp.error}
          {sp.pista ? <span className="hrr-aviso-pista">{sp.pista}</span> : null}
        </div>
      ) : null}

      {/* ─────────────────── copia de seguridad ─────────────────── */}

      <Card title="Copia de seguridad">
        <p className="hrr-pista">
          Descarga un fichero con TODA tu tienda: productos, colecciones, páginas, pedidos y clientas. Guárdalo donde
          guardas lo importante. Si algún día se pierde la web, con este fichero se reconstruye; y si algún día te
          mudas a otra plataforma, tus datos se van contigo.
        </p>

        <div className="adm-grid">
          <StatCard label="Productos" value={nProductos} />
          <StatCard label="Colecciones" value={nColecciones} />
          <StatCard label="Pedidos" value={nPedidos} />
          <StatCard label="Clientas" value={nClientas} />
          <StatCard label="Páginas" value={nPaginas} />
          <StatCard label="Fotos guardadas" value={nMedios} />
        </div>

        <div className="hrr-acciones">
          <BotonDescarga accion={generarCopia} etiqueta="Descargar copia (.json)" tipoMime="application/json" />
          <BotonDescarga
            accion={generarCsvShopify}
            etiqueta="Exportar catálogo a Shopify (.csv)"
            tipoMime="text/csv"
            variante="ghost"
          />
        </div>

        <p className="hrr-nota">
          El fichero .json lleva datos de tus clientas (nombre, correo, dirección): trátalo como tratarías el cuaderno
          de pedidos. No lleva contraseñas ni sesiones, eso nunca sale de aquí. El .csv es solo el catálogo, en el
          formato que pide la plantilla de productos de Shopify.
        </p>
      </Card>

      {/* ─────────────────── restaurar ─────────────────── */}

      <Card title="Restaurar desde una copia">
        <p className="hrr-pista">
          Sube un fichero .json de los que descargaste arriba. Antes de tocar nada se comprueba que sea una copia de
          Bloom y que esté completa; si algo no cuadra, no se aplica nada.
        </p>

        <form action={restaurarCopia} className="hrr-form">
          <Field label="Fichero de copia" htmlFor="archivo" required>
            <input id="archivo" name="archivo" type="file" accept="application/json,.json" required />
          </Field>

          <Field
            label="Qué hacer con lo que ya tienes"
            htmlFor="modo"
            hint="«Añadir» es lo seguro: respeta todo lo que ya está en la tienda."
          >
            <select id="modo" name="modo" defaultValue="anadir">
              <option value="anadir">Añadir lo que falte (no borra nada)</option>
              <option value="reemplazar">Reemplazar la tienda entera por la copia (borra lo de ahora)</option>
            </select>
          </Field>

          <Field
            label={`Confirmación para reemplazar`}
            htmlFor="confirmacion"
            hint={`Solo si elegiste «reemplazar»: escribe ${PALABRA_REEMPLAZAR} en mayúsculas. Sin esa palabra no se borra nada.`}
          >
            <input id="confirmacion" name="confirmacion" type="text" autoComplete="off" placeholder="" />
          </Field>

          <Button type="submit" variant="ghost">
            Restaurar
          </Button>
        </form>

        <p className="hrr-nota">
          <strong>Reemplazar borra los pedidos, el catálogo y las clientas de ahora</strong> y los sustituye por los del
          fichero. Descarga primero una copia de lo que tienes hoy: así siempre hay camino de vuelta.
        </p>
      </Card>

      {/* ─────────────────── SEO ─────────────────── */}

      <Card
        title="Cómo te ve Google"
        actions={
          // Ancla suelta con el aspecto de botón (clase documentada en _ADMIN_UI):
          // <Button href> pinta un <Link> de Next y no acepta target/rel, y el
          // sitemap es XML crudo: abrirlo en la misma pestaña saca del panel.
          <a className="adm-btn adm-btn-ghost adm-btn-sm" href="/sitemap.xml" target="_blank" rel="noreferrer">
            Ver el sitemap
          </a>
        }
      >
        <p className="hrr-pista">
          El título y la descripción son lo que se lee en los resultados de Google. Si están vacíos, Google se inventa
          un trozo de la página; escribirlos tú es la diferencia entre que te hagan clic y que no.
        </p>

        <div className="adm-grid">
          <StatCard label="Direcciones en el sitemap" value={sitemap.total} hint="Es lo que le damos a Google" />
          <StatCard label="Productos listados" value={sitemap.productos} hint={`${sitemap.fuera.productos} fuera (borrador o archivado)`} />
          <StatCard label="Colecciones listadas" value={sitemap.colecciones} hint={`${sitemap.fuera.colecciones} ocultas`} />
          <StatCard label="Páginas listadas" value={sitemap.paginas} hint={`${sitemap.fuera.paginas} en borrador`} />
        </div>

        <SeoPanel
          items={itemsSeo}
          limites={{
            tituloMin: LIMITES_SEO.tituloMin,
            tituloMax: LIMITES_SEO.tituloMax,
            descripcionMin: LIMITES_SEO.descripcionMin,
            descripcionMax: LIMITES_SEO.descripcionMax,
          }}
          base={urlBase().replace(/^https?:\/\//, "")}
          nombreTienda={ajustes.storeName}
        />
      </Card>

      {/* ─────────────────── redirecciones ─────────────────── */}

      <Card title="Redirecciones" flush>
        <div className="hrr-cuerpo">
          <p className="hrr-pista">
            Cuando cambias la dirección de un producto, el enlace que compartiste en Instagram deja de funcionar. Aquí
            se apunta la dirección vieja y a dónde tiene que llevar ahora, y quien pulse el enlace antiguo llega igual.
          </p>

          <form action={crearRedireccion} className="hrr-form hrr-form-linea">
            <Field label="Dirección vieja" htmlFor="fromPath" hint="Por ejemplo: /producto/vestido-rojo">
              <input id="fromPath" name="fromPath" type="text" placeholder="/producto/direccion-vieja" required />
            </Field>
            <Field label="Lleva a" htmlFor="toPath" hint="Por ejemplo: /producto/vestido-rojo-flores">
              <input id="toPath" name="toPath" type="text" placeholder="/producto/direccion-nueva" required />
            </Field>
            <Button type="submit" variant="ghost">
              Añadir
            </Button>
          </form>
        </div>

        <DataTable
          columns={columnasRedir}
          rows={redirecciones}
          rowKey={(r) => r.id}
          empty={
            <EmptyState
              title="Todavía no hay redirecciones"
              text="No hace falta ninguna hasta que cambies la dirección de un producto o de una página. Cuando pase, apúntala aquí y el enlace viejo seguirá vivo."
            />
          }
        />
      </Card>

      {/* ─────────────────── limpieza ─────────────────── */}

      <Card title="Limpieza de datos">
        <p className="hrr-pista">
          Cosas que se acumulan solas y no sirven para nada. Borrarlas no afecta a tus productos ni a tus pedidos.
        </p>

        <div className="hrr-limpieza">
          <div className="hrr-limpia-fila">
            <div>
              <b>Carritos abandonados</b>
              <p className="adm-small adm-muted">
                Carritos de visitantes sin tocar desde hace más de {DIAS_CARRITO_VIEJO} días (antes del{" "}
                {fecha.format(limpiables.carritosDesde)}). Son cestas a medio llenar de gente que se fue.
              </p>
            </div>
            <div className="hrr-limpia-accion">
              <Badge tone={limpiables.carritos > 0 ? "warning" : "neutral"}>{limpiables.carritos}</Badge>
              {limpiables.carritos > 0 ? (
                sp.limpiar === "carritos" ? (
                  <form action={ejecutarLimpieza} className="hrr-linea">
                    <input type="hidden" name="tipo" value="carritos" />
                    <input type="hidden" name="esperados" value={limpiables.carritos} />
                    <span className="adm-small">
                      Se van a borrar <strong>{limpiables.carritos}</strong> carritos y sus líneas. No se toca ningún
                      pedido.
                    </span>
                    <Button type="submit" variant="danger" size="sm">
                      Sí, borrar {limpiables.carritos}
                    </Button>
                    <Button href="/admin/herramientas" variant="ghost" size="sm">
                      Cancelar
                    </Button>
                  </form>
                ) : (
                  <Button href="/admin/herramientas?limpiar=carritos" variant="ghost" size="sm">
                    Borrar…
                  </Button>
                )
              ) : (
                <span className="adm-small adm-muted">Nada que borrar</span>
              )}
            </div>
          </div>

          <div className="hrr-limpia-fila">
            <div>
              <b>Importaciones fallidas</b>
              <p className="adm-small adm-muted">
                Intentos de traer un producto de un proveedor que no salieron. Se guardan para poder mirar qué pasó;
                cuando ya no interesan, estorban.
              </p>
            </div>
            <div className="hrr-limpia-accion">
              <Badge tone={limpiables.importacionesFallidas > 0 ? "warning" : "neutral"}>
                {limpiables.importacionesFallidas}
              </Badge>
              {limpiables.importacionesFallidas > 0 ? (
                sp.limpiar === "importaciones" ? (
                  <form action={ejecutarLimpieza} className="hrr-linea">
                    <input type="hidden" name="tipo" value="importaciones" />
                    <input type="hidden" name="esperados" value={limpiables.importacionesFallidas} />
                    <span className="adm-small">
                      Se van a borrar <strong>{limpiables.importacionesFallidas}</strong> importaciones fallidas. Los
                      productos ya importados no se tocan.
                    </span>
                    <Button type="submit" variant="danger" size="sm">
                      Sí, borrar {limpiables.importacionesFallidas}
                    </Button>
                    <Button href="/admin/herramientas" variant="ghost" size="sm">
                      Cancelar
                    </Button>
                  </form>
                ) : (
                  <Button href="/admin/herramientas?limpiar=importaciones" variant="ghost" size="sm">
                    Borrar…
                  </Button>
                )
              ) : (
                <span className="adm-small adm-muted">Nada que borrar</span>
              )}
            </div>
          </div>
        </div>
      </Card>

      <p className="hrr-pie">
        ¿Buscabas los mensajes para las clientas? Están en{" "}
        <Link className="adm-link" href="/admin/plantillas">
          Plantillas de mensajes
        </Link>
        .
      </p>
    </>
  );
}
