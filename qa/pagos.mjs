// Recorre el circuito de pagos ENTERO con Chrome de verdad, sin cuenta real:
// panel Pagos (guardar/validar/activar una llave falsa de Stripe), el checkout
// ofreciendo la tarjeta, y la caída con gracia cuando la pasarela rechaza la
// llave — el pedido tiene que sobrevivir con su botón «Pagar ahora».
//
// No cobra nada ni puede: la llave es inventada. Lo que protege es el CABLEADO
// (panel → BD cifrada → checkout → pedido) y los mensajes que ve cada una.
//
// Uso:
//   npm run qa:pagos                       (contra el localhost del dev)
//   node qa/pagos.mjs -- --base=http://…
//
// ⚠ Escribe en la BD del .env (guarda y luego QUITA una llave falsa de Stripe,
// y crea un pedido de prueba). Nunca contra producción con clientas dentro.

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};

const BASE = flag("base", "http://localhost:4590");
const USUARIO = flag("usuario", process.env.ADMIN_USERNAME || "");
const CLAVE = flag("password", process.env.ADMIN_PASSWORD || "");

// Formato válido (sk_test_…), cuenta inexistente: Stripe la rechaza siempre.
const LLAVE_FALSA = "sk_test_qa_bloom_llave_falsa_0000000000000000";

if (!USUARIO || !CLAVE) {
  console.error("Faltan credenciales: ADMIN_USERNAME y ADMIN_PASSWORD en el .env, o --usuario= y --password=.");
  process.exit(2);
}

const navegador = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  defaultViewport: { width: 1280, height: 900 },
});

const resultados = [];
const anota = (nombre, ok, detalle = "") => {
  resultados.push({ nombre, ok });
  console.log(`${ok ? "  OK " : "FALLO"} ${nombre}${detalle ? ` — ${detalle}` : ""}`);
};

/** Espera a que la URL o el DOM cumplan una condición, sin tiempos fijos. */
async function esperar(page, condicion, ms = 20000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await page.evaluate(condicion).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Espera a que la server action termine. Las actions del panel redirigen con
 * ?hecho=/?error= mediante navegación SUAVE del router (sin recarga), así que
 * esperar «que haya un aviso» leería el aviso viejo: lo fiable es esperar a que
 * cambie la query de la URL.
 */
async function esperarRespuesta(page, searchAntes) {
  const cambio = await esperar(
    page,
    new Function(`return location.search !== ${JSON.stringify(searchAntes)};`),
  );
  await new Promise((r) => setTimeout(r, 400));
  return cambio;
}

/** Envía el formulario que contiene `selector` y espera la vuelta de la action. */
async function enviarFormularioDe(page, selector) {
  const antes = await page.evaluate(() => location.search);
  await page.evaluate((sel) => {
    document.querySelector(sel)?.closest("form")?.querySelector('button[type="submit"]')?.click();
  }, selector);
  await esperarRespuesta(page, antes);
}

const contexto = await navegador.createBrowserContext();
const page = await contexto.newPage();

/* ── 1. Entrar al panel y abrir Pagos ── */
await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle2", timeout: 90000 });
await page.type('input[name="usuario"]', USUARIO, { delay: 8 });
await page.type('input[name="password"]', CLAVE, { delay: 8 });
await Promise.all([
  page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
  page.click('button[type="submit"]'),
]);

await page.goto(`${BASE}/admin/pagos`, { waitUntil: "networkidle2", timeout: 90000 });
const tarjetas = await page.evaluate(() => document.body.innerText);
anota(
  "la página Pagos pinta las tres pasarelas y los métodos sin pasarela",
  // Con /i a la fuerza: los titulos van en mayusculas por CSS e innerText las
  // devuelve asi. Sin /i, esta comprobacion solo pasaba de casualidad, porque el
  // nombre aparecia ademas en la guia de abajo escrito en minusculas.
  /stripe/i.test(tarjetas) && /paypal/i.test(tarjetas) && /square/i.test(tarjetas) && /sin pasarela/i.test(tarjetas),
);
anota(
  "el enlace Pagos está en el menú lateral",
  await page.evaluate(() => !![...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/admin/pagos")),
);

/* ── 2. Una llave publicable (pk_) se rechaza con su explicación ── */
await page.type("#stripe-key", "pk_live_esta_no_cobra_nada");
await enviarFormularioDe(page, "#stripe-key");
anota(
  "una llave pk_ se rechaza explicando que no es la secreta",
  await page.evaluate(() => /pk_.*publicable|no parece la llave SECRETA/i.test(document.querySelector(".pag-aviso")?.textContent ?? "")),
  await page.evaluate(() => document.querySelector(".pag-aviso")?.textContent?.trim().slice(0, 90) ?? "(sin aviso)"),
);

/* ── 3. Activar sin llave guardada tampoco cuela ── */
await page.evaluate(() => {
  const check = document.querySelector('#stripe-key')?.closest("form")?.querySelector('input[name="activo"]');
  if (check && !check.checked) check.click();
});
await enviarFormularioDe(page, "#stripe-key");
anota(
  "activar Stripe sin llave se rechaza",
  await page.evaluate(() => /primero pega su llave/i.test(document.querySelector(".pag-aviso")?.textContent ?? "")),
);

/* ── 4. Guardar la llave falsa (formato bueno) y activar ── */
await page.type("#stripe-key", LLAVE_FALSA);
await page.evaluate(() => {
  const check = document.querySelector('#stripe-key')?.closest("form")?.querySelector('input[name="activo"]');
  if (check && !check.checked) check.click();
});
await enviarFormularioDe(page, "#stripe-key");
// ⭐ LA COMPROBACIÓN QUE MÁS IMPORTA. Una llave con formato bueno pero que la
// pasarela rechaza NO puede encender el cobro: si lo hiciera, el checkout
// ofrecería «Pagar con tarjeta», la clienta llegaría al final, se crearía su
// pedido con la talla apartada y el cobro no ocurriría nunca. Pasó de verdad en
// producción con un token de Square, y de ahí salió este guardia.
// (OJO: los badges van en mayúsculas por CSS e innerText las devuelve así:
// las regex van siempre con /i.)
await esperar(page, () => /rechazó esa llave/i.test(document.querySelector(".pag-aviso")?.textContent ?? ""), 20000);
const trasActivar = await page.evaluate(() => ({
  aviso: document.querySelector(".pag-aviso")?.textContent?.trim() ?? "(sin aviso)",
  activo: /Cobrando/i.test(document.body.innerText),
  // El panel ahora dice POR QUE no se activo, no solo que no se activo: la
  // insignia queda en «Rechazada» y la tarjeta explica que hacer.
  rechazada: /Rechazada/i.test(document.body.innerText),
  diagnostico: /rechazó esas llaves|copiaste enteras/i.test(document.body.innerText),
}));
anota(
  "una llave que la pasarela RECHAZA no puede activarse (queda guardada y apagada)",
  !trasActivar.activo && trasActivar.rechazada && trasActivar.diagnostico && /rechazó esa llave/i.test(trasActivar.aviso),
  trasActivar.aviso.slice(0, 90),
);
anota(
  "la llave no se enseña entera: solo su final",
  await page.evaluate((llave) => !document.body.innerHTML.includes(llave), LLAVE_FALSA),
);

/* ── 5. «Probar conexión» delata la llave falsa sin romper nada ── */
const antesDeProbar = await page.evaluate(() => location.search);
await page.evaluate(() => {
  [...document.querySelectorAll("form")]
    .find((f) => f.querySelector('input[name="proveedor"][value="stripe"]') && /Probar|Comprobar/.test(f.textContent))
    ?.querySelector("button")
    ?.click();
});
await esperarRespuesta(page, antesDeProbar);
await esperar(page, () => /rechaz/i.test(document.querySelector(".pag-aviso")?.textContent ?? ""), 25000);
anota(
  "probar conexión con la llave falsa avisa del rechazo",
  await page.evaluate(() => /rechaz/i.test(document.querySelector(".pag-aviso")?.textContent ?? "") && /Rechazada/i.test(document.body.innerText)),
  await page.evaluate(() => `url=${location.search} aviso=«${document.querySelector(".pag-aviso")?.textContent?.trim().slice(0, 80) ?? "(sin aviso)"}»`),
);

/* ── 6. El checkout ofrece la tarjeta y la pone primera ── */
// El primer enlace de /tienda puede ser un producto AGOTADO (los demo lo son a
// propósito): se recorren las fichas hasta encontrar una con el botón de
// añadir habilitado, igual que haría una clienta.
async function llenarCarrito() {
  await page.goto(`${BASE}/tienda`, { waitUntil: "networkidle2" });
  const rutas = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('a[href^="/producto/"]')].map((a) => a.getAttribute("href")))],
  );
  for (const ruta of rutas.slice(0, 8)) {
    await page.goto(BASE + ruta, { waitUntil: "networkidle2" });
    await page.evaluate(() => {
      const radios = [...document.querySelectorAll('input[type="radio"]')].filter((r) => !r.disabled);
      if (radios.length) radios[0].click();
      else {
        const boton = [...document.querySelectorAll("button")].find((b) => !b.disabled && /^(XS|S|M|L|XL|\d+)$/i.test((b.textContent ?? "").trim()));
        boton?.click();
      }
    });
    const pulsado = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /añadir|agregar|carrito/i.test(x.textContent ?? "") && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    });
    if (pulsado && (await esperar(page, () => Number(document.querySelector(".cart-count")?.textContent ?? "0") > 0, 10000))) {
      return true;
    }
  }
  return false;
}
anota("hay una pieza con stock en el carrito", await llenarCarrito());

await page.goto(`${BASE}/checkout`, { waitUntil: "networkidle2" });
const metodos = await page.evaluate(() =>
  [...document.querySelectorAll('input[name="paymentMethod"]')].map((r) => ({ v: r.value, off: r.disabled, sel: r.checked })),
);
// Con la llave rechazada, el cobro con tarjeta NO se ofrece: aparece apagada
// («Próximamente») y la compra sigue siendo posible por los métodos manuales.
const stripe = metodos.find((m) => m.v === "stripe");
anota(
  "con la llave rechazada, la tarjeta NO se ofrece: sale apagada",
  !!stripe && stripe.off && !stripe.sel,
  JSON.stringify(metodos),
);
anota(
  "aun así se puede terminar la compra por otro método",
  metodos.some((m) => !m.off),
);

/* ── 7. Un pedido por un método manual llega hasta su confirmación ── */
await page.evaluate(() => {
  const poner = (name, valor) => {
    const el = document.querySelector(`[name="${name}"]`);
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    setter?.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  poner("name", "QA Pagos");
  poner("email", "qa-pagos@ejemplo.test");
  poner("line1", "123 Calle de Prueba");
  poner("city", "Hamilton");
  poner("state", "OH");
  poner("zip", "45011");
  // El primer método que SÍ esté disponible (dm o recogida).
  document.querySelector('input[name="paymentMethod"]:not(:disabled)')?.click();
});
await page.evaluate(() => document.querySelector('form button[type="submit"]')?.click());
await esperar(page, () => /\/pedido\//.test(location.pathname), 25000);

const pedidoFinal = await page.evaluate(() => ({
  url: location.pathname + location.search,
  numero: (document.body.innerText.match(/BLM-\d+/) ?? [null])[0],
}));
anota(
  "el pedido se crea y aterriza en su confirmación",
  !!pedidoFinal.numero && /\/pedido\//.test(pedidoFinal.url),
  pedidoFinal.url,
);

/* ── 8. El pedido aparece en el panel ── */
await page.goto(`${BASE}/admin/pedidos`, { waitUntil: "networkidle2" });
anota(
  "el pedido nuevo sale en el panel",
  await page.evaluate((n) => document.body.innerText.includes(n), pedidoFinal.numero ?? "BLM-"),
);

/* ── 9. Limpieza: quitar la llave falsa; el checkout vuelve a Próximamente ── */
await page.goto(`${BASE}/admin/pagos`, { waitUntil: "networkidle2" });
const antesDeQuitar = await page.evaluate(() => location.search);
await page.evaluate(() => {
  [...document.querySelectorAll("form")]
    .find((f) => f.querySelector('input[name="proveedor"][value="stripe"]') && /Quitar|Desconectar/.test(f.textContent))
    ?.querySelector("button")
    ?.click();
});
await esperarRespuesta(page, antesDeQuitar);
await esperar(page, () => /quitadas/i.test(document.querySelector(".pag-aviso")?.textContent ?? ""), 8000);
anota(
  "quitar llaves deja Stripe sin conectar otra vez",
  await page.evaluate(() => /Sin conectar/i.test(document.body.innerText) && /quitadas/i.test(document.querySelector(".pag-aviso")?.textContent ?? "")),
  await page.evaluate(() => document.querySelector(".pag-aviso")?.textContent?.trim().slice(0, 70) ?? "(sin aviso)"),
);

// El carrito se vació al crear el pedido de prueba: se rellena para que el
// checkout vuelva a pintar el selector de métodos.
await llenarCarrito();
await page.goto(`${BASE}/checkout`, { waitUntil: "networkidle2" });
anota(
  "sin llaves, la tarjeta vuelve a «Próximamente» (apagada, no escondida)",
  await page.evaluate(() => {
    const stripe = document.querySelector('input[name="paymentMethod"][value="stripe"]');
    return !!stripe && stripe.disabled && /Próximamente/i.test(document.body.innerText);
  }),
  await page.evaluate(() => JSON.stringify([...document.querySelectorAll('input[name="paymentMethod"]')].map((r) => ({ v: r.value, off: r.disabled })))),
);

await navegador.close();

const fallos = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - fallos.length}/${resultados.length} comprobaciones pasadas`);
process.exit(fallos.length ? 1 : 0);
