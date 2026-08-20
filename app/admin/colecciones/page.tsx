import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { buscar as filtroTexto } from "@/lib/search";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Money,
  PageHeader,
  type Column,
} from "../_components/ui";
import {
  asignarProducto,
  borrarColeccion,
  guardarColeccion,
  moverColeccion,
  moverProductoEnColeccion,
} from "./actions";
import "../productos/catalogo.css";

/**
 * Colecciones: crear, ordenar a mano, esconder y decidir qué productos llevan
 * dentro. Todo cabe en una pantalla con tres estados (listado, ficha, borrado)
 * porque una boutique maneja seis u ocho colecciones, no seiscientas.
 *
 * El orden es manual y no alfabético a propósito: en el escaparate la primera
 * colección es la que vende, y esa decisión es de Madeline.
 */

export const dynamic = "force-dynamic";

const MENSAJES: Record<string, { texto: string; tono: "ok" | "warn" | "info" | "error" }> = {
  guardada: { texto: "Colección guardada.", tono: "ok" },
  borrada: { texto: "Colección borrada. Los productos que tenía siguen en el catálogo.", tono: "ok" },
  movida: { texto: "Nuevo orden guardado.", tono: "ok" },
  anadido: { texto: "Producto añadido a la colección.", tono: "ok" },
  quitado: { texto: "Producto quitado de la colección.", tono: "ok" },
  ordenado: { texto: "Nuevo orden de los productos guardado.", tono: "ok" },
  "no-existe": { texto: "Esa colección ya no existe.", tono: "error" },
};

type Busqueda = Record<string, string | string[] | undefined>;

export default async function ColeccionesPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const editar = uno(sp.editar);
  const idBorrar = uno(sp.borrar);
  const buscar = uno(sp.buscar).trim();
  const error = uno(sp.error);
  const mensaje = MENSAJES[uno(sp.hecho)];

  /* ── confirmación de borrado ────────────────────────────────────────── */

  if (idBorrar) {
    const coleccion = await db.collection.findUnique({
      where: { id: idBorrar },
      select: { id: true, title: true, _count: { select: { products: true } } },
    });

    return (
      <>
        <PageHeader title="Confirmar el borrado" subtitle="Borrar una colección es definitivo." />
        <Card
          title={coleccion ? `Vas a borrar "${coleccion.title}"` : "Esa colección ya no existe"}
          footer={
            coleccion ? (
              <form action={borrarColeccion} className="adm-row">
                <input type="hidden" name="id" value={coleccion.id} />
                <input type="hidden" name="confirmado" value="1" />
                <Button type="submit" variant="danger">
                  Sí, borrar &quot;{coleccion.title}&quot;
                </Button>
                <Button href="/admin/colecciones" variant="ghost">
                  Cancelar
                </Button>
              </form>
            ) : (
              <Button href="/admin/colecciones" variant="ghost">
                Volver
              </Button>
            )
          }
        >
          {coleccion ? (
            <p>
              Tiene {coleccion._count.products}{" "}
              {coleccion._count.products === 1 ? "producto dentro" : "productos dentro"}. Los productos{" "}
              <b>no se borran</b>: solo dejan de estar agrupados, y desaparece la página /coleccion/… del
              escaparate.
            </p>
          ) : null}
        </Card>
      </>
    );
  }

  /* ── ficha de una colección (o alta) ────────────────────────────────── */

  if (editar) {
    const esNueva = editar === "nueva";
    const coleccion = esNueva
      ? null
      : await db.collection.findUnique({
          where: { id: editar },
          include: {
            products: {
              orderBy: { position: "asc" },
              select: {
                position: true,
                product: {
                  select: {
                    id: true,
                    title: true,
                    status: true,
                    priceCents: true,
                    images: { orderBy: { position: "asc" }, take: 1, select: { url: true } },
                  },
                },
              },
            },
          },
        });

    if (!esNueva && !coleccion) redirect("/admin/colecciones?hecho=no-existe");

    const dentro = coleccion?.products ?? [];
    const idsDentro = dentro.map((p) => p.product.id);

    // El buscador solo se usa para añadir, así que quita de la lista lo que ya
    // está dentro: enseñar un botón "Añadir" que no hace nada es peor que nada.
    const candidatos = buscar
      ? await db.product.findMany({
          where: {
            id: { notIn: idsDentro },
            OR: [{ title: filtroTexto(buscar) }, { slug: filtroTexto(buscar) }, { tagsJson: filtroTexto(buscar) }],
          },
          orderBy: { title: "asc" },
          take: 12,
          select: { id: true, title: true, status: true, priceCents: true },
        })
      : [];

    return (
      <>
        <PageHeader
          title={esNueva ? "Nueva colección" : coleccion?.title || "Colección"}
          subtitle={
            esNueva
              ? "Una colección agrupa productos y les da su propia página en la tienda."
              : `${dentro.length} ${dentro.length === 1 ? "producto dentro" : "productos dentro"} · /coleccion/${coleccion?.slug}`
          }
          actions={
            <Button href="/admin/colecciones" variant="ghost">
              Volver al listado
            </Button>
          }
        />

        {mensaje ? <div className={`cat-aviso cat-aviso-${mensaje.tono}`}>{mensaje.texto}</div> : null}
        {error === "titulo" ? (
          <div className="cat-aviso cat-aviso-error">La colección necesita un título.</div>
        ) : null}

        <div className="cat-cols">
          <div className="cat-stack">
            <Card title="Datos de la colección">
              <form action={guardarColeccion}>
                <input type="hidden" name="id" value={coleccion?.id ?? ""} />

                <Field label="Título" htmlFor="title" required>
                  <input
                    id="title"
                    name="title"
                    type="text"
                    defaultValue={coleccion?.title ?? ""}
                    placeholder="Vestidos de verano"
                  />
                </Field>

                <Field
                  label="Dirección en la tienda"
                  htmlFor="slug"
                  hint="Si la dejas vacía se genera del título."
                >
                  <input id="slug" name="slug" type="text" defaultValue={coleccion?.slug ?? ""} />
                </Field>

                <Field label="Descripción" htmlFor="description">
                  <textarea id="description" name="description" defaultValue={coleccion?.description ?? ""} />
                </Field>

                <Field label="Imagen de portada" htmlFor="imageUrl" hint="Dirección de la foto que la representa.">
                  <input
                    id="imageUrl"
                    name="imageUrl"
                    type="url"
                    defaultValue={coleccion?.imageUrl ?? ""}
                    placeholder="https://…"
                  />
                </Field>

                <label className="cat-inline" style={{ marginBottom: 16 }}>
                  <input type="checkbox" name="isVisible" defaultChecked={coleccion?.isVisible ?? true} />
                  Visible en la tienda
                </label>

                <Button type="submit">{esNueva ? "Crear colección" : "Guardar cambios"}</Button>
              </form>
            </Card>

            {coleccion ? (
              <Card title="Productos de la colección" flush>
                <DataTable
                  columns={columnasDentro(coleccion.id, dentro.length)}
                  rows={dentro}
                  rowKey={(fila) => fila.product.id}
                  empty={
                    <EmptyState
                      title="Colección vacía"
                      text="Busca productos en el panel de la derecha y añádelos. El orden que les des aquí es el que verá la clienta."
                    />
                  }
                />
              </Card>
            ) : null}
          </div>

          <aside className="cat-stack">
            {coleccion ? (
              <Card title="Añadir productos">
                <form method="get" action="/admin/colecciones" className="cat-img-alta">
                  <input type="hidden" name="editar" value={coleccion.id} />
                  <div className="adm-field">
                    <label className="adm-field-lbl" htmlFor="buscar">
                      Buscar en el catálogo
                    </label>
                    <input id="buscar" name="buscar" type="search" defaultValue={buscar} placeholder="Vestido…" />
                  </div>
                  <Button type="submit" variant="ghost">
                    Buscar
                  </Button>
                </form>

                {buscar && candidatos.length === 0 ? (
                  <p className="adm-muted adm-small" style={{ marginTop: 12 }}>
                    Ningún producto suelto coincide con «{buscar}».
                  </p>
                ) : null}

                <div className="cat-imgs" style={{ marginTop: 12 }}>
                  {candidatos.map((p) => (
                    <form action={asignarProducto} key={p.id} className="cat-img">
                      <input type="hidden" name="coleccionId" value={coleccion.id} />
                      <input type="hidden" name="productoId" value={p.id} />
                      <input type="hidden" name="buscar" value={buscar} />
                      <span className="cat-img-cuerpo">
                        <b>{p.title}</b>
                        <span className="adm-row">
                          <Badge tone={p.status === "active" ? "success" : "neutral"}>
                            {p.status === "active" ? "Activo" : p.status === "archived" ? "Archivado" : "Borrador"}
                          </Badge>
                          <Money cents={p.priceCents} tone="muted" />
                        </span>
                      </span>
                      <Button type="submit" variant="ghost" size="sm">
                        Añadir
                      </Button>
                    </form>
                  ))}
                </div>
              </Card>
            ) : (
              <Card title="Cómo funciona">
                <p className="adm-small">
                  Crea la colección primero. En cuanto exista podrás buscar productos y añadirlos, y decidir en qué
                  orden se ven en su página de la tienda.
                </p>
              </Card>
            )}

            {coleccion ? (
              <Card title="Zona peligrosa">
                <form action={borrarColeccion} className="adm-row">
                  <input type="hidden" name="id" value={coleccion.id} />
                  <Button type="submit" variant="danger">
                    Borrar colección
                  </Button>
                  <span className="adm-muted adm-small">Se pedirá confirmación. Los productos no se borran.</span>
                </form>
              </Card>
            ) : null}
          </aside>
        </div>
      </>
    );
  }

  /* ── listado ────────────────────────────────────────────────────────── */

  const colecciones = await db.collection.findMany({
    orderBy: [{ position: "asc" }, { title: "asc" }],
    include: { _count: { select: { products: true } } },
  });

  const columnas: Column<(typeof colecciones)[number]>[] = [
    {
      key: "orden",
      header: "Orden",
      width: "104px",
      label: "Orden",
      render: (c, i) => (
        <span className="adm-row">
          <form action={moverColeccion}>
            <input type="hidden" name="id" value={c.id} />
            <input type="hidden" name="direccion" value="arriba" />
            <Button type="submit" variant="ghost" size="sm" disabled={i === 0} aria-label="Subir">
              ↑
            </Button>
          </form>
          <form action={moverColeccion}>
            <input type="hidden" name="id" value={c.id} />
            <input type="hidden" name="direccion" value="abajo" />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              disabled={i === colecciones.length - 1}
              aria-label="Bajar"
            >
              ↓
            </Button>
          </form>
        </span>
      ),
    },
    {
      key: "coleccion",
      header: "Colección",
      primary: true,
      render: (c) => (
        <span className="cat-prod">
          {c.imageUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- miniatura del
               panel; la foto puede estar en el CDN de un proveedor. */
            <img className="cat-col-thumb" src={c.imageUrl} alt="" />
          ) : (
            <span className="cat-thumb-vacio">SIN FOTO</span>
          )}
          <span className="cat-prod-txt">
            <Link className="adm-link" href={`/admin/colecciones?editar=${c.id}`}>
              {c.title}
            </Link>
            <span className="adm-muted adm-small">/coleccion/{c.slug}</span>
          </span>
        </span>
      ),
    },
    {
      key: "visible",
      header: "Visibilidad",
      render: (c) =>
        c.isVisible ? <Badge tone="success">Visible</Badge> : <Badge tone="neutral">Escondida</Badge>,
    },
    {
      key: "productos",
      header: "Productos",
      align: "right",
      render: (c) => (
        <Link className="adm-link" href={`/admin/productos?coleccion=${c.id}`}>
          {c._count.products}
        </Link>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Colecciones"
        subtitle={
          colecciones.length === 0
            ? "Todavía no hay ninguna"
            : `${colecciones.length} ${colecciones.length === 1 ? "colección" : "colecciones"} · ${colecciones.filter((c) => c.isVisible).length} visibles en la tienda`
        }
        actions={<Button href="/admin/colecciones?editar=nueva">Nueva colección</Button>}
      />

      {mensaje ? <div className={`cat-aviso cat-aviso-${mensaje.tono}`}>{mensaje.texto}</div> : null}

      <Card title="Orden del escaparate" flush>
        <DataTable
          columns={columnas}
          rows={colecciones}
          rowKey={(c) => c.id}
          empty={
            <EmptyState
              title="Sin colecciones"
              text="Las colecciones agrupan productos y les dan su propia página. Sin ellas, la tienda solo tiene el catálogo entero."
              action={<Button href="/admin/colecciones?editar=nueva">Crear la primera</Button>}
            />
          }
        />
      </Card>
    </>
  );
}

/* ─────────────────── tabla de productos de la ficha ─────────────────── */

type FilaDentro = {
  position: number;
  product: {
    id: string;
    title: string;
    status: string;
    priceCents: number;
    images: { url: string }[];
  };
};

function columnasDentro(coleccionId: string, total: number): Column<FilaDentro>[] {
  return [
    {
      key: "orden",
      header: "Orden",
      width: "104px",
      render: (fila, i) => (
        <span className="adm-row">
          <form action={moverProductoEnColeccion}>
            <input type="hidden" name="coleccionId" value={coleccionId} />
            <input type="hidden" name="productoId" value={fila.product.id} />
            <input type="hidden" name="direccion" value="arriba" />
            <Button type="submit" variant="ghost" size="sm" disabled={i === 0} aria-label="Subir">
              ↑
            </Button>
          </form>
          <form action={moverProductoEnColeccion}>
            <input type="hidden" name="coleccionId" value={coleccionId} />
            <input type="hidden" name="productoId" value={fila.product.id} />
            <input type="hidden" name="direccion" value="abajo" />
            <Button type="submit" variant="ghost" size="sm" disabled={i === total - 1} aria-label="Bajar">
              ↓
            </Button>
          </form>
        </span>
      ),
    },
    {
      key: "producto",
      header: "Producto",
      primary: true,
      render: (fila) => (
        <span className="cat-prod">
          {fila.product.images[0] ? (
            /* eslint-disable-next-line @next/next/no-img-element -- miniatura del panel. */
            <img className="adm-thumb" src={fila.product.images[0].url} alt="" />
          ) : (
            <span className="cat-thumb-vacio">SIN FOTO</span>
          )}
          <span className="cat-prod-txt">
            <Link className="adm-link" href={`/admin/productos/${fila.product.id}`}>
              {fila.product.title}
            </Link>
            {fila.product.priceCents <= 0 ? <Badge tone="danger">Sin precio</Badge> : null}
          </span>
        </span>
      ),
    },
    {
      key: "estado",
      header: "Estado",
      hideOnMobile: true,
      render: (fila) => (
        <Badge tone={fila.product.status === "active" ? "success" : "neutral"}>
          {fila.product.status === "active"
            ? "Activo"
            : fila.product.status === "archived"
              ? "Archivado"
              : "Borrador"}
        </Badge>
      ),
    },
    {
      key: "precio",
      header: "Precio",
      align: "right",
      render: (fila) => <Money cents={fila.product.priceCents} />,
    },
    {
      key: "quitar",
      header: "",
      label: "Acciones",
      align: "right",
      render: (fila) => (
        <form action={asignarProducto}>
          <input type="hidden" name="coleccionId" value={coleccionId} />
          <input type="hidden" name="productoId" value={fila.product.id} />
          <input type="hidden" name="accion" value="quitar" />
          <Button type="submit" variant="ghost" size="sm">
            Quitar
          </Button>
        </form>
      ),
    },
  ];
}

function uno(valor: string | string[] | undefined): string {
  if (Array.isArray(valor)) return valor[0] ?? "";
  return valor ?? "";
}
