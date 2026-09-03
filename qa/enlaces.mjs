// Recorre la web entera siguiendo enlaces y dice cuáles no llevan a ningún sitio.
//
// Complementa a qa/audit.mjs (que comprueba páginas concretas) y a qa/anclas.mjs
// (que pulsa las anclas de la portada): esto SIGUE los enlaces, así que encuentra
// lo que nadie recordaba mirar — un enlace del pie a una página despublicada, una
// prenda borrada que sigue enlazada desde una colección, un href vacío.
//
// Uso:
//   node qa/enlaces.mjs                                  -> contra localhost:4590
//   node qa/enlaces.mjs --base=https://bloom-by-madeline.vercel.app
//   node qa/enlaces.mjs --max=60

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const BASE = flag("base", "http://localhost:4590").replace(/\/$/, "");
const MAX = Number(flag("max", "40"));

// El panel no se rastrea: pide sesión y ya lo audita qa/audit.mjs.
const FUERA = /^\/(admin|api)\b/;

const navegador = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const pagina = await navegador.newPage();
await pagina.setViewport({ width: 1440, height: 900 });

const vistas = new Set();
const cola = ["/"];
const problemas = [];
/** ruta -> ids que esa página pinta, para validar las anclas de otras páginas. */
const anclasPorRuta = new Map();
/** { desde, href } de cada enlace con ancla, para revisarlos al final. */
const conAncla = [];

while (cola.length > 0 && vistas.size < MAX) {
  const ruta = cola.shift();
  if (vistas.has(ruta)) continue;
  vistas.add(ruta);

  let respuesta;
  try {
    respuesta = await pagina.goto(BASE + ruta, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (e) {
    problemas.push({ ruta, que: `no cargó: ${e.message.split("\n")[0]}` });
    continue;
  }

  const codigo = respuesta?.status() ?? 0;
  const esNotFound = await pagina.evaluate(() =>
    /no encontramos|no existe|404/i.test(document.querySelector("h1")?.textContent || ""),
  );
  if (codigo >= 400 || esNotFound) {
    problemas.push({ ruta, que: `responde ${codigo}${esNotFound ? " (página de «no encontrado»)" : ""}` });
    continue;
  }

  const { ids, enlaces } = await pagina.evaluate(() => ({
    ids: [...document.querySelectorAll("[id]")].map((e) => e.id),
    enlaces: [...document.querySelectorAll("a")].map((a) => ({
      href: a.getAttribute("href") || "",
      texto: (a.textContent || "").trim().slice(0, 40),
    })),
  }));
  anclasPorRuta.set(ruta, new Set(ids));

  for (const { href, texto } of enlaces) {
    if (!href || href === "#") {
      problemas.push({ ruta, que: `enlace sin destino («${texto || "sin texto"}»)` });
      continue;
    }
    if (/^(https?:|mailto:|tel:)/i.test(href)) continue; // externos: no se rastrean
    if (href.startsWith("#") || href.startsWith("/#")) {
      conAncla.push({ desde: ruta, href, texto });
      continue;
    }
    const destino = href.split("?")[0].split("#")[0];
    if (!destino.startsWith("/") || FUERA.test(destino)) continue;
    if (!vistas.has(destino) && !cola.includes(destino)) cola.push(destino);
  }
}

// Las anclas se revisan al final, cuando ya se sabe qué ids pinta cada página.
for (const { desde, href, texto } of conAncla) {
  const id = href.replace(/^\/?#/, "");
  // `/#x` desde otra página apunta a la portada; `#x` a la página en la que está.
  const objetivo = href.startsWith("/#") ? "/" : desde;
  const ids = anclasPorRuta.get(objetivo);
  if (!ids) continue; // esa página no se llegó a visitar
  if (!ids.has(id)) problemas.push({ ruta: desde, que: `«${texto}» apunta a ${href} y ${objetivo} no pinta ese id` });
}

await navegador.close();

console.log(`\nRastreadas ${vistas.size} páginas de ${BASE}`);
console.log([...vistas].sort().join("  "));
if (problemas.length === 0) {
  console.log("\nNingún enlace roto.");
} else {
  console.log(`\n${problemas.length} problema(s):`);
  for (const p of problemas) console.log(`  ${p.ruta.padEnd(28)} ${p.que}`);
}
process.exit(problemas.length === 0 ? 0 : 1);
