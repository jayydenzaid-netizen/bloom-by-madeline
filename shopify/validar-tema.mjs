// Validador del tema, sin depender de la CLI de Shopify.
//
// No pretende ser un `theme check` completo. Comprueba exactamente los ocho
// fallos que rompen un tema DE VERDAD y que no se ven leyendo el código:
//
//   1. `{% render 'x' %}` que apunta a un snippet que no existe
//   2. `{% section 'x' %}` / `{% sections 'x' %}` sin su fichero
//   3. una plantilla JSON que referencia un tipo de sección inexistente
//   4. `'algo.css' | asset_url` sin el recurso en assets/
//   5. `'clave' | t` sin la clave en locales/es.default.json
//   6. un `{% schema %}` que no es JSON válido
//   7. etiquetas Liquid sin cerrar (if/for/form/paginate/case…)
//   8. `settings.x` que no existe en settings_schema.json
//
// Los cuatro primeros producen una página en blanco o un error de Liquid en
// producción; el quinto, un «translation missing» delante de la clienta; el
// sexto impide subir el tema; el séptimo rompe el renderizado entero; el octavo
// deja huecos vacíos que nadie entiende.
//
//   node shopify/validar-tema.mjs

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const TEMA = path.join(process.cwd(), "shopify", "tema");

const problemas = [];
const avisos = [];

function fallo(fichero, mensaje) {
  problemas.push({ fichero, mensaje });
}
function aviso(fichero, mensaje) {
  avisos.push({ fichero, mensaje });
}

async function existe(ruta) {
  try {
    await stat(ruta);
    return true;
  } catch {
    return false;
  }
}

async function listar(carpeta) {
  try {
    return await readdir(path.join(TEMA, carpeta));
  } catch {
    return [];
  }
}

/** Todos los .liquid del tema, con su ruta relativa. */
async function ficherosLiquid() {
  const salida = [];
  for (const carpeta of ["layout", "sections", "snippets", "templates", "templates/customers"]) {
    for (const nombre of await listar(carpeta)) {
      if (nombre.endsWith(".liquid")) salida.push(`${carpeta}/${nombre}`);
    }
  }
  return salida;
}

/* ─────────────────── 6 · los bloques {% schema %} ─────────────────── */

/** Devuelve el schema ya parseado, o null. Registra el fallo si no es JSON. */
function leerSchema(relativa, contenido) {
  const inicio = contenido.indexOf("{% schema %}");
  if (inicio === -1) return null;

  const fin = contenido.indexOf("{% endschema %}", inicio);
  if (fin === -1) {
    fallo(relativa, "tiene {% schema %} sin {% endschema %}");
    return null;
  }

  const crudo = contenido.slice(inicio + "{% schema %}".length, fin).trim();
  try {
    return JSON.parse(crudo);
  } catch (error) {
    fallo(relativa, `el bloque {% schema %} no es JSON válido: ${error.message}`);
    return null;
  }
}

/* ─────────────────── 7 · equilibrio de etiquetas ─────────────────── */

const PAREJAS = [
  ["if", "endif"],
  ["unless", "endunless"],
  ["for", "endfor"],
  ["case", "endcase"],
  ["form", "endform"],
  ["paginate", "endpaginate"],
  ["capture", "endcapture"],
  ["comment", "endcomment"],
  ["tablerow", "endtablerow"],
  ["raw", "endraw"],
  ["javascript", "endjavascript"],
  ["stylesheet", "endstylesheet"],
  ["schema", "endschema"],
  ["liquid", null],
];

function comprobarEquilibrio(relativa, contenido) {
  // Los comentarios se quitan primero: dentro puede haber ejemplos con
  // etiquetas que descuadrarían la cuenta.
  const limpio = contenido.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");

  for (const [abre, cierra] of PAREJAS) {
    if (!cierra) continue;
    if (abre === "comment") continue; // ya se quitaron

    const reAbre = new RegExp(`\\{%-?\\s*${abre}[\\s%]`, "g");
    const reCierra = new RegExp(`\\{%-?\\s*${cierra}\\s*-?%\\}`, "g");

    const nAbre = (limpio.match(reAbre) || []).length;
    const nCierra = (limpio.match(reCierra) || []).length;

    if (nAbre !== nCierra) {
      fallo(relativa, `${abre}/${cierra} descuadrado: ${nAbre} abre, ${nCierra} cierra`);
    }
  }
}

/* ─────────────────── recolección de referencias ─────────────────── */

function extraer(contenido, expresion, grupo = 1) {
  const salida = new Set();
  let m;
  const re = new RegExp(expresion.source, expresion.flags.includes("g") ? expresion.flags : expresion.flags + "g");
  while ((m = re.exec(contenido)) !== null) {
    if (m[grupo]) salida.add(m[grupo]);
  }
  return salida;
}

/* ─────────────────── 5 · claves de traducción ─────────────────── */

function aplanar(objeto, prefijo = "", salida = new Set()) {
  for (const [clave, valor] of Object.entries(objeto)) {
    const completa = prefijo ? `${prefijo}.${clave}` : clave;
    if (valor && typeof valor === "object" && !Array.isArray(valor)) {
      // Un objeto con `one`/`other` es una forma plural, no un nivel más.
      if ("one" in valor || "other" in valor || "zero" in valor) {
        salida.add(completa);
      } else {
        aplanar(valor, completa, salida);
      }
    } else {
      salida.add(completa);
    }
  }
  return salida;
}

/* ─────────────────────────── principal ─────────────────────────── */

async function principal() {
  console.log("\nValidando el tema de Bloom");
  console.log("─".repeat(58));

  if (!(await existe(TEMA))) {
    console.error(`\nNo encuentro el tema en ${TEMA}\n`);
    process.exitCode = 1;
    return;
  }

  const snippets = new Set((await listar("snippets")).map((f) => f.replace(/\.liquid$/, "")));
  const secciones = new Set(
    (await listar("sections")).filter((f) => f.endsWith(".liquid")).map((f) => f.replace(/\.liquid$/, "")),
  );
  const grupos = new Set(
    (await listar("sections")).filter((f) => f.endsWith("-group.json")).map((f) => f.replace(/-group\.json$/, "")),
  );
  const recursos = new Set(await listar("assets"));

  // Claves de traducción disponibles.
  let claves = new Set();
  try {
    const locale = JSON.parse(await readFile(path.join(TEMA, "locales", "es.default.json"), "utf8"));
    claves = aplanar(locale);
  } catch (error) {
    fallo("locales/es.default.json", `no se pudo leer: ${error.message}`);
  }

  // Ajustes globales disponibles.
  const ajustes = new Set();
  try {
    const esquema = JSON.parse(await readFile(path.join(TEMA, "config", "settings_schema.json"), "utf8"));
    for (const grupo of esquema) {
      for (const ajuste of grupo.settings || []) {
        if (ajuste.id) ajustes.add(ajuste.id);
      }
    }
  } catch (error) {
    fallo("config/settings_schema.json", `no se pudo leer: ${error.message}`);
  }

  /* ── recorrer cada .liquid ── */
  const liquids = await ficherosLiquid();
  for (const relativa of liquids) {
    const contenido = await readFile(path.join(TEMA, relativa), "utf8");

    comprobarEquilibrio(relativa, contenido);
    const esquemaSeccion = leerSchema(relativa, contenido);

    // 1 · render
    for (const nombre of extraer(contenido, /\{%-?\s*render\s+'([^']+)'/g)) {
      if (!snippets.has(nombre)) fallo(relativa, `render '${nombre}' — no existe snippets/${nombre}.liquid`);
    }

    // 2 · section / sections
    for (const nombre of extraer(contenido, /\{%-?\s*section\s+'([^']+)'/g)) {
      if (!secciones.has(nombre)) fallo(relativa, `section '${nombre}' — no existe sections/${nombre}.liquid`);
    }
    for (const nombre of extraer(contenido, /\{%-?\s*sections\s+'([^']+)-group'/g)) {
      if (!grupos.has(nombre)) fallo(relativa, `sections '${nombre}-group' — no existe sections/${nombre}-group.json`);
    }

    // 4 · asset_url
    for (const nombre of extraer(contenido, /'([^']+\.(?:css|js|jpg|jpeg|png|svg|webp|woff2?))'\s*\|\s*asset_url/g)) {
      if (!recursos.has(nombre)) fallo(relativa, `asset_url '${nombre}' — no está en assets/`);
    }

    // 5 · traducciones
    for (const clave of extraer(contenido, /'([a-z_]+\.[a-z0-9_.]+)'\s*\|\s*t\b/g)) {
      if (claves.size && !claves.has(clave)) fallo(relativa, `traducción '${clave}' — no está en locales/es.default.json`);
    }

    // 8 · settings globales.
    //
    // La mirada atrás es lo que separa `settings.x` (ajuste global del tema) de
    // `section.settings.x` y `bloque.settings.x`, que son de otro sitio. Sin ella
    // el validador acusa de «no declarado» a cada ajuste de cada sección.
    for (const id of extraer(contenido, /(?<![.\w])settings\.([a-z0-9_]+)/g)) {
      if (ajustes.size && !ajustes.has(id)) {
        fallo(relativa, `settings.${id} — no está declarado en config/settings_schema.json`);
      }
    }

    // 8b · section.settings y los ajustes de cada bloque
    if (esquemaSeccion) {
      const propios = new Set((esquemaSeccion.settings || []).map((s) => s.id).filter(Boolean));
      for (const id of extraer(contenido, /\bsection\.settings\.([a-z0-9_]+)/g)) {
        if (!propios.has(id)) fallo(relativa, `section.settings.${id} — no está en su {% schema %}`);
      }

      // Los ajustes de bloque valen si CUALQUIER tipo de bloque los declara: la
      // plantilla no sabe qué tipo le va a tocar en cada vuelta del bucle.
      const idsDeBloque = new Set();
      for (const bloque of esquemaSeccion.blocks || []) {
        for (const ajuste of bloque.settings || []) {
          if (ajuste.id) idsDeBloque.add(ajuste.id);
        }
      }
      for (const id of extraer(contenido, /\b(?:bloque|block)\.settings\.([a-z0-9_]+)/g)) {
        if (!idsDeBloque.has(id)) {
          fallo(relativa, `bloque.settings.${id} — ningún tipo de bloque lo declara en su {% schema %}`);
        }
      }

      const tiposBloque = new Set((esquemaSeccion.blocks || []).map((b) => b.type));
      for (const preset of esquemaSeccion.presets || []) {
        for (const bloque of preset.blocks || []) {
          if (!tiposBloque.has(bloque.type)) {
            fallo(relativa, `el preset usa el bloque '${bloque.type}', que no está declarado en blocks`);
          }
        }
      }
    }
  }

  /* ── 3 · plantillas JSON ── */
  for (const carpeta of ["templates", "sections"]) {
    for (const nombre of await listar(carpeta)) {
      if (!nombre.endsWith(".json")) continue;
      const relativa = `${carpeta}/${nombre}`;

      let datos;
      try {
        datos = JSON.parse(await readFile(path.join(TEMA, carpeta, nombre), "utf8"));
      } catch (error) {
        fallo(relativa, `no es JSON válido: ${error.message}`);
        continue;
      }

      for (const [id, seccion] of Object.entries(datos.sections || {})) {
        if (!seccion.type) {
          fallo(relativa, `la sección '${id}' no declara type`);
          continue;
        }
        if (!secciones.has(seccion.type)) {
          fallo(relativa, `la sección '${id}' usa type '${seccion.type}', que no existe en sections/`);
        }
      }

      for (const id of datos.order || []) {
        if (!(datos.sections || {})[id]) {
          fallo(relativa, `order menciona '${id}', que no está en sections`);
        }
      }
    }
  }

  /* ── ficheros que Shopify espera ── */
  const OBLIGATORIOS = [
    "layout/theme.liquid",
    "config/settings_schema.json",
    "templates/index.json",
    "templates/product.json",
    "templates/collection.json",
    "templates/cart.json",
    "templates/page.json",
    "templates/404.json",
    "templates/search.json",
    "templates/list-collections.json",
    "templates/blog.json",
    "templates/article.json",
  ];
  for (const relativa of OBLIGATORIOS) {
    if (!(await existe(path.join(TEMA, relativa)))) fallo(relativa, "falta, y Shopify lo espera");
  }

  // El CSS generado: si falta, el tema se sube y se ve sin estilo ninguno.
  if (!recursos.has("bloom.css")) {
    fallo("assets/bloom.css", "no está — ejecuta antes: node shopify/construir-tema.mjs");
  }

  // Traducciones declaradas y nunca usadas: no rompen, pero delatan un cambio a medias.
  const usadas = new Set();
  for (const relativa of liquids) {
    const contenido = await readFile(path.join(TEMA, relativa), "utf8");
    for (const clave of extraer(contenido, /'([a-z_]+\.[a-z0-9_.]+)'\s*\|\s*t\b/g)) usadas.add(clave);
  }
  const sinUsar = [...claves].filter((c) => !usadas.has(c));
  if (sinUsar.length) {
    aviso("locales/es.default.json", `${sinUsar.length} claves declaradas y sin usar: ${sinUsar.join(", ")}`);
  }

  /* ── informe ── */
  console.log(`\n  ${liquids.length} ficheros Liquid · ${secciones.size} secciones · ${snippets.size} snippets · ${recursos.size} recursos`);

  if (avisos.length) {
    console.log(`\n  Avisos (${avisos.length}):`);
    for (const a of avisos) console.log(`    · ${a.fichero}: ${a.mensaje}`);
  }

  if (problemas.length) {
    console.log(`\n  FALLOS (${problemas.length}):`);
    for (const p of problemas) console.log(`    ✗ ${p.fichero}: ${p.mensaje}`);
    console.log("");
    process.exitCode = 1;
    return;
  }

  console.log("\n  Sin fallos. El tema se puede subir.\n");
}

principal().catch((error) => {
  console.error(`\nError del validador: ${error.message}\n`);
  process.exitCode = 1;
});
