"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { markdownAHtml } from "@/lib/markdown";
import { Button, Card, Field } from "../../_components/ui";
import { guardarBloque, type EstadoBloque } from "../actions";
import { guardarPagina, type EstadoPagina } from "../../paginas/actions";
import { guardarItemMenu, type EstadoMenu } from "../../menus/actions";

/**
 * Los tres formularios del módulo de contenido.
 *
 * Viven en el mismo fichero a propósito: los tres son la capa cliente de la
 * misma idea (escribir algo y verlo antes de publicarlo), comparten la vista
 * previa del markdown y el mismo patrón de estado con useActionState. Tenerlos
 * juntos evita tres módulos cliente casi idénticos — el storefront hace lo mismo
 * en CartDrawer.tsx.
 *
 * Todo lo demás del módulo (listas, tablas, cabeceras) es Server Component:
 * aquí solo está lo que de verdad necesita interacción.
 */

/* ═══════════════════════ 1. BLOQUES DE LA PORTADA ═══════════════════════ */

type NombreCampo = "title" | "subtitle" | "body" | "imageUrl" | "linkUrl" | "linkLabel" | "items";

type DefCampo = {
  campo: NombreCampo;
  etiqueta: string;
  /** DÓNDE sale esto en la página. "Subtítulo" no significa nada sin contexto. */
  donde: string;
  tipo: "texto" | "area" | "lista";
  filas?: number;
};

/**
 * Qué campos tiene cada bloque y qué es cada uno EN LA PÁGINA.
 *
 * El modelo HomeBlock tiene los mismos siete huecos para todos los bloques
 * (title, subtitle, body, imageUrl, linkUrl, linkLabel, dataJson) porque así se
 * reordenan sin migraciones. Esta tabla es la que traduce esos huecos a lo que
 * Madeline ve: sin ella, "subtítulo" es una caja de texto sin sentido.
 */
const CAMPOS: Record<string, DefCampo[]> = {
  hero: [
    { campo: "subtitle", etiqueta: "Línea pequeña de arriba", donde: "En mayúsculas pequeñas, encima del titular.", tipo: "texto" },
    { campo: "title", etiqueta: "Titular grande", donde: "El texto enorme que se lee nada más abrir la web.", tipo: "area", filas: 2 },
    { campo: "body", etiqueta: "Párrafo de presentación", donde: "Debajo del titular, antes de los botones.", tipo: "area", filas: 3 },
    { campo: "linkLabel", etiqueta: "Texto del botón", donde: "Botón oscuro del titular.", tipo: "texto" },
    { campo: "linkUrl", etiqueta: "Destino del botón", donde: "A dónde lleva ese botón: /tienda, #coleccion o una dirección completa.", tipo: "texto" },
    { campo: "imageUrl", etiqueta: "Foto principal", donde: "La foto grande de la derecha (en el móvil, debajo del texto).", tipo: "texto" },
    { campo: "items", etiqueta: "Los tres datos de abajo", donde: "La fila «2,880+ seguidoras · S · M · L tallas…». Uno por línea, con | entre el dato y su etiqueta.", tipo: "lista", filas: 4 },
  ],
  marquee: [
    { campo: "items", etiqueta: "Frases de la cinta", donde: "La cinta oscura que se desliza sola bajo el titular. Una frase por línea.", tipo: "lista", filas: 6 },
  ],
  coleccion: [
    { campo: "subtitle", etiqueta: "Línea pequeña de arriba", donde: "Encima del título de la sección («01 — La Colección»).", tipo: "texto" },
    { campo: "title", etiqueta: "Título de la sección", donde: "El título grande sobre la rejilla de prendas.", tipo: "texto" },
    { campo: "body", etiqueta: "Nota lateral", donde: "El texto pequeño a la derecha del título.", tipo: "area", filas: 3 },
    { campo: "linkLabel", etiqueta: "Texto del botón final", donde: "El botón que cierra la sección, bajo las prendas.", tipo: "texto" },
    { campo: "linkUrl", etiqueta: "Destino del botón final", donde: "Normalmente el DM de Instagram.", tipo: "texto" },
  ],
  cita: [
    { campo: "body", etiqueta: "La frase", donde: "La frase grande en cursiva entre dos secciones. Cada línea es un renglón.", tipo: "area", filas: 3 },
  ],
  filosofia: [
    { campo: "subtitle", etiqueta: "Línea pequeña de arriba", donde: "Encima del título («02 — Nuestra Filosofía»).", tipo: "texto" },
    { campo: "title", etiqueta: "Título", donde: "El título grande de la sección oscura.", tipo: "texto" },
    { campo: "body", etiqueta: "Texto", donde: "Primer renglón: la frase corta en cursiva. Deja una línea en blanco y escribe debajo el párrafo largo.", tipo: "area", filas: 6 },
    { campo: "items", etiqueta: "Las cuatro palabras", donde: "La lista numerada de la derecha. Una palabra por línea.", tipo: "lista", filas: 4 },
  ],
  boutique: [
    { campo: "subtitle", etiqueta: "Línea pequeña de arriba", donde: "Encima del título («03 — La Boutique»).", tipo: "texto" },
    { campo: "title", etiqueta: "Título", donde: "El título grande junto a las fotos de la tienda.", tipo: "texto" },
    { campo: "body", etiqueta: "Párrafo", donde: "Bajo el título, antes de la lista de ventajas.", tipo: "area", filas: 4 },
    { campo: "imageUrl", etiqueta: "Foto de la boutique", donde: "La foto grande del interior de la tienda.", tipo: "texto" },
    { campo: "items", etiqueta: "Ventajas", donde: "La lista con negritas. Una por línea, con | entre el título y la explicación.", tipo: "lista", filas: 5 },
  ],
  comoComprar: [
    { campo: "subtitle", etiqueta: "Línea pequeña de arriba", donde: "Encima del título («04 — Cómo Comprar»).", tipo: "texto" },
    { campo: "title", etiqueta: "Título", donde: "El título grande sobre los tres pasos.", tipo: "texto" },
    { campo: "items", etiqueta: "Los pasos", donde: "Las tarjetas numeradas. Una por línea, con | entre el título del paso y su explicación.", tipo: "lista", filas: 5 },
  ],
  visitanos: [
    { campo: "subtitle", etiqueta: "Línea pequeña de arriba", donde: "Encima del título («05 — Visítanos»).", tipo: "texto" },
    { campo: "title", etiqueta: "Título", donde: "El título de la tarjeta que va junto al mapa.", tipo: "texto" },
    { campo: "body", etiqueta: "Nota pequeña", donde: "El texto gris bajo los botones («El horario puede variar…»).", tipo: "area", filas: 2 },
    { campo: "linkLabel", etiqueta: "Texto del botón", donde: "El botón «Cómo llegar».", tipo: "texto" },
    { campo: "linkUrl", etiqueta: "Destino del botón", donde: "El enlace al mapa.", tipo: "texto" },
  ],
  instagram: [
    { campo: "subtitle", etiqueta: "Línea pequeña de arriba", donde: "Encima del título («Síguenos»).", tipo: "texto" },
    { campo: "title", etiqueta: "Título", donde: "El título de la sección de Instagram.", tipo: "texto" },
    { campo: "body", etiqueta: "Frase bajo el título", donde: "La línea con el número de seguidoras.", tipo: "area", filas: 2 },
    { campo: "items", etiqueta: "Fotos de la rejilla", donde: "Las cuatro fotos del final. Una ruta por línea (por ejemplo /assets/post-02-tendencia.jpg).", tipo: "lista", filas: 5 },
    { campo: "linkLabel", etiqueta: "Texto del botón", donde: "El botón que lleva a tu perfil.", tipo: "texto" },
    { campo: "linkUrl", etiqueta: "Destino del botón", donde: "La dirección de tu Instagram.", tipo: "texto" },
  ],
  banner: [
    { campo: "body", etiqueta: "Texto del aviso", donde: "Una franja de aviso (envíos, rebajas, horario especial). Enciéndela solo cuando tengas algo que anunciar.", tipo: "area", filas: 2 },
    { campo: "linkLabel", etiqueta: "Texto del enlace", donde: "Opcional, al final del aviso.", tipo: "texto" },
    { campo: "linkUrl", etiqueta: "Destino del enlace", donde: "A dónde lleva el aviso.", tipo: "texto" },
  ],
};

export type BloqueEditable = {
  id: string;
  kind: string;
  nombre: string;
  title: string;
  subtitle: string;
  body: string;
  imageUrl: string;
  linkUrl: string;
  linkLabel: string;
  items: string[];
};

export function BlockEditor({ bloque }: { bloque: BloqueEditable }) {
  const [estado, enviar, pendiente] = useActionState<EstadoBloque, FormData>(guardarBloque, {});
  const campos = CAMPOS[bloque.kind] ?? [];

  const valor = (campo: NombreCampo): string => {
    if (campo === "items") return bloque.items.join("\n");
    return bloque[campo] ?? "";
  };

  return (
    <Card
      title={`Editar: ${bloque.nombre}`}
      actions={
        <Button href="/admin/contenido" variant="ghost" size="sm">
          Cerrar
        </Button>
      }
    >
      {estado.error ? <div className="cnt-aviso cnt-aviso-error">{estado.error}</div> : null}
      {estado.ok ? <div className="cnt-aviso cnt-aviso-ok">{estado.mensaje}</div> : null}

      <form action={enviar}>
        <input type="hidden" name="id" value={bloque.id} />

        {campos.map((def) => (
          <Field
            key={def.campo}
            label={def.etiqueta}
            htmlFor={`c-${def.campo}`}
            hint={def.donde}
            error={estado.errores?.[def.campo]}
          >
            {def.tipo === "texto" ? (
              <input
                id={`c-${def.campo}`}
                name={def.campo}
                type="text"
                defaultValue={valor(def.campo)}
              />
            ) : (
              <textarea
                id={`c-${def.campo}`}
                name={def.campo}
                rows={def.filas ?? 3}
                defaultValue={valor(def.campo)}
              />
            )}
          </Field>
        ))}

        {/* Los campos que este bloque no usa viajan igual con su valor actual:
            si no, guardar un bloque borraría en silencio lo que no se enseña. */}
        {(["title", "subtitle", "body", "imageUrl", "linkUrl", "linkLabel", "items"] as NombreCampo[])
          .filter((c) => !campos.some((def) => def.campo === c))
          .map((c) => (
            <input key={c} type="hidden" name={c} value={valor(c)} />
          ))}

        <div className="cnt-barra">
          <Button type="submit" disabled={pendiente}>
            {pendiente ? "Guardando…" : "Guardar bloque"}
          </Button>
          {/* Un enlace que abre otra pestaña no puede ser <Button>: su tipo no
              admite target. La hoja del panel expone las clases del botón justo
              para esto. */}
          <a className="adm-btn adm-btn-ghost adm-btn-md" href="/" target="_blank" rel="noreferrer">
            Ver la portada
          </a>
        </div>
      </form>
    </Card>
  );
}

/* ═══════════════════════ 2. EDITOR DE PÁGINAS ═══════════════════════ */

export type PaginaEditable = {
  id: string | null;
  slug: string;
  title: string;
  content: string;
  status: string;
  seoTitle: string;
  seoDescription: string;
  showInFooter: boolean;
};

export function EditorPagina({ pagina }: { pagina: PaginaEditable }) {
  const [estado, enviar, pendiente] = useActionState<EstadoPagina, FormData>(guardarPagina, {});
  const [texto, setTexto] = useState(pagina.content);
  const [titulo, setTitulo] = useState(pagina.title);

  // La vista previa usa EXACTAMENTE el mismo conversor que la página pública:
  // si aquí se ve bien, en la tienda se ve igual. Y como escapa el HTML antes de
  // formatear, pegar un <script> aquí tampoco hace nada.
  const html = useMemo(() => markdownAHtml(texto), [texto]);

  return (
    <form action={enviar}>
      <input type="hidden" name="id" value={pagina.id ?? ""} />

      {estado.error ? <div className="cnt-aviso cnt-aviso-error">{estado.error}</div> : null}
      {estado.ok ? <div className="cnt-aviso cnt-aviso-ok">{estado.mensaje}</div> : null}

      <div className="cnt-editor">
        <div>
          <Card title="Contenido">
            <Field label="Título de la página" htmlFor="p-title" required error={estado.errores?.title} hint="Sale como titular arriba del todo y en el menú del pie.">
              <input
                id="p-title"
                name="title"
                type="text"
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                placeholder="Envíos y entregas"
              />
            </Field>

            <Field
              label="Dirección en la web"
              htmlFor="p-slug"
              error={estado.errores?.slug}
              hint="Si lo dejas vacío se saca del título. La página quedará en /pagina/lo-que-pongas-aquí."
            >
              <input id="p-slug" name="slug" type="text" defaultValue={pagina.slug} placeholder="envios-y-entregas" />
            </Field>

            <Field label="Texto de la página" htmlFor="p-content" error={estado.errores?.content}>
              <textarea
                id="p-content"
                name="content"
                className="cnt-md"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder={"## Un título\n\nUn párrafo normal.\n\n- una cosa\n- otra cosa"}
              />
            </Field>

            <div className="cnt-chuleta">
              <span>
                <code># Título</code> grande
              </span>
              <span>
                <code>## Título</code> mediano
              </span>
              <span>
                <code>**negrita**</code>
              </span>
              <span>
                <code>*cursiva*</code>
              </span>
              <span>
                <code>- lista</code>
              </span>
              <span>
                <code>[texto](/tienda)</code> enlace
              </span>
            </div>
          </Card>

          <Card title="Cómo se publica">
            <Field label="Estado" htmlFor="p-status" hint="En borrador solo la ves tú. Publicada la ve cualquiera que entre en la dirección.">
              <select id="p-status" name="status" defaultValue={pagina.status}>
                <option value="draft">Borrador — todavía no se ve</option>
                <option value="published">Publicada — visible en la web</option>
              </select>
            </Field>

            <Field label="¿Sale en el pie de la web?" htmlFor="p-footer" hint="El pie es donde la gente busca envíos, devoluciones y condiciones.">
              <select id="p-footer" name="showInFooter" defaultValue={pagina.showInFooter ? "1" : "0"}>
                <option value="1">Sí, enséñala en el pie</option>
                <option value="0">No, solo con el enlace directo</option>
              </select>
            </Field>
          </Card>

          <Card title="Cómo se ve en Google">
            <Field
              label="Título en Google"
              htmlFor="p-seotitle"
              hint="Si lo dejas vacío se usa el título de la página. Máximo unas 60 letras."
            >
              <input id="p-seotitle" name="seoTitle" type="text" defaultValue={pagina.seoTitle} />
            </Field>
            <Field
              label="Descripción en Google"
              htmlFor="p-seodesc"
              hint="Las dos líneas grises bajo el título en los resultados de búsqueda."
            >
              <textarea id="p-seodesc" name="seoDescription" rows={3} defaultValue={pagina.seoDescription} />
            </Field>
          </Card>

          <div className="cnt-barra">
            <Button type="submit" disabled={pendiente}>
              {pendiente ? "Guardando…" : "Guardar página"}
            </Button>
            <Button href="/admin/paginas" variant="ghost">
              Volver a la lista
            </Button>
          </div>
        </div>

        <div className="cnt-panel">
          <Card title="Vista previa">
            <p className="cnt-pista">Así se verá el texto en la web. Se actualiza mientras escribes.</p>
            <div className="cnt-vista">
              <h2>{titulo || "Título de la página"}</h2>
              {html ? (
                <div dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <p className="cnt-vista-vacia">Escribe algo a la izquierda y aparecerá aquí.</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </form>
  );
}

/* ═══════════════════════ 3. EDITOR DE ENLACES DEL MENÚ ═══════════════════════ */

export type OpcionDestino = { valor: string; etiqueta: string; grupo: string };

export type ItemMenuEditable = {
  id: string | null;
  menu: string;
  label: string;
  url: string;
};

export function EditorMenu({
  item,
  destinos,
  titulo,
}: {
  item: ItemMenuEditable;
  destinos: OpcionDestino[];
  titulo: string;
}) {
  const [estado, enviar, pendiente] = useActionState<EstadoMenu, FormData>(guardarItemMenu, {});

  // Si el destino guardado no está entre los conocidos, es una dirección escrita
  // a mano: el desplegable arranca en "otra dirección" y no se pierde el valor.
  const conocido = destinos.some((d) => d.valor === item.url);
  const [eleccion, setEleccion] = useState(item.url && conocido ? item.url : "__otra__");
  const [urlLibre, setUrlLibre] = useState(conocido ? "" : item.url);

  const grupos = useMemo(() => {
    const mapa = new Map<string, OpcionDestino[]>();
    for (const d of destinos) {
      const lista = mapa.get(d.grupo) ?? [];
      lista.push(d);
      mapa.set(d.grupo, lista);
    }
    return [...mapa.entries()];
  }, [destinos]);

  return (
    <Card
      title={titulo}
      actions={
        item.id ? (
          <Button href={`/admin/menus?menu=${item.menu}`} variant="ghost" size="sm">
            Cancelar
          </Button>
        ) : null
      }
    >
      {estado.error ? <div className="cnt-aviso cnt-aviso-error">{estado.error}</div> : null}
      {estado.ok ? <div className="cnt-aviso cnt-aviso-ok">{estado.mensaje}</div> : null}

      <form action={enviar}>
        <input type="hidden" name="id" value={item.id ?? ""} />
        <input type="hidden" name="menu" value={item.menu} />

        <Field label="Lo que se lee" htmlFor="m-label" required error={estado.errores?.label} hint="El texto del enlace tal cual lo verá la clienta.">
          <input id="m-label" name="label" type="text" defaultValue={item.label} placeholder="Nuevas llegadas" />
        </Field>

        <Field label="A dónde lleva" htmlFor="m-destino" hint="Elige una página de tu tienda o escribe una dirección de fuera.">
          <select
            id="m-destino"
            name="destino"
            value={eleccion}
            onChange={(e) => setEleccion(e.target.value)}
          >
            {grupos.map(([grupo, opciones]) => (
              <optgroup key={grupo} label={grupo}>
                {opciones.map((o) => (
                  <option key={o.valor} value={o.valor}>
                    {o.etiqueta}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value="__otra__">Otra dirección (la escribo yo)</option>
          </select>
        </Field>

        {eleccion === "__otra__" ? (
          <Field
            label="Dirección"
            htmlFor="m-url"
            required
            error={estado.errores?.url}
            hint="Una dirección completa (https://…) o una ruta del sitio (/tienda, #visitanos)."
          >
            <input
              id="m-url"
              name="url"
              type="text"
              value={urlLibre}
              onChange={(e) => setUrlLibre(e.target.value)}
              placeholder="https://www.instagram.com/bloombymadelin/"
            />
          </Field>
        ) : (
          <input type="hidden" name="url" value={eleccion} />
        )}

        <div className="cnt-barra">
          <Button type="submit" disabled={pendiente}>
            {pendiente ? "Guardando…" : item.id ? "Guardar enlace" : "Añadir enlace"}
          </Button>
          {item.id ? (
            <Link className="adm-link" href={`/admin/menus?menu=${item.menu}&item=${item.id}&borrar=1`}>
              Quitar este enlace
            </Link>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
