// Prueba visual de la hoja de estilo del tema.
//
// QUÉ COMPRUEBA Y QUÉ NO — importa entenderlo antes de fiarse del resultado:
//
//   SÍ: que `assets/bloom.css` sobrevivió a la concatenación. Que las tres
//       tipografías cargan, que las variables de color existen, que los marcos
//       «pétalo» tienen su radio, que la rejilla de producto alterna, que los
//       botones y los chips se ven como en la web actual.
//
//   NO: que el Liquid del tema produzca el HTML correcto. Eso solo lo puede
//       decir Shopify renderizando el tema de verdad, y para eso hay que
//       subirlo. Este script no sustituye a esa comprobación.
//
// Se usa Chrome de verdad con puppeteer-core, que es lo que en este equipo da la
// verdad visual (el panel del navegador integrado no la da).
//
//   node shopify/vista-previa.mjs

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const RAIZ = process.cwd();
const TEMA = path.join(RAIZ, "shopify", "tema");
const SALIDA = path.join(RAIZ, "shopify", "vista-previa");

/**
 * La página de prueba usa las MISMAS clases que las secciones del tema. No es un
 * diseño nuevo: es un muestrario de los componentes que el CSS portado tiene que
 * saber pintar. Si algo aquí se ve mal, se verá mal en la tienda.
 */
function paginaDePrueba() {
  const producto = (titulo, meta, precio, tachado, bandera) => `
      <a class="product" href="#">
        <figure>
          <img src="../tema/assets/post-03-vestido-negro-olivo.jpg" alt="${titulo}" loading="lazy">
          ${bandera ? `<span class="pc-flag${bandera === "Rebaja" ? " pc-flag-sale" : ""}">${bandera}</span>` : ""}
          <figcaption><span>Ver la pieza</span></figcaption>
        </figure>
        <h3>${titulo}</h3>
        <p class="product-meta">${meta}</p>
        <p class="pc-price">
          <strong>${precio}</strong>
          ${tachado ? `<s>${tachado}</s>` : ""}
        </p>
      </a>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prueba visual · tema Bloom</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Jost:wght@300;400;500&family=Allura&display=swap">
<link rel="stylesheet" href="../tema/assets/bloom.css">
<link rel="stylesheet" href="../tema/assets/bloom-shopify.css">
</head>
<body>

<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <g id="lotus" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none">
    <path d="M60 88 C51 62 51.5 34 60 12 C68.5 34 69 62 60 88 Z"/>
    <path d="M60 88 C40 70 33 44 42 20 C56 36 61 62 60 88 Z"/>
    <path d="M60 88 C80 70 87 44 78 20 C64 36 59 62 60 88 Z"/>
    <path d="M60 88 C34 82 15 62 13 34 C36 42 54 62 60 88 Z"/>
    <path d="M60 88 C86 82 105 62 107 34 C84 42 66 62 60 88 Z"/>
    <path d="M60 88 C48 66 45 46 50 28" stroke-width="1.4" opacity=".55"/>
    <path d="M60 88 C72 66 75 46 70 28" stroke-width="1.4" opacity=".55"/>
    <path d="M18 95 C44 103 80 101 104 90" stroke-width="1.6" opacity=".8"/>
  </g>
</defs></svg>

<header class="nav scrolled" id="nav">
  <a class="nav-brand" href="#">
    <svg class="brand-lotus" viewBox="0 0 120 104" aria-hidden="true"><use href="#lotus"/></svg>
    <span class="brand-text">
      <span class="brand-bloom">BLOOM</span>
      <span class="brand-by"><em>by</em> MADELINE</span>
    </span>
  </a>
  <nav class="nav-links">
    <a href="#">Tienda</a><a href="#">Colecciones</a><a href="#">La boutique</a><a href="#">Visítanos</a>
  </nav>
  <div class="nav-actions">
    <a class="btn btn-ink btn-sm" href="#">Pedir por DM</a>
    <a class="cart-btn" href="#">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 8V6.5a4 4 0 0 1 8 0V8"/>
        <path d="M4.8 8h14.4l-1.1 11.1a2 2 0 0 1-2 1.9H7.9a2 2 0 0 1-2-1.9L4.8 8z"/>
      </svg>
      <span class="cart-count">3</span>
    </a>
  </div>
</header>

<main style="padding-top: var(--nav-h)">

<section class="section">
  <div class="section-head">
    <div>
      <p class="overline in reveal">Prueba visual del tema</p>
      <h2 class="in reveal">La <em>identidad</em> sobrevivió</h2>
    </div>
    <p class="section-note in reveal">Cada bloque de esta página usa las mismas clases que las secciones del tema. Si aquí se ve bien, el CSS portado está entero.</p>
  </div>

  <h3 style="margin:34px 0 14px;letter-spacing:.2em;font-size:12px;text-transform:uppercase;color:var(--stone)">Botones</h3>
  <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
    <a class="btn btn-ink" href="#">Añadir al carrito</a>
    <a class="btn btn-ghost" href="#">Ver la tienda</a>
    <a class="btn btn-ink btn-sm" href="#">Pedir por DM</a>
  </div>

  <h3 style="margin:40px 0 14px;letter-spacing:.2em;font-size:12px;text-transform:uppercase;color:var(--stone)">Chips de talla (label + radio oculto)</h3>
  <div class="lb-tallas">
    <input class="visualmente-oculto" type="radio" name="talla" id="t-s" checked>
    <label class="talla-chip" for="t-s">S</label>
    <input class="visualmente-oculto" type="radio" name="talla" id="t-m">
    <label class="talla-chip" for="t-m">M</label>
    <input class="visualmente-oculto" type="radio" name="talla" id="t-l">
    <label class="talla-chip" for="t-l">L</label>
    <input class="visualmente-oculto" type="radio" name="talla" id="t-xl" disabled>
    <label class="talla-chip" for="t-xl">XL</label>
  </div>

  <h3 style="margin:40px 0 14px;letter-spacing:.2em;font-size:12px;text-transform:uppercase;color:var(--stone)">Rejilla de producto (el marco «pétalo» alterna)</h3>
  <div class="product-grid">
    ${producto("Vestido Amapola", "Negro · Lunares — S / M / L", "$54.99", "", "")}
    ${producto("Blusa Magnolia", "Crema — S / M", "$38.99", "$52.00", "Rebaja")}
    ${producto("Set Dalia", "Oliva — M / L", "$72.99", "", "Agotado")}
    ${producto("Falda Jazmín", "Camel — S / M / L", "$44.99", "", "")}
  </div>
</section>

<section class="quote">
  <svg class="quote-lotus in reveal" viewBox="0 0 120 104" aria-hidden="true"><use href="#lotus"/></svg>
  <blockquote class="in reveal">« Cada prenda cuenta una historia…<br><em class="serif-it">haz que la tuya brille con estilo.</em> »</blockquote>
</section>

<section class="section filosofia">
  <div class="filosofia-grid">
    <div class="filosofia-copy">
      <p class="overline overline-light in reveal">02 — Nuestra Filosofía</p>
      <h2 class="in reveal">Vestir con <em class="serif-it">intención</em></h2>
      <p class="filosofia-sub in reveal">(No es moda… es presencia.)</p>
      <p class="filosofia-text in reveal">Sección oscura: aquí se comprueba que el texto claro sobre tinta conserva el contraste y que el antetítulo usa la variante clara.</p>
    </div>
    <ol class="filosofia-list">
      <li class="in reveal"><span>01</span>Coherencia</li>
      <li class="in reveal"><span>02</span>Identidad</li>
      <li class="in reveal"><span>03</span>Presencia</li>
      <li class="in reveal"><span>04</span>Intención</li>
    </ol>
  </div>
</section>

<section class="section como-comprar">
  <div class="section-head">
    <div>
      <p class="overline in reveal">04 — Cómo Comprar</p>
      <h2 class="in reveal">Tan fácil como <em class="serif-it">enamorarse</em></h2>
    </div>
  </div>
  <div class="pasos">
    <div class="paso in reveal">
      <svg class="paso-lotus" viewBox="0 0 120 104" aria-hidden="true"><use href="#lotus"/></svg>
      <span class="paso-num">01</span><h3>Visítanos en la boutique</h3>
      <p>1305 Grand Blvd, Hamilton, OH 45011.</p>
    </div>
    <div class="paso in reveal">
      <svg class="paso-lotus" viewBox="0 0 120 104" aria-hidden="true"><use href="#lotus"/></svg>
      <span class="paso-num">02</span><h3>O pide por Instagram DM</h3>
      <p>Mándanos la foto y tu talla.</p>
    </div>
    <div class="paso in reveal">
      <svg class="paso-lotus" viewBox="0 0 120 104" aria-hidden="true"><use href="#lotus"/></svg>
      <span class="paso-num">03</span><h3>Envíos a todo USA</h3>
      <p>Tu look llega hasta tu puerta.</p>
    </div>
  </div>
</section>

<section class="section">
  <h3 style="margin-bottom:14px;letter-spacing:.2em;font-size:12px;text-transform:uppercase;color:var(--stone)">Texto enriquecido del panel (.rte)</h3>
  <div class="pagina-cuerpo rte">
    <h2>Política de devoluciones</h2>
    <p>Este bloque llega como HTML desde el panel de Shopify. Aquí se comprueba que tiene ritmo tipográfico y no se lee como un muro.</p>
    <ul><li>Cambios en 14 días</li><li>La prenda debe conservar su etiqueta</li><li>Los envíos de vuelta corren por cuenta de la clienta</li></ul>
    <blockquote>Si algo no te queda como esperabas, escríbenos y lo resolvemos.</blockquote>
  </div>
</section>

</main>

<footer class="footer">
  <div class="footer-brand">
    <svg class="footer-lotus" viewBox="0 0 120 104" aria-hidden="true"><use href="#lotus"/></svg>
    <p class="footer-bloom">B&thinsp;L&thinsp;O&thinsp;O&thinsp;M</p>
    <p class="footer-by"><em>by</em> MADELINE</p>
  </div>
  <div class="footer-cols footer-cols-4">
    <div><h4>Visítanos</h4><p>1305 Grand Blvd, Hamilton, OH 45011<br>Jueves a sábado · 1:00 – 8:00 PM</p></div>
    <div><h4>Síguenos</h4><p><a href="#">Instagram — @bloombymadelin</a><br><a href="#">Pedidos por DM</a></p></div>
    <div><h4>Tienda</h4><p><a href="#">Toda la tienda</a><br><a href="#">Nuevas llegadas</a></p></div>
    <div><h4>Información</h4><p><a href="#">Devoluciones</a><br><a href="#">Envíos</a></p></div>
  </div>
  <div class="footer-bottom">
    <p>© 2026 Bloom by Madeline · Hamilton, Ohio</p>
    <p class="footer-tag">Tendencias exclusivas · Elevamos tu estilo casual elegante</p>
  </div>
</footer>

</body></html>`;
}

/* ─────────────────── comprobaciones sobre el CSS ─────────────────── */

/**
 * Lo que TIENE que estar dentro de bloom.css. Si la concatenación se hubiera
 * truncado o hubiera perdido un fichero, alguna de estas desaparecería, y el
 * síntoma en la tienda sería «se ve raro» sin más pistas.
 */
const IMPRESCINDIBLES = [
  { que: "--bone", donde: "la paleta champán" },
  { que: "--clay", donde: "el burdeos de la marca" },
  { que: "--petal", donde: "los marcos asimétricos" },
  { que: "Cormorant Garamond", donde: "la serif de los titulares" },
  { que: "Allura", donde: "la manuscrita del «by»" },
  { que: ".product-grid", donde: "la rejilla del catálogo" },
  { que: ".hero-arch", donde: "el hero" },
  { que: ".footer-bloom", donde: "el pie" },
  { que: ".talla-chip", donde: "los chips de talla" },
  { que: ".cat-filtros", donde: "los filtros del catálogo" },
  { que: ".cp-lines", donde: "la página de carrito" },
  { que: ".rs-card", donde: "las reseñas" },
];

async function comprobarCss() {
  const css = await readFile(path.join(TEMA, "assets", "bloom.css"), "utf8");
  const faltan = IMPRESCINDIBLES.filter((x) => !css.includes(x.que));

  console.log(`  bloom.css: ${Math.round(css.length / 1024)} KB`);
  if (faltan.length) {
    for (const f of faltan) console.log(`    ✗ falta «${f.que}» — ${f.donde}`);
    return false;
  }
  console.log(`    ✓ las ${IMPRESCINDIBLES.length} piezas clave del diseño están`);
  return true;
}

/* ─────────────────────────── principal ─────────────────────────── */

async function principal() {
  console.log("\nPrueba visual del tema de Bloom");
  console.log("─".repeat(58));
  console.log("");

  const cssOk = await comprobarCss();

  await mkdir(SALIDA, { recursive: true });
  const ficheroHtml = path.join(SALIDA, "muestrario.html");
  await writeFile(ficheroHtml, paginaDePrueba(), "utf8");
  console.log(`\n  muestrario: ${ficheroHtml}`);

  let navegador;
  try {
    navegador = await puppeteer.launch({
      executablePath: CHROME,
      headless: "new",
      args: ["--allow-file-access-from-files", "--hide-scrollbars"],
    });
  } catch (error) {
    console.log(`\n  No se pudo abrir Chrome: ${error.message}`);
    console.log(`  Abre a mano el muestrario para verlo.`);
    if (!cssOk) process.exitCode = 1;
    return;
  }

  const pagina = await navegador.newPage();
  const erroresConsola = [];
  pagina.on("pageerror", (e) => erroresConsola.push(String(e)));

  const capturas = [
    { nombre: "escritorio", ancho: 1440, alto: 1000 },
    { nombre: "movil", ancho: 390, alto: 844 },
  ];

  for (const captura of capturas) {
    await pagina.setViewport({ width: captura.ancho, height: captura.alto, deviceScaleFactor: 2 });
    await pagina.goto(pathToFileURL(ficheroHtml).href, { waitUntil: "networkidle0" });
    // Las fuentes de Google llegan por red: sin esperarlas, la captura sale con
    // la tipografía de reserva y no prueba nada de lo que se quería probar.
    await pagina.evaluate(() => document.fonts.ready);

    const destino = path.join(SALIDA, `${captura.nombre}.png`);
    await pagina.screenshot({ path: destino, fullPage: true });
    console.log(`  captura ${captura.nombre}: ${destino}`);
  }

  // ¿Cargaron de verdad las tres familias? Es la comprobación que separa «se ve
  // parecido» de «es la identidad de la marca».
  const fuentes = await pagina.evaluate(() => {
    const familias = ["Cormorant Garamond", "Jost", "Allura"];
    return familias.map((f) => ({ familia: f, cargada: document.fonts.check(`16px "${f}"`) }));
  });

  console.log("");
  let fuentesOk = true;
  for (const f of fuentes) {
    console.log(`  ${f.cargada ? "✓" : "✗"} ${f.familia}`);
    if (!f.cargada) fuentesOk = false;
  }

  if (erroresConsola.length) {
    console.log(`\n  Errores en la página: ${erroresConsola.length}`);
    for (const e of erroresConsola.slice(0, 5)) console.log(`    · ${e}`);
  }

  await navegador.close();

  console.log("");
  if (cssOk && fuentesOk) {
    console.log("  La hoja de estilo del tema está entera.");
    console.log("  OJO: esto prueba el CSS, no el Liquid. Para eso hay que subir el tema.\n");
  } else {
    console.log("  Hay algo que revisar arriba.\n");
    process.exitCode = 1;
  }
}

principal().catch((error) => {
  console.error(`\nError: ${error.message}\n`);
  process.exitCode = 1;
});
