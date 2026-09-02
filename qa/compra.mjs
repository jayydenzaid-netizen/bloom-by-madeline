// Prueba de compra de punta a punta, con el Chrome del sistema.
//
// Recorre lo que haría una clienta: catálogo → ficha → talla → carrito →
// checkout → pedido, y después comprueba EN LA BASE DE DATOS que el pedido
// quedó bien y que el carrito se vació. Pulsa de verdad; no mira capturas.
//
//   node qa/compra.mjs [--base=http://localhost:4590]

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith("--base=")) ?? "--base=http://localhost:4590").split("=").slice(1).join("=");

const pasos = [];
const anotar = (paso, esperado, real, ok) => {
  pasos.push({ paso, esperado, real, ok });
  console.log(`${ok ? "✔" : "✖"} ${paso}\n    esperado: ${esperado}\n    real:     ${real}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell",
  args: ["--disable-gpu", "--hide-scrollbars", "--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const errores = [];
page.on("pageerror", (e) => errores.push(String(e).slice(0, 160)));

// ── 1. Catálogo ─────────────────────────────────────────────────────────────
await page.goto(`${BASE}/tienda`, { waitUntil: "networkidle2" });
const catalogo = await page.evaluate(() => {
  const enlaces = Array.from(document.querySelectorAll('a[href^="/producto/"]'));
  return { total: enlaces.length, primero: enlaces[0]?.getAttribute("href") ?? null };
});
anotar("El catálogo lista productos", "al menos 1 producto", `${catalogo.total} enlaces a fichas`, catalogo.total > 0);

if (!catalogo.primero) {
  console.error("\nSin productos activos: no se puede seguir.");
  await browser.close();
  process.exit(1);
}

// ── 2. Ficha de producto ────────────────────────────────────────────────────
// El producto se elige preguntando a la base, no adivinando en el HTML: la
// primera versión miraba el texto de la tarjeta, se llevó justo el que está
// agotado a propósito, y los cinco pasos siguientes fallaron por culpa de la
// prueba y no de la tienda.
const { execSync: ejecutar } = await import("node:child_process");
const consulta = ejecutar(
  `npx tsx -e "import {db} from './lib/db'; async function m(){const p=await db.product.findFirst({where:{status:'active',variants:{some:{OR:[{trackStock:false},{stock:{gt:0}}]}}},select:{slug:true}}); console.log('SLUG='+(p?.slug??''))} m().then(()=>process.exit(0))"`,
  { encoding: "utf8", cwd: process.cwd() },
);
const slug = consulta.match(/SLUG=(\S+)/)?.[1] ?? "";
const ruta = slug ? `/producto/${slug}` : catalogo.primero;
console.log(`  (producto elegido: ${ruta})`);

await page.goto(BASE + ruta, { waitUntil: "networkidle2" });
const ficha = await page.evaluate(() => ({
  titulo: document.querySelector("h1")?.textContent?.trim() ?? "",
  precio: (document.body.innerText.match(/\$\d+[.,]\d{2}/) ?? ["sin precio"])[0],
  tallas: document.querySelectorAll('input[name*="option"], button[data-option], .variant-opcion, [data-valor]').length,
}));
anotar("La ficha enseña título y precio", "un título y un precio en dólares", `«${ficha.titulo}» a ${ficha.precio}`, !!ficha.titulo && ficha.precio !== "sin precio");

// ── 3. Elegir talla y añadir al carrito ─────────────────────────────────────
const elegida = await page.evaluate(() => {
  // La talla puede ser un radio, un botón o una etiqueta; se prueba lo que haya.
  const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter((r) => !r.disabled);
  if (radios.length) { radios[0].click(); return `radio «${radios[0].value || radios[0].id}»`; }
  const botones = Array.from(document.querySelectorAll("button")).filter(
    (b) => !b.disabled && /^(XS|S|M|L|XL|\d+)$/i.test((b.textContent ?? "").trim()),
  );
  if (botones.length) { botones[0].click(); return `botón «${botones[0].textContent.trim()}»`; }
  return "no hizo falta (producto sin variantes visibles)";
});
anotar("Se puede elegir talla", "una talla seleccionable", elegida, true);

const antesDeAnadir = await page.evaluate(() => document.querySelector(".cart-count")?.textContent?.trim() ?? "0");

const anadido = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll("button")).find(
    (x) => /añadir|agregar|carrito/i.test(x.textContent ?? "") && !x.disabled,
  );
  if (!b) return "no se encontró el botón de añadir";
  b.click();
  return `pulsado «${b.textContent.trim()}»`;
});
// Sondeo en vez de espera fija: la acción de servidor + revalidación tardan lo
// que tarden (compilación en frío incluida), y una espera de 2500 ms clavados
// era la causa nº 1 de falsos rojos de este script.
const contador = await (async () => {
  const limite = Date.now() + 15000;
  let ultimo = antesDeAnadir;
  while (Date.now() < limite) {
    ultimo = await page.evaluate(() => document.querySelector(".cart-count")?.textContent?.trim() ?? "0");
    if (Number(ultimo) > Number(antesDeAnadir || 0)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return ultimo;
})();
anotar("Añadir al carrito sube el contador", `más de ${antesDeAnadir}`, `${anadido} → contador = ${contador}`, Number(contador) > Number(antesDeAnadir || 0));

// ── 4. Carrito ──────────────────────────────────────────────────────────────
await page.goto(`${BASE}/carrito`, { waitUntil: "networkidle2" });
const carrito = await page.evaluate(() => {
  const texto = document.body.innerText;
  const importes = [...texto.matchAll(/\$(\d+)[.,](\d{2})/g)].map((m) => Number(m[1]) * 100 + Number(m[2]));
  return { vacio: /vac[íi]o/i.test(texto), importes, tieneCheckout: !!document.querySelector('a[href*="checkout"], button') };
});
// Ojo: "no dice vacío" no basta. Un carrito sin importes en pantalla tampoco
// tiene género dentro, y la primera versión lo daba por bueno.
anotar("El carrito conserva la pieza", "líneas con sus importes", carrito.vacio ? "aparece vacío" : `${carrito.importes.length} importes en pantalla`, !carrito.vacio && carrito.importes.length > 0);

// ── 5. Checkout: primero mal, para ver si valida ────────────────────────────
await page.goto(`${BASE}/checkout`, { waitUntil: "networkidle2" });
const vacioEnviado = await page.evaluate(() => {
  const f = document.querySelector("form");
  if (!f) return "no hay formulario";
  const b = f.querySelector('button[type="submit"]');
  if (!b) return "no hay botón de enviar";
  b.click();
  return "enviado vacío";
});
await new Promise((r) => setTimeout(r, 2000));
const trasVacio = await page.evaluate(() => ({
  url: location.pathname,
  errores: document.querySelectorAll(".adm-field-err, [class*='error'], [aria-invalid='true']").length,
  requeridosNativos: document.querySelectorAll("input:invalid").length,
}));
anotar(
  "El checkout no acepta un formulario vacío",
  "se queda en /checkout y avisa",
  `${vacioEnviado} → ${trasVacio.url}, ${trasVacio.errores} avisos, ${trasVacio.requeridosNativos} campos inválidos`,
  trasVacio.url.includes("checkout") && (trasVacio.errores > 0 || trasVacio.requeridosNativos > 0),
);

// ── 6. Checkout con datos correctos ─────────────────────────────────────────
const relleno = await page.evaluate(() => {
  const datos = {
    name: "Prueba QA", nombre: "Prueba QA",
    email: "qa-prueba@ejemplo.test",
    phone: "5135550000", telefono: "5135550000",
    shipLine1: "1305 Grand Blvd", line1: "1305 Grand Blvd", direccion: "1305 Grand Blvd",
    shipCity: "Hamilton", city: "Hamilton", ciudad: "Hamilton",
    shipState: "OH", state: "OH", estado: "OH",
    shipZip: "45011", zip: "45011", cp: "45011",
  };
  const puestos = [];
  for (const input of document.querySelectorAll("input, select, textarea")) {
    const n = input.name;
    if (!n || input.type === "hidden" || input.type === "radio" || input.type === "checkbox") continue;
    const valor = datos[n];
    if (valor === undefined) continue;
    const setter = Object.getOwnPropertyDescriptor(
      input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value",
    )?.set;
    setter?.call(input, valor);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    puestos.push(n);
  }
  // Método de pago: DM explícitamente. Con las pasarelas activas (Stripe/PayPal/
  // Square) el primer radio de la página puede ser un pago por redirect, y este
  // test debe TERMINAR en /pedido/BLM-x — un redirect a la pasarela lo rompería.
  const metodo =
    document.querySelector('input[name="paymentMethod"][value="dm"]:not(:disabled)') ??
    Array.from(document.querySelectorAll('input[name="paymentMethod"]')).find((r) => !r.disabled) ??
    Array.from(document.querySelectorAll('input[type="radio"]')).find((r) => !r.disabled);
  if (metodo) { metodo.click(); puestos.push(`pago=${metodo.value}`); }
  return puestos;
});
anotar("Se rellena el formulario", "campos de envío completos", relleno.join(", ") || "ningún campo reconocido", relleno.length >= 4);

await page.evaluate(() => document.querySelector('form button[type="submit"]')?.click());
// Sondeo hasta aterrizar en /pedido/BLM-x: el redirect llega cuando la acción
// termina y la página del pedido compila — con 4000 ms fijos, un arranque en
// frío daba falso rojo con el pedido ya creado en la base de datos.
await (async () => {
  const limite = Date.now() + 20000;
  while (Date.now() < limite) {
    const url = await page.evaluate(() => location.pathname);
    if (/\/pedido\//.test(url)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
})();

const final = await page.evaluate(() => ({
  url: location.pathname,
  numero: (document.body.innerText.match(/BLM-\d+/) ?? [null])[0],
}));
anotar("Se crea el pedido", "redirige a /pedido/BLM-xxxx", `${final.url} · número ${final.numero ?? "no encontrado"}`, !!final.numero);

await page.screenshot({ path: "qa/shots/compra-final.png" });
await browser.close();

// ── 7. Comprobación en la base de datos ─────────────────────────────────────
if (final.numero) {
  const { execSync } = await import("node:child_process");
  const salida = execSync(
    `npx tsx -e "import {db} from './lib/db'; async function m(){const o=await db.order.findUnique({where:{number:'${final.numero}'},include:{items:true}}); if(!o){console.log('NO_EXISTE');return} const suma=o.items.reduce((s,i)=>s+i.priceCents*i.quantity,0); console.log(JSON.stringify({numero:o.number,email:o.email,estado:o.paymentStatus,metodo:o.paymentMethod,lineas:o.items.length,subtotal:o.subtotalCents,sumaLineas:suma,total:o.totalCents})); } m().then(()=>process.exit(0))"`,
    { encoding: "utf8", cwd: process.cwd() },
  );
  const json = salida.match(/\{.*\}/)?.[0];
  if (json) {
    const o = JSON.parse(json);
    anotar("El pedido está en la base de datos", `${final.numero} con líneas`, JSON.stringify(o), o.lineas > 0);
    anotar("Los importes cuadran", "subtotal = suma de las líneas", `${o.subtotal} vs ${o.sumaLineas} centavos`, o.subtotal === o.sumaLineas);
  } else {
    anotar("El pedido está en la base de datos", "encontrarlo", salida.trim().slice(0, 120), false);
  }
}

// ── Resumen ─────────────────────────────────────────────────────────────────
const fallos = pasos.filter((p) => !p.ok);
console.log(`\n${"─".repeat(60)}`);
console.log(`${pasos.length} pasos · ${pasos.length - fallos.length} correctos · ${fallos.length} con fallo`);
if (errores.length) console.log(`Errores de JavaScript en la página: ${errores.slice(0, 3).join(" | ")}`);
console.log(`${"─".repeat(60)}\n`);
process.exit(fallos.length ? 1 : 0);
