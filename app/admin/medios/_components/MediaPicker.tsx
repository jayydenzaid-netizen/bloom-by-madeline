"use client";

import { useCallback, useEffect, useState } from "react";
import type { MedioVista } from "@/lib/media";
import { Button } from "../../_components/ui";
import { buscarMedios } from "../actions";
import "../medios.css";

/**
 * Selector de imágenes de la biblioteca, para el resto del panel.
 *
 * Existe para que ningún otro módulo vuelva a pedirle a Madeline que pegue una
 * URL a mano: eso es donde se cuelan las direcciones caducadas de los CDN de
 * proveedor y las fotos que un día desaparecen de la tienda.
 *
 * ── Cómo se usa ────────────────────────────────────────────────────────────
 *
 *   // una sola imagen
 *   const [portada, setPortada] = useState<string | null>(bloque.imageUrl);
 *   <MediaPicker name="imageUrl" label="Foto del bloque" value={portada} onChange={setPortada} />
 *
 *   // varias
 *   const [fotos, setFotos] = useState<string[]>([]);
 *   <MediaPicker multiple name="imagenes" label="Galería" value={fotos} onChange={setFotos} />
 *
 * ── Contrato ───────────────────────────────────────────────────────────────
 *  · `value`    — `string | null` en modo simple · `string[]` con `multiple`.
 *  · `onChange` — recibe el mismo tipo que `value`. Componente CONTROLADO.
 *  · `multiple` — false por defecto. En simple, elegir una foto cierra la ventana.
 *  · `name`     — opcional. Si se pasa, pinta `<input type="hidden">` con ese
 *                 nombre (uno por URL en modo múltiple), así el valor viaja en
 *                 un formulario normal y lo lee `FormData.get` / `.getAll`.
 *  · `label`, `hint`, `boton` — textos de la interfaz.
 *  · `carpeta`  — carpeta con la que abrir la ventana filtrada.
 *
 * ── Convivencia con formularios ────────────────────────────────────────────
 * Todos los botones son `type="button"` y NO hay un `<form>` dentro: meter uno
 * dentro de otro es HTML inválido y el navegador lo desanida por su cuenta,
 * rompiendo el formulario de quien nos usa. El Enter del buscador se intercepta
 * para que tampoco envíe el formulario de fuera por accidente.
 *
 * Es un componente cliente: quien lo monte tiene que ser cliente también, o
 * pasarlo como `children` desde un Server Component.
 */

type PropsComunes = {
  name?: string;
  label?: string;
  hint?: string;
  boton?: string;
  carpeta?: string;
};

export type MediaPickerProps =
  | (PropsComunes & { multiple?: false; value: string | null; onChange: (valor: string | null) => void })
  | (PropsComunes & { multiple: true; value: string[]; onChange: (valor: string[]) => void });

const ACEPTA = "image/jpeg,image/png,image/webp,image/avif,image/gif";

export default function MediaPicker(props: MediaPickerProps) {
  const { name, label, hint, boton, carpeta } = props;
  const multiple = props.multiple === true;
  const seleccion = multiple ? props.value : props.value ? [props.value] : [];

  const [abierto, setAbierto] = useState(false);
  const [consulta, setConsulta] = useState("");
  const [medios, setMedios] = useState<MedioVista[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(
    async (texto: string) => {
      setCargando(true);
      setError(null);
      try {
        setMedios(await buscarMedios(texto, carpeta ?? null));
      } catch {
        setError("No se pudo leer la biblioteca. Prueba a recargar la página.");
      } finally {
        setCargando(false);
      }
    },
    [carpeta],
  );

  useEffect(() => {
    if (abierto) void cargar(consulta);
    // La consulta se dispara a mano con el botón Buscar: recargar en cada tecla
    // sería una llamada al servidor por letra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierto, cargar]);

  // Escape cierra. Sin esto, en el móvil la ventana atrapa a la usuaria.
  useEffect(() => {
    if (!abierto) return;
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [abierto]);

  function emitir(urls: string[]) {
    if (props.multiple === true) props.onChange(urls);
    else props.onChange(urls[0] ?? null);
  }

  function alElegir(url: string) {
    if (multiple) {
      emitir(seleccion.includes(url) ? seleccion.filter((u) => u !== url) : [...seleccion, url]);
    } else {
      emitir([url]);
      setAbierto(false);
    }
  }

  function quitar(url: string) {
    emitir(seleccion.filter((u) => u !== url));
  }

  async function subir(ficheros: FileList | null) {
    if (!ficheros || ficheros.length === 0) return;
    setCargando(true);
    setError(null);
    const nuevas: string[] = [];
    for (const fichero of Array.from(ficheros)) {
      const cuerpo = new FormData();
      cuerpo.append("file", fichero);
      cuerpo.append("carpeta", carpeta ?? "");
      try {
        const respuesta = await fetch("/api/media/upload", { method: "POST", body: cuerpo });
        const datos = await respuesta.json();
        if (!datos.ok) setError(datos.error ?? "No se pudo subir.");
        else if (datos.resultados?.[0]?.ok) nuevas.push(datos.resultados[0].asset.url);
        else setError(datos.resultados?.[0]?.error ?? "No se pudo subir.");
      } catch {
        setError("Se cortó la conexión al subir.");
      }
    }
    setCargando(false);
    if (nuevas.length > 0) emitir(multiple ? [...seleccion, ...nuevas] : [nuevas[0]]);
    await cargar(consulta);
  }

  return (
    <div className="adm-field">
      {label ? <span className="adm-field-lbl">{label}</span> : null}

      {/* El valor viaja como campo oculto para que un formulario normal lo envíe
          sin que quien nos usa tenga que acordarse de serializarlo. */}
      {name
        ? multiple
          ? seleccion.map((url) => <input key={url} type="hidden" name={name} value={url} />)
          : <input type="hidden" name={name} value={seleccion[0] ?? ""} />
        : null}

      <div className="med-picker-valor">
        {seleccion.length === 0 ? (
          <span className="med-picker-vacio">Ninguna imagen elegida todavía.</span>
        ) : (
          seleccion.map((url) => (
            <span key={url} className="med-picker-mini">
              <img src={url} alt="" />
              <button
                type="button"
                className="med-picker-quitar"
                onClick={() => quitar(url)}
                aria-label="Quitar esta imagen"
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <Button type="button" variant="ghost" size="sm" onClick={() => setAbierto(true)}>
        {boton ?? (seleccion.length > 0 ? "Cambiar imagen" : "Elegir de la biblioteca")}
      </Button>

      {hint ? <div className="adm-field-hint">{hint}</div> : null}

      {abierto ? (
        <div
          className="med-modal-fondo"
          role="dialog"
          aria-modal="true"
          aria-label="Biblioteca de imágenes"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAbierto(false);
          }}
        >
          <div className="med-modal">
            <div className="med-modal-cab">
              <h2>Biblioteca de imágenes</h2>
              <Button type="button" variant="ghost" size="sm" onClick={() => setAbierto(false)}>
                Cerrar
              </Button>
            </div>

            <div className="med-modal-cuerpo">
              <div className="med-filtros" style={{ marginBottom: 14 }}>
                <input
                  type="text"
                  className="med-filtros-campo"
                  placeholder="Buscar por nombre"
                  value={consulta}
                  onChange={(e) => setConsulta(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter dentro de un formulario ajeno lo enviaría: se corta.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void cargar(consulta);
                    }
                  }}
                  aria-label="Buscar imágenes por nombre"
                />
                <Button type="button" variant="ghost" size="sm" onClick={() => void cargar(consulta)}>
                  Buscar
                </Button>
                <label className="adm-btn adm-btn-ghost adm-btn-sm" style={{ cursor: "pointer" }}>
                  Subir nueva
                  <input type="file" accept={ACEPTA} multiple hidden onChange={(e) => void subir(e.target.files)} />
                </label>
              </div>

              {error ? <p className="med-aviso med-aviso-error">{error}</p> : null}

              {cargando ? (
                <p className="adm-muted adm-small">Cargando…</p>
              ) : medios.length === 0 ? (
                <p className="adm-muted adm-small">
                  No hay imágenes todavía. Sube una con el botón de arriba, o ve a Medios en el panel.
                </p>
              ) : (
                <div className="med-grid">
                  {medios.map((medio) => (
                    <div
                      key={medio.id}
                      className={`med-tile${seleccion.includes(medio.url) ? " is-abierta" : ""}`}
                    >
                      <button
                        type="button"
                        className="med-tile-btn"
                        onClick={() => alElegir(medio.url)}
                        aria-pressed={seleccion.includes(medio.url)}
                      >
                        <img className="med-tile-img" src={medio.url} alt={medio.alt} loading="lazy" />
                        <span className="med-tile-pie">
                          <span className="med-tile-nombre">{medio.filename}</span>
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="med-modal-pie">
              <Button type="button" variant="ghost" size="sm" onClick={() => emitir([])}>
                Quitar todas
              </Button>
              <Button type="button" size="sm" onClick={() => setAbierto(false)}>
                Listo
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
