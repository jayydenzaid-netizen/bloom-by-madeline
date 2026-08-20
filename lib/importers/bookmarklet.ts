// Fabricación del bookmarklet que Madeline arrastra a su barra de marcadores.
//
// La fuente de verdad es `public/bookmarklet.js`: legible, comentada y servida tal
// cual en /bookmarklet.js para quien quiera auditar qué hace antes de instalarlo
// (razonable: es un script que se ejecuta dentro de páginas de terceros). Aquí solo
// se le quitan los comentarios, se sustituyen los tres marcadores por los valores
// de esta tienda y se empaqueta como URL `javascript:`.
//
// El token va DENTRO del marcador. Es la consecuencia de que el bookmarklet corra
// en el dominio del proveedor: allí la cookie de sesión del panel no existe, así
// que la única credencial posible es la que lleve el propio código.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { getOrCreateImportToken } from "@/lib/importers/pipeline";

export type BookmarkletBundle = {
  /** Código minificado, para enseñarlo o copiarlo. */
  code: string;
  /** `javascript:...` listo para el href del enlace arrastrable. */
  href: string;
  token: string;
  endpoint: string;
  panelUrl: string;
  bytes: number;
};

const SOURCE_FILE = path.join(process.cwd(), "public", "bookmarklet.js");

/**
 * Versión de emergencia. Solo entra en juego si `public/bookmarklet.js` no viajó
 * al despliegue (en serverless el rastreo de ficheros a veces deja fuera public/).
 * Hace lo mismo pero avisa con un alert() del navegador en vez de con el aviso
 * flotante: menos bonito, igual de funcional.
 */
const FALLBACK_SOURCE = `(function(){
  var ENDPOINT="__BLOOM_ENDPOINT__";var TOKEN="__BLOOM_TOKEN__";var PANEL="__BLOOM_PANEL__";
  var h=String(location.hostname).toLowerCase();
  var p=h.indexOf("alibaba.")!==-1?"alibaba":(h.indexOf("aliexpress.")!==-1?"aliexpress":"");
  if(!p){alert("Este marcador solo funciona en una ficha de AliExpress o Alibaba.");return;}
  var d={};try{if(window.runParams)d.runParams=window.runParams;}catch(e){}
  try{if(window._d_c_&&window._d_c_.DCData)d.dcData=window._d_c_.DCData;}catch(e){}
  try{if(window.detailData)d.detailData=window.detailData;}catch(e){}
  try{if(window.__NEXT_DATA__)d.nextData=window.__NEXT_DATA__;}catch(e){}
  var cuerpo;try{cuerpo=JSON.stringify({provider:p,url:location.href,token:TOKEN,data:d,html:document.documentElement.outerHTML});}catch(e){cuerpo=JSON.stringify({provider:p,url:location.href,token:TOKEN,data:{}});}
  fetch(ENDPOINT,{method:"POST",mode:"cors",credentials:"omit",headers:{"Content-Type":"text/plain;charset=UTF-8"},body:cuerpo})
    .then(function(r){return r.text();})
    .then(function(t){var j=null;try{j=JSON.parse(t);}catch(e){}
      if(j&&j.ok){if(confirm("Producto enviado a Bloom. Abrir el panel para revisarlo?"))window.open(j.reviewUrl||PANEL,"_blank");}
      else{alert("No se pudo importar: "+((j&&(j.error||j.hint))||t));}})
    .catch(function(e){alert("No se pudo contactar con la tienda: "+e);});
})();`;

/** Lee la fuente legible. Nunca lanza: si el fichero falta, entra el respaldo. */
export async function bookmarkletSource(): Promise<string> {
  try {
    const text = await readFile(SOURCE_FILE, "utf8");
    if (text && text.includes("__BLOOM_ENDPOINT__")) return text;
  } catch {
    // Sin fichero: respaldo.
  }
  return FALLBACK_SOURCE;
}

// ─────────────────────────────── minificado ───────────────────────────────

const ESPACIO_PEGABLE = new Set(["{", "}", "(", ")", "[", "]", ";", ",", ":"]);

/**
 * Quita comentarios y espacio sobrante sin romper las cadenas de texto.
 *
 * Es un tokenizador de tres estados (código / cadena / comentario) y NO entiende
 * expresiones regulares literales: por eso la fuente tiene prohibido usarlas. Se
 * acepta esa limitación a cambio de no meter un minificador de verdad como
 * dependencia para 200 líneas de script.
 */
export function minifyBookmarklet(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // Comentario de línea.
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    // Comentario de bloque.
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Cadenas: se copian intactas, con sus escapes.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = source[i];
        out += c;
        if (c === "\\") {
          if (i + 1 < n) out += source[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }
    // Espacio en blanco: se colapsa a uno solo.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      while (i < n && /\s/.test(source[i])) i++;
      if (out.length > 0) out += " ";
      continue;
    }

    out += ch;
    i++;
  }

  // Segunda pasada: fuera los espacios pegados a puntuación que nunca forma
  // operadores compuestos. Se deja en paz todo lo demás (un `a + + b` mal
  // colapsado se convertiría en `a++b`, que es otro programa).
  let compact = "";
  for (let k = 0; k < out.length; k++) {
    const ch = out[k];
    if (ch === " ") {
      const prev = compact[compact.length - 1];
      const next = out[k + 1];
      if (prev && next && (ESPACIO_PEGABLE.has(prev) || ESPACIO_PEGABLE.has(next))) continue;
      if (!prev || !next) continue;
    }
    compact += ch;
  }

  return compact.trim();
}

// ─────────────────────────────── el paquete ───────────────────────────────

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Sustituye los marcadores y devuelve código + href.
 *
 * `void 0` al final no es adorno: un `javascript:` que devuelve un valor hace que
 * el navegador sustituya la página entera por ese valor. Devolver undefined es lo
 * que mantiene la ficha del proveedor en su sitio.
 */
export function buildBookmarklet(input: { source: string; origin: string; token: string }): BookmarkletBundle {
  const origin = stripTrailingSlash(input.origin || "");
  const endpoint = `${origin}/api/import/ingest`;
  const panelUrl = `${origin}/admin/importar`;

  const code =
    minifyBookmarklet(input.source)
      .split("__BLOOM_ENDPOINT__")
      .join(endpoint)
      .split("__BLOOM_PANEL__")
      .join(panelUrl)
      .split("__BLOOM_TOKEN__")
      .join(input.token) + "void 0;";

  return {
    code,
    href: `javascript:${encodeURIComponent(code)}`,
    token: input.token,
    endpoint,
    panelUrl,
    bytes: Buffer.byteLength(code, "utf8"),
  };
}

/**
 * Lo que llama el panel: token de la tienda (creándolo la primera vez) + fuente.
 * `origin` sale de las cabeceras de la petición porque en desarrollo la tienda
 * vive en localhost:4590 y en producción en el dominio real, y el marcador tiene
 * que apuntar al que la usuaria esté usando.
 */
export async function getBookmarklet(origin: string): Promise<BookmarkletBundle> {
  const [source, token] = await Promise.all([bookmarkletSource(), getOrCreateImportToken()]);
  return buildBookmarklet({ source, origin, token });
}
