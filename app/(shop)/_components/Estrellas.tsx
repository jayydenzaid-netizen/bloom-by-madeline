import type { CSSProperties } from "react";

/**
 * Puntuación en estrellas, accesible y sin JavaScript.
 *
 * Se usa igual en la ficha de producto, en las tarjetas del catálogo, en la
 * portada y dentro del panel (los tokens `--clay` viven en globals.css, que
 * carga en toda la app). No lleva "use client": es puro marcado.
 *
 * Interfaz:
 *   <Estrellas valor={4.3} total={12} />                     // "4.3 (12)"
 *   <Estrellas valor={5} tamano="sm" mostrarNumero={false} /> // solo estrellas
 *   <Estrellas valor={0} total={0} />                         // "Aún sin reseñas"
 *   <Estrellas valor={0} total={0} ocultarSiVacio />          // no pinta nada
 *
 * Accesibilidad: el conjunto es un `role="img"` con `aria-label` del tipo
 * "4.3 de 5 estrellas · 12 reseñas". Los SVG van `aria-hidden` para que un
 * lector de pantalla lea una sola frase y no cinco estrellas sueltas.
 *
 * El decimal va con PUNTO, no con coma: el locale es `es-US` (el mismo que usa
 * formatCents para dar "$45.99"), porque las clientas están en Ohio. Textos en
 * español, números a la americana.
 */

export type TamanoEstrellas = "sm" | "md" | "lg";

export type EstrellasProps = {
  /** Media de 0 a 5. Admite decimales: la estrella parcial se rellena a medias. */
  valor: number;
  /** Número de reseñas que sostienen la media. Si es 0 se considera "sin reseñas". */
  total?: number;
  /** sm 12px (tarjetas) · md 16px (por defecto) · lg 22px (ficha de producto). */
  tamano?: TamanoEstrellas;
  /** Pinta el "4,3 (12)" al lado. Por defecto sí. */
  mostrarNumero?: boolean;
  /** Texto cuando no hay reseñas. */
  etiquetaVacia?: string;
  /** Si no hay reseñas, no pinta nada en vez del texto. */
  ocultarSiVacio?: boolean;
  className?: string;
};

const PX: Record<TamanoEstrellas, number> = { sm: 12, md: 16, lg: 22 };
const HUECO = 2; // separación entre estrellas, en px

const NUMERO = new Intl.NumberFormat("es-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Camino de una estrella de 5 puntas dentro de un viewBox 24×24. */
const ESTRELLA = "M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z";

export default function Estrellas({
  valor,
  total,
  tamano = "md",
  mostrarNumero = true,
  etiquetaVacia = "Aún sin reseñas",
  ocultarSiVacio = false,
  className,
}: EstrellasProps) {
  const sinResenas = total !== undefined && total <= 0;
  if (sinResenas && ocultarSiVacio) return null;

  const px = PX[tamano];
  const anchoFila = px * 5 + HUECO * 4;

  // Se recorta a [0,5] antes de calcular: un valor corrupto en base de datos no
  // puede pintar seis estrellas ni una barra que se salga del componente.
  const acotado = Math.min(5, Math.max(0, Number.isFinite(valor) ? valor : 0));
  const porcentaje = (acotado / 5) * 100;

  const etiqueta = sinResenas
    ? etiquetaVacia
    : `${NUMERO.format(acotado)} de 5 estrellas${total !== undefined ? ` · ${total} ${total === 1 ? "reseña" : "reseñas"}` : ""}`;

  const contenedor: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    lineHeight: 1,
    verticalAlign: "middle",
  };

  const fila: CSSProperties = {
    display: "flex",
    gap: HUECO,
    width: anchoFila,
    flex: "0 0 auto",
  };

  return (
    <span className={className} style={contenedor} role="img" aria-label={etiqueta}>
      <span style={{ position: "relative", display: "inline-block", width: anchoFila, height: px }} aria-hidden="true">
        {/* Capa de fondo: las cinco siluetas apagadas. */}
        <span style={fila}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Punta key={i} px={px} color="rgba(119, 48, 62, 0.22)" />
          ))}
        </span>
        {/* Capa de relleno recortada al porcentaje: así 4,3 pinta media estrella. */}
        <span
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            height: px,
            width: `${porcentaje}%`,
            overflow: "hidden",
          }}
        >
          <span style={fila}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Punta key={i} px={px} color="var(--clay, #77303E)" />
            ))}
          </span>
        </span>
      </span>

      {mostrarNumero ? (
        <span style={{ fontSize: Math.max(11, px - 3), letterSpacing: ".02em", opacity: sinResenas ? 0.7 : 1 }}>
          {sinResenas ? etiquetaVacia : NUMERO.format(acotado)}
          {!sinResenas && total !== undefined ? (
            <span style={{ opacity: 0.65 }}> ({total})</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function Punta({ px, color }: { px: number; color: string }) {
  return (
    <svg width={px} height={px} viewBox="0 0 24 24" style={{ display: "block", flex: "0 0 auto" }} aria-hidden="true">
      <path d={ESTRELLA} fill={color} />
    </svg>
  );
}
