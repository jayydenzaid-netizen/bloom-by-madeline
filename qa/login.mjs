// Comprueba la entrada al panel con Chrome de verdad.
//
// Nació al cambiar el login de correo a usuario, porque esa es la puerta: si se
// rompe, la tienda sigue vendiendo pero Madeline se queda fuera de su propio
// panel y no hay forma de arreglarlo desde dentro. Un `npm run qa:login` después
// de tocar auth cuesta veinte segundos.
//
// Uso:
//   npm run qa:login                          (contra el localhost del dev)
//   npm run qa:login -- --base=https://…      (contra producción)
//
// Las credenciales salen del entorno (ADMIN_USERNAME / ADMIN_PASSWORD, que el
// script npm carga del .env) o de --usuario= y --password=. Aquí no se escribe
// ninguna: este repositorio es público.

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
const SHOTS = flag("shots", "qa/shots");

if (!USUARIO || !CLAVE) {
  console.error("Faltan credenciales: pon ADMIN_USERNAME y ADMIN_PASSWORD en el .env, o pasa --usuario= y --password=.");
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
  resultados.push({ nombre, ok, detalle });
  console.log(`${ok ? "  OK " : "FALLO"} ${nombre}${detalle ? ` — ${detalle}` : ""}`);
};

/**
 * Rellena el formulario y dice si acabó dentro del panel.
 *
 * Cada intento estrena contexto (una ventana de incógnito propia) porque la
 * cookie del intento anterior seguiría abierta: al pedir /admin/login con sesión
 * viva, el panel te devuelve al panel y el formulario ni se pinta. La primera
 * versión de este script se estrelló justo ahí.
 */
async function intentar(usuario, clave, nombreShot) {
  const contexto = await navegador.createBrowserContext();
  const page = await contexto.newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: "networkidle2", timeout: 90000 });

  const campos = await page.evaluate(() =>
    [...document.querySelectorAll("form input")].map((i) => ({
      name: i.name,
      type: i.type,
      etiqueta: document.querySelector(`label[for="${i.id}"]`)?.textContent?.trim() ?? "",
    })),
  );

  if (nombreShot) await page.screenshot({ path: `${SHOTS}/${nombreShot}-login.png` });

  await page.type('input[name="usuario"]', usuario, { delay: 8 });
  await page.type('input[name="password"]', clave, { delay: 8 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  // El error del formulario llega por el Server Action, no por navegación.
  await new Promise((r) => setTimeout(r, 1200));

  const url = page.url();
  const error = await page.evaluate(() => document.querySelector(".adm-auth-error")?.textContent?.trim() ?? "");
  const dentro = !url.includes("/admin/login") && url.includes("/admin");

  if (nombreShot && dentro) await page.screenshot({ path: `${SHOTS}/${nombreShot}-panel.png` });
  return { campos, url, error, dentro, page, cerrar: () => contexto.close() };
}

console.log(`Panel: ${BASE}/admin/login · usuario ${USUARIO}\n`);

// 1. La pantalla pide usuario, no correo.
const primero = await intentar(USUARIO, CLAVE, "login");
const nombres = primero.campos.map((c) => c.name);
anota(
  "el formulario pide «usuario» y ya no «email»",
  nombres.includes("usuario") && !nombres.includes("email"),
  nombres.join(", "),
);
const campoUsuario = primero.campos.find((c) => c.name === "usuario");
anota(
  "el campo se llama Usuario y no valida como correo",
  campoUsuario?.etiqueta === "Usuario" && campoUsuario?.type === "text",
  `etiqueta=${campoUsuario?.etiqueta} tipo=${campoUsuario?.type}`,
);

// 2. Entra con las credenciales buenas.
anota("entra con el usuario y la contraseña buenos", primero.dentro, primero.url + (primero.error ? ` · ${primero.error}` : ""));
if (primero.dentro) {
  const texto = await primero.page.evaluate(() => document.body.innerText.slice(0, 100).replace(/\s+/g, " "));
  anota("el panel se pinta de verdad", texto.length > 10, texto);
}
await primero.cerrar();

// 3. En minúsculas también: el teclado del móvil hace lo que quiere.
const minus = await intentar(USUARIO.toLowerCase(), CLAVE, null);
anota("entra igual escribiéndolo en minúsculas", minus.dentro, minus.url);
await minus.cerrar();

// 4. Con espacios pegados de un copiar y pegar.
const espacios = await intentar(`  ${USUARIO}  `, CLAVE, null);
anota("aguanta espacios alrededor", espacios.dentro, espacios.url);
await espacios.cerrar();

// 5. Contraseña mala: no entra y el mensaje no delata cuál de los dos falló.
const mala = await intentar(USUARIO, "estanoeslabuena123", null);
anota("con la contraseña mala no entra", !mala.dentro, mala.url);
anota("el error es el genérico", mala.error === "Usuario o contraseña incorrectos.", mala.error || "(sin mensaje)");
await mala.cerrar();

// 6. Sin sesión, el panel no se pinta ni por asomo.
const limpio = await navegador.createBrowserContext();
const anonima = await limpio.newPage();
await anonima.goto(`${BASE}/admin`, { waitUntil: "networkidle2", timeout: 45000 });
anota("sin sesión, /admin manda al login", anonima.url().includes("/admin/login"), anonima.url());
await limpio.close();

await navegador.close();

const fallos = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - fallos.length}/${resultados.length} comprobaciones pasadas`);
process.exit(fallos.length ? 1 : 0);
