"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { fijarPrecio, fijarStock, quitarLimiteStock } from "../rapido";

/**
 * Celdas editables del listado: un clic sobre el precio o el stock abre un campo
 * ahí mismo, se escribe el número, Enter guarda. Sin abrir el editor entero.
 *
 * Cada celda guarda una copia optimista de lo que acaba de escribir para que el
 * cambio se vea al instante, y llama a router.refresh() para que el resto de la
 * fila (la etiqueta "Sin precio", el badge de agotado) se ponga al día sola.
 */

/* ─────────────────────────────── PRECIO ─────────────────────────────── */

export function PrecioRapido({ id, priceCents }: { id: string; priceCents: number }) {
  const router = useRouter();
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [optimista, setOptimista] = useState<number | null>(null);
  const [guardando, empezar] = useTransition();
  // Enter y blur pueden dispararse casi a la vez; este cerrojo evita guardar dos veces.
  const yaEnviado = useRef(false);

  const precio = optimista ?? priceCents;

  function abrir() {
    setValor(precio > 0 ? (precio / 100).toFixed(2) : "");
    setError(null);
    yaEnviado.current = false;
    setEditando(true);
  }

  function guardar() {
    if (yaEnviado.current) return;
    yaEnviado.current = true;
    empezar(async () => {
      const r = await fijarPrecio(id, valor);
      if (!r.ok) {
        setError(r.mensaje ?? "No se pudo guardar.");
        yaEnviado.current = false;
        return;
      }
      setOptimista(r.priceCents ?? 0);
      setEditando(false);
      setError(null);
      router.refresh();
    });
  }

  function cancelar() {
    setEditando(false);
    setError(null);
  }

  if (editando) {
    return (
      <span className="cat-quick cat-quick-editando">
        <span className="cat-quick-campo">
          <span className="cat-quick-signo">$</span>
          <input
            autoFocus
            className="cat-quick-in"
            type="text"
            inputMode="decimal"
            value={valor}
            placeholder="45.99"
            disabled={guardando}
            onChange={(e) => setValor(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); guardar(); }
              if (e.key === "Escape") { e.preventDefault(); cancelar(); }
            }}
            onBlur={guardar}
            aria-label="Precio"
          />
        </span>
        {guardando ? <span className="cat-quick-spin" aria-hidden /> : null}
        {error ? <span className="cat-quick-err">{error}</span> : null}
      </span>
    );
  }

  return (
    <button type="button" className={`cat-quick-btn${precio > 0 ? "" : " es-vacio"}`} onClick={abrir}>
      {precio > 0 ? (
        <span className="adm-money adm-money-strong">{formatCents(precio)}</span>
      ) : (
        <span className="cat-quick-poner">Poner precio</span>
      )}
      <span className="cat-quick-lapiz" aria-hidden>✎</span>
    </button>
  );
}

/* ─────────────────────────────── STOCK ─────────────────────────────── */

export function StockRapido({
  id,
  stockTotal,
  controlaStock,
  variantes,
}: {
  id: string;
  stockTotal: number;
  controlaStock: boolean;
  /** Nº de variantes: el número que escribe se pone en CADA talla. */
  variantes: number;
}) {
  const router = useRouter();
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [optimista, setOptimista] = useState<{ stock: number; controla: boolean } | null>(null);
  const [guardando, empezar] = useTransition();
  const yaEnviado = useRef(false);

  const controla = optimista?.controla ?? controlaStock;
  // Con varias tallas, el "por talla" que se escribe se multiplica en el total.
  const total = optimista ? optimista.stock * Math.max(1, variantes) : stockTotal;

  function abrir() {
    setValor(controla && variantes > 0 ? String(Math.round(stockTotal / Math.max(1, variantes))) : "");
    setError(null);
    yaEnviado.current = false;
    setEditando(true);
  }

  function guardar() {
    if (yaEnviado.current) return;
    yaEnviado.current = true;
    empezar(async () => {
      const r = await fijarStock(id, valor);
      if (!r.ok) {
        setError(r.mensaje ?? "No se pudo guardar.");
        yaEnviado.current = false;
        return;
      }
      setOptimista({ stock: r.stock ?? 0, controla: true });
      setEditando(false);
      setError(null);
      router.refresh();
    });
  }

  function sinLimite() {
    empezar(async () => {
      const r = await quitarLimiteStock(id);
      if (!r.ok) { setError(r.mensaje ?? "No se pudo."); return; }
      setOptimista({ stock: 0, controla: false });
      setEditando(false);
      router.refresh();
    });
  }

  if (editando) {
    return (
      <span className="cat-quick cat-quick-editando">
        <span className="cat-quick-campo">
          <input
            autoFocus
            className="cat-quick-in cat-quick-in-sm"
            type="text"
            inputMode="numeric"
            value={valor}
            placeholder="5"
            disabled={guardando}
            onChange={(e) => setValor(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); guardar(); }
              if (e.key === "Escape") { e.preventDefault(); setEditando(false); }
            }}
            aria-label="Existencias por talla"
          />
        </span>
        {variantes > 1 ? <span className="cat-quick-nota">por talla</span> : null}
        <button type="button" className="cat-quick-mini" onClick={guardar} disabled={guardando}>
          Guardar
        </button>
        <button type="button" className="cat-quick-mini cat-quick-mini-ghost" onClick={sinLimite} disabled={guardando}>
          Sin límite
        </button>
        {guardando ? <span className="cat-quick-spin" aria-hidden /> : null}
        {error ? <span className="cat-quick-err">{error}</span> : null}
      </span>
    );
  }

  return (
    <button type="button" className="cat-quick-btn" onClick={abrir}>
      {controla ? (
        <span className={total <= 0 ? "cat-margen-malo" : undefined}>{total}</span>
      ) : (
        <span className="adm-muted adm-small">Sin límite</span>
      )}
      <span className="cat-quick-lapiz" aria-hidden>✎</span>
    </button>
  );
}
