// QA real de Bloom by Madeline: recorre la tienda y el panel con el Chrome del
// sistema, y comprueba lo que las capturas NO pueden comprobar.
//
// Por qué existe: en este proyecto ya se coló un P0 a producción — una capa
// invisible tapaba el viewport y NADA era clickeable. Sobrevivió a decenas de
// screenshots porque una captura no sabe si algo responde al ratón. Aquí se
// hace hit-testing de verdad con document.elementFromPoint.
//
// Uso:
//   node qa/audit.mjs                 -> audita todo contra localhost:4590
//   node qa/audit.mjs --base=http://localhost:4611
//   node qa/audit.mjs --shots         -> además guarda capturas en qa/shots
//   node qa/audit.mjs --only=/tienda,/admin

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const BASE = flag("base", "http://localhost:4590");
const SHOTS = args.includes("--shots");
// Credenciales del panel. Se entra con usuario, no con correo.
//
// Salen del entorno (los scripts se lanzan con --env-file, ver package.json) o
// de un --flag. Aquí no se escribe la de verdad: este repositorio es público.
const ADMIN_USUARIO = flag("usuario", process.env.ADMIN_USERNAME || "admin");
const ADMIN_PASSWORD = flag("password", process.env.ADMIN_PASSWORD || "bloom2026");
const OUT = path.resolve("qa/shots");

const PUBLICAS = ["/", "/tienda", "/carrito", "/checkout"];

const PANEL = [
  "/admin",
  "/admin/pedidos",
  "/admin/carritos",
  "/admin/productos",
  "/admin/productos/nuevo",
  "/admin/colecciones",
  "/admin/inventario",
  "/admin/inventario/movimientos",
  "/admin/resenas",
  "/admin/importar",
  "/admin/pos",
  "/admin/clientes",
  "/admin/descuentos",
  "/admin/descuentos/nuevo",
  "/admin/informes",
  "/admin/contenido",
  "/admin/paginas",
  "/admin/menus",
  "/admin/medios",
  "/admin/ajustes",
  "/admin/envios",
  "/admin/plantillas",
  "/admin/herramientas",
  "/admin/equipo",
  "/admin/actividad",
  "/admin/cuenta",
];

const only = flag("only", "");
const filtro = only ? only.split(",").map((s) => s.trim()) : null;
const rutas = [...PUBLICAS, ...PANEL].filter((r) => !filtro || filtro.includes(r));

if (SHOTS) mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  // Perfil limpio a propósito: con --user-data-dir persistente Chrome sirve el
  // CSS de caché y los cambios de estilo no aparecen. Ya nos costó una sesión.
  args: ["--disable-gpu", "--hide-scrollbars", "--no-sandbox"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

const errores = [];
page.on("pageerror", (e) => errores.push(String(e).slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") errores.push(m.text().slice(0, 200));
});

// ── Login en el panel ───────────────────────────────────────────────────────
async function login() {
  const res = await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle2", timeout: 45000 });
  if (!res || res.status() >= 400) return { ok: false, motivo: `login devolvió ${res?.status()}` };
  try {
    await page.type('input[name="usuario"]', ADMIN_USUARIO, { delay: 5 });
    await page.type('input[type="password"], input[name="password"]', ADMIN_PASSWORD, { delay: 5 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);
    const url = page.url();
    return { ok: !url.includes("/admin/login"), motivo: url };
  } catch (e) {
    return { ok: false, motivo: String(e).slice(0, 150) };
  }
}

// ── Auditoría de una ruta ───────────────────────────────────────────────────
async function auditar(ruta) {
  errores.length = 0;
  const fila = { ruta, status: 0, titulo: "", texto: 0, bloqueo: null, enlaces: 0, errores: [] };

  // `?static` apaga preloader y animaciones de entrada (el sitio ya lo traía).
  // Sin esto la captura de la portada sale con el logo de carga y aparenta una
  // página vacía: la imagen miente, no la página.
  const url = BASE + ruta + (SHOTS && !ruta.startsWith("/admin") ? (ruta.includes("?") ? "&" : "?") + "static" : "");

  let res;
  try {
    res = await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  } catch (e) {
    fila.status = -1;
    fila.errores.push(`navegación falló: ${String(e).slice(0, 120)}`);
    return fila;
  }

  fila.status = res?.status() ?? 0;

  // El preloader de la portada tarda un poco en irse y `networkidle2` no lo
  // espera: sin esto se captura la pantalla de carga y parece que la página
  // está en blanco. Se espera a que desaparezca, con tope para no colgarse.
  await page
    .waitForFunction(
      () => {
        const pre = document.querySelector(".preloader") || document.getElementById("preloader");
        if (!pre) return true;
        const cs = getComputedStyle(pre);
        return cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05;
      },
      { timeout: 6000 },
    )
    .catch(() => fila.errores.push("el preloader seguía visible tras 6 s"));

  const info = await page.evaluate(() => {
    // Hit-testing: ¿quién recibe el clic en nueve puntos repartidos por la
    // pantalla? Si en todos responde el mismo overlay, la página está muerta
    // aunque la captura se vea perfecta.
    const puntos = [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const fx of [0.15, 0.5, 0.85]) {
      for (const fy of [0.2, 0.5, 0.8]) {
        const el = document.elementFromPoint(Math.round(w * fx), Math.round(h * fy));
        puntos.push(el ? `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}` : "null");
      }
    }
    const unicos = new Set(puntos);

    // Un elemento fijo que ocupe casi toda la pantalla y capture el ratón es
    // exactamente la firma del bug que ya nos pasó.
    let sospechoso = null;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "absolute") continue;
      if (cs.pointerEvents === "none" || cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const cubre = r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9;
      const invisible = Number(cs.opacity) < 0.05;
      if (cubre && invisible) {
        sospechoso = `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} opacity=${cs.opacity} z=${cs.zIndex}`;
        break;
      }
    }

    return {
      titulo: document.title,
      texto: (document.body.innerText || "").trim().length,
      puntosUnicos: unicos.size,
      punto: puntos[4],
      sospechoso,
      enlaces: document.querySelectorAll("a[href], button").length,
      // Next pinta el error en el DOM cuando algo revienta en servidor.
      errorNext: !!document.querySelector("#__next-error__, [data-nextjs-dialog]") ||
        /Application error|Unhandled Runtime Error|Internal Server Error/i.test(document.body.innerText || ""),
    };
  });

  fila.titulo = info.titulo;
  fila.texto = info.texto;
  fila.enlaces = info.enlaces;

  if (info.sospechoso) fila.bloqueo = `capa invisible: ${info.sospechoso}`;
  // Si los nueve puntos devuelven el mismo elemento, algo está tapando todo.
  else if (info.puntosUnicos === 1 && info.enlaces > 3) fila.bloqueo = `todo el viewport responde a ${info.punto}`;

  if (info.errorNext) fila.errores.push("pantalla de error de Next");
  if (info.texto < 80) fila.errores.push(`solo ${info.texto} caracteres de texto`);
  fila.errores.push(...errores.slice(0, 3));

  if (SHOTS) {
    const slug = ruta === "/" ? "home" : ruta.replace(/^\//, "").replace(/\//g, "-");
    await page.screenshot({ path: path.join(OUT, `${slug}.png`), fullPage: false }).catch(() => {});
  }

  return fila;
}

// ── Ejecución ───────────────────────────────────────────────────────────────
const filas = [];

for (const ruta of rutas.filter((r) => !r.startsWith("/admin"))) {
  filas.push(await auditar(ruta));
}

const necesitaPanel = rutas.some((r) => r.startsWith("/admin"));
if (necesitaPanel) {
  const acceso = await login();
  if (!acceso.ok) {
    console.error(`\n⚠ No se pudo entrar al panel (${acceso.motivo}). Las rutas de /admin no se auditan.\n`);
  } else {
    for (const ruta of rutas.filter((r) => r.startsWith("/admin") && r !== "/admin/login")) {
      filas.push(await auditar(ruta));
    }
  }
}

await browser.close();

// ── Informe ─────────────────────────────────────────────────────────────────
const ancho = Math.max(...filas.map((f) => f.ruta.length), 10);
console.log("\n" + "─".repeat(ancho + 46));
console.log(`${"RUTA".padEnd(ancho)}  HTTP  TEXTO   CLIC  PROBLEMAS`);
console.log("─".repeat(ancho + 46));

let fallos = 0;
for (const f of filas) {
  const problemas = [f.bloqueo, ...f.errores].filter(Boolean);
  const ok = f.status === 200 && !f.bloqueo && problemas.length === 0;
  if (!ok) fallos++;
  console.log(
    `${f.ruta.padEnd(ancho)}  ${String(f.status).padStart(4)}  ${String(f.texto).padStart(5)}  ${f.bloqueo ? " NO " : " sí "}  ${problemas.join(" · ").slice(0, 90) || "—"}`
  );
}
console.log("─".repeat(ancho + 46));
console.log(`${filas.length} rutas · ${filas.length - fallos} correctas · ${fallos} con problemas\n`);

writeFileSync(path.resolve("qa/informe.json"), JSON.stringify({ base: BASE, filas }, null, 2));
process.exit(fallos > 0 ? 1 : 0);
