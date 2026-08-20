"use client";

import { useActionState, useState } from "react";
import { formatCents, type PricingRule } from "@/lib/money";
import { Badge, Button, Card, Field, PageHeader } from "../../_components/ui";
import { accionEnLote, guardarProducto, type EstadoProducto, type ImagenDraft } from "../actions";
import ImageManager from "./ImageManager";
import VariantEditor, { filaAVariante, filaDesdeVariante, filaVacia, type Fila, type Opcion } from "./VariantEditor";
import "../catalogo.css";

/**
 * Editor de producto: sirve igual para crear y para editar, porque son la misma
 * pantalla con el mismo contrato. Todo el estado vive aquí y viaja al Server
 * Action en tres campos ocultos con JSON dentro; así el guardado es uno solo y
 * atómico, y no quedan a medias variantes sin producto ni al revés.
 */

export type ProductoEditable = {
  id: string;
  title: string;
  slug: string;
  description: string;
  status: string;
  vendor: string;
  productType: string;
  tags: string[];
  optionNames: string[];
  seoTitle: string;
  seoDescription: string;
  sourceProvider: string | null;
  sourceUrl: string | null;
  coleccionesIds: string[];
  imagenes: ImagenDraft[];
  variantes: {
    id: string;
    sku: string;
    option1: string | null;
    option2: string | null;
    option3: string | null;
    priceCents: number;
    compareAtCents: number | null;
    costCents: number | null;
    stock: number;
    trackStock: boolean;
    imageUrl: string | null;
  }[];
};

type Props = {
  producto: ProductoEditable | null;
  colecciones: { id: string; title: string }[];
  pricing: PricingRule;
  /** Mensaje de la redirección que sigue a crear el producto. */
  recienCreado?: boolean;
};

const ORIGENES: Record<string, string> = {
  manual: "Creado a mano",
  aliexpress: "Importado de AliExpress",
  alibaba: "Importado de Alibaba",
  csv: "Importado de CSV",
};

/**
 * Vista previa del slug mientras se escribe. La versión que manda es siempre la
 * del servidor (`slugify` + `uniqueProductSlug` de lib/slug.ts), que además
 * garantiza que no choque con otro producto; esta solo pinta lo que va a salir.
 */
function slugAproximado(texto: string): string {
  return (
    texto
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "producto"
  );
}

export default function ProductForm({ producto, colecciones, pricing, recienCreado = false }: Props) {
  const [estado, enviar, pendiente] = useActionState<EstadoProducto, FormData>(guardarProducto, {});

  const [title, setTitle] = useState(producto?.title ?? "");
  // Vacío = "sígueme el título". En cuanto se escribe algo, manda lo escrito:
  // cambiar la dirección de un producto ya publicado rompe los enlaces que
  // Madeline mandó por Instagram, así que nunca se mueve sola tras editarla.
  const [slug, setSlug] = useState(producto?.slug ?? "");
  const [description, setDescription] = useState(producto?.description ?? "");
  const [seoTitle, setSeoTitle] = useState(producto?.seoTitle ?? "");
  const [seoDescription, setSeoDescription] = useState(producto?.seoDescription ?? "");
  const [status, setStatus] = useState(producto?.status ?? "draft");

  const [opciones, setOpciones] = useState<Opcion[]>(() => opcionesIniciales(producto));
  const [filas, setFilas] = useState<Fila[]>(() =>
    producto && producto.variantes.length > 0 ? producto.variantes.map(filaDesdeVariante) : [filaVacia()],
  );
  const [imagenes, setImagenes] = useState<ImagenDraft[]>(producto?.imagenes ?? []);

  const variantes = filas.map(filaAVariante);
  const preciosPositivos = variantes.map((v) => v.priceCents).filter((p) => p > 0);
  const precioMinimo = preciosPositivos.length > 0 ? Math.min(...preciosPositivos) : 0;
  const puedePublicar = precioMinimo > 0 && imagenes.length > 0;

  const slugVisible = slug.trim() ? slugAproximado(slug) : slugAproximado(title);

  const avisos: string[] = [];
  if (precioMinimo <= 0) avisos.push("No tiene precio: así no se puede publicar ni cobrar.");
  if (imagenes.length === 0) avisos.push("No tiene ninguna foto: la ficha saldría vacía.");
  const agotadas = filas.filter((f) => f.trackStock && (Number.parseInt(f.stock, 10) || 0) <= 0);
  if (agotadas.length > 0) {
    avisos.push(
      `${agotadas.length} ${agotadas.length === 1 ? "variante controlada está agotada" : "variantes controladas están agotadas"}: no se podrán comprar.`,
    );
  }

  return (
    <>
      <form action={enviar}>
        <input type="hidden" name="id" value={producto?.id ?? ""} />
        <input type="hidden" name="variantesJson" value={JSON.stringify(variantes)} />
        <input
          type="hidden"
          name="imagenesJson"
          value={JSON.stringify(imagenes.map(({ id, url, alt }) => ({ id, url, alt })))}
        />
        <input
          type="hidden"
          name="optionNamesJson"
          value={JSON.stringify(opciones.map((o) => o.nombre.trim()).filter(Boolean))}
        />

        <PageHeader
          title={producto ? producto.title || "Producto sin título" : "Nuevo producto"}
          subtitle={
            producto
              ? `${ORIGENES[producto.sourceProvider ?? "manual"] ?? "Origen desconocido"} · ${filas.length} ${filas.length === 1 ? "variante" : "variantes"} · desde ${formatCents(precioMinimo)}`
              : "Rellena lo básico, pon precio y foto, y ya se puede publicar."
          }
          actions={
            <>
              <Button href="/admin/productos" variant="ghost">
                Volver al listado
              </Button>
              <Button type="submit" disabled={pendiente}>
                {pendiente ? "Guardando…" : "Guardar"}
              </Button>
            </>
          }
        />

        {recienCreado ? <div className="cat-aviso cat-aviso-ok">Producto creado. Ya puedes seguir editándolo.</div> : null}
        {estado.error ? <div className="cat-aviso cat-aviso-error">{estado.error}</div> : null}
        {estado.mensaje ? <div className="cat-aviso cat-aviso-ok">{estado.mensaje}</div> : null}

        {avisos.length > 0 ? (
          <div className="cat-aviso cat-aviso-warn">
            {avisos.map((aviso) => (
              <div key={aviso}>{aviso}</div>
            ))}
          </div>
        ) : null}

        <div className="cat-cols">
          <div className="cat-stack">
            <Card title="Lo básico">
              <Field label="Título" htmlFor="title" required error={estado.errores?.title}>
                <input
                  id="title"
                  name="title"
                  type="text"
                  value={title}
                  placeholder="Vestido midi floral"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>

              <Field
                label="Dirección en la tienda"
                htmlFor="slug"
                hint={`Quedará en /producto/${slugVisible}. Si lo dejas vacío se genera del título.`}
              >
                <input
                  id="slug"
                  name="slug"
                  type="text"
                  value={slug}
                  placeholder={slugAproximado(title)}
                  onChange={(e) => setSlug(e.target.value)}
                />
              </Field>

              <Field label="Descripción" htmlFor="description" hint="Lo que la clienta lee en la ficha.">
                <textarea
                  id="description"
                  name="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </Card>

            <Card title="Variantes, precio y margen">
              <VariantEditor
                opciones={opciones}
                filas={filas}
                pricing={pricing}
                onOpciones={setOpciones}
                onFilas={setFilas}
              />
            </Card>

            <Card title="Fotos">
              <ImageManager imagenes={imagenes} onCambio={setImagenes} />
            </Card>

            <Card title="Cómo se ve en Google">
              <div className="cat-google">
                <span className="cat-google-url">…/producto/{slugVisible}</span>
                <span className="cat-google-title">{seoTitle || title || "Título del producto"}</span>
                <span className="cat-google-desc">
                  {(seoDescription || description || "Aquí saldría la descripción del producto.").slice(0, 160)}
                </span>
              </div>

              <div style={{ marginTop: 16 }}>
                <Field
                  label="Título para buscadores"
                  htmlFor="seoTitle"
                  hint={
                    <>
                      Si lo dejas vacío se usa el título del producto. Google corta sobre los 60 caracteres:{" "}
                      <span className={`cat-contador${(seoTitle || title).length > 60 ? " se-pasa" : ""}`}>
                        {(seoTitle || title).length}
                      </span>
                      .
                    </>
                  }
                >
                  <input
                    id="seoTitle"
                    name="seoTitle"
                    type="text"
                    value={seoTitle}
                    onChange={(e) => setSeoTitle(e.target.value)}
                  />
                </Field>

                <Field
                  label="Descripción para buscadores"
                  htmlFor="seoDescription"
                  hint={
                    <>
                      Google corta sobre los 160 caracteres:{" "}
                      <span className={`cat-contador${(seoDescription || description).length > 160 ? " se-pasa" : ""}`}>
                        {(seoDescription || description).length}
                      </span>
                      .
                    </>
                  }
                >
                  <textarea
                    id="seoDescription"
                    name="seoDescription"
                    value={seoDescription}
                    onChange={(e) => setSeoDescription(e.target.value)}
                  />
                </Field>
              </div>
            </Card>
          </div>

          <aside className="cat-stack">
            <Card title="Publicación">
              <Field label="Estado" htmlFor="status" error={estado.errores?.status}>
                <select id="status" name="status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="draft">Borrador — no se ve en la tienda</option>
                  <option value="active" disabled={!puedePublicar}>
                    Activo — a la venta
                  </option>
                  <option value="archived">Archivado — fuera del catálogo</option>
                </select>
              </Field>

              {!puedePublicar ? (
                <p className="adm-field-hint">
                  Para poder activarlo necesita al menos un precio mayor que cero y una foto. Un producto activo a
                  $0.00 es dinero regalado, y uno sin foto no lo compra nadie.
                </p>
              ) : null}

              <div className="adm-row" style={{ marginTop: 8 }}>
                <Badge tone={status === "active" ? "success" : "neutral"}>
                  {status === "active" ? "Activo" : status === "archived" ? "Archivado" : "Borrador"}
                </Badge>
                <span className="adm-muted adm-small">Desde {formatCents(precioMinimo)}</span>
              </div>
            </Card>

            <Card title="Organización">
              <Field label="Tipo de producto" htmlFor="productType" hint="Vestidos, Tops, Accesorios…">
                <input
                  id="productType"
                  name="productType"
                  type="text"
                  defaultValue={producto?.productType ?? ""}
                />
              </Field>

              <Field label="Marca o proveedor" htmlFor="vendor">
                <input
                  id="vendor"
                  name="vendor"
                  type="text"
                  defaultValue={producto?.vendor ?? "Bloom by Madeline"}
                />
              </Field>

              <Field label="Etiquetas" htmlFor="tags" hint="Separadas por comas. Sirven para buscar en el panel.">
                <input id="tags" name="tags" type="text" defaultValue={(producto?.tags ?? []).join(", ")} />
              </Field>
            </Card>

            <Card title="Colecciones">
              {colecciones.length === 0 ? (
                <p className="adm-muted adm-small">
                  Todavía no hay colecciones. <a className="adm-link" href="/admin/colecciones">Crea la primera</a>.
                </p>
              ) : (
                <div className="cat-checks">
                  {colecciones.map((coleccion) => (
                    <label key={coleccion.id}>
                      <input
                        type="checkbox"
                        name="colecciones"
                        value={coleccion.id}
                        defaultChecked={producto?.coleccionesIds.includes(coleccion.id) ?? false}
                      />
                      {coleccion.title}
                    </label>
                  ))}
                </div>
              )}
            </Card>

            {producto?.sourceUrl ? (
              <Card title="Origen">
                <p className="adm-small">
                  {ORIGENES[producto.sourceProvider ?? "manual"] ?? "Origen desconocido"}.{" "}
                  <a className="adm-link" href={producto.sourceUrl} target="_blank" rel="noreferrer">
                    Ver la ficha del proveedor
                  </a>
                </p>
              </Card>
            ) : null}
          </aside>
        </div>
      </form>

      {/* Fuera del formulario principal: el HTML no permite anidar dos <form>, y
          borrar no debe compartir envío con guardar. */}
      {producto ? (
        <form action={accionEnLote} style={{ marginTop: 20 }}>
          <input type="hidden" name="ids" value={producto.id} />
          <input type="hidden" name="accion" value="borrar" />
          <input type="hidden" name="volver" value="/admin/productos" />
          <Card title="Zona peligrosa">
            <div className="adm-row">
              <Button type="submit" variant="danger">
                Borrar este producto
              </Button>
              <span className="adm-muted adm-small">
                Se pedirá confirmación. Los pedidos antiguos siguen siendo legibles porque guardan su propia copia
                del título y del precio.
              </span>
            </div>
          </Card>
        </form>
      ) : null}
    </>
  );
}

/* ─────────────────────────── utilidades ─────────────────────────── */

/**
 * Reconstruye los nombres y valores de opción a partir de las variantes que ya
 * existen: el esquema guarda los nombres, pero los valores solo viven repartidos
 * por las filas.
 */
function opcionesIniciales(producto: ProductoEditable | null): Opcion[] {
  if (!producto || producto.optionNames.length === 0) return [];
  return producto.optionNames.map((nombre, indice) => {
    const valores = new Set<string>();
    for (const variante of producto.variantes) {
      const valor = [variante.option1, variante.option2, variante.option3][indice];
      if (valor) valores.add(valor);
    }
    return { nombre, valores: [...valores].join(", ") };
  });
}
