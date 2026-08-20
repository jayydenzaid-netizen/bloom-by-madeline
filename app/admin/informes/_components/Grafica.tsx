"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCents } from "@/lib/money";

/**
 * Gráfica de ventas por día, dibujada en SVG a mano.
 *
 * Por qué sin librería: una librería de gráficas pesa más que todo el panel
 * junto, trae su propia paleta que pelea con la de la casa, y aquí solo hace
 * falta una serie temporal. Un `<path>` bien calculado no tiene dependencias
 * que actualizar ni CSS ajeno que anular.
 *
 * Es cliente por dos cosas reales: el puntero (y las flechas del teclado)
 * seleccionan un día y abren el detalle, y el lienzo **se mide** en vez de
 * estirarse. Esto último no es un capricho: con un `viewBox` fijo de 760
 * unidades metido en los 297 px de un teléfono, un texto de 11 unidades acaba
 * dibujado a 4 px reales y las cifras del eje dejan de leerse — medido con
 * Chrome a 375 px, no supuesto. Midiendo el ancho, una unidad del `viewBox` es
 * un píxel de verdad y el eje se lee igual en el móvil que en el escritorio.
 *
 * Sin JavaScript la gráfica se pinta igual con la medida por defecto: solo se
 * queda sin tooltip, que es un extra, no la información.
 */

export type PuntoGrafica = {
  /** "2026-08-19" — clave estable para React. */
  dia: string;
  /** Etiqueta del eje X, ya formateada en el servidor ("19 ago"). */
  etiqueta: string;
  /** Etiqueta del tooltip, ya formateada en el servidor ("martes, 19 de agosto"). */
  etiquetaLarga: string;
  ingresosCents: number;
  pedidos: number;
};

/** Ancho que se supone antes de medir (y el que usa el HTML del servidor). */
const ANCHO_POR_DEFECTO = 760;
const DIVISIONES = 4;

/** Un teléfono no aguanta la misma altura ni los mismos márgenes que un portátil. */
function medidas(ancho: number) {
  const estrecho = ancho < 560;
  return {
    W: ancho,
    H: estrecho ? 210 : 280,
    PAD: {
      top: 16,
      right: estrecho ? 10 : 16,
      bottom: 30,
      // Hueco del eje de dinero: "$1,500.00" no cabe en menos.
      left: estrecho ? 58 : 68,
    },
    /** Fechas del eje X que caben sin solaparse. */
    maxEtiquetasX: estrecho ? 4 : 7,
  };
}

/**
 * Techo "redondo" para el eje: 1, 1.5, 2, 2.5 o 5 por la potencia de diez que
 * toque. Un eje que acaba en $1,347.28 obliga a leer el número; uno que acaba
 * en $1,500.00 se lee de un vistazo.
 */
function escalaMaxima(valor: number): number {
  if (valor <= 0) return 0;
  const magnitud = 10 ** Math.floor(Math.log10(valor));
  for (const paso of [1, 1.5, 2, 2.5, 5, 10]) {
    const candidato = paso * magnitud;
    if (candidato >= valor) return Math.ceil(candidato);
  }
  return Math.ceil(10 * magnitud);
}

function limitar(valor: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, valor));
}

export function Grafica({ puntos }: { puntos: PuntoGrafica[] }) {
  const cajaRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [ancho, setAncho] = useState(ANCHO_POR_DEFECTO);
  const [activo, setActivo] = useState<number | null>(null);

  // El ancho real del contenedor manda. Se redondea a 4 px para que arrastrar
  // el borde de la ventana no dispare un re-render por cada píxel.
  useEffect(() => {
    const caja = cajaRef.current;
    if (!caja || typeof ResizeObserver === "undefined") return;
    const observador = new ResizeObserver((entradas) => {
      const w = entradas[0]?.contentRect.width ?? 0;
      if (w > 0) setAncho(Math.max(280, Math.round(w / 4) * 4));
    });
    observador.observe(caja);
    return () => observador.disconnect();
  }, []);

  const n = puntos.length;

  const modelo = useMemo(() => {
    const { W, H, PAD, maxEtiquetasX } = medidas(ancho);
    const anchoInterno = W - PAD.left - PAD.right;
    const altoInterno = H - PAD.top - PAD.bottom;

    const maximoReal = puntos.reduce((max, p) => Math.max(max, p.ingresosCents), 0);
    // Con todo a cero se inventa una escala de $10 solo para tener eje; la línea
    // se queda pegada al suelo, que es exactamente lo que hay que ver.
    const max = escalaMaxima(maximoReal) || 1000;

    const x = (i: number) => (n <= 1 ? PAD.left + anchoInterno / 2 : PAD.left + (i * anchoInterno) / (n - 1));
    const y = (v: number) => PAD.top + altoInterno - (v / max) * altoInterno;

    // Dos decimales bastan en este lienzo: sin redondear, cada punto escupe un
    // `63.599999999999994` al HTML y la página engorda de balde.
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const coords = puntos.map((p, i) => ({ x: r2(x(i)), y: r2(y(p.ingresosCents)) }));

    // Con un solo día (atajo "Hoy") no hay línea que trazar entre dos puntos, y
    // un punto suelto no se lee. Se dibuja el nivel de ese día de lado a lado:
    // es la misma cifra, contada de una forma que sí se ve.
    const trazo =
      coords.length === 1
        ? [
            { x: PAD.left, y: coords[0].y },
            { x: W - PAD.right, y: coords[0].y },
          ]
        : coords;

    const linea = trazo.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(" ");
    const suelo = PAD.top + altoInterno;
    const area =
      trazo.length > 1
        ? `${linea} L${trazo[trazo.length - 1].x.toFixed(2)} ${suelo} L${trazo[0].x.toFixed(2)} ${suelo} Z`
        : "";

    const ticks = Array.from({ length: DIVISIONES + 1 }, (_, i) => {
      const valor = Math.round((max / DIVISIONES) * i);
      return { valor, y: r2(y(valor)), texto: formatCents(valor) };
    });

    const paso = Math.max(1, Math.ceil(n / maxEtiquetasX));
    // La fecha del extremo se ancla al borde en vez de centrarse en su punto:
    // centrada, la mitad del texto se sale del lienzo y "20 ago" se lee "20 agc".
    const etiquetasX = puntos
      .map((p, i) => {
        const px = r2(x(i));
        const ancla = px > W - PAD.right - 22 ? "end" : px < PAD.left + 22 ? "start" : "middle";
        return { i, texto: p.etiqueta, x: px, ancla } as const;
      })
      .filter(({ i }) => i % paso === 0 || i === n - 1);

    return { W, H, PAD, anchoInterno, max, coords, linea, area, ticks, etiquetasX, suelo };
  }, [puntos, n, ancho]);

  const indiceDesdeEvento = useCallback(
    (clientX: number): number | null => {
      const svg = svgRef.current;
      if (!svg || n === 0) return null;
      const caja = svg.getBoundingClientRect();
      if (caja.width === 0) return null;
      // Se pasa el píxel de pantalla al sistema del viewBox y de ahí al índice.
      const xViewBox = ((clientX - caja.left) / caja.width) * modelo.W;
      if (n === 1) return 0;
      const t = (xViewBox - modelo.PAD.left) / modelo.anchoInterno;
      return limitar(Math.round(t * (n - 1)), 0, n - 1);
    },
    [n, modelo],
  );

  const alMover = (e: React.PointerEvent<SVGSVGElement>) => setActivo(indiceDesdeEvento(e.clientX));

  const alTeclear = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const actual = activo ?? n - 1;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setActivo(limitar(actual - 1, 0, n - 1));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setActivo(limitar(actual + 1, 0, n - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActivo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActivo(n - 1);
    } else if (e.key === "Escape") {
      setActivo(null);
    }
  };

  // El contenedor se pinta siempre, aunque no haya nada dentro: es lo que mide
  // el ResizeObserver, y sin él la gráfica no sabría de cuánto sitio dispone.
  if (n === 0) return <div className="inf-graf" ref={cajaRef} />;

  const punto = activo === null ? null : puntos[activo];
  const coord = activo === null ? null : modelo.coords[activo];
  // Posición del tooltip en % del ancho: sirve igual sea cual sea el tamaño real.
  const pctX = coord ? (coord.x / modelo.W) * 100 : 0;
  const anclaje = pctX < 22 ? "izq" : pctX > 78 ? "der" : "centro";

  const total = puntos.reduce((acc, p) => acc + p.ingresosCents, 0);
  const resumenAccesible = `Ventas por día del periodo: ${formatCents(total)} en ${n} ${n === 1 ? "día" : "días"}. Usa las flechas para recorrer los días.`;

  return (
    <div className="inf-graf" ref={cajaRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${modelo.W} ${modelo.H}`}
        className="inf-graf-svg"
        role="img"
        aria-label={resumenAccesible}
        tabIndex={0}
        onPointerMove={alMover}
        onPointerDown={alMover}
        onPointerLeave={() => setActivo(null)}
        onBlur={() => setActivo(null)}
        onKeyDown={alTeclear}
      >
        <defs>
          <linearGradient id="inf-relleno" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="inf-graf-stop-alto" />
            <stop offset="100%" className="inf-graf-stop-bajo" />
          </linearGradient>
        </defs>

        {/* Cuadrícula y eje de dinero */}
        {modelo.ticks.map((t) => (
          <g key={t.valor}>
            <line
              x1={modelo.PAD.left}
              x2={modelo.W - modelo.PAD.right}
              y1={t.y}
              y2={t.y}
              className={t.valor === 0 ? "inf-graf-base" : "inf-graf-rejilla"}
              vectorEffect="non-scaling-stroke"
            />
            <text x={modelo.PAD.left - 8} y={t.y + 4} className="inf-graf-tick" textAnchor="end">
              {t.texto}
            </text>
          </g>
        ))}

        {/* Área + línea de ingresos */}
        {modelo.area ? <path d={modelo.area} className="inf-graf-area" /> : null}
        <path d={modelo.linea} className="inf-graf-linea" fill="none" vectorEffect="non-scaling-stroke" />

        {/* Puntos: solo mientras se distingan; con 60 días ya son una fila de manchas. */}
        {n <= 45
          ? modelo.coords.map((c, i) => (
              <circle key={puntos[i].dia} cx={c.x} cy={c.y} r={n <= 14 ? 4 : 2.8} className="inf-graf-punto" />
            ))
          : null}

        {/* Fechas del eje X */}
        {modelo.etiquetasX.map((e) => (
          <text key={e.i} x={e.x} y={modelo.H - 10} className="inf-graf-tick" textAnchor={e.ancla}>
            {e.texto}
          </text>
        ))}

        {/* Marca del día señalado */}
        {coord ? (
          <g className="inf-graf-marca">
            <line
              x1={coord.x}
              x2={coord.x}
              y1={modelo.PAD.top}
              y2={modelo.suelo}
              className="inf-graf-guia"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={coord.x} cy={coord.y} r="5.5" className="inf-graf-activo" vectorEffect="non-scaling-stroke" />
          </g>
        ) : null}
      </svg>

      {punto ? (
        <div className={`inf-tip inf-tip-${anclaje}`} style={{ left: `${pctX}%` }} role="status">
          <b>{punto.etiquetaLarga}</b>
          <span className="inf-tip-dinero">{formatCents(punto.ingresosCents)}</span>
          <span className="inf-tip-sub">
            {punto.pedidos === 0
              ? "sin ventas ese día"
              : `${punto.pedidos} ${punto.pedidos === 1 ? "pedido" : "pedidos"}`}
          </span>
        </div>
      ) : null}
    </div>
  );
}
