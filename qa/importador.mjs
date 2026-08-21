// Auditoría del importador de Bloom, con clics de verdad.
//
// Por qué existe: el fallo que destapó todo esto ("error 404 al importar") no se
// veía leyendo el código de una en una — se veía recorriendo el flujo entero y
// pulsando cada botón que la pantalla ofrece DESPUÉS de publicar. Este arnés hace
// justo eso: entra al panel con Chrome real, importa un producto por HTML, lo
// publica, y luego comprueba el HTTP de cada enlace que aparece.
//
// No repara nada. Solo mide y cuenta lo que pasa.
//
// Uso:
//   node qa/importador.mjs                       -> todo, contra localhost:4652
//   node qa/importador.mjs --base=http://...     -> otro servidor
//   node qa/importador.mjs --only=api            -> solo los bloques indicados
//   node qa/importador.mjs --limpiar             -> borra lo que dejó la última pasada
//
// Bloques: pestanas, html, publicar, duplicado, csv, api, historial, romper

import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const BASE = flag("base", "http://localhost:4652");
const EMAIL = flag("email", "madeline@bloombymadeline.com");
const PASSWORD = flag("password", "bloom2026");
const only = flag("only", "");
const BLOQUES = only ? only.split(",").map((s) => s.trim()) : null;
const activo = (bloque) => !BLOQUES || BLOQUES.includes(bloque);

const db = new PrismaClient();

/* ─────────────────────────── libreta de resultados ─────────────────────────── */

const FILAS = [];
function anotar(paso, hice, esperaba, ocurrio, veredicto) {
  FILAS.push({ paso, hice, esperaba, ocurrio, veredicto });
  const icono = veredicto === "OK" ? "  OK  " : veredicto === "ROTO" ? " ROTO " : " MEJ. ";
  console.log(`[${icono}] ${paso}\n         ${ocurrio}`);
}

/* ────────────────────────────── fixture de AliExpress ──────────────────────────────
   Copiado de tests/aliexpress.test.ts: es el estado que AliExpress deja en
   window.runParams, con los seis módulos que el adaptador sabe leer. */

const RUN_PARAMS_STATE = {
  data: {
    actionModule: { productId: 1005006543210987, itemStatus: 0 },
    titleModule: { subject: "Vestido midi satinado de manga larga", formatTradeCount: "1,203 vendidos" },
    imageModule: {
      imagePathList: [
        "//ae01.alicdn.com/kf/S1a.jpg_640x640q90.jpg",
        "//ae01.alicdn.com/kf/S1a.jpg_220x220.jpg",
        "https://ae01.alicdn.com/kf/S2b.png_220x220.png",
        "//ae01.alicdn.com/kf/S3c.jpg",
        "//ae01.alicdn.com/images/placeholder.gif",
      ],
    },
    priceModule: {
      formatedPrice: "US $15.99 - US $22.50",
      formatedActivityPrice: "US $12.34 - US $18.90",
      minAmount: { value: 15.99, currency: "USD", formatedAmount: "US $15.99" },
      maxAmount: { value: 22.5, currency: "USD", formatedAmount: "US $22.50" },
      minActivityAmount: { value: 12.34, currency: "USD", formatedAmount: "US $12.34" },
      maxActivityAmount: { value: 18.9, currency: "USD", formatedAmount: "US $18.90" },
    },
    skuModule: {
      productSKUPropertyList: [
        {
          skuPropertyId: 14,
          skuPropertyName: "Color",
          skuPropertyValues: [
            {
              propertyValueId: 350852,
              propertyValueName: "Red",
              propertyValueDisplayName: "Rojo",
              skuPropertyImagePath: "//ae01.alicdn.com/kf/Sred.jpg_220x220.jpg",
            },
            {
              propertyValueId: 350850,
              propertyValueName: "Black",
              propertyValueDisplayName: "Negro",
              skuPropertyImagePath: "//ae01.alicdn.com/kf/Sblack.jpg_220x220.jpg",
            },
          ],
        },
        {
          skuPropertyId: 5,
          skuPropertyName: "Size",
          skuPropertyValues: [
            { propertyValueId: 361386, propertyValueName: "S", propertyValueDisplayName: "S" },
            { propertyValueId: 361387, propertyValueName: "M", propertyValueDisplayName: "M" },
          ],
        },
      ],
      skuPriceList: [
        {
          skuId: "12000037181001",
          skuAttr: "14:350852#Red;5:361386",
          skuPropIds: "350852,361386",
          skuVal: {
            skuAmount: { value: 15.99, currency: "USD", formatedAmount: "US $15.99" },
            skuActivityAmount: { value: 12.34, currency: "USD", formatedAmount: "US $12.34" },
            availQuantity: 120,
          },
        },
        {
          skuId: "12000037181002",
          skuAttr: "14:350852#Red;5:361387",
          skuPropIds: "350852,361387",
          skuVal: {
            skuAmount: { value: 16.99, currency: "USD" },
            skuActivityAmount: { value: 13.34, currency: "USD" },
            availQuantity: 8,
          },
        },
        {
          skuId: "12000037181003",
          skuAttr: "14:350850#Black;5:361386",
          skuPropIds: "350850,361386",
          skuVal: { skuAmount: { value: 15.99, currency: "USD" }, availQuantity: 0 },
        },
        {
          skuId: "12000037181004",
          skuAttr: "14:350850#Black;5:361387",
          skuPropIds: "350850,361387",
          skuVal: { skuCalPrice: "18.90", availQuantity: 55 },
        },
      ],
    },
    specsModule: {
      props: [
        { attrName: "Material", attrValue: "Poliéster" },
        { attrName: "Largo del vestido", attrValue: "Midi" },
      ],
    },
    descriptionModule: {
      descriptionUrl: "https://aeproductsourcesite.alicdn.com/product/description/pc/v2/es_ES/desc.htm",
    },
    storeModule: { storeName: "Chic Fashion Store" },
  },
  csrfToken: "abc123",
};

const URL_FICHA = "https://www.aliexpress.com/item/1005006543210987.html";

function htmlFicha(state = RUN_PARAMS_STATE) {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta property="og:title" content="Vestido midi satinado &amp; elegante | AliExpress">
<meta property="og:image" content="//ae01.alicdn.com/kf/Sog.jpg_480x480.jpg">
<title>Vestido midi</title>
</head><body>
<div id="root"></div>
<script>window.runParams = {"data":{"titleModule":{"subject":"BLOQUE DECOY QUE NO ES LA FICHA"}}};</script>
<script type="text/javascript">
  window.runParams = ${JSON.stringify(state)};
</script>
<script>window.adminSeo = {"a":"}"};</script>
</body></html>`;
}

/* ── la misma regla de precio que usa el servidor (lib/money.ts), reescrita aquí
      porque el arnés es .mjs y no puede importar TypeScript ── */

function roundToEnding(cents, ending) {
  const dollars = Math.floor(cents / 100);
  const candidate = dollars * 100 + ending;
  return candidate >= cents ? candidate : (dollars + 1) * 100 + ending;
}

function applyPricing(costCents, rule) {
  const cost = Math.max(0, Math.round(costCents || 0));
  let price = Math.round(cost * rule.multiplier) + Math.round(rule.addCents || 0);
  if (rule.rounding === "99") price = roundToEnding(price, 99);
  else if (rule.rounding === "95") price = roundToEnding(price, 95);
  else if (rule.rounding === "whole") price = Math.ceil(price / 100) * 100;
  return Math.max(price, cost + 1);
}

/* ───────────────────────────────── utilidades ───────────────────────────────── */

/** Escribir en un input de React: sin el setter nativo el estado no se entera. */
async function escribir(page, selector, texto) {
  await page.$eval(
    selector,
    (el, valor) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, valor);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    texto,
  );
}

/** Pulsa el primer botón/enlace cuyo texto contenga `texto`. Devuelve si lo encontró. */
async function pulsarPorTexto(page, texto, selector = "button, a") {
  const hecho = await page.evaluate(
    (t, sel) => {
      const nodos = Array.from(document.querySelectorAll(sel));
      const nodo = nodos.find((n) => (n.textContent || "").toLowerCase().includes(t.toLowerCase()));
      if (!nodo) return false;
      nodo.click();
      return true;
    },
    texto,
    selector,
  );
  return hecho;
}

/** ¿Quién recibe el clic en el centro de este elemento? Prueba de clicabilidad real. */
async function clicable(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return "no existe";
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return "tamaño 0";
    const encima = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!encima) return "nada responde";
    return el.contains(encima) || encima.contains(el) ? "sí" : `lo tapa ${encima.tagName.toLowerCase()}`;
  }, selector);
}

let COOKIE = "";

async function pedir(url, opciones = {}) {
  const res = await fetch(url, {
    redirect: "manual",
    ...opciones,
    headers: { ...(opciones.headers ?? {}), ...(COOKIE ? { Cookie: COOKIE } : {}) },
  });
  const cuerpo = await res.text().catch(() => "");
  return { status: res.status, cuerpo, headers: res.headers };
}

/* ─────────────────────────────── limpieza ─────────────────────────────── */

/**
 * Limpieza ACOTADA a lo que crea este arnés.
 *
 * Nada de `deleteMany({})`: en esta máquina puede haber otra sesión trabajando
 * contra la misma base de datos de desarrollo, y borrar su historial de
 * importaciones le arranca el contexto de debajo de los pies.
 */
const IDS_FIXTURE = ["1005006543210987", "1005006543210999"];
const SLUGS_QA = ["qa-blusa-lino", "qa-falda-midi", "qa-sin-precio"];

async function limpiar() {
  const jobs = await db.importJob.findMany({
    where: {
      OR: [
        { sourceUrl: { contains: "1005006543210987" } },
        { sourceUrl: { contains: "1005006543210999" } },
        { sourceUrl: { contains: "999999999999999" } },
        { draftJson: { contains: "QA " } },
        { error: { contains: "QA:" } },
      ],
    },
    select: { id: true, provider: true, method: true, status: true },
  });
  const productos = await db.product.findMany({
    where: { OR: [{ sourceProductId: { in: [...IDS_FIXTURE, ...SLUGS_QA] } }] },
    select: { id: true, title: true, slug: true },
  });
  console.log(`Jobs a borrar: ${jobs.length} (${jobs.map((j) => `${j.provider}/${j.status}`).join(", ")})`);
  console.log(`Productos a borrar: ${productos.map((p) => p.slug).join(", ") || "ninguno"}`);
  await db.importJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
  for (const p of productos) {
    await db.collectionProduct.deleteMany({ where: { productId: p.id } });
    await db.productImage.deleteMany({ where: { productId: p.id } });
    await db.productVariant.deleteMany({ where: { productId: p.id } });
    await db.product.delete({ where: { id: p.id } });
  }
  console.log("Limpio.");
}

if (args.includes("--limpiar")) {
  await limpiar();
  await db.$disconnect();
  process.exit(0);
}

/* ─────────────────────────────── el recorrido ─────────────────────────────── */

const ajustes = await db.setting.findUnique({ where: { key: "pricing" } });
const REGLA = JSON.parse(ajustes?.value ?? '{"multiplier":2.6,"addCents":500,"rounding":"99"}');
const TOKEN = (await db.setting.findUnique({ where: { key: "importToken" } }))?.value ?? "";

console.log(`Regla de precio: x${REGLA.multiplier} + ${REGLA.addCents}c, termina en ${REGLA.rounding}`);
console.log(`Base: ${BASE}\n`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  args: ["--disable-gpu", "--hide-scrollbars", "--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });

const errores = [];
page.on("pageerror", (e) => errores.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on("console", (m) => {
  if (m.type() === "error") errores.push(`console: ${m.text().slice(0, 300)}`);
});

async function login() {
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.type('input[name="email"]', EMAIL, { delay: 3 });
  await page.type('input[name="password"]', PASSWORD, { delay: 3 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  const cookies = await browser.cookies();
  COOKIE = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return !page.url().includes("/admin/login");
}

const entrado = await login();
if (!entrado) {
  console.error("No se pudo entrar al panel. Abortando.");
  await browser.close();
  await db.$disconnect();
  process.exit(1);
}

let jobId = "";
let productId = "";
let slugPublicado = "";

/* ── 1 · las cuatro pestañas ── */
if (activo("pestanas")) {
  await page.goto(`${BASE}/admin/importar`, { waitUntil: "networkidle2", timeout: 60000 });
  const tabs = await page.$$eval(".imp-tab", (els) => els.map((e) => e.textContent.trim().slice(0, 20)));
  const esperados = [
    { i: 0, sel: "#imp-urls", nombre: "Pegar enlace" },
    { i: 1, sel: "#imp-html", nombre: "Pegar HTML" },
    { i: 2, sel: ".imp-marcador", nombre: "Marcador" },
    { i: 3, sel: "#imp-csv", nombre: "CSV" },
  ];
  for (const t of esperados) {
    errores.length = 0;
    await page.$$eval(".imp-tab", (els, i) => els[i].click(), t.i);
    await new Promise((r) => setTimeout(r, 400));
    const presente = await page.$(t.sel);
    const hit = presente ? await clicable(page, t.sel) : "no existe";
    anotar(
      `1 · pestaña «${t.nombre}»`,
      `clic en la pestaña ${t.i + 1} de ${tabs.length}`,
      `aparece ${t.sel} y responde al ratón`,
      presente ? `aparece ${t.sel}; clicable: ${hit}${errores.length ? ` · errores: ${errores[0]}` : ""}` : `NO aparece ${t.sel}`,
      presente && hit === "sí" ? "OK" : "ROTO",
    );
  }
  // El marcador: comprobar que el href javascript: se instaló de verdad.
  await page.$$eval(".imp-tab", (els) => els[2].click());
  await new Promise((r) => setTimeout(r, 500));
  const href = await page.$eval(".imp-marcador", (a) => a.getAttribute("href")).catch(() => "");
  anotar(
    "1b · marcador arrastrable",
    "abrir la pestaña Marcador y leer el href del enlace rosa",
    "un href javascript:... con el token dentro",
    href?.startsWith("javascript:")
      ? `href de ${href.length} caracteres, empieza por javascript:`
      : `href = ${JSON.stringify(href)}`,
    href?.startsWith("javascript:") ? "OK" : "ROTO",
  );
}

/* ── 2 · vía HTML ── */
if (activo("html")) {
  await page.goto(`${BASE}/admin/importar?tab=html`, { waitUntil: "networkidle2", timeout: 60000 });
  errores.length = 0;
  await escribir(page, "#imp-url-html", URL_FICHA);
  await escribir(page, "#imp-html", htmlFicha());
  await pulsarPorTexto(page, "Leer la ficha");
  await page
    .waitForFunction(() => location.search.includes("job="), { timeout: 30000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  const url = page.url();
  jobId = new URL(url).searchParams.get("job") ?? "";

  const vista = await page.evaluate(() => {
    const titulo = document.querySelector("#imp-titulo")?.value ?? null;
    const fotos = document.querySelectorAll(".imp-galeria img").length;
    const costes = Array.from(document.querySelectorAll('input[aria-label^="Coste de"]')).map((i) => i.value);
    const precios = Array.from(document.querySelectorAll('input[aria-label^="Precio de venta de"]')).map((i) => i.value);
    const margenes = Array.from(document.querySelectorAll(".imp-margen")).map((s) => s.textContent.trim());
    const variantes = Array.from(document.querySelectorAll('input[aria-label^="Incluir la variante"]')).map(
      (i) => i.getAttribute("aria-label"),
    );
    const avisos = Array.from(document.querySelectorAll(".imp-aviso-cuerpo")).map((n) => n.textContent.trim().slice(0, 120));
    const totales = Array.from(document.querySelectorAll(".imp-total")).map((n) => n.textContent.trim());
    return { titulo, fotos, costes, precios, margenes, variantes, avisos, totales };
  });

  anotar(
    "2 · vista previa por HTML",
    "pegar el HTML del fixture de AliExpress y pulsar «Leer la ficha»",
    "salta a ?job=… con título, fotos, variantes, coste, precio y margen",
    jobId
      ? `job ${jobId.slice(0, 8)}…; título «${vista.titulo}»; ${vista.fotos} fotos; ${vista.variantes.length} variantes; costes ${vista.costes.join("/")}; precios ${vista.precios.join("/")}`
      : `la URL se quedó en ${url}`,
    jobId && vista.titulo && vista.fotos > 0 && vista.variantes.length > 0 ? "OK" : "ROTO",
  );

  // Los precios tienen que ser exactamente applyPricing(coste).
  const desajustes = [];
  vista.costes.forEach((coste, i) => {
    const cents = Math.round(Number.parseFloat(coste || "0") * 100);
    const esperado = (applyPricing(cents, REGLA) / 100).toFixed(2);
    if (esperado !== vista.precios[i]) desajustes.push(`fila ${i + 1}: coste ${coste} → esperaba ${esperado}, salió ${vista.precios[i]}`);
  });
  anotar(
    "2b · precios = applyPricing(coste)",
    `recalcular con la regla de Ajustes (x${REGLA.multiplier} + ${REGLA.addCents}c → ${REGLA.rounding})`,
    "cada precio de la tabla coincide con la regla",
    desajustes.length === 0 ? `las ${vista.costes.length} filas cuadran` : desajustes.join(" · "),
    desajustes.length === 0 ? "OK" : "ROTO",
  );

  anotar(
    "2c · margen a la vista",
    "leer la columna Margen y el pie de totales",
    "porcentaje por fila y totales de coste/venta/ganancia",
    `márgenes ${vista.margenes.join(" ")} · totales: ${vista.totales.join(" | ")}`,
    vista.margenes.length === vista.costes.length && vista.totales.length >= 4 ? "OK" : "ROTO",
  );

  if (errores.length) {
    anotar("2d · consola limpia", "vigilar errores de consola durante la importación", "ninguno", errores.slice(0, 3).join(" · "), "MEJORABLE");
  }
}

/* ── 3 · publicar y comprobar la BD y TODOS los enlaces ── */
if (activo("publicar") && jobId) {
  errores.length = 0;
  await pulsarPorTexto(page, "Publicar como borrador");
  await new Promise((r) => setTimeout(r, 3500));

  const job = await db.importJob.findUnique({ where: { id: jobId } });
  productId = job?.productId ?? "";
  const producto = productId
    ? await db.product.findUnique({ where: { id: productId }, include: { images: true, variants: true } })
    : null;
  slugPublicado = producto?.slug ?? "";

  anotar(
    "3 · publicar → fila en la BD",
    "pulsar «Publicar como borrador» y consultar la base de datos",
    "Product con sus variantes, sus imágenes y su trazabilidad",
    producto
      ? `«${producto.title}» slug ${producto.slug}, estado ${producto.status}, ${producto.variants.length} variantes, ${producto.images.length} imágenes, provider ${producto.sourceProvider}, sourceProductId ${producto.sourceProductId}, sourceUrl ${producto.sourceUrl ? "sí" : "NO"}`
      : `el job quedó en estado ${job?.status} sin productId`,
    producto && producto.variants.length > 0 && producto.images.length > 0 && producto.sourceProductId
      ? "OK"
      : "ROTO",
  );

  // ¿Qué ve la usuaria exactamente en esa pantalla? (una sola cosa, o dos que
  // dicen lo mismo y la dejan sin saber cuál es la buena).
  const pantalla = await page.evaluate(() => ({
    tarjetas: Array.from(document.querySelectorAll(".adm-card-title, .adm-card h2, .adm-card h3")).map((n) =>
      n.textContent.trim().slice(0, 60),
    ),
    texto: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
  }));
  anotar(
    "3a · qué se ve tras publicar",
    "leer los títulos de tarjeta de la pantalla resultante",
    "un único mensaje de éxito con qué hacer ahora",
    `tarjetas: ${pantalla.tarjetas.join(" | ")}`,
    "OK",
  );

  // TODOS los enlaces y botones de la pantalla de "publicado".
  const acciones = await page.evaluate(() => {
    const zona = document.querySelector(".imp-resultado-acciones");
    if (!zona) return null;
    return Array.from(zona.querySelectorAll("a, button")).map((n) => ({
      texto: n.textContent.trim(),
      href: n.getAttribute("href"),
      tag: n.tagName.toLowerCase(),
    }));
  });

  if (!acciones) {
    anotar("3b · pantalla tras publicar", "buscar la caja de acciones posteriores", "botones de seguimiento", "no apareció .imp-resultado-acciones", "ROTO");
  } else {
    for (const accion of acciones) {
      if (!accion.href) {
        anotar(`3b · botón «${accion.texto}»`, "leer el destino", "algo que hacer", `es un <${accion.tag}> sin href (acción de cliente)`, "OK");
        continue;
      }
      const destino = accion.href.startsWith("http") ? accion.href : BASE + accion.href;
      const r = await pedir(destino);
      const vacia = r.cuerpo.length < 500;
      anotar(
        `3b · enlace «${accion.texto}» → ${accion.href}`,
        `GET ${accion.href} con la sesión del panel`,
        "200 y una pantalla con contenido",
        `HTTP ${r.status}${vacia ? " (respuesta casi vacía)" : ""}`,
        r.status === 200 && !vacia ? "OK" : "ROTO",
      );
    }
  }

  // El historial también ofrece un enlace al producto publicado.
  await page.goto(`${BASE}/admin/importar`, { waitUntil: "networkidle2" });
  const enHistorial = await page.evaluate(() => {
    const filas = Array.from(document.querySelectorAll("tbody tr, .adm-card-fila"));
    const enlaces = Array.from(document.querySelectorAll('a[href*="/admin/productos/"]')).map((a) => a.getAttribute("href"));
    return { filas: filas.length, enlaces: enlaces.slice(0, 5) };
  });
  anotar(
    "3c · el job aparece en el historial",
    "volver a /admin/importar y mirar la tabla de importaciones recientes",
    "una fila con estado Publicado y enlace al producto",
    `${enHistorial.filas} filas; enlaces ${enHistorial.enlaces.join(", ") || "ninguno"}`,
    enHistorial.filas > 0 ? "OK" : "ROTO",
  );
}

/* ── 4 · duplicado ── */
if (activo("duplicado")) {
  await page.goto(`${BASE}/admin/importar?tab=html`, { waitUntil: "networkidle2", timeout: 60000 });
  await escribir(page, "#imp-url-html", URL_FICHA);
  await escribir(page, "#imp-html", htmlFicha());
  await pulsarPorTexto(page, "Leer la ficha");
  await page.waitForFunction(() => location.search.includes("job="), { timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  const segundoJob = new URL(page.url()).searchParams.get("job") ?? "";
  const avisoDup = await page.evaluate(() => {
    const nodos = Array.from(document.querySelectorAll(".imp-aviso-warning .imp-aviso-cuerpo"));
    const dup = nodos.find((n) => /ya está en tu catálogo/i.test(n.textContent));
    return dup ? dup.textContent.trim().slice(0, 160) : null;
  });
  anotar(
    "4 · aviso de duplicado en la vista previa",
    "importar el mismo producto por segunda vez",
    "aviso «ya está en tu catálogo» antes de tocar nada",
    avisoDup ?? "no salió ningún aviso de duplicado",
    avisoDup ? "OK" : "ROTO",
  );

  const antes = await db.product.count();
  await pulsarPorTexto(page, "Publicar como borrador");
  await new Promise((r) => setTimeout(r, 3000));
  const despues = await db.product.count();
  const errorDup = await page.evaluate(() => {
    const n = Array.from(document.querySelectorAll(".imp-aviso-cuerpo")).find((x) =>
      /ya está en el catálogo|ya está en tu catálogo/i.test(x.textContent),
    );
    return n ? n.textContent.trim().slice(0, 160) : null;
  });
  anotar(
    "4b · publicar el duplicado no crea otra ficha",
    "pulsar Publicar con el aviso de duplicado delante",
    "se frena y explica; el catálogo no crece",
    `productos antes ${antes}, después ${despues}; mensaje: ${errorDup ?? "ninguno"}`,
    despues === antes && errorDup ? "OK" : "ROTO",
  );

  // «Actualizar el que ya tengo»: la salida honesta que ofrece la propia pantalla.
  if (productId) {
    await db.product.update({ where: { id: productId }, data: { status: "active" } });
    await page.goto(`${BASE}/admin/importar?job=${segundoJob}`, { waitUntil: "networkidle2" });
    await pulsarPorTexto(page, "Actualizar el que ya tengo");
    await new Promise((r) => setTimeout(r, 3000));
    const tras = await db.product.findUnique({ where: { id: productId }, select: { status: true, title: true } });
    anotar(
      "4c · «Actualizar el que ya tengo» respeta el estado",
      "poner el producto en ACTIVO y pulsar «Actualizar el que ya tengo»",
      "se actualizan datos y precios; sigue activo y visible en la tienda",
      `el producto quedó en estado «${tras?.status}»`,
      tras?.status === "active" ? "OK" : "ROTO",
    );
    if (tras?.status !== "active") {
      const ficha = await pedir(`${BASE}/producto/${slugPublicado}`);
      anotar(
        "4d · la tienda tras esa actualización",
        `GET /producto/${slugPublicado}`,
        "la ficha sigue viéndose",
        `HTTP ${ficha.status}`,
        ficha.status === 200 ? "OK" : "ROTO",
      );
    }
  }
}

/* ── 5 · CSV ── */
if (activo("csv")) {
  await page.goto(`${BASE}/admin/importar?tab=csv`, { waitUntil: "networkidle2", timeout: 60000 });

  // La plantilla se pide por Server Action; se comprueba que devuelve algo usable.
  errores.length = 0;
  await pulsarPorTexto(page, "Descargar plantilla");
  await new Promise((r) => setTimeout(r, 1500));
  const errorPlantilla = await page.evaluate(() => {
    const n = document.querySelector(".imp-aviso-danger .imp-aviso-cuerpo");
    return n ? n.textContent.trim().slice(0, 160) : null;
  });
  anotar(
    "5 · descargar la plantilla de ejemplo",
    "pulsar «Descargar plantilla de ejemplo»",
    "se descarga un CSV; ningún 404 ni error en pantalla",
    errorPlantilla ? `error en pantalla: ${errorPlantilla}` : `sin error visible${errores.length ? ` (consola: ${errores[0]})` : ""}`,
    errorPlantilla ? "ROTO" : "OK",
  );

  // Se sube un CSV con DOS productos, con las cabeceras de la propia plantilla.
  const csv = [
    "handle,title,description,price,cost,sku,option1_name,option1_value,image_url,tags,status",
    'qa-blusa-lino,QA Blusa de lino,"Blusa ligera, manga corta.",39.99,12.00,QA-001,Talla,S,https://ejemplo.com/qa-1.jpg,blusas|qa,active',
    "qa-blusa-lino,,,41.99,13.00,QA-002,Talla,M,https://ejemplo.com/qa-2.jpg,,",
    'qa-falda-midi,QA Falda midi,"Falda midi plisada.",54.99,19.50,QA-003,Talla,U,https://ejemplo.com/qa-3.jpg,faldas|qa,draft',
  ].join("\n");

  const input = await page.$("#imp-csv");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const dir = mkdtempSync(pathMod.join(tmpdir(), "bloomqa-"));
  const fichero = pathMod.join(dir, "qa-catalogo.csv");
  writeFileSync(fichero, csv, "utf8");
  await input.uploadFile(fichero);
  await new Promise((r) => setTimeout(r, 800));
  await pulsarPorTexto(page, "Importar «qa-catalogo.csv»");
  await new Promise((r) => setTimeout(r, 3000));

  const resumen = await page.evaluate(() => {
    const cajas = Array.from(document.querySelectorAll(".imp-aviso"));
    return cajas.map((c) => `${c.className.includes("success") ? "OK" : c.className.includes("danger") ? "ERR" : "AVISO"}: ${c.textContent.trim().slice(0, 110)}`);
  });
  const jobsCsv = await db.importJob.findMany({ where: { provider: "csv" }, select: { id: true, draftJson: true } });
  anotar(
    "5b · subir un CSV de dos productos",
    "elegir el fichero y pulsar Importar",
    "dos importaciones nuevas listas para revisar",
    `${jobsCsv.length} jobs CSV en la BD · pantalla: ${resumen.join(" || ") || "sin mensajes"}`,
    jobsCsv.length === 2 ? "OK" : "ROTO",
  );

  // ¿Llegó el status del CSV ("active") al borrador?
  if (jobsCsv.length > 0) {
    const borrador = JSON.parse(jobsCsv[0].draftJson ?? "{}");
    anotar(
      "5c · columnas status/tags/type del CSV",
      "mirar el borrador guardado del primer producto del CSV",
      "el estado y las etiquetas del fichero llegan al borrador",
      `claves del borrador: ${Object.keys(borrador).join(", ")} · variantes ${borrador.variants?.length} · avisos: ${(borrador.warnings ?? []).join(" / ") || "ninguno"}`,
      "MEJORABLE",
    );
  }
}

/* ── 6 · el endpoint del bookmarklet ── */
if (activo("api")) {
  const payload = {
    provider: "aliexpress",
    url: URL_FICHA,
    token: TOKEN,
    data: { runParams: RUN_PARAMS_STATE },
    html: htmlFicha(),
  };
  const endpoint = `${BASE}/api/import/ingest`;

  const sinToken = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ ...payload, token: undefined }),
  });
  const cuerpoSinToken = await sinToken.json().catch(() => ({}));
  anotar(
    "6 · POST /api/import/ingest SIN token",
    "mandar el payload del marcador sin token",
    "401 y un mensaje que diga qué hacer",
    `HTTP ${sinToken.status} · ${cuerpoSinToken.error ?? "(sin error)"} / ${cuerpoSinToken.hint ?? ""}`.slice(0, 200),
    sinToken.status === 401 ? "OK" : "ROTO",
  );

  const conToken = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(payload),
  });
  const cuerpo = await conToken.json().catch(() => ({}));
  anotar(
    "6b · POST con token válido",
    "mandar el mismo payload con el token de la tienda",
    "200, jobId y reviewUrl que abra el panel",
    `HTTP ${conToken.status} · job ${cuerpo.jobId ?? "—"} · reviewUrl ${cuerpo.reviewUrl ?? "—"} · duplicado ${cuerpo.duplicate ? "avisado" : "no"}`,
    conToken.status === 200 && cuerpo.jobId ? "OK" : "ROTO",
  );

  if (cuerpo.reviewUrl) {
    const r = await pedir(cuerpo.reviewUrl);
    anotar(
      "6c · reviewUrl del marcador",
      `GET ${cuerpo.reviewUrl}`,
      "200 con la pantalla de revisión",
      `HTTP ${r.status}`,
      r.status === 200 ? "OK" : "ROTO",
    );
  }

  // Peso del borrador que guarda esta vía, comparado con el de la vía HTML.
  if (cuerpo.jobId) {
    const jobApi = await db.importJob.findUnique({ where: { id: cuerpo.jobId }, select: { draftJson: true, rawJson: true } });
    const jobHtml = jobId ? await db.importJob.findUnique({ where: { id: jobId }, select: { draftJson: true } }) : null;
    anotar(
      "6d · tamaño del borrador guardado",
      "comparar draftJson del bookmarklet con el de la vía HTML",
      "parecidos: el volcado crudo va en rawJson, no en el borrador",
      `bookmarklet ${jobApi?.draftJson?.length ?? 0} caracteres vs HTML ${jobHtml?.draftJson?.length ?? 0}`,
      (jobApi?.draftJson?.length ?? 0) > (jobHtml?.draftJson?.length ?? 0) * 1.5 ? "ROTO" : "OK",
    );
  }

  const opciones = await fetch(endpoint, {
    method: "OPTIONS",
    headers: { Origin: "https://www.aliexpress.com", "Access-Control-Request-Method": "POST" },
  });
  anotar(
    "6e · OPTIONS (CORS) desde aliexpress.com",
    "preflight con Origin de AliExpress",
    "204 con Access-Control-Allow-Origin",
    `HTTP ${opciones.status} · allow-origin: ${opciones.headers.get("access-control-allow-origin") ?? "ninguno"}`,
    opciones.status === 204 && opciones.headers.get("access-control-allow-origin") ? "OK" : "ROTO",
  );

  const opcionesMalas = await fetch(endpoint, {
    method: "OPTIONS",
    headers: { Origin: "https://sitio-cualquiera.example", "Access-Control-Request-Method": "POST" },
  });
  anotar(
    "6f · OPTIONS desde un origen ajeno",
    "preflight con Origin desconocido",
    "403 sin cabecera permisiva",
    `HTTP ${opcionesMalas.status} · allow-origin: ${opcionesMalas.headers.get("access-control-allow-origin") ?? "ninguno"}`,
    opcionesMalas.status === 403 ? "OK" : "ROTO",
  );

  // Payload gigante: 5 MB, por encima del tope declarado de 4 MB.
  const gigante = JSON.stringify({ ...payload, html: "x".repeat(5_000_000) });
  let resGigante;
  try {
    resGigante = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: gigante,
    });
  } catch (e) {
    resGigante = { status: -1, texto: String(e) };
  }
  const cuerpoGigante = resGigante.json ? await resGigante.json().catch(() => ({})) : {};
  anotar(
    "6g · payload de 5 MB",
    "POST con un HTML de cinco millones de caracteres",
    "413 con un mensaje que diga qué hacer, no un 500 pelado",
    `HTTP ${resGigante.status} · ${cuerpoGigante.error ?? ""} ${cuerpoGigante.hint ?? ""}`.slice(0, 200),
    resGigante.status === 413 ? "OK" : "ROTO",
  );

  const malJson = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: "{esto no es json",
  });
  const cuerpoMal = await malJson.json().catch(() => ({}));
  anotar(
    "6h · JSON malformado",
    "POST con un cuerpo que no es JSON",
    "400 con mensaje claro",
    `HTTP ${malJson.status} · ${cuerpoMal.error ?? "(sin error)"}`,
    malJson.status === 400 && cuerpoMal.error ? "OK" : "ROTO",
  );

  const conGet = await fetch(endpoint);
  const cuerpoGet = await conGet.json().catch(() => ({}));
  anotar(
    "6i · GET al endpoint",
    "abrir el endpoint en el navegador",
    "405 explicando que solo acepta POST",
    `HTTP ${conGet.status} · ${cuerpoGet.error ?? ""}`,
    conGet.status === 405 ? "OK" : "ROTO",
  );

  // Token válido pero payload sin nada reconocible: ¿queda rastro y mensaje útil?
  const vacio = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ provider: "aliexpress", url: URL_FICHA, token: TOKEN, data: {}, html: "<html></html>" }),
  });
  const cuerpoVacio = await vacio.json().catch(() => ({}));
  const fallidos = await db.importJob.count({ where: { status: "failed" } });
  anotar(
    "6j · envío del marcador sin datos legibles",
    "POST con token válido pero una página vacía",
    "422 con error+pista y un job 'failed' en el historial",
    `HTTP ${vacio.status} · ${cuerpoVacio.error ?? ""} · ${cuerpoVacio.hint ? "con pista" : "SIN pista"} · jobs fallidos en BD: ${fallidos}`,
    vacio.status === 422 && cuerpoVacio.error && fallidos > 0 ? "OK" : "ROTO",
  );
}

/* ── 7 · historial: reintentar y retomar ── */
if (activo("historial")) {
  // Un job fallido CON enlace: el botón Reintentar.
  const fallido = await db.importJob.create({
    data: {
      provider: "aliexpress",
      method: "url",
      status: "failed",
      sourceUrl: "https://www.aliexpress.com/item/999999999999999.html",
      error: "QA: fallo simulado para probar el reintento",
    },
    select: { id: true },
  });
  await page.goto(`${BASE}/admin/importar`, { waitUntil: "networkidle2" });
  const hayBoton = await pulsarPorTexto(page, "Reintentar");
  // El reintento sale a la red de verdad (con un reintento interno): puede tardar.
  await page.waitForFunction(() => location.search.includes("aviso=") || location.search.includes("job="), { timeout: 90000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  const urlTrasReintento = page.url();
  const textoPantalla = await page.evaluate(() => document.body.innerText.slice(0, 400));
  anotar(
    "7 · reintentar un job fallido",
    "pulsar «Reintentar» en una importación fallida con enlace",
    "vuelve al importador diciendo cómo acabó el reintento",
    hayBoton
      ? `acabó en ${urlTrasReintento} · en pantalla: ${textoPantalla.replace(/\s+/g, " ").slice(0, 160)}`
      : "no había botón Reintentar",
    hayBoton && urlTrasReintento.includes("/admin/importar") ? "OK" : "ROTO",
  );

  // Un job en 'ready': el botón «Seguir revisando».
  await page.goto(`${BASE}/admin/importar`, { waitUntil: "networkidle2" });
  const haySeguir = await pulsarPorTexto(page, "Seguir revisando");
  await new Promise((r) => setTimeout(r, 2500));
  const hayEditor = await page.$("#imp-titulo");
  anotar(
    "7b · retomar un job «Por revisar»",
    "pulsar «Seguir revisando» en el historial",
    "abre la vista previa de ese borrador",
    haySeguir ? `URL ${page.url()} · editor ${hayEditor ? "presente" : "AUSENTE"}` : "no había botón «Seguir revisando»",
    haySeguir && hayEditor ? "OK" : "ROTO",
  );

  // Los enlaces de cada fila del historial.
  await page.goto(`${BASE}/admin/importar`, { waitUntil: "networkidle2" });
  const enlaces = await page.$$eval("a[href]", (as) =>
    Array.from(new Set(as.map((a) => a.getAttribute("href")))).filter((h) => h && !h.startsWith("javascript:")),
  );
  const rotos = [];
  for (const h of enlaces) {
    if (h.startsWith("http") && !h.startsWith(BASE)) continue;
    const r = await pedir(h.startsWith("http") ? h : BASE + h);
    if (r.status >= 400) rotos.push(`${h} → ${r.status}`);
  }
  anotar(
    "7c · todos los enlaces de la pantalla",
    `recorrer los ${enlaces.length} enlaces internos de /admin/importar y pedir cada uno`,
    "ninguno devuelve 4xx ni 5xx",
    rotos.length === 0 ? "todos responden 200/3xx" : rotos.join(" · "),
    rotos.length === 0 ? "OK" : "ROTO",
  );

  await db.importJob.deleteMany({ where: { id: fallido.id } });
}

/* ── 8 · romperlo a propósito ── */
if (activo("romper")) {
  const casos = [
    {
      nombre: "8 · HTML vacío",
      tab: "html",
      url: "",
      html: "   ",
      espera: "dice que no hay HTML y explica cómo copiarlo",
    },
    {
      nombre: "8b · HTML de una página que no es un producto",
      tab: "html",
      url: "",
      html: `<!doctype html><html><head><title>Blog</title></head><body>${"<p>Una entrada cualquiera del blog, sin ningún producto dentro.</p>".repeat(60)}</body></html>`,
      espera: "dice que no reconoció ninguna ficha y ofrece salida",
    },
  ];

  for (const caso of casos) {
    await page.goto(`${BASE}/admin/importar?tab=html`, { waitUntil: "networkidle2" });
    errores.length = 0;
    await escribir(page, "#imp-html", caso.html);
    await pulsarPorTexto(page, "Leer la ficha");
    await new Promise((r) => setTimeout(r, 3000));
    const mensaje = await page.evaluate(() => {
      const n = document.querySelector(".imp-aviso-danger .imp-aviso-cuerpo");
      return n ? n.textContent.trim() : null;
    });
    const colgada = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => /Leyendo la ficha/i.test(x.textContent));
      return Boolean(b);
    });
    anotar(
      caso.nombre,
      "pegar ese contenido y pulsar «Leer la ficha»",
      caso.espera,
      mensaje ? `${mensaje.replace(/\s+/g, " ").slice(0, 200)}${colgada ? " · EL BOTÓN SE QUEDÓ EN «Leyendo…»" : ""}` : "no salió ningún mensaje",
      mensaje && !colgada && errores.length === 0 ? "OK" : mensaje ? "MEJORABLE" : "ROTO",
    );
  }

  // URL de un dominio desconocido y URL de AliExpress inventada.
  const urls = [
    { nombre: "8c · dominio que no reconoce", url: "https://www.zara.com/es/producto-12345.html" },
    { nombre: "8d · URL de AliExpress inventada", url: "https://www.aliexpress.com/item/1000000000000001.html" },
    { nombre: "8e · texto que no es una URL", url: "esto no es un enlace" },
  ];
  for (const caso of urls) {
    await page.goto(`${BASE}/admin/importar`, { waitUntil: "networkidle2" });
    errores.length = 0;
    await escribir(page, "#imp-urls", caso.url);
    await pulsarPorTexto(page, "Traer productos");
    // Primero esperar a que ARRANQUE (si no, la comprobación de abajo pasa antes
    // de que el botón cambie de texto y se mide un estado que aún no existe).
    await page
      .waitForFunction(() => Boolean(document.querySelector(".imp-fila-url")), { timeout: 15000 })
      .catch(() => {});
    await page
      .waitForFunction(() => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => /Trayendo productos/i.test(x.textContent));
        return !b;
      }, { timeout: 90000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    const info = await page.evaluate(() => {
      const caja = document.querySelector(".imp-fila-url .imp-aviso-danger .imp-aviso-cuerpo");
      const acciones = caja ? Array.from(caja.querySelectorAll("button")).map((b) => b.textContent.trim()) : [];
      const fila = document.querySelector(".imp-fila-url");
      return {
        mensaje: caja ? caja.textContent.trim() : null,
        acciones,
        fila: fila ? fila.textContent.replace(/\s+/g, " ").trim().slice(0, 200) : "(no hay fila)",
      };
    });
    anotar(
      caso.nombre,
      `pegar «${caso.url}» y pulsar «Traer productos»`,
      "mensaje que diga qué pasó y qué hacer, sin excepción sin capturar",
      info.mensaje
        ? `${info.mensaje.replace(/\s+/g, " ").slice(0, 190)}${info.acciones.length ? ` · botones: ${info.acciones.join(", ")}` : ""}`
        : `sin mensaje · la fila dice: ${info.fila}${errores.length ? ` · consola: ${errores[0]}` : ""}`,
      info.mensaje && errores.length === 0 ? "OK" : info.mensaje ? "MEJORABLE" : "ROTO",
    );
  }
}

/* ── 9 · lo que pasa entre revisar y publicar ── */
if (activo("extras")) {
  /* 9a · un CSV que trae SU precio: ¿se respeta o lo pisa la regla? */
  const jobCsv = await db.importJob.findFirst({
    where: { provider: "csv", status: "ready" },
    orderBy: { createdAt: "desc" },
    select: { id: true, draftJson: true },
  });
  if (jobCsv) {
    const borrador = JSON.parse(jobCsv.draftJson);
    await page.goto(`${BASE}/admin/importar?job=${jobCsv.id}`, { waitUntil: "networkidle2" });
    const vista = await page.evaluate(() => ({
      costes: Array.from(document.querySelectorAll('input[aria-label^="Coste de"]')).map((i) => i.value),
      precios: Array.from(document.querySelectorAll('input[aria-label^="Precio de venta de"]')).map((i) => i.value),
    }));
    const delCsv = borrador.variants.map((v) => (v.priceCents / 100).toFixed(2));
    anotar(
      "9a · precio propio del CSV en la vista previa",
      "abrir un producto traído por CSV que traía columna price",
      "la vista previa enseña el precio que venía en el fichero",
      `el CSV traía ${delCsv.join("/")} y la pantalla enseña ${vista.precios.join("/")} (coste ${vista.costes.join("/")})`,
      JSON.stringify(delCsv) === JSON.stringify(vista.precios) ? "OK" : "ROTO",
    );

    /* 9b · publicarlo ACTIVO y ver la ficha pública */
    await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[name="imp-estado"]'));
      radios[1]?.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    await pulsarPorTexto(page, "Publicar y poner a la venta");
    await new Promise((r) => setTimeout(r, 4000));
    const jobTras = await db.importJob.findUnique({ where: { id: jobCsv.id } });
    const prod = jobTras?.productId
      ? await db.product.findUnique({ where: { id: jobTras.productId }, include: { variants: true } })
      : null;
    const publica = prod ? await pedir(`${BASE}/producto/${prod.slug}`) : { status: 0 };
    anotar(
      "9b · publicar «Activo, a la venta»",
      "elegir «Activo, a la venta», publicar y pedir la ficha pública",
      "producto active y /producto/[slug] devuelve 200",
      prod
        ? `estado ${prod.status}, precio ${(prod.priceCents / 100).toFixed(2)}, publishedAt ${prod.publishedAt ? "sí" : "NO"} · GET /producto/${prod.slug} → ${publica.status}`
        : "no se creó el producto",
      prod?.status === "active" && publica.status === 200 ? "OK" : "ROTO",
    );
  }

  /* 9c · «Guardar y seguir luego»: ¿qué sobrevive? */
  await page.goto(`${BASE}/admin/importar?tab=html`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#imp-url-html", { timeout: 20000 }).catch(async () => {
    // Si la pestaña no vino puesta por la URL, se abre a mano.
    await page.$$eval(".imp-tab", (els) => els[1].click());
    await page.waitForSelector("#imp-url-html", { timeout: 20000 });
  });
  await escribir(page, "#imp-url-html", "https://www.aliexpress.com/item/1005006543210999.html");
  await escribir(page, "#imp-html", htmlFicha({ ...RUN_PARAMS_STATE, data: { ...RUN_PARAMS_STATE.data, actionModule: { productId: 1005006543210999, itemStatus: 0 } } }));
  await pulsarPorTexto(page, "Leer la ficha");
  await page.waitForFunction(() => location.search.includes("job="), { timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const jobGuardar = new URL(page.url()).searchParams.get("job") ?? "";

  const antes = await page.evaluate(() => ({
    fotos: document.querySelectorAll(".imp-galeria img").length,
    variantes: document.querySelectorAll('input[aria-label^="Incluir la variante"]').length,
  }));
  // Quitar la segunda foto y descartar la última variante.
  await page.evaluate(() => {
    const botones = Array.from(document.querySelectorAll('.imp-galeria button[aria-label^="Quitar la foto"]'));
    botones[1]?.click();
    const checks = Array.from(document.querySelectorAll('input[aria-label^="Incluir la variante"]'));
    checks[checks.length - 1]?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  await pulsarPorTexto(page, "Guardar y seguir luego");
  await new Promise((r) => setTimeout(r, 3000));

  await page.goto(`${BASE}/admin/importar?job=${jobGuardar}`, { waitUntil: "networkidle2" });
  const despues = await page.evaluate(() => ({
    fotos: document.querySelectorAll(".imp-galeria img").length,
    variantes: document.querySelectorAll('input[aria-label^="Incluir la variante"]').length,
    marcadas: Array.from(document.querySelectorAll('input[aria-label^="Incluir la variante"]')).filter((i) => i.checked).length,
  }));
  anotar(
    "9c · «Guardar y seguir luego» conserva el trabajo",
    "quitar una foto, descartar una variante, guardar y volver a abrir el borrador",
    "al volver, la foto sigue estando disponible y la variante sigue descartada",
    `antes ${antes.fotos} fotos / ${antes.variantes} variantes → después ${despues.fotos} fotos / ${despues.variantes} variantes (${despues.marcadas} marcadas)`,
    despues.fotos === antes.fotos && despues.marcadas === antes.variantes - 1 ? "OK" : "ROTO",
  );
}

/* ── 9d · la plantilla: ¿se descarga el fichero de verdad? ── */
if (activo("plantilla")) {
  const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const destino = mkdtempSync(pathMod.join(tmpdir(), "bloomdl-"));

  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: destino });

  await page.goto(`${BASE}/admin/importar?tab=csv`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#imp-csv", { timeout: 20000 }).catch(async () => {
    await page.$$eval(".imp-tab", (els) => els[3].click());
    await page.waitForSelector("#imp-csv", { timeout: 20000 });
  });
  await pulsarPorTexto(page, "Descargar plantilla");
  await new Promise((r) => setTimeout(r, 4000));

  const ficheros = readdirSync(destino).filter((f) => !f.endsWith(".crdownload"));
  const contenido = ficheros.length ? readFileSync(pathMod.join(destino, ficheros[0]), "utf8") : "";
  anotar(
    "9d · la plantilla llega al disco",
    "pulsar «Descargar plantilla de ejemplo» con las descargas permitidas",
    "un .csv en la carpeta de descargas, con las cabeceras que entiende el importador",
    ficheros.length
      ? `${ficheros.join(", ")} · primera línea: ${contenido.split("\n")[0]}`
      : `no llegó ningún fichero a ${destino}`,
    ficheros.length > 0 && /handle,title/.test(contenido) ? "OK" : "ROTO",
  );
}

/* ── 10 · el aviso que más importa: «se publicó a precio 0» ── */
if (activo("aviso0")) {
  const csvSinPrecio = ["handle,title,sku,option1_name,option1_value", "qa-sin-precio,QA Sin precio,QA-SP-1,Talla,U"].join("\n");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const dir = mkdtempSync(pathMod.join(tmpdir(), "bloomqa-"));
  const fichero = pathMod.join(dir, "qa-sin-precio.csv");
  writeFileSync(fichero, csvSinPrecio, "utf8");

  await page.goto(`${BASE}/admin/importar?tab=csv`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#imp-csv", { timeout: 20000 }).catch(async () => {
    await page.$$eval(".imp-tab", (els) => els[3].click());
    await page.waitForSelector("#imp-csv", { timeout: 20000 });
  });
  const input = await page.$("#imp-csv");
  await input.uploadFile(fichero);
  await new Promise((r) => setTimeout(r, 800));
  await pulsarPorTexto(page, "Importar «qa-sin-precio.csv»");
  await new Promise((r) => setTimeout(r, 3000));
  await pulsarPorTexto(page, "Revisar el primero");
  await page.waitForFunction(() => location.search.includes("job="), { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  const avisoAntes = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".imp-aviso-cuerpo"))
      .map((n) => n.textContent.trim())
      .filter((t) => /precio 0/i.test(t))
      .join(" · "),
  );

  await pulsarPorTexto(page, "Publicar como borrador");
  await new Promise((r) => setTimeout(r, 4000));

  const despues = await page.evaluate(() => ({
    texto: document.body.innerText.replace(/\s+/g, " "),
    tarjetas: Array.from(document.querySelectorAll(".adm-card-title, .adm-card h3")).map((n) => n.textContent.trim().slice(0, 50)),
  }));
  const avisoTrasPublicar = /precio 0|se venderá gratis/i.test(despues.texto);

  const creado = await db.product.findFirst({ where: { slug: { startsWith: "qa-sin-precio" } }, select: { priceCents: true, slug: true } });
  anotar(
    "10 · aviso «quedó a precio 0» tras publicar",
    "importar por CSV un producto sin precio ni coste y publicarlo",
    "tras publicar, la pantalla avisa de que se quedó a 0",
    `en la vista previa ${avisoAntes ? "sí avisa" : "no avisa"}; tras publicar ${avisoTrasPublicar ? "sí avisa" : "NO avisa"} (tarjetas: ${despues.tarjetas.join(" | ")}); en la BD priceCents=${creado?.priceCents}`,
    avisoTrasPublicar ? "OK" : "ROTO",
  );
}

/* ─────────────────────────────── resumen ─────────────────────────────── */

console.log("\n─────────── RESUMEN ───────────");
const cuenta = FILAS.reduce((acc, f) => ({ ...acc, [f.veredicto]: (acc[f.veredicto] ?? 0) + 1 }), {});
console.log(JSON.stringify(cuenta));
console.log("\n─────────── TABLA (markdown) ───────────");
console.log("| Paso | Qué hice | Qué esperaba | Qué pasó | Veredicto |");
console.log("|---|---|---|---|---|");
for (const f of FILAS) {
  const esc = (t) => String(t).replace(/\|/g, "\\|").replace(/\n/g, " ");
  console.log(`| ${esc(f.paso)} | ${esc(f.hice)} | ${esc(f.esperaba)} | ${esc(f.ocurrio)} | ${f.veredicto} |`);
}

await browser.close();
await db.$disconnect();
