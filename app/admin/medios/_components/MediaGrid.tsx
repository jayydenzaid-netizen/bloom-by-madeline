"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { MedioVista, UsoMedio } from "@/lib/media";
import { Button, Card, EmptyState, Field } from "../../_components/ui";
import {
  borrarMedio,
  borrarMedios,
  guardarAlt,
  importarUrls,
  moverCarpeta,
  type EstadoImportacion,
} from "../actions";

/**
 * Rejilla de la biblioteca: subir, mirar, organizar y borrar.
 *
 * Es cliente porque aquí sí hay interacción de verdad (arrastrar ficheros,
 * barra de progreso, selección múltiple). Todo lo que escribe pasa por Server
 * Actions o por /api/media/upload; este componente no toca la base de datos.
 *
 * Decisión importante: el buscador y el filtro de carpeta NO viven aquí, son un
 * formulario GET de la página. Así siguen funcionando aunque el móvil de la
 * boutique tarde en cargar el JavaScript, y la URL se puede guardar en favoritos.
 */

/* Las constantes se repiten a mano en vez de importarlas de lib/media.ts: ese
   módulo usa node:fs y arrastrarlo al bundle del navegador rompería el build. */
const MAX_BYTES_CLIENTE = 8 * 1024 * 1024;
const ACEPTA = "image/jpeg,image/png,image/webp,image/avif,image/gif";

type EstadoItem = "esperando" | "subiendo" | "ok" | "error";

type ItemCola = {
  clave: string;
  nombre: string;
  progreso: number;
  estado: EstadoItem;
  error?: string;
};

type Aviso = { tono: "ok" | "error" | "info"; texto: string; usos?: UsoMedio[] } | null;

/** Peso legible. Duplicado a propósito (ver nota de arriba sobre node:fs). */
function peso(bytes: number): string {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

const FECHA = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

const ICONO_VACIO = (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="M21 16l-5-5-4.5 4.5L9 13l-6 6" />
  </svg>
);

export default function MediaGrid({
  medios,
  carpetas,
  carpetaActiva,
}: {
  medios: MedioVista[];
  /** Carpetas ya existentes, para sugerirlas al mover sin obligar a escribirlas. */
  carpetas: string[];
  /** Carpeta del filtro actual: las subidas nuevas caen aquí por comodidad. */
  carpetaActiva: string;
}) {
  const router = useRouter();
  const inputFichero = useRef<HTMLInputElement>(null);

  const [cola, setCola] = useState<ItemCola[]>([]);
  const [arrastrando, setArrastrando] = useState(false);
  const [marcadas, setMarcadas] = useState<string[]>([]);
  const [abiertaId, setAbiertaId] = useState<string | null>(null);
  const [aviso, setAviso] = useState<Aviso>(null);
  const [pendiente, empezar] = useTransition();

  // Estado del borrado en dos tiempos: nada destructivo a un solo clic.
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [forzar, setForzar] = useState<string | null>(null);
  const [confirmandoLote, setConfirmandoLote] = useState(false);

  const [alt, setAlt] = useState("");
  const [carpetaDestino, setCarpetaDestino] = useState("");
  const [mostrarUrls, setMostrarUrls] = useState(false);

  const [estadoUrls, accionUrls, urlsPendientes] = useActionState<EstadoImportacion, FormData>(importarUrls, {});

  const abierta = medios.find((m) => m.id === abiertaId) ?? null;

  // Si la imagen abierta desaparece (la borró otra pestaña, o la propia tanda),
  // el panel se cierra solo en vez de quedarse enseñando un fantasma.
  useEffect(() => {
    if (abiertaId && !medios.some((m) => m.id === abiertaId)) {
      setAbiertaId(null);
      setConfirmando(null);
      setForzar(null);
    }
    setMarcadas((previas) => previas.filter((id) => medios.some((m) => m.id === id)));
  }, [medios, abiertaId]);

  // El campo de texto alternativo es controlado: se recarga al cambiar de foto.
  useEffect(() => {
    setAlt(abierta?.alt ?? "");
  }, [abierta?.id, abierta?.alt]);

  // Una importación por URL terminada refresca la rejilla del servidor.
  useEffect(() => {
    if (estadoUrls.ok) router.refresh();
  }, [estadoUrls, router]);

  /* ─────────────────────────── subida de ficheros ─────────────────────────── */

  function subirUno(fichero: File, clave: string, carpeta: string): Promise<void> {
    return new Promise((resolver) => {
      const cuerpo = new FormData();
      cuerpo.append("file", fichero);
      cuerpo.append("carpeta", carpeta);

      // XMLHttpRequest y no fetch: fetch todavía no informa del progreso de
      // SUBIDA, y sin barra la usuaria no sabe si el móvil está haciendo algo.
      const peticion = new XMLHttpRequest();
      peticion.open("POST", "/api/media/upload");

      peticion.upload.onprogress = (evento) => {
        if (!evento.lengthComputable) return;
        const porcentaje = Math.round((evento.loaded / evento.total) * 100);
        setCola((actual) =>
          actual.map((i) => (i.clave === clave ? { ...i, progreso: porcentaje, estado: "subiendo" } : i)),
        );
      };

      peticion.onload = () => {
        let error: string | undefined;
        try {
          const datos = JSON.parse(peticion.responseText);
          if (!datos.ok) error = datos.error ?? "No se pudo subir.";
          else if (datos.resultados?.[0] && !datos.resultados[0].ok) error = datos.resultados[0].error;
        } catch {
          error = `El servidor respondió ${peticion.status} sin explicación.`;
        }
        setCola((actual) =>
          actual.map((i) =>
            i.clave === clave ? { ...i, progreso: 100, estado: error ? "error" : "ok", error } : i,
          ),
        );
        resolver();
      };

      peticion.onerror = () => {
        setCola((actual) =>
          actual.map((i) =>
            i.clave === clave ? { ...i, estado: "error", error: "Se cortó la conexión." } : i,
          ),
        );
        resolver();
      };

      peticion.send(cuerpo);
    });
  }

  async function subirFicheros(lista: FileList | File[]) {
    const ficheros = Array.from(lista);
    if (ficheros.length === 0) return;

    const items: ItemCola[] = ficheros.map((f, i) => ({
      clave: `${Date.now()}-${i}-${f.name}`,
      nombre: f.name,
      progreso: 0,
      estado: "esperando",
    }));
    setCola((actual) => [...actual, ...items]);
    setAviso(null);

    // De una en una: así el progreso es honesto y no se satura la conexión de
    // la boutique subiendo doce fotos en paralelo.
    for (let i = 0; i < ficheros.length; i += 1) {
      const fichero = ficheros[i];
      const item = items[i];
      if (fichero.size > MAX_BYTES_CLIENTE) {
        setCola((actual) =>
          actual.map((x) =>
            x.clave === item.clave
              ? { ...x, estado: "error", progreso: 100, error: `Pesa ${peso(fichero.size)} y el tope son 8,0 MB.` }
              : x,
          ),
        );
        continue;
      }
      await subirUno(fichero, item.clave, carpetaActiva);
    }

    router.refresh();
  }

  /* ─────────────────────────── acciones del panel ─────────────────────────── */

  function alternarMarca(id: string) {
    setMarcadas((actual) => (actual.includes(id) ? actual.filter((x) => x !== id) : [...actual, id]));
  }

  function copiarUrl(url: string) {
    const completa = `${window.location.origin}${url}`;
    navigator.clipboard
      ?.writeText(completa)
      .then(() => setAviso({ tono: "ok", texto: "Dirección copiada al portapapeles." }))
      .catch(() => setAviso({ tono: "info", texto: completa }));
  }

  function alGuardarAlt() {
    if (!abierta) return;
    const id = abierta.id;
    empezar(async () => {
      const resultado = await guardarAlt(id, alt);
      setAviso(
        resultado.ok
          ? { tono: "ok", texto: resultado.mensaje ?? "Guardado." }
          : { tono: "error", texto: resultado.error ?? "No se pudo guardar." },
      );
      if (resultado.ok) router.refresh();
    });
  }

  function alBorrar(id: string, confirmado: boolean) {
    empezar(async () => {
      const resultado = await borrarMedio(id, confirmado);
      if (resultado.ok) {
        setAviso({ tono: "ok", texto: resultado.mensaje });
        setConfirmando(null);
        setForzar(null);
        setAbiertaId(null);
        router.refresh();
        return;
      }
      setAviso({ tono: "error", texto: resultado.error, usos: resultado.usos });
      setConfirmando(null);
      // Si el problema es que está en uso, se ofrece el segundo gesto explícito.
      setForzar(resultado.requiereConfirmacion ? id : null);
    });
  }

  function alMover() {
    const ids = [...marcadas];
    const destino = carpetaDestino;
    empezar(async () => {
      const resultado = await moverCarpeta(ids, destino);
      setAviso(
        resultado.ok
          ? { tono: "ok", texto: resultado.mensaje ?? "Listo." }
          : { tono: "error", texto: resultado.error ?? "No se pudo mover." },
      );
      if (resultado.ok) {
        setMarcadas([]);
        setCarpetaDestino("");
        router.refresh();
      }
    });
  }

  function alBorrarLote() {
    const ids = [...marcadas];
    empezar(async () => {
      const resultado = await borrarMedios(ids);
      setConfirmandoLote(false);
      if (resultado.error) {
        setAviso({ tono: "error", texto: resultado.error });
        return;
      }
      const bloqueadas = resultado.bloqueadas;
      if (bloqueadas.length > 0) {
        setAviso({
          tono: "info",
          texto: `Se borraron ${resultado.borrados}. Quedan ${bloqueadas.length} sin borrar porque están en uso; ábrelas una a una para decidir.`,
          usos: bloqueadas.flatMap((b) => b.usos),
        });
      } else {
        setAviso({ tono: "ok", texto: `Se borraron ${resultado.borrados} imágenes.` });
      }
      setMarcadas([]);
      router.refresh();
    });
  }

  const subiendo = cola.some((i) => i.estado === "subiendo" || i.estado === "esperando");

  /* ─────────────────────────────── pintado ─────────────────────────────── */

  return (
    <>
      <Card
        title="Añadir imágenes"
        actions={
          <Button variant="ghost" size="sm" onClick={() => setMostrarUrls((v) => !v)}>
            {mostrarUrls ? "Ocultar enlaces" : "Añadir por enlace"}
          </Button>
        }
      >
        <div
          className={`med-drop${arrastrando ? " is-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setArrastrando(true);
          }}
          onDragLeave={() => setArrastrando(false)}
          onDrop={(e) => {
            e.preventDefault();
            setArrastrando(false);
            void subirFicheros(e.dataTransfer.files);
          }}
        >
          <p className="med-drop-titulo">Arrastra aquí tus fotos</p>
          <p className="med-drop-texto">
            JPG, PNG, WebP, AVIF o GIF, hasta 8 MB cada una.
            {carpetaActiva ? ` Se guardarán en la carpeta "${carpetaActiva}".` : ""}
          </p>
          <div className="med-drop-acciones">
            <Button size="sm" onClick={() => inputFichero.current?.click()} disabled={subiendo}>
              {subiendo ? "Subiendo…" : "Elegir del teléfono"}
            </Button>
            {cola.length > 0 && !subiendo ? (
              <Button variant="ghost" size="sm" onClick={() => setCola([])}>
                Limpiar la lista
              </Button>
            ) : null}
          </div>

          <input
            ref={inputFichero}
            type="file"
            accept={ACEPTA}
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void subirFicheros(e.target.files);
              e.target.value = "";
            }}
          />

          {cola.length > 0 ? (
            <ul className="med-cola">
              {cola.map((item) => (
                <li
                  key={item.clave}
                  className={`med-cola-item${item.estado === "error" ? " is-error" : ""}${item.estado === "ok" ? " is-ok" : ""}`}
                >
                  <div className="med-cola-fila">
                    <span className="med-cola-nombre">{item.nombre}</span>
                    <span className="med-cola-estado">
                      {item.estado === "ok"
                        ? "Subida"
                        : item.estado === "error"
                          ? "Falló"
                          : item.estado === "esperando"
                            ? "En cola"
                            : `${item.progreso}%`}
                    </span>
                  </div>
                  <div className="med-barra">
                    <span style={{ width: `${item.progreso}%` }} />
                  </div>
                  {item.error ? <p className="med-cola-error">{item.error}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {mostrarUrls ? (
          <form action={accionUrls} style={{ marginTop: 16 }}>
            <Field
              label="Pegar enlaces de imágenes"
              htmlFor="med-urls"
              hint="Uno por línea. Útil para las fotos del proveedor: se descargan aquí y ya no dependen de su servidor."
              error={estadoUrls.error}
            >
              <textarea id="med-urls" name="urls" rows={3} placeholder="https://…/foto.jpg" />
            </Field>
            <input type="hidden" name="carpeta" value={carpetaActiva} />
            <div className="adm-row">
              <Button type="submit" size="sm" disabled={urlsPendientes}>
                {urlsPendientes ? "Trayendo…" : "Traer imágenes"}
              </Button>
            </div>
            {estadoUrls.mensaje ? <p className="med-aviso med-aviso-ok">{estadoUrls.mensaje}</p> : null}
            {estadoUrls.detalles?.some((d) => !d.ok) ? (
              <ul className="med-usos">
                {estadoUrls.detalles
                  .filter((d) => !d.ok)
                  .map((d) => (
                    <li key={d.url}>
                      {d.url} — {d.error}
                    </li>
                  ))}
              </ul>
            ) : null}
          </form>
        ) : null}
      </Card>

      {aviso ? (
        <div className={`med-aviso med-aviso-${aviso.tono}`} role="status">
          {aviso.texto}
          {aviso.usos?.length ? (
            <ul className="med-usos">
              {aviso.usos.map((uso, i) => (
                <li key={`${uso.tipo}-${i}`}>
                  {uso.etiqueta}: {uso.titulo}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="med-layout">
        <Card title={`Biblioteca · ${medios.length} ${medios.length === 1 ? "imagen" : "imágenes"}`}>
          {marcadas.length > 0 ? (
            <div className="med-lote">
              <span className="med-lote-texto">
                {marcadas.length} {marcadas.length === 1 ? "seleccionada" : "seleccionadas"}
              </span>
              <input
                type="text"
                list="med-carpetas-existentes"
                placeholder="Carpeta (p. ej. vestidos)"
                value={carpetaDestino}
                onChange={(e) => setCarpetaDestino(e.target.value)}
                aria-label="Carpeta de destino"
              />
              <datalist id="med-carpetas-existentes">
                {carpetas.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <Button variant="ghost" size="sm" onClick={alMover} disabled={pendiente}>
                Mover
              </Button>
              {confirmandoLote ? (
                <>
                  <Button variant="danger" size="sm" onClick={alBorrarLote} disabled={pendiente}>
                    Sí, borrar {marcadas.length}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmandoLote(false)}>
                    Cancelar
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmandoLote(true)}>
                  Borrar…
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setMarcadas([])}>
                Quitar selección
              </Button>
            </div>
          ) : null}

          {medios.length === 0 ? (
            <EmptyState
              icon={ICONO_VACIO}
              title="Aquí guardas tus fotos"
              text="Sube una foto una sola vez y podrás usarla en los productos, en la portada y en las páginas sin volver a buscarla en el teléfono."
              action={
                <Button size="sm" onClick={() => inputFichero.current?.click()}>
                  Subir la primera foto
                </Button>
              }
            />
          ) : (
            <div className="med-grid">
              {medios.map((medio) => {
                const marcada = marcadas.includes(medio.id);
                return (
                  <div
                    key={medio.id}
                    className={`med-tile${abiertaId === medio.id ? " is-abierta" : ""}${marcada ? " is-marcada" : ""}`}
                  >
                    <label className="med-marca" title="Seleccionar">
                      <input
                        type="checkbox"
                        checked={marcada}
                        onChange={() => alternarMarca(medio.id)}
                        aria-label={`Seleccionar ${medio.filename}`}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setAbiertaId(medio.id);
                        setConfirmando(null);
                        setForzar(null);
                        setAviso(null);
                      }}
                      className="med-tile-btn"
                      aria-label={`Ver detalles de ${medio.filename}`}
                    >
                      <img className="med-tile-img" src={medio.url} alt={medio.alt} loading="lazy" />
                      <span className="med-tile-pie">
                        <span className="med-tile-nombre">{medio.filename}</span>
                        <span className="med-tile-meta">
                          {medio.width > 0 ? `${medio.width}×${medio.height} · ` : ""}
                          {peso(medio.bytes)}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {abierta ? (
          <Card
            title="Detalles"
            actions={
              <Button variant="ghost" size="sm" onClick={() => setAbiertaId(null)}>
                Cerrar
              </Button>
            }
          >
            <img className="med-panel-vista" src={abierta.url} alt={abierta.alt} />

            <dl className="med-datos">
              <dt>Nombre</dt>
              <dd>{abierta.filename}</dd>
              <dt>Medidas</dt>
              <dd>{abierta.width > 0 ? `${abierta.width} × ${abierta.height} px` : "sin leer"}</dd>
              <dt>Peso</dt>
              <dd>{peso(abierta.bytes)}</dd>
              <dt>Carpeta</dt>
              <dd>{abierta.folder || "sin carpeta"}</dd>
              <dt>Subida</dt>
              <dd>{FECHA.format(new Date(abierta.createdAt))}</dd>
              <dt>Dirección</dt>
              <dd>{abierta.url}</dd>
            </dl>

            <Field
              label="Texto alternativo"
              htmlFor="med-alt"
              hint="Describe la foto en una frase. Lo lee quien no puede verla, y Google lo usa para entenderla."
            >
              <textarea id="med-alt" rows={2} value={alt} onChange={(e) => setAlt(e.target.value)} />
            </Field>

            <div className="med-panel-acciones">
              <Button size="sm" onClick={alGuardarAlt} disabled={pendiente || alt === abierta.alt}>
                Guardar texto
              </Button>
              <Button variant="ghost" size="sm" onClick={() => copiarUrl(abierta.url)}>
                Copiar dirección
              </Button>
              {/* <a> a pelo y no <Button href>: la primitiva no acepta `target`
                  y aquí abrir en otra pestaña es justo lo que hace falta. */}
              <a
                className="adm-btn adm-btn-ghost adm-btn-sm"
                href={abierta.url}
                target="_blank"
                rel="noreferrer"
              >
                Ver original
              </a>
            </div>

            <div className="med-panel-acciones">
              {forzar === abierta.id ? (
                <>
                  <Button variant="danger" size="sm" onClick={() => alBorrar(abierta.id, true)} disabled={pendiente}>
                    Borrar de todas formas
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setForzar(null)}>
                    Dejarlo como está
                  </Button>
                </>
              ) : confirmando === abierta.id ? (
                <>
                  <Button variant="danger" size="sm" onClick={() => alBorrar(abierta.id, false)} disabled={pendiente}>
                    Sí, borrar
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmando(null)}>
                    Cancelar
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmando(abierta.id)}>
                  Borrar imagen…
                </Button>
              )}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
