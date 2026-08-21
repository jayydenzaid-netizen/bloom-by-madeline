// Prueba de los cuatro fallos del NÚCLEO del importador (1, 2, 3 y 4 del informe).
//
// No lee código: hace clic con Chrome real y luego mira la base de datos, que es
// donde se ve si un producto sigue a la venta o si una foto se perdió.
//
// Uso:
//   node qa/nucleo-importador.mjs                 -> todo, contra localhost:4661
//   node qa/nucleo-importador.mjs --only=f1
//   node qa/nucleo-importador.mjs --limpiar       -> borra SOLO lo que crea este arnés
//
// Bloques: f1 (actualizar no tumba), f2 (guardar y seguir luego), f3 (precio del
// CSV), f4 (el aviso sobrevive).

import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import pathMod from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const BASE = flag("base", "http://localhost:4661");
const EMAIL = flag("email", "madeline@bloombymadeline.com");
const PASSWORD = flag("password", "bloom2026");
const only = flag("only", "");
const BLOQUES = only ? only.split(",").map((s) => s.trim()) : null;
const activo = (b) => !BLOQUES || BLOQUES.includes(b);

const db = new PrismaClient();

/* ── marcas propias: nada de esto se cruza con la otra sesión ── */
const ID_ACTIVO = "1005006543214661";
const ID_GUARDAR = "1005006543214662";
const HANDLES = ["qa4661-blusa-lino", "qa4661-sin-precio"];

const FILAS = [];
function anotar(paso, esperaba, ocurrio, veredicto) {
  FILAS.push({ paso, esperaba, ocurrio, veredicto });
  console.log(`[${veredicto === "OK" ? "  OK  " : " ROTO "}] ${paso}\n         ${ocurrio}`);
}

/* ─────────────────────────── fixture de AliExpress ─────────────────────────── */

function estado(productId, titulo) {
  return {
    data: {
      actionModule: { productId, itemStatus: 0 },
      titleModule: { subject: titulo, formatTradeCount: "1,203 vendidos" },
      imageModule: {
        imagePathList: [
          "//ae01.alicdn.com/kf/S1a.jpg_640x640q90.jpg",
          "https://ae01.alicdn.com/kf/S2b.png_220x220.png",
          "//ae01.alicdn.com/kf/S3c.jpg",
          "//ae01.alicdn.com/kf/S4d.jpg",
          "//ae01.alicdn.com/kf/S5e.jpg",
        ],
      },
      priceModule: {
        formatedPrice: "US $15.99 - US $22.50",
        minAmount: { value: 15.99, currency: "USD" },
        maxAmount: { value: 22.5, currency: "USD" },
      },
      skuModule: {
        productSKUPropertyList: [
          {
            skuPropertyId: 14,
            skuPropertyName: "Color",
            skuPropertyValues: [
              { propertyValueId: 350852, propertyValueName: "Red", propertyValueDisplayName: "Rojo" },
              { propertyValueId: 350850, propertyValueName: "Black", propertyValueDisplayName: "Negro" },
            ],
          },
        ],
        skuPriceList: [
          {
            skuId: "1200003718" + String(productId).slice(-4) + "1",
            skuAttr: "14:350852#Red",
            skuPropIds: "350852",
            skuVal: { skuAmount: { value: 15.99, currency: "USD" }, availQuantity: 120 },
          },
          {
            skuId: "1200003718" + String(productId).slice(-4) + "2",
            skuAttr: "14:350850#Black",
            skuPropIds: "350850",
            skuVal: { skuAmount: { value: 18.9, currency: "USD" }, availQuantity: 55 },
          },
        ],
      },
      specsModule: { props: [{ attrName: "Material", attrValue: "Poliéster" }] },
      storeModule: { storeName: "Chic Fashion Store" },
    },
    csrfToken: "abc123",
  };
}

function htmlFicha(productId, titulo) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${titulo}</title></head><body>
<div id="root"></div>
<script type="text/javascript">window.runParams = ${JSON.stringify(estado(productId, titulo))};</script>
</body></html>`;
}

/* ───────────────────────────────── utilidades ───────────────────────────────── */

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

/** Como pulsarPorTexto, pero se planta si el botón no está: un clic al aire falsea la prueba. */
async function pulsarSeguro(page, texto, selector = "button, a") {
  const ok = await pulsarPorTexto(page, texto, selector);
  if (!ok) throw new Error(`No encontré ningún «${texto}» que pulsar.`);
  return ok;
}

async function pulsarPorTexto(page, texto, selector = "button, a") {
  return page.evaluate(
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
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let COOKIE = "";
async function pedir(url) {
  const res = await fetch(url, { redirect: "manual", headers: COOKIE ? { Cookie: COOKIE } : {} });
  await res.text().catch(() => "");
  return res.status;
}

async function borrarProducto(p) {
  await db.collectionProduct.deleteMany({ where: { productId: p.id } });
  await db.productImage.deleteMany({ where: { productId: p.id } });
  await db.productVariant.deleteMany({ where: { productId: p.id } });
  await db.product.delete({ where: { id: p.id } });
}

async function limpiar() {
  const jobs = await db.importJob.findMany({
    where: {
      OR: [
        { sourceUrl: { contains: ID_ACTIVO } },
        { sourceUrl: { contains: ID_GUARDAR } },
        { draftJson: { contains: "QA4661" } },
      ],
    },
    select: { id: true },
  });
  const productos = await db.product.findMany({
    where: { OR: [{ sourceProductId: { in: [ID_ACTIVO, ID_GUARDAR, ...HANDLES] } }, { title: { contains: "QA4661" } }] },
    select: { id: true, slug: true },
  });
  await db.importJob.deleteMany({ where: { id: { in: jobs.map((j) => j.id) } } });
  for (const p of productos) await borrarProducto(p);
  console.log(`Limpio: ${jobs.length} jobs y ${productos.length} productos (${productos.map((p) => p.slug).join(", ")}).`);
}

if (args.includes("--limpiar")) {
  await limpiar();
  await db.$disconnect();
  process.exit(0);
}

/* ───────────────────────────────── arranque ───────────────────────────────── */

const ajustes = await db.setting.findUnique({ where: { key: "pricing" } });
const REGLA = JSON.parse(ajustes?.value ?? '{"multiplier":2.6,"addCents":500,"rounding":"99"}');
console.log(`Regla de precio: x${REGLA.multiplier} + ${REGLA.addCents}c → ${REGLA.rounding}`);
console.log(`Base: ${BASE}\n`);

await limpiar();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  args: ["--disable-gpu", "--hide-scrollbars", "--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1200 });

await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle2", timeout: 60000 });
await page.type('input[name="email"]', EMAIL, { delay: 3 });
await page.type('input[name="password"]', PASSWORD, { delay: 3 });
await Promise.all([
  page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {}),
  page.click('button[type="submit"]'),
]);
COOKIE = (await browser.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
if (page.url().includes("/admin/login")) {
  console.error("No se pudo entrar al panel.");
  await browser.close();
  await db.$disconnect();
  process.exit(1);
}

/** Importa el fixture por HTML y devuelve el jobId. */
async function importarHtml(productId, titulo) {
  await page.goto(`${BASE}/admin/importar?tab=html`, { waitUntil: "networkidle2", timeout: 60000 });
  // El formulario es un componente cliente: pulsar antes de que React se haya
  // enganchado no dispara nada y la prueba se queda esperando una pantalla que
  // nadie pidió. Se reintenta hasta que la URL cambia a ?job=.
  for (let intento = 0; intento < 4; intento++) {
    await esperar(1200);
    await escribir(page, "#imp-url-html", `https://www.aliexpress.com/item/${productId}.html`);
    await escribir(page, "#imp-html", htmlFicha(productId, titulo));
    await pulsarSeguro(page, "Leer la ficha");
    const llego = await page
      .waitForFunction(() => location.search.includes("job="), { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    if (llego) break;
  }
  // Hidratado de verdad: el editor es un componente cliente y sus clics no valen
  // hasta que React se ha enganchado a los nodos.
  await page.waitForSelector('input[name="imp-estado"]', { timeout: 30000 });
  await esperar(2500);
  return new URL(page.url()).searchParams.get("job") ?? "";
}

/* ══════════════════ FALLO 1 · actualizar no tumba lo que está a la venta ══════════════════ */

if (activo("f1")) {
  const jobA = await importarHtml(ID_ACTIVO, "QA4661 Vestido a la venta");

  // Publicar ACTIVO: se marca el radio «Activo, a la venta». Se comprueba que el
  // clic prendió mirando cómo cambia el texto del botón de publicar.
  await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[name="imp-estado"]'));
    radios[1]?.click();
  });
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("button")).some((b) => b.textContent.includes("poner a la venta")),
    { timeout: 15000 },
  );
  await pulsarSeguro(page, "Publicar y poner a la venta");
  await esperar(4500);

  const job = await db.importJob.findUnique({ where: { id: jobA } });
  const producto = await db.product.findUnique({ where: { id: job?.productId ?? "" } });
  const antesHttp = [];
  for (let i = 0; i < 3 && producto; i++) {
    antesHttp.push(await pedir(`${BASE}/producto/${producto.slug}`));
    await esperar(1200);
  }

  anotar(
    "f1 · punto de partida: producto publicado ACTIVO",
    "estado active y ficha pública en 200",
    `estado ${producto?.status}, publishedAt ${producto?.publishedAt ? "sí" : "no"}, GET /producto/${producto?.slug} → ${antesHttp.join("/")}`,
    producto?.status === "active" && antesHttp.at(-1) === 200 ? "OK" : "ROTO",
  );

  // Reimportar el MISMO producto: sale el aviso de duplicado.
  const jobB = await importarHtml(ID_ACTIVO, "QA4661 Vestido a la venta");
  const aviso = await page.evaluate(() => {
    // El banner de duplicado no es el único aviso amarillo de la pantalla: hay
    // que buscar el que habla del producto que ya existe.
    const cajas = Array.from(document.querySelectorAll(".imp-aviso-warning .imp-aviso-cuerpo"));
    const n = cajas.find((c) => (c.textContent || "").includes("Ya lo tienes"));
    return n ? n.textContent.trim().slice(0, 200) : (cajas[0]?.textContent.trim().slice(0, 200) ?? null);
  });
  anotar(
    "f1b · el aviso de duplicado dice EN QUÉ ESTADO está",
    "«Ya lo tienes y está a la venta»",
    aviso ?? "no salió ningún aviso",
    (aviso ?? "").includes("está a la venta") ? "OK" : "ROTO",
  );

  // El botón del fallo: «Actualizar el que ya tengo».
  await pulsarSeguro(page, "Actualizar el que ya tengo");
  await esperar(5000);

  const despues = await db.product.findUnique({ where: { id: producto?.id ?? "" } });
  // Dos veces: el servidor de desarrollo recompila rutas al vuelo y la primera
  // petición tras un cambio puede contestar cualquier cosa. La que cuenta es la
  // segunda, igual que lo que vería una clienta.
  const http1 = despues ? await pedir(`${BASE}/producto/${despues.slug}`) : 0;
  await esperar(1500);
  const http2 = despues ? await pedir(`${BASE}/producto/${despues.slug}`) : 0;
  const jobBFila = await db.importJob.findUnique({ where: { id: jobB } });

  // Y lo que la pantalla le cuenta después de actualizar tiene que cuadrar con
  // la realidad: nada de «está en borrador» sobre un producto que está a la venta.
  const dice = await page.evaluate(() => {
    const n = document.querySelector(".imp-resultado p");
    return n ? n.textContent.trim().slice(0, 160) : null;
  });
  // Ojo: la pantalla que QUEDA no es la del editor (se desmonta al refrescar,
  // ver fallo 4) sino la tarjeta del servidor. Lo que se comprueba es que lo que
  // lee la dueña sea verdad: a la venta, no «en borrador».
  anotar(
    "f1d · lo que dice la pantalla tras actualizar",
    "que sigue a la venta, no que quedó en borrador",
    dice ?? "no se pintó ningún mensaje",
    (dice ?? "").includes("a la venta") && !(dice ?? "").includes("borrador") ? "OK" : "ROTO",
  );

  anotar(
    "f1c · «Actualizar el que ya tengo» sobre un producto ACTIVO",
    "sigue active y su URL sigue respondiendo 200",
    `estado ${despues?.status}, publishedAt ${despues?.publishedAt ? "sí" : "no"}, GET /producto/${despues?.slug} → ${http1}/${http2}, job ${jobBFila?.status}`,
    despues?.status === "active" && http2 === 200 ? "OK" : "ROTO",
  );
}

/* ══════════════════ FALLO 2 · «Guardar y seguir luego» conserva las decisiones ══════════════════ */

if (activo("f2")) {
  const jobId = await importarHtml(ID_GUARDAR, "QA4661 Vestido para guardar");

  const antes = await page.evaluate(() => ({
    fotos: document.querySelectorAll(".imp-galeria img").length,
    variantes: document.querySelectorAll('input[aria-label^="Incluir la variante"]').length,
  }));

  // Quitar la última foto y descartar la segunda variante.
  await page.evaluate(() => {
    const botones = Array.from(document.querySelectorAll('.imp-foto button[aria-label^="Quitar la foto"]'));
    botones[botones.length - 1]?.click();
  });
  await esperar(200);
  await page.evaluate(() => {
    const checks = Array.from(document.querySelectorAll('input[aria-label^="Incluir la variante"]'));
    checks[1]?.click();
  });
  await esperar(300);

  await pulsarPorTexto(page, "Guardar y seguir luego");
  await esperar(3500);

  const job = await db.importJob.findUnique({ where: { id: jobId } });
  const borrador = JSON.parse(job?.draftJson ?? "{}");

  anotar(
    "f2 · el borrador guardado conserva TODAS las fotos",
    `${antes.fotos} imágenes en el borrador + la decisión aparte`,
    `images=${borrador.images?.length} · revision.imagenesExcluidas=${JSON.stringify(borrador.revision?.imagenesExcluidas)} · revision.variantesDescartadas=${JSON.stringify(borrador.revision?.variantesDescartadas)}`,
    borrador.images?.length === antes.fotos &&
      (borrador.revision?.imagenesExcluidas ?? []).length === 1 &&
      (borrador.revision?.variantesDescartadas ?? []).length === 1
      ? "OK"
      : "ROTO",
  );

  // Recargar la pantalla: ¿se ve exactamente lo que se dejó?
  await page.goto(`${BASE}/admin/importar?job=${jobId}`, { waitUntil: "networkidle2", timeout: 60000 });
  await esperar(2500);
  const vuelta = await page.evaluate(() => {
    const checks = Array.from(document.querySelectorAll('input[aria-label^="Incluir la variante"]'));
    const fuera = document.querySelectorAll(".imp-foto.is-fuera").length;
    const titulo = Array.from(document.querySelectorAll(".adm-card-title, h2, h3"))
      .map((n) => n.textContent.trim())
      .find((t) => t.startsWith("Fotos"));
    return {
      fotos: document.querySelectorAll(".imp-galeria img").length,
      fuera,
      titulo: titulo ?? null,
      variantesMarcadas: checks.map((c) => c.checked),
    };
  });

  anotar(
    "f2b · al reabrir se ve lo que se dejó",
    "la foto quitada sigue estando (excluida) y la variante sigue descartada",
    `${vuelta.fotos} fotos en pantalla, ${vuelta.fuera} marcadas fuera, cabecera «${vuelta.titulo}», variantes ${JSON.stringify(vuelta.variantesMarcadas)}`,
    vuelta.fotos === antes.fotos && vuelta.fuera === 1 && vuelta.variantesMarcadas[1] === false ? "OK" : "ROTO",
  );

  // Y al publicar desde ese borrador reabierto: la foto excluida NO entra, la
  // variante descartada NO se crea y los precios siguen siendo los de la regla.
  await pulsarSeguro(page, "Publicar como borrador");
  await esperar(4500);
  const job2 = await db.importJob.findUnique({ where: { id: jobId } });
  const producto = await db.product.findUnique({
    where: { id: job2?.productId ?? "" },
    include: { images: true, variants: true },
  });
  anotar(
    "f2c · publicar el borrador reabierto respeta las decisiones",
    `${antes.fotos - 1} fotos, 1 variante, precios de la regla (46.99)`,
    producto
      ? `${producto.images.length} imágenes, ${producto.variants.length} variantes (${producto.variants.map((v) => `${v.title} ${v.priceCents}`).join(", ")})`
      : `el job quedó en ${job2?.status} sin producto`,
    producto?.images.length === antes.fotos - 1 &&
      producto.variants.length === 1 &&
      producto.variants[0].priceCents === 4699
      ? "OK"
      : "ROTO",
  );
}

/* ══════════════════ FALLO 3 y 4 · CSV ══════════════════ */

if (activo("f3") || activo("f4")) {
  const csv = [
    "handle,title,description,price,cost,sku,option1_name,option1_value,image_url,tags,status",
    'qa4661-blusa-lino,QA4661 Blusa de lino,"Blusa ligera.",39.99,12.00,QA4661-001,Talla,S,https://ejemplo.com/qa-1.jpg,blusas|qa,draft',
    "qa4661-sin-precio,QA4661 Sin precio,,,,QA4661-002,Talla,U,https://ejemplo.com/qa-2.jpg,,",
  ].join("\n");

  await page.goto(`${BASE}/admin/importar?tab=csv`, { waitUntil: "networkidle2", timeout: 60000 });
  const dir = mkdtempSync(pathMod.join(tmpdir(), "bloomqa4661-"));
  const fichero = pathMod.join(dir, "qa4661.csv");
  writeFileSync(fichero, csv, "utf8");
  const input = await page.$("#imp-csv");
  await input.uploadFile(fichero);
  await esperar(800);
  await pulsarPorTexto(page, "Importar «qa4661.csv»");
  await esperar(4000);

  const jobsCsv = await db.importJob.findMany({
    where: { provider: "csv", draftJson: { contains: "QA4661" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, draftJson: true },
  });
  console.log(`  (jobs CSV creados: ${jobsCsv.length})`);

  const jobPrecio = jobsCsv.find((j) => (j.draftJson ?? "").includes("Blusa de lino"));
  const jobSinPrecio = jobsCsv.find((j) => (j.draftJson ?? "").includes("Sin precio"));

  if (activo("f3") && jobPrecio) {
    await page.goto(`${BASE}/admin/importar?job=${jobPrecio.id}`, { waitUntil: "networkidle2", timeout: 60000 });
    await esperar(2500);
    const vista = await page.evaluate(() => ({
      precios: Array.from(document.querySelectorAll('input[aria-label^="Precio de venta de"]')).map((i) => i.value),
      costes: Array.from(document.querySelectorAll('input[aria-label^="Coste de"]')).map((i) => i.value),
      etiquetas: Array.from(document.querySelectorAll(".imp-manual")).map((n) => n.textContent.trim()),
    }));

    anotar(
      "f3 · la vista previa respeta el precio del fichero",
      "39.99 (el del CSV), no 36.99 (la regla)",
      `precio en pantalla ${vista.precios.join("/")} · coste ${vista.costes.join("/")} · etiquetas ${vista.etiquetas.join(" | ")}`,
      vista.precios[0] === "39.99" && vista.etiquetas.some((e) => e.includes("precio del fichero")) ? "OK" : "ROTO",
    );

    await pulsarPorTexto(page, "Publicar como borrador");
    await esperar(4000);
    const job = await db.importJob.findUnique({ where: { id: jobPrecio.id } });
    const producto = await db.product.findUnique({
      where: { id: job?.productId ?? "" },
      include: { variants: true },
    });
    anotar(
      "f3b · el precio del fichero llega a la BASE DE DATOS",
      "priceCents 3999 en producto y variante",
      producto
        ? `producto ${producto.priceCents}, variantes ${producto.variants.map((v) => v.priceCents).join("/")}, coste ${producto.costCents}`
        : `el job quedó en ${job?.status} sin producto`,
      producto?.priceCents === 3999 && producto.variants.every((v) => v.priceCents === 3999) ? "OK" : "ROTO",
    );
  }

  if (activo("f4") && jobSinPrecio) {
    await page.goto(`${BASE}/admin/importar?job=${jobSinPrecio.id}`, { waitUntil: "networkidle2", timeout: 60000 });
    await esperar(2500);
    await pulsarPorTexto(page, "Publicar como borrador");
    await esperar(4000);

    const job = await db.importJob.findUnique({ where: { id: jobSinPrecio.id } });
    const producto = await db.product.findUnique({
      where: { id: job?.productId ?? "" },
      include: { variants: true },
    });
    const revision = JSON.parse(job?.draftJson ?? "{}").revision ?? {};
    const avisos = revision.avisosPublicacion ?? [];

    anotar(
      "f4 · el aviso «se venderá gratis» queda guardado en el job",
      "draftJson → revision.avisosPublicacion con el aviso de precio 0",
      `producto priceCents ${producto?.priceCents} · avisosPublicacion: ${JSON.stringify(avisos)}`,
      avisos.some((a) => a.includes("precio 0")) ? "OK" : "ROTO",
    );
  }
}

/* ─────────────────────────────── resumen ─────────────────────────────── */

console.log("\n───────── resumen ─────────");
const rotos = FILAS.filter((f) => f.veredicto !== "OK");
console.log(`${FILAS.length} comprobaciones · ${FILAS.length - rotos.length} OK · ${rotos.length} ROTO`);
for (const f of rotos) console.log(`  ROTO: ${f.paso} → ${f.ocurrio}`);

await browser.close();
await db.$disconnect();
