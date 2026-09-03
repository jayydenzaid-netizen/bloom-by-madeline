// Revisa la tienda en un móvil de verdad (iPhone 13, 390×844) con Chrome real.
//
// Busca lo que solo se ve en pantalla pequeña y que ninguna captura de escritorio
// enseña: la página que se va de ancho y se desplaza en horizontal, los botones
// que no se pueden pulsar con el pulgar, y el texto tan pequeño que no se lee.
//
// Uso:
//   node qa/movil.mjs
//   node qa/movil.mjs --base=https://bloom-by-madeline.vercel.app

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const BASE = flag("base", "http://localhost:4590").replace(/\/$/, "");
const RUTAS = flag("rutas", "/,/tienda,/producto/vestido-amapola,/carrito,/checkout").split(",");

// 24 px es el mínimo de la WCAG 2.2 (criterio 2.5.8, nivel AA). Se mide la zona
// que responde al dedo, no la caja del elemento: no siempre coinciden.
const MINIMO_TACTIL = 24;

const navegador = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const pagina = await navegador.newPage();
await pagina.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await pagina.setUserAgent(
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
);

const problemas = [];

for (const ruta of RUTAS) {
  await pagina.goto(BASE + ruta, { waitUntil: "networkidle2", timeout: 60_000 });
  await pagina.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 400));

  const informe = await pagina.evaluate((minimo) => {
    const ancho = window.innerWidth;

    // 1. ¿Se va de ancho? Y si se va, ¿por culpa de quién?
    const desborde = document.documentElement.scrollWidth - ancho;
    const culpables = [];
    if (desborde > 1) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right <= ancho + 1 && r.left >= -1) continue;
        const estilo = getComputedStyle(el);
        if (estilo.position === "fixed" || estilo.visibility === "hidden") continue;
        // Solo el más externo: si el padre ya desborda, el hijo es consecuencia.
        if (culpables.some((c) => c.el.contains(el))) continue;
        culpables.push({ el, sel: el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ").filter(Boolean).slice(0, 2).join(".") : ""), derecha: Math.round(r.right) });
      }
    }

    // 2. Botones y enlaces demasiado pequeños para un pulgar.
    //
    // No basta con mirar la caja del elemento: la zona que responde al dedo puede
    // ser MAYOR que la caja (una capa invisible por encima) o MENOR (algo tapando).
    // Así que a los que no cumplen por caja se les mide la zona de verdad palpando
    // la pantalla punto a punto, que es lo único que sabe dónde llega el dedo.
    //
    // ⚠️ Cada candidato se sube a la pantalla antes de palparlo, y a un tercio de
    // altura: ni debajo de la cabecera fija ni debajo del botón flotante de DM. La
    // primera versión de esto solo miraba lo que ya estaba a la vista y daba el
    // móvil por limpio sin haber tocado el pie siquiera.
    const pequenos = [];
    const tapados = [];
    const sinComprobar = [];
    const candidatos = [...document.querySelectorAll("a, button, input[type=submit], [role=button]")].filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const estilo = getComputedStyle(el);
      if (estilo.visibility === "hidden" || estilo.display === "none" || estilo.opacity === "0") return false;
      return r.width < minimo || r.height < minimo;
    });

    const antes = window.scrollY;
    // El sitio lleva `scroll-behavior: smooth`, así que `scrollBy` NO ha terminado
    // cuando se mide justo después: la primera versión de esto medía en el sitio
    // equivocado, no encontraba el elemento y lo daba por comprobado. Se apaga
    // mientras dura la auditoría y se devuelve como estaba.
    const suave = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    for (const el of candidatos) {
      // Colocarlo a un tercio de la ventana, lejos de la cabecera y del flotante.
      const caja = el.getBoundingClientRect();
      window.scrollBy(0, caja.top - window.innerHeight / 3);
      const r = el.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
      const c = r.top + r.height / 2;
      const texto = (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30) || "(sin texto)";
      if (c < 1 || c > window.innerHeight - 1) {
        // Nunca en silencio: si no se pudo comprobar, se dice.
        sinComprobar.push(texto);
        continue;
      }

      const suyo = (y) => {
        const en = document.elementFromPoint(x, y);
        return !!en && (en === el || el.contains(en));
      };
      if (!suyo(c)) {
        const en = document.elementFromPoint(x, c);
        tapados.push({ texto, por: en ? (en.className || en.tagName).toString().slice(0, 34) : "nada" });
        continue;
      }

      let a = c, b = c;
      while (a > 1 && c - a < 40 && suyo(a - 1)) a -= 1;
      while (b < window.innerHeight - 1 && b - c < 40 && suyo(b + 1)) b += 1;
      const alto = b - a;
      if (alto >= minimo && r.width >= minimo) continue;
      pequenos.push({ texto, medida: `${Math.round(r.width)}×${Math.round(alto)}` });
    }
    document.documentElement.style.scrollBehavior = suave;
    window.scrollTo(0, antes);

    return { desborde, culpables: culpables.map((c) => ({ sel: c.sel, derecha: c.derecha })), pequenos, tapados, sinComprobar, ancho };
  }, MINIMO_TACTIL);

  console.log(`\n${ruta}`);
  if (informe.desborde > 1) {
    problemas.push(`${ruta}: se desplaza ${informe.desborde}px en horizontal`);
    console.log(`  MAL  se va ${informe.desborde}px de ancho (ventana ${informe.ancho}px)`);
    for (const c of informe.culpables.slice(0, 5)) console.log(`       ↳ ${c.sel} llega a ${c.derecha}px`);
  } else {
    console.log("  ok   no se desplaza en horizontal");
  }

  if (informe.sinComprobar.length > 0) {
    problemas.push(`${ruta}: ${informe.sinComprobar.length} elemento(s) que no se pudieron comprobar`);
    console.log(`  ¿?   ${informe.sinComprobar.length} sin comprobar: ${informe.sinComprobar.slice(0, 4).map((t) => `«${t}»`).join(", ")}`);
  }

  if (informe.tapados.length > 0) {
    problemas.push(`${ruta}: ${informe.tapados.length} elemento(s) pulsable(s) tapado(s) por otra cosa`);
    console.log(`  MAL  ${informe.tapados.length} cosa(s) pulsable(s) que algo tapa`);
    for (const t of informe.tapados.slice(0, 6)) console.log(`       ↳ «${t.texto}» lo tapa ${t.por}`);
  }

  if (informe.pequenos.length > 0) {
    problemas.push(`${ruta}: ${informe.pequenos.length} zona(s) táctil(es) por debajo de ${MINIMO_TACTIL}px`);
    console.log(`  MAL  ${informe.pequenos.length} zona(s) táctil(es) menores de ${MINIMO_TACTIL}px`);
    for (const p of informe.pequenos.slice(0, 6)) console.log(`       ↳ «${p.texto}» ${p.medida}`);
  } else {
    console.log(`  ok   todo lo pulsable llega a ${MINIMO_TACTIL}px`);
  }
}

await navegador.close();
console.log(problemas.length === 0 ? "\nEl móvil está limpio." : `\n${problemas.length} problema(s) en móvil.`);
process.exit(problemas.length === 0 ? 0 : 1);
