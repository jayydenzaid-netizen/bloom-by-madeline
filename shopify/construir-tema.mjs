// Ensambla el tema de Shopify a partir del sitio actual.
//
// El tema NO reescribe el diseño de Bloom: lo REUTILIZA. El CSS que está hoy en
// producción se pulió durante meses y es la identidad de la marca, así que aquí
// se concatena tal cual en `assets/bloom.css` en vez de traducirse a mano — una
// traducción a ojo es exactamente donde se pierden los detalles (los radios
// «pétalo», el grano de fondo, el ritmo del nth-child) que hacen que se vea como
// se ve.
//
// Lo que sí es nuevo vive aparte, en `assets/bloom-shopify.css`: lo que Shopify
// necesita y el sitio actual no tenía (paginación, página de carrito nativa,
// cursivas de los campos de texto enriquecido del editor de temas).
//
// Y las fotos de la boutique viajan como recursos del tema para que, recién
// instalado, se vea la tienda de verdad y no cuadros grises.
//
//   node shopify/construir-tema.mjs           ensambla
//   node shopify/construir-tema.mjs --zip     ensambla y empaqueta para subir

import { readFile, writeFile, mkdir, copyFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { empaquetarCarpeta } from "./lib/zip.mjs";

const RAIZ = process.cwd();
const TEMA = path.join(RAIZ, "shopify", "tema");

/**
 * Las hojas del sitio actual, EN ORDEN. El orden es el mismo con el que las
 * carga Next: globals define el sistema y las demás lo especializan. Cambiarlo
 * rompe cascadas reales (por ejemplo `.product` de shop.css afina lo que
 * globals.css ya declaró).
 */
const HOJAS = [
  { fichero: "app/globals.css", que: "La identidad: tipos, color, nav, hero, secciones, pie, rejilla de producto" },
  { fichero: "app/(shop)/shop.css", que: "Tarjeta de producto, cajón del carrito, botón de añadir" },
  { fichero: "app/(shop)/home.css", que: "Telón de marca y tarjetas de inspiración" },
  { fichero: "app/(shop)/catalogo.css", que: "Ficha de producto y filtros del catálogo" },
  { fichero: "app/(shop)/resenas.css", que: "Reseñas" },
  { fichero: "app/(shop)/checkout.css", que: "Página de carrito (.cp-*). El checkout en sí lo pinta Shopify" },
];

/** Fotos del sitio que viajan con el tema para que se vea bien al instalarlo. */
const FOTOS = [
  "boutique-interior.jpg",
  "logo-profile.jpg",
  "og.jpg",
  "post-02-tendencia.jpg",
  "post-03-vestido-negro-olivo.jpg",
  "post-05-vestido-blanco.jpg",
  "post-08-look-perfecto.jpg",
  "post-09-coleccion-exclusiva.jpg",
  "post-10-vestido-orange.jpg",
  "post-12-vestido-coral.jpg",
];

async function existe(ruta) {
  try {
    await stat(ruta);
    return true;
  } catch {
    return false;
  }
}

async function construirCss() {
  const trozos = [
    `/* ══════════════════════════════════════════════════════════════════════`,
    `   BLOOM BY MADELINE — hoja de estilo del tema de Shopify`,
    ``,
    `   GENERADO. No editar a mano: lo sobrescribe \`node shopify/construir-tema.mjs\`.`,
    `   La fuente son las hojas del sitio Next, que siguen siendo la única verdad`,
    `   del diseño. Lo específico de Shopify va en bloom-shopify.css.`,
    `   ══════════════════════════════════════════════════════════════════════ */`,
    ``,
  ];

  let total = 0;
  for (const hoja of HOJAS) {
    const ruta = path.join(RAIZ, hoja.fichero);
    if (!(await existe(ruta))) {
      console.log(`  ! falta ${hoja.fichero} — se salta`);
      continue;
    }
    const css = await readFile(ruta, "utf8");
    total += css.length;
    trozos.push(
      ``,
      `/* ─────────────────────────────────────────────────────────────────────`,
      `   ${hoja.fichero}`,
      `   ${hoja.que}`,
      `   ───────────────────────────────────────────────────────────────────── */`,
      ``,
      css.trim(),
      ``,
    );
    console.log(`  · ${hoja.fichero} (${Math.round(css.length / 1024)} KB)`);
  }

  const salida = path.join(TEMA, "assets", "bloom.css");
  await writeFile(salida, trozos.join("\n"), "utf8");
  console.log(`\n  bloom.css: ${Math.round(total / 1024)} KB de CSS portado`);
}

async function copiarFotos() {
  const origen = path.join(RAIZ, "public", "assets");
  if (!(await existe(origen))) {
    console.log("  ! no hay public/assets: el tema se instalará sin fotos de ejemplo");
    return;
  }

  let copiadas = 0;
  for (const foto of FOTOS) {
    const de = path.join(origen, foto);
    if (!(await existe(de))) continue;
    await copyFile(de, path.join(TEMA, "assets", foto));
    copiadas++;
  }
  console.log(`  ${copiadas} fotos copiadas a assets/`);
}

/** Cuenta lo que hay, para poder decir de un vistazo si el tema está completo. */
async function inventario() {
  const carpetas = ["layout", "templates", "sections", "snippets", "assets", "config", "locales"];
  const filas = [];
  for (const carpeta of carpetas) {
    const ruta = path.join(TEMA, carpeta);
    if (!(await existe(ruta))) {
      filas.push(`  ${carpeta.padEnd(12)} FALTA`);
      continue;
    }
    const entradas = await readdir(ruta, { recursive: true, withFileTypes: true });
    const ficheros = entradas.filter((e) => e.isFile()).length;
    filas.push(`  ${carpeta.padEnd(12)} ${ficheros}`);
  }
  console.log(filas.join("\n"));
}

/**
 * Empaqueta en .zip para subirlo desde el panel (Tienda online → Temas →
 * Añadir tema → Subir archivo ZIP).
 *
 * NO se usa `Compress-Archive` de PowerShell: en Windows PowerShell 5.1 escribe
 * los nombres de entrada con barra invertida, y eso rompe la subida a Shopify.
 * El empaquetador propio (shopify/lib/zip.mjs) escribe barras normales y deja el
 * contenido colgando de la raíz, que es como Shopify lo espera.
 */
async function empaquetar() {
  const destino = path.join(RAIZ, "shopify", "tema-bloom.zip");
  const resultado = await empaquetarCarpeta(TEMA, destino);

  const ahorro = Math.round((1 - resultado.bytes / resultado.bytesOriginales) * 100);
  console.log(`\n  tema-bloom.zip · ${Math.round(resultado.bytes / 1024)} KB · ${resultado.ficheros} ficheros (−${ahorro}%)`);
  console.log(`  ${destino}`);
}

async function principal() {
  console.log("\nConstruyendo el tema de Bloom para Shopify");
  console.log("─".repeat(58));

  await mkdir(path.join(TEMA, "assets"), { recursive: true });

  console.log("\nCSS portado del sitio actual:");
  await construirCss();

  console.log("\nFotos:");
  await copiarFotos();

  console.log("\nInventario del tema:");
  await inventario();

  if (process.argv.includes("--zip")) {
    console.log("\nEmpaquetando:");
    await empaquetar();
    console.log("\n  Súbelo en: Tienda online → Temas → Añadir tema → Subir archivo ZIP");
  } else {
    console.log("\n  Añade --zip para empaquetarlo y poder subirlo al panel.");
  }

  console.log("");
}

principal().catch((error) => {
  console.error(`\nError: ${error.message}\n`);
  process.exitCode = 1;
});
