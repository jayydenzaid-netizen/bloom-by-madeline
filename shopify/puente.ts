// Puente del bookmarklet: de la pestaña del proveedor a Shopify, de un clic.
//
// POR QUÉ ESTA VÍA Y NO LA DESCARGA DIRECTA
// AliExpress y Alibaba bloquean a los scripts: detectan que quien pide la página
// no es un navegador con sesión y devuelven una página de captcha o una ficha
// vacía. El bookmarklet esquiva eso por completo porque NO descarga nada: se
// ejecuta dentro de la pestaña que ya tienes abierta, donde la ficha ya está
// cargada y el estado JSON del producto está en memoria.
//
// CÓMO SE COMUNICA (y por qué no con fetch)
// La primera versión de esto usaba `fetch` contra localhost. Falla de dos formas
// distintas y las dos son difíciles de diagnosticar: CORS, y sobre todo el
// bloqueo de Chrome a las peticiones de una web pública hacia la red privada
// (Private Network Access). Un formulario con `target="_blank"` no sufre ninguna
// de las dos —es una navegación, no una subpetición— y además deja al usuario
// mirando la página de resultado con el enlace al panel de Shopify. Menos código
// y más robusto.
//
//   npx tsx shopify/puente.ts
//   → abre http://localhost:4595 y arrastra el marcador a la barra

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { importFromPayload } from "@/lib/importers";
import { DEFAULT_PRICING } from "@/lib/money";
import type { NormalizedProduct } from "@/lib/importers/types";

import { ClienteShopify, mensajeDe } from "./lib/admin.js";
import { detectarCapacidades, type Capacidades } from "./lib/capacidades.js";
import { aEntradaProductSet, aHandle } from "./lib/mapear.js";
import { buscarImportadoAntes, crearProducto, handleDisponible } from "./lib/productos.js";
import { bien, mal, ojo, nota, titulo, regla, negrita, verde, gris, cian } from "./lib/consola.js";

const PUERTO = Number(process.env.PUERTO_PUENTE || 4595);
/** El HTML de una ficha de AliExpress pasa de 2 MB con facilidad. */
const TOPE_CUERPO = 24 * 1024 * 1024;
const FICHERO_TOKEN = path.join(process.cwd(), "shopify", ".puente-token");

/* ─────────────────────────── el token ───────────────────────────
 *
 * Cualquier web que visites puede mandar un POST a localhost. El token no es
 * paranoia: sin él, una página cualquiera podría crear productos en la tienda
 * mientras el puente esté levantado. Se guarda en disco para que el marcador
 * siga valiendo entre reinicios y no haya que volver a arrastrarlo cada vez.
 */
async function conseguirToken(): Promise<string> {
  try {
    const guardado = (await readFile(FICHERO_TOKEN, "utf8")).trim();
    if (guardado.length >= 24) return guardado;
  } catch {
    // Primera vez.
  }
  const nuevo = randomBytes(24).toString("base64url");
  await writeFile(FICHERO_TOKEN, nuevo, "utf8");
  return nuevo;
}

/* ─────────────────────────── el bookmarklet ─────────────────────────── */

/**
 * El código que se ejecuta dentro de la página del proveedor.
 *
 * Recoge los cuatro sitios donde AliExpress y Alibaba han ido dejando su estado
 * a lo largo de los años, más el HTML entero como red de seguridad, y lo manda
 * por formulario. Se queda deliberadamente corto y sin dependencias: es código
 * que corre en una página de terceros y tiene que poder leerse de un vistazo.
 */
function codigoBookmarklet(destino: string, token: string): string {
  const fuente = `(function(){
  var DESTINO=${JSON.stringify(destino)},TOKEN=${JSON.stringify(token)};
  var h=String(location.hostname).toLowerCase();
  var p=h.indexOf("alibaba.")!==-1?"alibaba":(h.indexOf("aliexpress.")!==-1?"aliexpress":"");
  if(!p){alert("Este marcador solo funciona dentro de una ficha de AliExpress o Alibaba.");return;}
  var d={};
  try{if(window.runParams)d.runParams=window.runParams;}catch(e){}
  try{if(window._d_c_&&window._d_c_.DCData)d.dcData=window._d_c_.DCData;}catch(e){}
  try{if(window.detailData)d.detailData=window.detailData;}catch(e){}
  try{if(window.__NEXT_DATA__)d.nextData=window.__NEXT_DATA__;}catch(e){}
  try{if(window.__INIT_DATA__)d.initData=window.__INIT_DATA__;}catch(e){}
  var html="";
  try{html=document.documentElement.outerHTML.slice(0,4000000);}catch(e){}
  var cuerpo;
  try{cuerpo=JSON.stringify({provider:p,url:location.href,token:TOKEN,data:d,html:html});}
  catch(e){cuerpo=JSON.stringify({provider:p,url:location.href,token:TOKEN,data:{},html:html});}
  var f=document.createElement("form");
  f.method="POST";f.action=DESTINO;f.target="_blank";f.style.display="none";
  var i=document.createElement("input");
  i.type="hidden";i.name="carga";i.value=cuerpo;
  f.appendChild(i);document.body.appendChild(f);f.submit();
  setTimeout(function(){try{document.body.removeChild(f);}catch(e){}},2000);
})();`;

  // Minificado de andar por casa: quitar saltos y la sangría. No se usa un
  // minificador de verdad a propósito — el usuario tiene derecho a leer lo que
  // se está metiendo en la barra de marcadores.
  const compacto = fuente
    .split("\n")
    .map((l) => l.trim())
    .join("");

  return `javascript:${encodeURIComponent(compacto)}`;
}

/* ─────────────────────────── páginas HTML ─────────────────────────── */

function escapar(texto: string): string {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ESTILO = `
  :root { --bone:#ECE1CD; --ink:#161513; --stone:#6E6151; --clay:#77303E; --cream:#F7F0E1; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bone); color:var(--ink); font:400 16px/1.6 "Jost","Century Gothic",system-ui,sans-serif;
         padding:48px 24px; display:flex; justify-content:center; }
  .caja { max-width:680px; width:100%; }
  h1 { font-weight:300; font-size:30px; letter-spacing:.06em; text-transform:uppercase; margin-bottom:8px; }
  h2 { font-weight:400; font-size:17px; letter-spacing:.12em; text-transform:uppercase; margin:32px 0 12px; }
  .sub { color:var(--stone); font-size:14px; letter-spacing:.16em; text-transform:uppercase; margin-bottom:28px; }
  .tarjeta { background:var(--cream); border:1px solid rgba(45,36,24,.18);
             border-radius:28px 8px 28px 8px; padding:26px 28px; margin-bottom:18px; }
  .marcador { display:inline-block; background:var(--ink); color:var(--bone); text-decoration:none;
              padding:15px 30px; font-size:13px; letter-spacing:.2em; text-transform:uppercase;
              cursor:grab; border-radius:24px 6px 24px 6px; }
  ol { padding-left:22px; } li { margin-bottom:10px; }
  code { background:rgba(45,36,24,.08); padding:2px 7px; border-radius:4px; font-size:14px; }
  a { color:var(--clay); }
  .ok { color:#2c6e49; } .fallo { color:var(--clay); }
  .aviso { border-left:3px solid var(--clay); padding-left:14px; margin:10px 0; font-size:15px; }
  .pie { color:var(--stone); font-size:13px; margin-top:34px; }
  .btn { display:inline-block; background:var(--ink); color:var(--bone); text-decoration:none;
         padding:14px 28px; font-size:12px; letter-spacing:.2em; text-transform:uppercase; margin-top:14px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 18px; font-size:15px; }
  dt { color:var(--stone); }
`;

function pagina(titulo: string, cuerpo: string): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapar(titulo)} · Puente Bloom → Shopify</title>
<style>${ESTILO}</style></head>
<body><div class="caja">${cuerpo}</div></body></html>`;
}

function paginaInicio(destino: string, token: string, tienda: string): string {
  const href = codigoBookmarklet(destino, token);
  return pagina(
    "Puente",
    `
    <h1>Puente Bloom → Shopify</h1>
    <p class="sub">${escapar(tienda)}</p>

    <div class="tarjeta">
      <h2 style="margin-top:0">1 · Arrastra esto a tu barra de marcadores</h2>
      <p style="margin-bottom:16px;color:var(--stone);font-size:15px">
        Arrástralo — no lo pulses aquí. Tiene que vivir en la barra del navegador.
      </p>
      <a class="marcador" href="${escapar(href)}">✿ Traer a Bloom</a>
    </div>

    <div class="tarjeta">
      <h2 style="margin-top:0">2 · Úsalo</h2>
      <ol>
        <li>Abre la ficha del producto en <strong>AliExpress</strong> o <strong>Alibaba</strong>.</li>
        <li>Espera a que cargue del todo (que se vean fotos y precio).</li>
        <li>Pulsa <strong>✿ Traer a Bloom</strong> en la barra de marcadores.</li>
        <li>Se abre una pestaña con el resultado y el enlace al panel de Shopify.</li>
      </ol>
    </div>

    <div class="tarjeta">
      <h2 style="margin-top:0">Lo que hace y lo que no</h2>
      <p class="aviso">Todo entra como <strong>borrador</strong>. Nadie ve nada en la tienda hasta que
      tú lo revises y lo publiques desde Shopify.</p>
      <p class="aviso">El precio se calcula con la regla de margen de la tienda
      (×${DEFAULT_PRICING.multiplier} sobre el coste, terminado en ${DEFAULT_PRICING.rounding}).
      Reví­salo siempre: el coste que publica el proveedor no incluye su envío.</p>
      <p class="aviso">El marcador solo se activa en dominios de AliExpress y Alibaba.
      En cualquier otra página no hace nada.</p>
    </div>

    <p class="pie">Este puente corre en tu ordenador. Ciérralo con Ctrl+C cuando termines.<br>
    Si cambias de tienda de Shopify, borra <code>shopify/.puente-token</code> y vuelve a arrastrar el marcador.</p>
  `,
  );
}

/* ─────────────────────────── el servidor ─────────────────────────── */

function leerCuerpo(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const trozos: Buffer[] = [];
    let bytes = 0;
    req.on("data", (trozo: Buffer) => {
      bytes += trozo.length;
      if (bytes > TOPE_CUERPO) {
        reject(new Error(`El envío pasa de ${Math.round(TOPE_CUERPO / 1024 / 1024)} MB.`));
        req.destroy();
        return;
      }
      trozos.push(trozo);
    });
    req.on("end", () => resolve(Buffer.concat(trozos).toString("utf8")));
    req.on("error", reject);
  });
}

/** Saca el JSON del campo `carga` de un formulario, o del cuerpo si vino como JSON. */
function extraerCarga(cuerpo: string, tipo: string): unknown {
  if (tipo.includes("application/json")) return JSON.parse(cuerpo);

  if (tipo.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(cuerpo);
    const carga = params.get("carga");
    if (!carga) throw new Error("El formulario no traía el campo «carga».");
    return JSON.parse(carga);
  }

  // Texto plano: se intenta como JSON directo.
  return JSON.parse(cuerpo);
}

type Contexto = {
  cliente: ClienteShopify;
  capacidades: Capacidades;
  token: string;
};

async function manejarIngesta(
  ctx: Contexto,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const cuerpo = await leerCuerpo(req);
  const carga = extraerCarga(cuerpo, req.headers["content-type"] || "");

  const registro = (carga || {}) as Record<string, unknown>;
  if (registro.token !== ctx.token) {
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      pagina(
        "Marcador caducado",
        `<h1 class="fallo">Marcador caducado</h1>
         <p class="sub">El token no coincide</p>
         <div class="tarjeta">
           <p>Este marcador se creó para otra sesión del puente.</p>
           <p style="margin-top:12px">Vuelve a <a href="/">la página del puente</a> y arrastra el marcador otra vez
           (borra antes el viejo de la barra).</p>
         </div>`,
      ),
    );
    return;
  }

  console.log("");
  titulo(`Llegó una ficha de ${String(registro.provider || "?")}`);
  nota(String(registro.url || ""));

  const resultado = importFromPayload(registro);
  if (!resultado.ok) {
    mal(resultado.error);
    if (resultado.hint) nota(resultado.hint);
    res.writeHead(422, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      pagina(
        "No se pudo leer",
        `<h1 class="fallo">No pude leer esa ficha</h1>
         <p class="sub">${escapar(String(registro.provider || ""))}</p>
         <div class="tarjeta">
           <p><strong>${escapar(resultado.error)}</strong></p>
           ${resultado.hint ? `<p class="aviso">${escapar(resultado.hint)}</p>` : ""}
           <p style="margin-top:14px;color:var(--stone);font-size:15px">
             Lo más común: la ficha no había terminado de cargar. Vuelve a la pestaña,
             baja hasta ver las fotos y el precio, y pulsa el marcador otra vez.
           </p>
         </div>
         <a class="btn" href="/">Volver al puente</a>`,
      ),
    );
    return;
  }

  const producto: NormalizedProduct = resultado.product;
  bien(`Leída: ${producto.title}`);
  nota(`${producto.images.length} fotos · ${producto.variants.length} variantes`);

  // ¿Repetida?
  const previo = await buscarImportadoAntes(
    ctx.cliente,
    producto.provider,
    producto.sourceProductId,
  ).catch(() => null);

  if (previo) {
    ojo(`Ya estaba importada: ${previo.titulo}`);
    const url = `${ctx.cliente.panel}/products/${previo.id.split("/").pop()}`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      pagina(
        "Ya estaba",
        `<h1>Esta pieza ya estaba</h1>
         <p class="sub">No se ha creado nada nuevo</p>
         <div class="tarjeta">
           <dl>
             <dt>En la tienda como</dt><dd>${escapar(previo.titulo)}</dd>
             <dt>Estado</dt><dd>${escapar(previo.estado.toLowerCase())}</dd>
           </dl>
         </div>
         <a class="btn" href="${escapar(url)}" target="_blank" rel="noopener">Abrirla en Shopify</a>`,
      ),
    );
    return;
  }

  // Crear.
  const handleBase = aHandle(producto.title || "pieza");
  const handle = await handleDisponible(ctx.cliente, handleBase).catch(() => handleBase);

  const { entrada, avisos } = aEntradaProductSet(producto, ctx.capacidades, {
    handle,
    estado: "DRAFT",
  });

  const creado = await crearProducto(ctx.cliente, ctx.capacidades, entrada);
  bien(`Creado en Shopify como borrador: ${creado.titulo}`);
  nota(creado.urlPanel);
  for (const aviso of avisos) ojo(aviso);

  const listaAvisos = avisos.length
    ? `<div class="tarjeta"><h2 style="margin-top:0">Revisa antes de publicar</h2>
       ${avisos.map((a) => `<p class="aviso">${escapar(a)}</p>`).join("")}</div>`
    : "";

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    pagina(
      "Importada",
      `<h1 class="ok">Importada</h1>
       <p class="sub">Entró como borrador · no la ve nadie todavía</p>
       <div class="tarjeta">
         <dl>
           <dt>Título</dt><dd>${escapar(creado.titulo)}</dd>
           <dt>Variantes</dt><dd>${creado.variantes}</dd>
           <dt>Fotos</dt><dd>${creado.fotos}</dd>
           <dt>Dirección</dt><dd>/${escapar(creado.handle)}</dd>
         </dl>
       </div>
       ${listaAvisos}
       <a class="btn" href="${escapar(creado.urlPanel)}" target="_blank" rel="noopener">Abrirla en Shopify</a>
       <p class="pie">Puedes cerrar esta pestaña y seguir importando desde el proveedor.</p>`,
    ),
  );
}

async function principal(): Promise<void> {
  console.log(negrita("\nPuente Bloom → Shopify"));
  regla();

  let cliente: ClienteShopify;
  try {
    cliente = await ClienteShopify.crear();
    bien(`Conectado a ${cliente.tienda} · API ${cliente.versionApi}`);
  } catch (error) {
    mal(mensajeDe(error));
    nota("Ejecuta primero: npx tsx shopify/verificar.ts");
    process.exitCode = 1;
    return;
  }

  const capacidades = await detectarCapacidades(cliente);
  const token = await conseguirToken();
  const ctx: Contexto = { cliente, capacidades, token };

  const servidor = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PUERTO}`);

    // Preflight: se contesta permisivo porque el servidor solo escucha en
    // 127.0.0.1 y toda operación exige el token.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Private-Network": "true",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(paginaInicio(`http://localhost:${PUERTO}/recibir`, token, cliente.tienda));
      return;
    }

    if (req.method === "POST" && url.pathname === "/recibir") {
      manejarIngesta(ctx, req, res).catch((error) => {
        mal(mensajeDe(error));
        if (res.headersSent) return;
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          pagina(
            "Error",
            `<h1 class="fallo">Algo falló al crear el producto</h1>
             <div class="tarjeta"><p>${escapar(mensajeDe(error))}</p>
             ${
               (error as { pista?: string }).pista
                 ? `<p class="aviso">${escapar((error as { pista?: string }).pista || "")}</p>`
                 : ""
             }</div>
             <a class="btn" href="/">Volver al puente</a>`,
          ),
        );
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("No hay nada aquí.");
  });

  // Solo 127.0.0.1: nadie de la red local puede tocar esto.
  servidor.listen(PUERTO, "127.0.0.1", () => {
    console.log("");
    console.log(`  ${verde("Puente levantado")} en ${cian(`http://localhost:${PUERTO}`)}`);
    console.log(`  ${gris("Abre esa dirección y arrastra el marcador a tu barra.")}`);
    console.log(`  ${gris("Ctrl+C para cerrarlo.")}`);
    console.log("");
  });

  servidor.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      mal(`El puerto ${PUERTO} ya está ocupado.`);
      nota(`Ciérra lo que lo use, o lanza con otro: PUERTO_PUENTE=4596 npx tsx shopify/puente.ts`);
    } else {
      mal(mensajeDe(error));
    }
    process.exitCode = 1;
  });
}

principal().catch((error) => {
  console.error(mensajeDe(error));
  process.exitCode = 1;
});
