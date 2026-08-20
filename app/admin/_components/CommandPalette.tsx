"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * Buscador global del panel (Ctrl+K / Cmd+K, o el botón "Buscar").
 *
 * Por qué existe: el panel tiene 25 pantallas. Madeline no debería tener que
 * recordar en qué sección vive cada cosa para encontrar el pedido BLM-1007 o
 * el vestido que subió ayer. Escribe, y aparece.
 *
 * ───────────────────────── LA REGLA QUE NO SE ROMPE ─────────────────────────
 * Cuando está cerrado, este componente devuelve `null`. No devuelve una capa
 * con `opacity: 0`, ni con `visibility: hidden`, ni con `hidden` y una clase
 * que lo anule. CERO nodos en el DOM.
 *
 * No es tiquismiquis: en este proyecto ya se coló a producción un lightbox que
 * dejaba una capa invisible cubriendo el viewport, y NADA de la página era
 * clickeable. Sobrevivió a decenas de capturas porque una captura no sabe si
 * algo responde al ratón (ver _CONTRATO.md, regla 4). Devolviendo `null` el
 * fallo es imposible por construcción, no por disciplina. Verificado con
 * document.elementFromPoint en qa/, no con una foto.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ─────────────────────────────── tipos ─────────────────────────────── */

export type TipoResultado = "producto" | "pedido" | "clienta";

export type ResultadoBusqueda = {
  id: string;
  tipo: TipoResultado;
  titulo: string;
  /** Línea secundaria: precio, estado, correo... lo que ayude a distinguir. */
  detalle: string;
  href: string;
};

/** Atajo a una pantalla o a una acción concreta. No depende de lo que escribas. */
export type AccionRapida = {
  id: string;
  titulo: string;
  detalle: string;
  href: string;
  /** Palabras por las que también se encuentra ("caja" → Mostrador). */
  claves: string;
};

type Fila =
  | { clase: "accion"; clave: string; titulo: string; detalle: string; href: string }
  | { clase: "resultado"; clave: string; titulo: string; detalle: string; href: string; tipo: TipoResultado };

/** Nombre del evento con el que cualquier botón de la página abre la paleta. */
const EVENTO_ABRIR = "bloom:abrir-buscador";

const ETIQUETA_TIPO: Record<TipoResultado, string> = {
  producto: "Producto",
  pedido: "Pedido",
  clienta: "Clienta",
};

/* ───────────────────────── botón que la abre ───────────────────────── */

/**
 * Disparador. Va en la cabecera móvil y en el sidebar de escritorio; los dos
 * mandan el mismo evento, así que la paleta se monta UNA sola vez en el layout
 * y no hay dos copias del estado peleándose.
 */
export function BotonBuscar({ variante = "sidebar" }: { variante?: "sidebar" | "topbar" }) {
  return (
    <button
      type="button"
      className={variante === "topbar" ? "adm-topbar-buscar" : "adm-side-buscar"}
      onClick={() => window.dispatchEvent(new CustomEvent(EVENTO_ABRIR))}
      aria-label="Buscar en el panel"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
      <span>Buscar</span>
      {variante === "sidebar" ? <kbd aria-hidden="true">Ctrl K</kbd> : null}
    </button>
  );
}

/* ─────────────────────────── la paleta ─────────────────────────── */

export default function CommandPalette({
  buscar,
  acciones,
}: {
  /** Server Action definida en el layout: consulta la BD con la sesión ya validada. */
  buscar: (consulta: string) => Promise<ResultadoBusqueda[]>;
  acciones: AccionRapida[];
}) {
  const router = useRouter();
  const idLista = useId();

  const [abierto, setAbierto] = useState(false);
  const [consulta, setConsulta] = useState("");
  const [resultados, setResultados] = useState<ResultadoBusqueda[]>([]);
  const [cargando, setCargando] = useState(false);
  const [indice, setIndice] = useState(0);

  const entrada = useRef<HTMLInputElement | null>(null);
  // Cada búsqueda lleva número: si vuelve una vieja después de una nueva, se
  // tira. Sin esto, teclear rápido enseña los resultados de hace dos letras.
  const peticion = useRef(0);

  const cerrar = useCallback(() => {
    setAbierto(false);
    setConsulta("");
    setResultados([]);
    setIndice(0);
  }, []);

  /* Atajo de teclado global + apertura desde los botones. */
  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setAbierto((v) => !v);
      }
    };
    const alPedirApertura = () => setAbierto(true);

    window.addEventListener("keydown", alPulsar);
    window.addEventListener(EVENTO_ABRIR, alPedirApertura);
    return () => {
      window.removeEventListener("keydown", alPulsar);
      window.removeEventListener(EVENTO_ABRIR, alPedirApertura);
    };
  }, []);

  /* Al abrir, el cursor ya está en el hueco de escribir. */
  useEffect(() => {
    if (abierto) entrada.current?.focus();
  }, [abierto]);

  /* Búsqueda con freno: no se consulta en cada tecla. */
  useEffect(() => {
    if (!abierto) return;

    const texto = consulta.trim();
    if (texto.length < 2) {
      setResultados([]);
      setCargando(false);
      return;
    }

    const mio = ++peticion.current;
    setCargando(true);
    const temporizador = setTimeout(() => {
      buscar(texto)
        .then((filas) => {
          if (peticion.current !== mio) return; // llegó tarde: ya hay otra búsqueda
          setResultados(filas);
          setCargando(false);
        })
        .catch(() => {
          if (peticion.current !== mio) return;
          setResultados([]);
          setCargando(false);
        });
    }, 170);

    return () => clearTimeout(temporizador);
  }, [abierto, consulta, buscar]);

  /* Acciones + resultados en una sola lista: las flechas recorren todo seguido. */
  const filas: Fila[] = useMemo(() => {
    const texto = consulta.trim().toLowerCase();
    const accionesVisibles = texto
      ? acciones.filter((a) => `${a.titulo} ${a.claves}`.toLowerCase().includes(texto))
      : acciones;

    return [
      ...accionesVisibles.map((a) => ({
        clase: "accion" as const,
        clave: `a:${a.id}`,
        titulo: a.titulo,
        detalle: a.detalle,
        href: a.href,
      })),
      ...resultados.map((r) => ({
        clase: "resultado" as const,
        clave: `r:${r.tipo}:${r.id}`,
        titulo: r.titulo,
        detalle: r.detalle,
        href: r.href,
        tipo: r.tipo,
      })),
    ];
  }, [acciones, consulta, resultados]);

  /* Si la lista encoge, el resaltado no puede quedarse fuera de rango. */
  useEffect(() => {
    setIndice((i) => (i >= filas.length ? 0 : i));
  }, [filas.length]);

  const ir = useCallback(
    (href: string) => {
      cerrar();
      router.push(href);
    },
    [cerrar, router],
  );

  if (!abierto) return null; // ← ni un nodo en el DOM. Ver el comentario de arriba.

  const alTeclear = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cerrar();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndice((i) => (filas.length === 0 ? 0 : (i + 1) % filas.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndice((i) => (filas.length === 0 ? 0 : (i - 1 + filas.length) % filas.length));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const fila = filas[indice];
      if (fila) ir(fila.href);
    }
  };

  const hayTexto = consulta.trim().length >= 2;

  return (
    <div
      className="cmdp-back"
      // mousedown y no click: si se pulsa fuera y se suelta dentro, no se cierra
      // a traición mientras se selecciona texto.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cerrar();
      }}
    >
      <div className="cmdp" role="dialog" aria-modal="true" aria-label="Buscar en el panel">
        <div className="cmdp-head">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="cmdp-lupa">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            ref={entrada}
            type="text"
            value={consulta}
            onChange={(e) => {
              setConsulta(e.target.value);
              setIndice(0);
            }}
            onKeyDown={alTeclear}
            placeholder="Busca un producto, un pedido o una clienta…"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls={idLista}
            aria-autocomplete="list"
            aria-activedescendant={filas[indice] ? `${idLista}-${indice}` : undefined}
          />
          <button type="button" className="cmdp-cerrar" onClick={cerrar} aria-label="Cerrar el buscador">
            Esc
          </button>
        </div>

        <div className="cmdp-lista" id={idLista} role="listbox" aria-label="Resultados">
          {filas.length === 0 ? (
            <p className="cmdp-vacio">
              {cargando
                ? "Buscando…"
                : hayTexto
                  ? `No hay nada que se llame «${consulta.trim()}». Prueba con otra palabra, o con el número del pedido.`
                  : "Escribe al menos dos letras."}
            </p>
          ) : (
            filas.map((fila, i) => (
              <button
                type="button"
                key={fila.clave}
                id={`${idLista}-${i}`}
                role="option"
                aria-selected={i === indice}
                className={`cmdp-fila${i === indice ? " is-sel" : ""}`}
                onMouseEnter={() => setIndice(i)}
                onClick={() => ir(fila.href)}
              >
                <span className="cmdp-fila-txt">
                  <b>{fila.titulo}</b>
                  <span>{fila.detalle}</span>
                </span>
                <span className={`cmdp-tag cmdp-tag-${fila.clase === "accion" ? "accion" : fila.tipo}`}>
                  {fila.clase === "accion" ? "Ir" : ETIQUETA_TIPO[fila.tipo]}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="cmdp-pie">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> moverse
          </span>
          <span>
            <kbd>Enter</kbd> abrir
          </span>
          <span>
            <kbd>Esc</kbd> cerrar
          </span>
        </div>
      </div>
    </div>
  );
}
