/**
 * Markdown ligero → HTML, sin dependencias y a prueba de inyección.
 *
 * Lo escribe Madeline desde el panel y sale tal cual en una página pública, así
 * que el orden de las operaciones es lo único que importa de verdad:
 *
 *   1. se ESCAPA el texto entero (`<script>` deja de ser una etiqueta),
 *   2. y solo DESPUÉS se aplica el formato, que genera etiquetas nuestras.
 *
 * Al revés —formatear y luego escapar— o mezclando ambas cosas, cualquier `<`
 * pegado desde Instagram acabaría siendo HTML ejecutable en el escaparate.
 * Por eso este módulo no acepta nunca HTML de entrada: no hay lista blanca de
 * etiquetas, no hay "modo avanzado". Lo que no esté aquí abajo, no se puede
 * escribir, y esa es la garantía.
 *
 * Se soporta a propósito solo lo que una persona no técnica usa sin miedo:
 * títulos, negrita, cursiva, listas, enlaces, citas, separadores y párrafos.
 */

/* ───────────────────────────── escape ───────────────────────────── */

/** Todo lo que podría convertir texto en marcado deja de poder hacerlo. */
export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ───────────────────────────── enlaces ───────────────────────────── */

/**
 * Esquemas permitidos en un enlace. Sin esta lista, `[pulsa](javascript:...)`
 * sería un XSS con el HTML perfectamente escapado: el peligro no estaría en el
 * texto sino en el destino.
 *
 * Como el escape ya convirtió `&` en `&amp;`, un `javascript:` disfrazado con
 * entidades (`&#x6a;avascript:`) llega aquí como texto literal `&amp;#x6a;…`,
 * que el navegador decodifica una sola vez y deja en `&#x6a;avascript:` — un
 * esquema inexistente, tratado como ruta relativa. No hace falta más.
 */
const ESQUEMA_SEGURO = /^(?:https?:\/\/|mailto:|tel:|\/|#)/i;

/** Un enlace a otra web se abre fuera; uno interno navega en la misma pestaña. */
function pintarEnlace(texto: string, urlEscapada: string): string {
  if (!ESQUEMA_SEGURO.test(urlEscapada)) {
    // Destino no permitido: se conserva el texto y se tira el enlace. Perder el
    // enlace es un fallo cosmético; conservarlo sería un agujero.
    return texto;
  }
  const externo = /^https?:\/\//i.test(urlEscapada);
  const extras = externo ? ' target="_blank" rel="noopener noreferrer"' : "";
  return `<a href="${urlEscapada}"${extras}>${texto}</a>`;
}

/* ─────────────────────────── formato en línea ─────────────────────────── */

/**
 * Negrita, cursiva, código y enlaces dentro de una línea ya escapada.
 *
 * Los enlaces y el código se sacan primero a fichas del tipo `<<0>>` porque
 * si no, una URL con guion bajo (`.../mi_pagina`) se comería a sí misma al
 * aplicar la cursiva. Se reinsertan al final, cuando ya no queda nada que
 * interpretar. El `<` de la ficha no puede venir del texto de nadie: cuando
 * se llama a esta función el contenido ya está escapado, así que ningún
 * párrafo pegado puede fabricar una ficha falsa.
 */
function ficha(indice: number): string {
  return `<<${indice}>>`;
}

function formatoEnLinea(linea: string): string {
  const fichas: string[] = [];
  const guardar = (html: string): string => {
    fichas.push(html);
    return ficha(fichas.length - 1);
  };

  let salida = linea;

  // `código` — literal, no se le aplica ningún otro formato.
  salida = salida.replace(/`([^`]+)`/g, (_m, codigo: string) => guardar(`<code>${codigo}</code>`));

  // [texto](destino)
  salida = salida.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_m, texto: string, url: string) => guardar(pintarEnlace(texto, url)),
  );

  // **negrita** antes que *cursiva*: si no, los dos asteriscos se leen como una
  // cursiva vacía y el resultado es un `<em>` suelto.
  salida = salida.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  salida = salida.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  salida = salida.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // El guion bajo solo hace cursiva si delimita una palabra entera: en
  // "nombre_de_variable" no debe pasar nada.
  salida = salida.replace(/(^|\s)_([^_\n]+)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");

  return salida.replace(/<<(\d+)>>/g, (_m, i: string) => fichas[Number(i)] ?? "");
}

/* ──────────────────────────── bloques ──────────────────────────── */

/** `# `, `## `, `### ` → h2/h3/h4. El h1 es el título de la página, no el cuerpo. */
const NIVEL_TITULO: Record<number, string> = { 1: "h2", 2: "h3", 3: "h4" };

/**
 * Convierte el markdown ligero de una página en HTML listo para inyectar.
 *
 * Devuelve siempre HTML seguro: cada trozo de texto del original pasó por
 * `escaparHtml` antes de que se generara una sola etiqueta.
 */
export function markdownAHtml(fuente: string): string {
  if (!fuente || !fuente.trim()) return "";

  // El escape va aquí, sobre el documento entero y una sola vez. A partir de
  // esta línea, `<` ya no existe en el texto: solo lo pone este módulo.
  const texto = escaparHtml(fuente.replace(/\r\n?/g, "\n"));
  const lineas = texto.split("\n");

  const html: string[] = [];
  let parrafo: string[] = [];
  let cita: string[] = [];
  /** Lista abierta: "ul" | "ol" | null. */
  let lista: "ul" | "ol" | null = null;

  const cerrarParrafo = () => {
    if (parrafo.length === 0) return;
    // Un salto de línea suelto dentro de un párrafo se respeta: quien escribe
    // una dirección en tres líneas espera verlas en tres líneas.
    html.push(`<p>${parrafo.map(formatoEnLinea).join("<br />")}</p>`);
    parrafo = [];
  };
  const cerrarLista = () => {
    if (!lista) return;
    html.push(`</${lista}>`);
    lista = null;
  };
  const cerrarCita = () => {
    if (cita.length === 0) return;
    html.push(`<blockquote><p>${cita.map(formatoEnLinea).join("<br />")}</p></blockquote>`);
    cita = [];
  };
  const cerrarTodo = () => {
    cerrarParrafo();
    cerrarLista();
    cerrarCita();
  };

  for (const cruda of lineas) {
    const linea = cruda.trimEnd();

    if (!linea.trim()) {
      cerrarTodo();
      continue;
    }

    // Separador: --- o *** en una línea sola.
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(linea)) {
      cerrarTodo();
      html.push("<hr />");
      continue;
    }

    // Título.
    const titulo = /^(#{1,3})\s+(.*)$/.exec(linea);
    if (titulo) {
      cerrarTodo();
      const etiqueta = NIVEL_TITULO[titulo[1].length];
      html.push(`<${etiqueta}>${formatoEnLinea(titulo[2].trim())}</${etiqueta}>`);
      continue;
    }

    // Cita. El `>` del original ya viene escapado como `&gt;`, porque el escape
    // se hizo antes a propósito: aquí se busca lo que quedó, no el carácter.
    const citaLinea = /^\s*&gt;\s?(.*)$/.exec(linea);
    if (citaLinea) {
      cerrarParrafo();
      cerrarLista();
      cita.push(citaLinea[1]);
      continue;
    }

    // Lista sin orden.
    const punto = /^\s*[-*+]\s+(.*)$/.exec(linea);
    if (punto) {
      cerrarParrafo();
      cerrarCita();
      if (lista !== "ul") {
        cerrarLista();
        html.push("<ul>");
        lista = "ul";
      }
      html.push(`<li>${formatoEnLinea(punto[1])}</li>`);
      continue;
    }

    // Lista numerada.
    const numero = /^\s*\d+[.)]\s+(.*)$/.exec(linea);
    if (numero) {
      cerrarParrafo();
      cerrarCita();
      if (lista !== "ol") {
        cerrarLista();
        html.push("<ol>");
        lista = "ol";
      }
      html.push(`<li>${formatoEnLinea(numero[1])}</li>`);
      continue;
    }

    // Texto normal.
    cerrarLista();
    cerrarCita();
    parrafo.push(linea.trim());
  }

  cerrarTodo();
  return html.join("\n");
}

/* ──────────────────────────── texto plano ──────────────────────────── */

/**
 * El mismo contenido sin marcas, para la descripción SEO automática y para el
 * resumen de una fila de tabla. No devuelve HTML: se pinta como texto.
 */
export function textoPlano(fuente: string, maximo = 0): string {
  const limpio = (fuente || "")
    .replace(/\r\n?/g, "\n")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*&gt;\s?/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/[*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (maximo > 0 && limpio.length > maximo) {
    // Se corta por palabra: "Cambios y devolucio…" queda peor que una frase corta.
    const cortado = limpio.slice(0, maximo);
    const espacio = cortado.lastIndexOf(" ");
    return `${(espacio > maximo * 0.6 ? cortado.slice(0, espacio) : cortado).trimEnd()}…`;
  }
  return limpio;
}
