"use client";

import { useState } from "react";
import { Button, EmptyState } from "../../_components/ui";
import type { ImagenDraft } from "../actions";

/**
 * Gestor de fotos de la ficha. La primera de la lista es la portada: es la que
 * sale en la parrilla de la tienda y en el carrito, así que el orden no es
 * decoración, es la foto que vende.
 *
 * Las subidas se mandan en el mismo envío del formulario (input file con
 * name="archivos"): así el producto y sus fotos se guardan o fallan juntos, sin
 * quedarse ficheros huérfanos en /public si el guardado se cae.
 */

type Props = {
  imagenes: ImagenDraft[];
  onCambio: (imagenes: ImagenDraft[]) => void;
};

export default function ImageManager({ imagenes, onCambio }: Props) {
  const [nuevaUrl, setNuevaUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function mover(indice: number, salto: number) {
    const destino = indice + salto;
    if (destino < 0 || destino >= imagenes.length) return;
    const copia = [...imagenes];
    const [movida] = copia.splice(indice, 1);
    copia.splice(destino, 0, movida);
    onCambio(copia);
  }

  function anadirPorUrl() {
    const url = nuevaUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setError("La dirección tiene que empezar por http:// o https://.");
      return;
    }
    if (imagenes.some((img) => img.url === url)) {
      setError("Esa foto ya está en la lista.");
      return;
    }
    setError(null);
    setNuevaUrl("");
    onCambio([...imagenes, { id: null, url, alt: "" }]);
  }

  return (
    <div>
      {imagenes.length === 0 ? (
        <EmptyState
          title="Sin fotos"
          text="Un producto sin foto no se puede publicar: en la tienda saldría un hueco gris. Sube una imagen o pega la dirección de una."
        />
      ) : (
        <div className="cat-imgs">
          {imagenes.map((img, i) => (
            <div className={`cat-img${i === 0 ? " es-portada" : ""}`} key={img.id ?? `nueva-${i}-${img.url}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- las fotos
                  importadas viven en CDNs de proveedores que no están en la lista
                  de next/image; aquí solo es una miniatura del panel. */}
              <img className="cat-img-foto" src={img.url} alt="" />

              <div className="cat-img-cuerpo">
                <div className="adm-field">
                  <label className="adm-field-lbl" htmlFor={`alt-${i}`}>
                    {i === 0 ? "Portada · texto alternativo" : "Texto alternativo"}
                  </label>
                  <input
                    id={`alt-${i}`}
                    type="text"
                    value={img.alt}
                    placeholder="Vestido midi floral visto de frente"
                    onChange={(e) =>
                      onCambio(imagenes.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)))
                    }
                  />
                </div>
                <span className="adm-muted adm-small">{img.url}</span>
              </div>

              <div className="cat-img-acciones">
                <Button type="button" variant="ghost" size="sm" onClick={() => mover(i, -1)} disabled={i === 0}>
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => mover(i, 1)}
                  disabled={i === imagenes.length - 1}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => onCambio(imagenes.filter((_, j) => j !== i))}
                >
                  Quitar
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error ? <p className="adm-field-err">{error}</p> : null}

      <div className="cat-img-alta">
        <div className="adm-field">
          <label className="adm-field-lbl" htmlFor="nueva-url">
            Añadir por dirección
          </label>
          <input
            id="nueva-url"
            type="url"
            value={nuevaUrl}
            placeholder="https://…"
            onChange={(e) => setNuevaUrl(e.target.value)}
          />
        </div>
        <Button type="button" variant="ghost" onClick={anadirPorUrl}>
          Añadir
        </Button>
      </div>

      <div className="adm-field" style={{ marginTop: 14 }}>
        <label className="adm-field-lbl" htmlFor="archivos">
          Subir desde el ordenador o el teléfono
        </label>
        <input id="archivos" name="archivos" type="file" accept="image/*" multiple />
        <div className="adm-field-hint">
          JPG, PNG, WebP, GIF o AVIF, hasta 5 MB cada una. Se añaden al final de la lista al guardar.
        </div>
      </div>
    </div>
  );
}
