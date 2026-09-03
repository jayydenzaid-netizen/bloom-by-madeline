// Comprueba que NINGÚN enlace del menú lleva a una sección que no existe.
//
// Por qué existe: la barra de arriba estuvo enseñando «Filosofía» después de que
// esa sección se apagara en la portada. El enlace se pintaba perfecto, el HTML
// era válido, ningún test lo veía — y la clienta pulsaba y no pasaba nada.
//
// Las pruebas unitarias ya vigilan que el menú solo apunte a anclas registradas
// (tests/navegacion.test.ts). Lo que NO pueden ver es que ese registro se
// corresponda con los `id=` que HomeSections.tsx pinta de verdad. Eso solo lo
// dice un navegador de verdad, así que aquí se abre Chrome, se pulsa cada
// enlace y se mira si la página se movió.
//
// Uso:
//   node qa/anclas.mjs
//   node qa/anclas.mjs --base=http://localhost:4590

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const BASE = flag("base", "http://localhost:4590");

const fallos = [];
const ok = (m) => console.log(`  ok   ${m}`);
const mal = (m) => { fallos.push(m); console.log(`  MAL  ${m}`); };

const navegador = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const pagina = await navegador.newPage();
  await pagina.setViewport({ width: 1440, height: 900 });
  await pagina.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60_000 });
  await pagina.evaluate(() => document.fonts.ready);

  // Los enlaces de ancla de la cabecera y del pie, sin duplicados.
  const anclas = await pagina.evaluate(() =>
    [...new Set(
      [...document.querySelectorAll('a[href*="#"]')]
        .map((a) => a.getAttribute("href") || "")
        .filter((h) => /^\/?#[^/?#]+$/.test(h)),
    )],
  );

  console.log(`Anclas enlazadas en la portada: ${anclas.length ? anclas.join(", ") : "(ninguna)"}`);
  if (anclas.length === 0) mal("la portada no enlaza a ninguna sección: revisa el menú");

  for (const href of anclas) {
    const id = href.replace(/^\/?#/, "");
    const existe = await pagina.evaluate((x) => {
      const el = document.getElementById(x);
      return el ? el.getBoundingClientRect().height : null;
    }, id);

    if (existe === null) { mal(`${href} → no existe ninguna sección con id="${id}"`); continue; }
    if (existe < 40) { mal(`${href} → la sección existe pero mide ${Math.round(existe)}px: no se ve`); continue; }

    // Pulsar de verdad y comprobar que la sección acabó arriba del todo.
    //
    // La posición se mide DESPUÉS del clic, no antes: la portada carga las fotos
    // en diferido y crece mientras bajas, así que un `offsetTop` tomado desde
    // arriba miente por cientos de píxeles. Lo que importa es dónde queda la
    // sección respecto a la ventana cuando el navegador ha terminado de moverse.
    await pagina.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 250));
    await pagina.evaluate((h) => {
      const a = [...document.querySelectorAll("a")].find((x) => x.getAttribute("href") === h);
      a?.click();
    }, href);
    await new Promise((r) => setTimeout(r, 1200));

    const donde = await pagina.evaluate((x) => {
      const r = document.getElementById(x).getBoundingClientRect();
      const finDePagina =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
      return { arriba: r.top, visible: r.top < window.innerHeight && r.bottom > 0, finDePagina };
    }, id);

    // Hay cabecera fija y desplazamiento suave, así que se admite holgura. Y la
    // última sección de la página no puede subir del todo: basta con que se vea.
    if (Math.abs(donde.arriba) <= 200 || (donde.finDePagina && donde.visible)) {
      ok(`${href} → el navegador se planta en su sección`);
    } else {
      mal(`${href} → se pulsó y la sección quedó a ${Math.round(donde.arriba)}px del borde de la ventana`);
    }
  }
} finally {
  await navegador.close();
}

console.log(fallos.length === 0 ? "\nTodos los enlaces de sección llevan a algún sitio." : `\n${fallos.length} enlace(s) roto(s).`);
process.exit(fallos.length === 0 ? 0 : 1);
