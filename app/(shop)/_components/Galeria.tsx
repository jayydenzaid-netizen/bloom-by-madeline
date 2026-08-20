"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Galería de la ficha: foto grande, miniaturas y ampliación a pantalla completa.
 *
 * Es un componente CONTROLADO (la foto activa viene de fuera) porque elegir una
 * variante con foto propia tiene que mover la galería, y el que sabe qué variante
 * está elegida es SelectorVariante.
 *
 * La ampliación se apaga con el atributo `hidden`, nunca con un display de autor:
 * `[hidden] { display: none !important }` de globals.css es lo único que garantiza
 * que la capa no exista cuando está cerrada. Aquí murió un P0 y no vuelve.
 */

export type ImagenGaleria = {
  url: string;
  alt: string;
};

export default function Galeria({
  imagenes,
  activa,
  onActiva,
  titulo,
}: {
  imagenes: ImagenGaleria[];
  activa: number;
  onActiva: (indice: number) => void;
  titulo: string;
}) {
  const [montada, setMontada] = useState(false); // controla el atributo hidden
  const [visible, setVisible] = useState(false); // controla la clase .show (fundido)
  const [zoom, setZoom] = useState(false);

  const total = imagenes.length;
  const indice = Math.min(Math.max(activa, 0), Math.max(total - 1, 0));
  const foto = imagenes[indice];

  const cerrar = useCallback(() => {
    // El atributo hidden se pone YA: nada de esperar a que acabe una transición
    // con una capa a pantalla completa todavía viva encima del contenido.
    setVisible(false);
    setMontada(false);
    setZoom(false);
  }, []);

  const mover = useCallback(
    (paso: number) => {
      if (total < 2) return;
      setZoom(false);
      onActiva((indice + paso + total) % total);
    },
    [indice, total, onActiva],
  );

  // El fundido necesita un fotograma con la capa ya visible pero aún en opacity 0.
  useEffect(() => {
    if (!montada) return;
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [montada]);

  useEffect(() => {
    if (!montada) return;
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key === "Escape") cerrar();
      if (e.key === "ArrowRight") mover(1);
      if (e.key === "ArrowLeft") mover(-1);
    };
    document.addEventListener("keydown", alPulsar);
    return () => document.removeEventListener("keydown", alPulsar);
  }, [montada, cerrar, mover]);

  return (
    <div className="pf-galeria">
      {/* Botón y no <figure> con onClick: así se abre también con el teclado. */}
      <button
        type="button"
        className="pf-foto"
        onClick={() => foto && setMontada(true)}
        disabled={!foto}
        aria-label={foto ? "Ampliar la foto" : undefined}
      >
        {foto ? (
          // eslint-disable-next-line @next/next/no-img-element -- las fotos importadas viven en el CDN del proveedor
          <img src={foto.url} alt={foto.alt || titulo} />
        ) : (
          <span className="pf-foto-vacia" aria-hidden="true" />
        )}
        {foto ? <span className="pf-lupa">Ampliar</span> : null}
      </button>

      {total > 1 ? (
        <div className="pf-thumbs">
          {imagenes.map((img, i) => (
            <button
              key={`${img.url}-${i}`}
              type="button"
              className={i === indice ? "pf-thumb sel" : "pf-thumb"}
              onClick={() => onActiva(i)}
              aria-label={`Ver la foto ${i + 1} de ${total}`}
              aria-current={i === indice}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- ídem */}
              <img src={img.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={visible ? "lightbox show" : "lightbox"}
        hidden={!montada}
        onClick={cerrar}
        role="dialog"
        aria-modal="true"
        aria-label={`Fotos de ${titulo}`}
      >
        <button className="lightbox-close" type="button" onClick={cerrar} aria-label="Cerrar la foto">
          ×
        </button>

        <div className="pf-lb-card" onClick={(e) => e.stopPropagation()}>
          {foto ? (
            // eslint-disable-next-line @next/next/no-img-element -- ídem
            <img
              src={foto.url}
              alt={foto.alt || titulo}
              className={zoom ? "zoom" : undefined}
              onClick={() => setZoom((z) => !z)}
            />
          ) : null}

          {total > 1 ? (
            <>
              <button
                className="pf-lb-nav pf-lb-prev"
                type="button"
                onClick={() => mover(-1)}
                aria-label="Foto anterior"
              >
                ‹
              </button>
              <button
                className="pf-lb-nav pf-lb-next"
                type="button"
                onClick={() => mover(1)}
                aria-label="Foto siguiente"
              >
                ›
              </button>
              <span className="pf-lb-conteo">
                {indice + 1} / {total}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
