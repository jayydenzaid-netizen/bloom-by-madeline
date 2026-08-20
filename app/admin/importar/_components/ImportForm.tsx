"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Badge, Button, Card, Field } from "../../_components/ui";
import BookmarkletCard from "./BookmarkletCard";
import {
  importarDesdeCsv,
  importarDesdeHtml,
  importarDesdeUrl,
  plantillaCsv,
  type ResultadoCsv,
  type ResultadoImportacion,
} from "../actions";

/**
 * PASO 1 — traer el producto.
 *
 * Las cuatro vías del contrato, ordenadas de más cómoda a más fiable, con una
 * línea cada una diciendo CUÁNDO se usa. El orden no es casual y la pantalla no
 * disimula: la vía por URL es la que menos trabajo da y la que más se rompe,
 * porque AliExpress y Alibaba bloquean lo que viene de un servidor. Prometer que
 * "siempre funciona" sería vender humo y perder a la clienta la primera tarde que
 * no vaya; decirlo antes convierte el bloqueo en algo esperado y con salida.
 */

type Pestana = "url" | "html" | "bookmarklet" | "csv";

export type PaqueteMarcador = {
  href: string;
  code: string;
  token: string;
  endpoint: string;
};

/* ── detección de proveedor en el navegador ───────────────────────────────
   Los adaptadores de verdad (lib/importers/aliexpress.ts) arrastran node:crypto
   para firmar la API oficial, así que no se pueden importar en un componente
   cliente. Aquí basta con reconocer el dominio para pintar la etiqueta mientras
   se escribe; quien decide de verdad es el servidor. */
const DOMINIOS: { id: string; etiqueta: string; patron: RegExp }[] = [
  { id: "aliexpress", etiqueta: "AliExpress", patron: /(^|\.)aliexpress\.[a-z.]+$/i },
  { id: "alibaba", etiqueta: "Alibaba", patron: /(^|\.)alibaba\.[a-z.]+$/i },
  { id: "1688", etiqueta: "1688", patron: /(^|\.)1688\.com$/i },
];

function proveedorDe(url: string): { etiqueta: string; conocido: boolean } {
  try {
    const host = new URL(url.trim()).hostname;
    const encontrado = DOMINIOS.find((d) => d.patron.test(host));
    if (encontrado) return { etiqueta: encontrado.etiqueta, conocido: true };
    return { etiqueta: host, conocido: false };
  } catch {
    return { etiqueta: "sin reconocer", conocido: false };
  }
}

/* ── tamaño máximo de un envío ────────────────────────────────────────────
   Next limita el cuerpo de una Server Action a 1 MB, y el HTML de una ficha de
   AliExpress ronda los 2 MB. Como los parsers solo miran los <script> con el
   estado JSON, cuando el pegado se pasa de largo se manda ese extracto en vez de
   fallar. Se le dice a la usuaria, porque un recorte silencioso que luego pierde
   una variante es peor que el error. */
const LIMITE_ENVIO = 850_000;

function peso(texto: string): number {
  try {
    return new Blob([texto]).size;
  } catch {
    return texto.length;
  }
}

function recortarHtml(html: string): { html: string; recortado: boolean; bytes: number } {
  const original = peso(html);
  if (original <= LIMITE_ENVIO) return { html, recortado: false, bytes: original };

  const trozos: string[] = [];
  const titulo = html.match(/<title[^>]*>[\s\S]*?<\/title>/i);
  if (titulo) trozos.push(titulo[0]);
  trozos.push(...(html.match(/<meta[^>]*>/gi) ?? []).slice(0, 80));

  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) ?? [];
  const utiles = scripts.filter((s) =>
    /runParams|_d_c_|DCData|detailData|__NEXT_DATA__|__INIT_DATA__|application\/ld\+json|skuModule|priceModule|titleModule/i.test(
      s,
    ),
  );

  let acumulado = trozos.join("\n");
  for (const script of utiles) {
    if (peso(acumulado) + peso(script) > LIMITE_ENVIO) continue;
    acumulado += `\n${script}`;
  }

  // Sin ningún <script> con estado no hay nada que extraer: se manda el principio
  // del documento y que el motor diga lo que falta, en vez de fingir un recorte útil.
  const cuerpo = utiles.length > 0 ? acumulado : html.slice(0, LIMITE_ENVIO);
  const final = `<!doctype html><html><head>${cuerpo}</head><body></body></html>`;
  return { html: final, recortado: true, bytes: peso(final) };
}

/* ────────────────────────────── el componente ────────────────────────────── */

type EstadoFila = "espera" | "cargando" | "ok" | "error";
type Fila = { url: string; estado: EstadoFila; resultado: ResultadoImportacion | null };

export default function ImportForm({
  marcador,
  errorMarcador,
  pestanaInicial = "url",
  urlInicial = "",
}: {
  marcador: PaqueteMarcador | null;
  errorMarcador?: string | null;
  pestanaInicial?: Pestana;
  urlInicial?: string;
}) {
  const router = useRouter();
  const [pestana, setPestana] = useState<Pestana>(pestanaInicial);

  // — vía URL —
  const [textoUrls, setTextoUrls] = useState(urlInicial);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [enCurso, setEnCurso] = useState(false);

  // — vía HTML —
  const [html, setHtml] = useState("");
  const [urlHtml, setUrlHtml] = useState(urlInicial);
  const [resultadoHtml, setResultadoHtml] = useState<ResultadoImportacion | null>(null);
  const [notaRecorte, setNotaRecorte] = useState<string | null>(null);
  const [cargandoHtml, setCargandoHtml] = useState(false);

  // — vía CSV —
  const [csv, setCsv] = useState<{ nombre: string; texto: string } | null>(null);
  const [resultadoCsv, setResultadoCsv] = useState<ResultadoCsv | null>(null);
  const [cargandoCsv, setCargandoCsv] = useState(false);
  const ficheroRef = useRef<HTMLInputElement | null>(null);

  const [errorGeneral, setErrorGeneral] = useState<string | null>(null);

  function irARevisar(jobId: string) {
    router.push(`/admin/importar?job=${encodeURIComponent(jobId)}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Manda a la pestaña que sí funciona llevándose la URL puesta. */
  function rescatar(destino: Pestana, url: string) {
    setUrlHtml(url);
    setPestana(destino);
    setResultadoHtml(null);
  }

  /* ─────────────────── vía 1: URLs en lote ─────────────────── */

  async function importarLote() {
    const urls = textoUrls
      .split(/\r?\n/)
      .map((linea) => linea.trim())
      .filter(Boolean)
      .slice(0, 20);

    if (urls.length === 0) {
      setErrorGeneral("Pega al menos un enlace de producto.");
      return;
    }

    setErrorGeneral(null);
    setEnCurso(true);
    setFilas(urls.map((url) => ({ url, estado: "espera", resultado: null })));

    // De una en una y en orden: así cada línea enseña su propio progreso y un
    // bloqueo en la tercera no tumba las dos que ya se habían traído bien.
    const resultados: (ResultadoImportacion | null)[] = [];
    for (let i = 0; i < urls.length; i++) {
      setFilas((prev) => prev.map((fila, j) => (j === i ? { ...fila, estado: "cargando" } : fila)));
      let resultado: ResultadoImportacion;
      try {
        resultado = await importarDesdeUrl(urls[i]);
      } catch (error) {
        resultado = { ok: false, error: mensaje(error), pista: null, bloqueado: false };
      }
      resultados.push(resultado);
      setFilas((prev) =>
        prev.map((fila, j) => (j === i ? { ...fila, estado: resultado.ok ? "ok" : "error", resultado } : fila)),
      );
    }

    setEnCurso(false);

    // Un solo enlace y salió bien: se va derecho a revisarlo, que es lo siguiente
    // que iba a hacer de todas formas. Con varios se queda la lista a la vista.
    const primero = resultados[0];
    if (resultados.length === 1 && primero?.ok) irARevisar(primero.jobId);
  }

  /* ─────────────────── vía 2: HTML pegado ─────────────────── */

  async function enviarHtml() {
    if (html.trim().length < 200) {
      setResultadoHtml({
        ok: false,
        error: "Todavía no has pegado el HTML de la ficha (o se copió a medias).",
        pista: "En la página del producto: Ctrl+U, luego Ctrl+A y Ctrl+C, y pega aquí.",
        bloqueado: false,
      });
      return;
    }

    setCargandoHtml(true);
    setResultadoHtml(null);
    setNotaRecorte(null);
    try {
      const { html: envio, recortado, bytes } = recortarHtml(html);
      if (recortado) {
        setNotaRecorte(
          `La página pesaba ${(peso(html) / 1_000_000).toFixed(1)} MB. Se enviaron solo los bloques con los datos del producto (${(bytes / 1000).toFixed(0)} KB): es lo único que lee el importador.`,
        );
      }
      const resultado = await importarDesdeHtml(envio, urlHtml.trim() || undefined);
      setResultadoHtml(resultado);
      if (resultado.ok) irARevisar(resultado.jobId);
    } catch (error) {
      setResultadoHtml({ ok: false, error: mensaje(error), pista: null, bloqueado: false });
    } finally {
      setCargandoHtml(false);
    }
  }

  /* ─────────────────── vía 4: CSV ─────────────────── */

  async function leerFichero(archivo: File | null) {
    setResultadoCsv(null);
    if (!archivo) {
      setCsv(null);
      return;
    }
    if (archivo.size > LIMITE_ENVIO) {
      setResultadoCsv({
        ok: false,
        creados: [],
        errores: [
          `El fichero pesa ${(archivo.size / 1_000_000).toFixed(1)} MB y el máximo por envío es ${(LIMITE_ENVIO / 1_000_000).toFixed(1)} MB. Pártelo en dos y súbelos por separado.`,
        ],
        avisos: [],
      });
      setCsv(null);
      return;
    }
    setCsv({ nombre: archivo.name, texto: await archivo.text() });
  }

  async function enviarCsv() {
    if (!csv) return;
    setCargandoCsv(true);
    try {
      setResultadoCsv(await importarDesdeCsv(csv.texto, csv.nombre));
      router.refresh();
    } catch (error) {
      setResultadoCsv({ ok: false, creados: [], errores: [mensaje(error)], avisos: [] });
    } finally {
      setCargandoCsv(false);
      if (ficheroRef.current) ficheroRef.current.value = "";
      setCsv(null);
    }
  }

  async function descargarPlantilla() {
    try {
      const texto = await plantillaCsv();
      const url = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = "plantilla-bloom.csv";
      enlace.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorGeneral(mensaje(error));
    }
  }

  /* ─────────────────────────── pintado ─────────────────────────── */

  const pestanas: { id: Pestana; titulo: string; cuando: string }[] = [
    { id: "url", titulo: "1 · Pegar enlace", cuando: "Lo más rápido. Funciona a ratos: los proveedores bloquean servidores." },
    { id: "html", titulo: "2 · Pegar HTML", cuando: "La red de seguridad: si copias el código de la página, nunca falla." },
    { id: "bookmarklet", titulo: "3 · Marcador", cuando: "La vía fiable del día a día. Un clic desde la ficha del proveedor." },
    { id: "csv", titulo: "4 · Fichero CSV", cuando: "Para traer muchos productos de golpe desde una hoja de cálculo." },
  ];

  return (
    <Card title="Traer un producto">
      <div className="imp-tabs" role="tablist" aria-label="Cómo traer el producto">
        {pestanas.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={pestana === tab.id}
            className={`imp-tab${pestana === tab.id ? " is-activa" : ""}`}
            onClick={() => setPestana(tab.id)}
          >
            <b>{tab.titulo}</b>
            <span>{tab.cuando}</span>
          </button>
        ))}
      </div>

      {errorGeneral ? (
        <div className="imp-aviso imp-aviso-danger" style={{ marginTop: 14 }}>
          <div className="imp-aviso-cuerpo">{errorGeneral}</div>
        </div>
      ) : null}

      <div className="imp-panel">
        {/* ───────────── PEGAR URL ───────────── */}
        {pestana === "url" ? (
          <>
            <p className="imp-nota">
              <b>Cómodo, pero frágil.</b> Bloom baja la ficha desde el servidor y AliExpress y Alibaba a veces lo
              detectan y responden con una página de verificación. Cuando pase, aquí abajo se dirá exactamente eso y
              tendrás a un clic las vías que no se pueden bloquear.
            </p>

            <Field
              label="Enlaces de producto"
              htmlFor="imp-urls"
              hint="Uno por línea, hasta 20. Se traen en orden y verás el progreso de cada uno."
            >
              <textarea
                id="imp-urls"
                rows={5}
                value={textoUrls}
                onChange={(e) => setTextoUrls(e.target.value)}
                placeholder={"https://www.aliexpress.com/item/1005006543210987.html\nhttps://www.alibaba.com/product-detail/....html"}
                spellCheck={false}
              />
            </Field>

            {textoUrls.trim() ? (
              <div className="adm-row" style={{ marginBottom: 12 }}>
                {[...new Set(textoUrls.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((u) => proveedorDe(u).etiqueta))]
                  .slice(0, 4)
                  .map((etiqueta) => (
                    <Badge key={etiqueta} tone={DOMINIOS.some((d) => d.etiqueta === etiqueta) ? "info" : "warning"}>
                      {etiqueta}
                    </Badge>
                  ))}
              </div>
            ) : null}

            <Button type="button" onClick={importarLote} disabled={enCurso}>
              {enCurso ? "Trayendo productos…" : "Traer productos"}
            </Button>

            {filas.length > 0 ? (
              <div className="imp-lote">
                {filas.map((fila, i) => (
                  <FilaUrl key={`${fila.url}-${i}`} fila={fila} onRevisar={irARevisar} onRescatar={rescatar} />
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {/* ───────────── PEGAR HTML ───────────── */}
        {pestana === "html" ? (
          <>
            <p className="imp-nota">
              <b>Esta vía nunca falla por bloqueo.</b> El código de la página ya está en tu navegador, así que el
              proveedor no tiene nada que impedir. Es más trabajo (tres atajos de teclado), pero cuando el enlace directo
              se atasque, esta es la que te saca del apuro.
            </p>

            <ol className="imp-pasos-lista">
              <li>
                Abre la ficha del producto en el navegador y pulsa <kbd>Ctrl</kbd> + <kbd>U</kbd>. Se abre una pestaña
                nueva con el código de la página (mucho texto de colores: es lo normal).
              </li>
              <li>
                En esa pestaña, <kbd>Ctrl</kbd> + <kbd>A</kbd> para seleccionarlo todo y <kbd>Ctrl</kbd> + <kbd>C</kbd>{" "}
                para copiarlo.
              </li>
              <li>
                Vuelve aquí, pulsa dentro del recuadro grande y <kbd>Ctrl</kbd> + <kbd>V</kbd>. Después, «Leer la ficha».
              </li>
            </ol>

            <Field label="Enlace de la ficha (opcional)" htmlFor="imp-url-html" hint="Ayuda a saber de qué proveedor es y deja el producto enlazado a su origen.">
              <input
                id="imp-url-html"
                type="url"
                value={urlHtml}
                onChange={(e) => setUrlHtml(e.target.value)}
                placeholder="https://www.aliexpress.com/item/…"
                spellCheck={false}
              />
            </Field>

            <Field
              label="Código de la página"
              htmlFor="imp-html"
              hint={html ? `${(peso(html) / 1000).toFixed(0)} KB pegados` : "Aquí va todo lo que copiaste con Ctrl+A."}
            >
              <textarea
                id="imp-html"
                rows={8}
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                placeholder="<!DOCTYPE html> …"
                spellCheck={false}
              />
            </Field>

            <div className="adm-row">
              <Button type="button" onClick={enviarHtml} disabled={cargandoHtml}>
                {cargandoHtml ? "Leyendo la ficha…" : "Leer la ficha"}
              </Button>
              {html ? (
                <Button variant="ghost" type="button" onClick={() => setHtml("")} disabled={cargandoHtml}>
                  Vaciar
                </Button>
              ) : null}
            </div>

            {notaRecorte ? (
              <div className="imp-aviso imp-aviso-info" style={{ marginTop: 14 }}>
                <div className="imp-aviso-cuerpo">{notaRecorte}</div>
              </div>
            ) : null}

            {resultadoHtml && !resultadoHtml.ok ? (
              <div className="imp-aviso imp-aviso-danger" style={{ marginTop: 14 }}>
                <div className="imp-aviso-cuerpo">
                  <b>{resultadoHtml.error}</b>
                  {resultadoHtml.pista ? <p>{resultadoHtml.pista}</p> : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {/* ───────────── BOOKMARKLET ───────────── */}
        {pestana === "bookmarklet" ? (
          marcador ? (
            <BookmarkletCard
              href={marcador.href}
              code={marcador.code}
              token={marcador.token}
              endpoint={marcador.endpoint}
              error={errorMarcador ?? null}
            />
          ) : (
            <BookmarkletCard
              href=""
              code=""
              token=""
              endpoint=""
              error={errorMarcador ?? "No se pudo preparar el marcador en este arranque."}
            />
          )
        ) : null}

        {/* ───────────── CSV ───────────── */}
        {pestana === "csv" ? (
          <>
            <p className="imp-nota">
              <b>Para lotes grandes.</b> Cada fila del fichero se convierte en una importación pendiente de revisar,
              exactamente igual que si la hubieras traído de AliExpress: tampoco por aquí se publica nada solo.
            </p>

            <Field
              label="Fichero CSV"
              htmlFor="imp-csv"
              hint="Se aceptan las columnas de Bloom y también la exportación de productos de Shopify."
            >
              <input
                id="imp-csv"
                ref={ficheroRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void leerFichero(e.target.files?.[0] ?? null)}
              />
            </Field>

            <div className="adm-row">
              <Button type="button" onClick={enviarCsv} disabled={!csv || cargandoCsv}>
                {cargandoCsv ? "Leyendo el fichero…" : csv ? `Importar «${csv.nombre}»` : "Elige un fichero"}
              </Button>
              <Button variant="ghost" type="button" onClick={descargarPlantilla}>
                Descargar plantilla de ejemplo
              </Button>
            </div>

            {resultadoCsv ? (
              <div style={{ marginTop: 14 }}>
                {resultadoCsv.creados.length > 0 ? (
                  <div className="imp-aviso imp-aviso-success">
                    <div className="imp-aviso-cuerpo">
                      <b>
                        {resultadoCsv.creados.length}{" "}
                        {resultadoCsv.creados.length === 1 ? "producto listo para revisar" : "productos listos para revisar"}.
                      </b>
                      <div className="imp-aviso-acciones">
                        <Button size="sm" type="button" onClick={() => irARevisar(resultadoCsv.creados[0].jobId)}>
                          Revisar el primero
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {resultadoCsv.errores.map((error, i) => (
                  <div className="imp-aviso imp-aviso-danger" key={`e${i}`}>
                    <div className="imp-aviso-cuerpo">{error}</div>
                  </div>
                ))}

                {resultadoCsv.avisos.map((aviso, i) => (
                  <div className="imp-aviso imp-aviso-warning" key={`a${i}`}>
                    <div className="imp-aviso-cuerpo">{aviso}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}

/* ───────────────────────── una línea del lote ───────────────────────── */

function FilaUrl({
  fila,
  onRevisar,
  onRescatar,
}: {
  fila: Fila;
  onRevisar: (jobId: string) => void;
  onRescatar: (destino: Pestana, url: string) => void;
}) {
  const proveedor = proveedorDe(fila.url);
  const resultado = fila.resultado;

  return (
    <div className="imp-fila-url">
      <div className="imp-fila-cab">
        <Badge tone={proveedor.conocido ? "info" : "warning"}>{proveedor.etiqueta}</Badge>
        <code title={fila.url}>{fila.url}</code>
        {fila.estado === "espera" ? <span className="adm-small adm-muted">En cola</span> : null}
        {fila.estado === "cargando" ? <span className="adm-small adm-muted">Trayendo…</span> : null}
        {fila.estado === "ok" ? <Badge tone="success">Listo</Badge> : null}
        {fila.estado === "error" ? <Badge tone="danger">No se pudo</Badge> : null}
      </div>

      {fila.estado !== "espera" ? (
        <div className="imp-barra">
          <div
            className={`imp-barra-relleno${fila.estado === "ok" ? " is-completa" : ""}${fila.estado === "error" ? " is-fallo" : ""}`}
          />
        </div>
      ) : null}

      {resultado?.ok ? (
        <div style={{ marginTop: 10 }}>
          <b>{resultado.titulo}</b>
          <div className="adm-small adm-muted">
            {resultado.imagenes} {resultado.imagenes === 1 ? "foto" : "fotos"} · {resultado.variantes}{" "}
            {resultado.variantes === 1 ? "variante" : "variantes"}
          </div>
          <div className="imp-aviso-acciones">
            <Button size="sm" type="button" onClick={() => onRevisar(resultado.jobId)}>
              Revisar y ajustar
            </Button>
          </div>
        </div>
      ) : null}

      {resultado && !resultado.ok ? (
        <div className="imp-aviso imp-aviso-danger" style={{ marginTop: 10 }}>
          <div className="imp-aviso-cuerpo">
            {/* El error se dice tal cual lo dio el proveedor. "Algo salió mal" haría
                que la usuaria reintentara el mismo enlace cinco veces. */}
            <b>{resultado.error}</b>
            {resultado.pista ? <p>{resultado.pista}</p> : null}
            {resultado.bloqueado ? (
              <div className="imp-aviso-acciones">
                <Button size="sm" type="button" onClick={() => onRescatar("html", fila.url)}>
                  Pegar el HTML de esta ficha
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => onRescatar("bookmarklet", fila.url)}>
                  Usar el marcador
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function mensaje(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
