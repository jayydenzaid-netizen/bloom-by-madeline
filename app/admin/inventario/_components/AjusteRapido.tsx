"use client";

import { useActionState, useEffect, useState } from "react";
import { guardarStock, type EstadoInventario } from "../actions";

// El estado inicial se declara aquí y no en actions.ts porque un fichero
// "use server" solo puede exportar funciones asíncronas.
const ESTADO_INICIAL: EstadoInventario = {};

/**
 * Editor de stock de una fila: escribes el número que hay de verdad y se
 * guarda, o tocas − / + para corregir de una en una.
 *
 * Es cliente porque hay interacción real (el número que se teclea, los pasos y
 * el "guardado" que confirma), pero el campo escrito sigue siendo un `<form>`
 * con Server Action: si el JavaScript aún no cargó — la boutique tiene mala
 * cobertura y Madeline entra desde el móvil — escribir el número y pulsar Enter
 * funciona igual. Los botones ± son el atajo, no el único camino.
 *
 * Cada guardado escribe su `StockMovement` (ver lib/inventory.ts): nunca se
 * cambia el número sin dejar rastro.
 */
export function AjusteRapido({
  variantId,
  stock,
  etiqueta,
}: {
  variantId: string;
  stock: number;
  /** Nombre completo de la variante, solo para los lectores de pantalla. */
  etiqueta: string;
}) {
  const [estado, enviar, pendiente] = useActionState(guardarStock, ESTADO_INICIAL);
  const [valor, setValor] = useState(String(stock));
  const [aviso, setAviso] = useState<EstadoInventario | null>(null);

  // Cuando el ajuste se guarda, el servidor revalida y la fila vuelve con el
  // stock nuevo: hay que reflejarlo en el campo o seguiría enseñando lo tecleado.
  useEffect(() => {
    setValor(String(stock));
  }, [stock]);

  // El "guardado" se va solo a los 5 s. Un panel lleno de confirmaciones viejas
  // hace dudar de si lo que se ve es de ahora o de hace media hora.
  useEffect(() => {
    if (!estado.ok && !estado.error) return;
    setAviso(estado);
    const t = setTimeout(() => setAviso(null), 5000);
    return () => clearTimeout(t);
  }, [estado]);

  function paso(direccion: 1 | -1) {
    const fd = new FormData();
    fd.set("variantId", variantId);
    fd.set("modo", direccion > 0 ? "sumar" : "restar");
    fd.set("valor", "1");
    enviar(fd);
  }

  const actual = Number.parseInt(valor, 10);
  const sinCambio = Number.isFinite(actual) && actual === stock;

  return (
    <div>
      <form action={enviar} className="inv-ajuste">
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="modo" value="fijar" />

        <button
          type="button"
          className="inv-paso"
          onClick={() => paso(-1)}
          disabled={pendiente || stock <= 0}
          aria-label={`Quitar una unidad de ${etiqueta}`}
          title="Quitar una unidad"
        >
          −
        </button>

        <input
          type="number"
          name="valor"
          value={valor}
          min={0}
          step={1}
          inputMode="numeric"
          disabled={pendiente}
          onChange={(e) => setValor(e.target.value)}
          aria-label={`Unidades de ${etiqueta}`}
        />

        <button
          type="button"
          className="inv-paso"
          onClick={() => paso(1)}
          disabled={pendiente}
          aria-label={`Añadir una unidad a ${etiqueta}`}
          title="Añadir una unidad"
        >
          +
        </button>

        <button
          type="submit"
          className="adm-btn adm-btn-ghost adm-btn-sm"
          disabled={pendiente || sinCambio}
          title="Guardar el número contado"
        >
          {pendiente ? "…" : "Guardar"}
        </button>
      </form>

      <span className="inv-estado" aria-live="polite">
        {aviso?.error ? <span className="inv-estado-error">{aviso.error}</span> : null}
        {aviso?.ok ? <span className="inv-estado-ok">Guardado</span> : null}
      </span>
    </div>
  );
}
