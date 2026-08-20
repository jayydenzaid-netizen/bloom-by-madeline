"use client";

import { useMemo, useState } from "react";
import { ESTADOS_US, REGION_COMODIN, REGION_RECOGIDA } from "@/lib/shipping";

/**
 * Selector de las regiones que cubre una zona.
 *
 * Cincuenta estados en una lista son inmanejables desde el móvil, así que hay
 * tres atajos arriba (todo Estados Unidos, recogida, y el estado de la boutique)
 * y un buscador para lo demás. Se envía como varias casillas `regions`, que es
 * lo que espera la Server Action.
 */
export function SelectorRegiones({
  seleccion,
  nombre = "regions",
}: {
  seleccion: string[];
  nombre?: string;
}) {
  const [elegidas, setElegidas] = useState<string[]>(() => seleccion);
  const [busqueda, setBusqueda] = useState("");
  const [abierto, setAbierto] = useState(false);

  const tiene = (code: string) => elegidas.includes(code);

  const alternar = (code: string) => {
    setElegidas((previas) =>
      previas.includes(code) ? previas.filter((c) => c !== code) : [...previas, code],
    );
  };

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return ESTADOS_US;
    return ESTADOS_US.filter(
      (e) => e.name.toLowerCase().includes(q) || e.code.toLowerCase().includes(q),
    );
  }, [busqueda]);

  const resumen = () => {
    if (elegidas.length === 0) return "Ninguna región elegida todavía";
    if (elegidas.includes(REGION_RECOGIDA)) return "Recogida en la boutique";
    if (elegidas.includes(REGION_COMODIN)) return "Todo el mundo";
    if (elegidas.includes("US")) return "Todo Estados Unidos";
    const nombres = elegidas
      .map((c) => ESTADOS_US.find((e) => `US-${e.code}` === c || e.code === c)?.name ?? c)
      .filter(Boolean);
    if (nombres.length <= 3) return nombres.join(" · ");
    return `${nombres.slice(0, 3).join(" · ")} y ${nombres.length - 3} más`;
  };

  return (
    <div className="env-regiones">
      {/* Lo que de verdad se envía: el estado de React, no las casillas visibles. */}
      {elegidas.map((code) => (
        <input key={code} type="hidden" name={nombre} value={code} />
      ))}

      <div className="env-reg-atajos">
        <button
          type="button"
          className={`env-chip ${tiene("US") ? "is-on" : ""}`}
          onClick={() => alternar("US")}
        >
          Todo Estados Unidos
        </button>
        <button
          type="button"
          className={`env-chip ${tiene("US-OH") ? "is-on" : ""}`}
          onClick={() => alternar("US-OH")}
        >
          Ohio
        </button>
        <button
          type="button"
          className={`env-chip ${tiene(REGION_RECOGIDA) ? "is-on" : ""}`}
          onClick={() => alternar(REGION_RECOGIDA)}
        >
          Recogida en la boutique
        </button>
      </div>

      <p className="env-reg-resumen">{resumen()}</p>

      <button type="button" className="env-reg-toggle" onClick={() => setAbierto((v) => !v)}>
        {abierto ? "Ocultar la lista de estados" : "Elegir estados uno a uno"}
      </button>

      {abierto ? (
        <div className="env-reg-panel">
          <input
            type="search"
            placeholder="Buscar un estado…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            aria-label="Buscar un estado"
          />
          <div className="env-reg-lista">
            {filtrados.map((estado) => {
              const code = `US-${estado.code}`;
              return (
                <label key={estado.code} className="env-reg-item">
                  <input type="checkbox" checked={tiene(code)} onChange={() => alternar(code)} />
                  <span>{estado.name}</span>
                  <em>{estado.code}</em>
                </label>
              );
            })}
            {filtrados.length === 0 ? (
              <p className="adm-muted adm-small">Ningún estado coincide con «{busqueda}».</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
