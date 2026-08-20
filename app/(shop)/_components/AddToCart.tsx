"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { formatCents } from "@/lib/money";
import { addToCart } from "../cart-actions";
import { useShopUI } from "./CartDrawer";

/**
 * Selector de variante + botón de añadir.
 *
 * Obliga a elegir talla/color antes de añadir: en la boutique el 90% de los
 * problemas de un pedido por DM eran "no dijo la talla". Las combinaciones que no
 * existen se deshabilitan en vez de dejar que llegue al error del servidor.
 */

export type AddToCartVariant = {
  id: string;
  title: string;
  /** Valores en el mismo orden que optionNames: [option1, option2, option3]. */
  optionValues: (string | null)[];
  priceCents: number;
  /** Unidades disponibles. null = sin control de stock (el proveedor lo tiene). */
  available: number | null;
};

const MAX_QTY = 20;

export default function AddToCart({
  optionNames,
  variants,
}: {
  /** ["Talla", "Color"]. Vacío si el producto no tiene opciones. */
  optionNames: string[];
  variants: AddToCartVariant[];
}) {
  const { openCart, toast } = useShopUI();
  const [pending, startTransition] = useTransition();
  const [qty, setQty] = useState(1);
  const [shake, setShake] = useState(false);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sin opciones o con una sola variante no hay nada que elegir.
  const unica = variants.length === 1 && optionNames.length === 0 ? variants[0] : null;
  const [picked, setPicked] = useState<(string | null)[]>(() => optionNames.map(() => null));

  const grupos = useMemo(
    () =>
      optionNames.map((name, i) => {
        const values: string[] = [];
        for (const v of variants) {
          const val = v.optionValues[i];
          if (val && !values.includes(val)) values.push(val);
        }
        return { name, values };
      }),
    [optionNames, variants],
  );

  /** Variantes compatibles con el valor `val` en la opción `i` dadas las ya elegidas. */
  const compatibles = (i: number, val: string) =>
    variants.filter(
      (v) =>
        v.optionValues[i] === val &&
        optionNames.every((_, j) => j === i || picked[j] === null || v.optionValues[j] === picked[j]),
    );

  const selected = useMemo(() => {
    if (unica) return unica;
    if (picked.some((v) => v === null)) return null;
    return (
      variants.find((v) => optionNames.every((_, i) => v.optionValues[i] === picked[i])) ?? null
    );
  }, [unica, picked, variants, optionNames]);

  const agotadoTodo = variants.length > 0 && variants.every((v) => v.available !== null && v.available <= 0);
  const sinVariantes = variants.length === 0;

  const tope = selected?.available ?? MAX_QTY;
  const maxQty = Math.max(1, Math.min(tope, MAX_QTY));

  // Solo tiene sentido enseñar el precio aquí si cambia según la variante.
  const preciosDistintos = new Set(variants.map((v) => v.priceCents)).size > 1;

  const pick = (i: number, val: string) => {
    setPicked((prev) => {
      const next = [...prev];
      next[i] = next[i] === val ? null : val;
      return next;
    });
    setQty(1);
  };

  const avisarFalta = () => {
    const pendiente = optionNames.find((_, i) => picked[i] === null) ?? "talla";
    toast(`Elige ${pendiente.toLowerCase()} ✿`);
    setShake(true);
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShake(false), 500);
  };

  const onAdd = () => {
    if (!selected) {
      avisarFalta();
      return;
    }
    if (selected.available !== null && selected.available <= 0) {
      toast("Esa combinación está agotada");
      return;
    }
    startTransition(async () => {
      const res = await addToCart(selected.id, qty);
      toast(res.message ?? (res.ok ? "Añadido a tu carrito" : "No pudimos añadirlo"));
      if (res.ok) openCart();
    });
  };

  if (sinVariantes) {
    return (
      <div className="atc">
        <p className="atc-sold">Esta pieza aún no está a la venta. Escríbenos por DM y te avisamos.</p>
      </div>
    );
  }

  return (
    <div className="atc">
      {grupos.map((grupo, i) => (
        <div className="atc-group" key={grupo.name}>
          <p className="lb-talla-label">{grupo.name}</p>
          <div className={shake ? "lb-tallas shake" : "lb-tallas"}>
            {grupo.values.map((val) => {
              const opciones = compatibles(i, val);
              const imposible = opciones.length === 0;
              const agotada =
                !imposible && opciones.every((v) => v.available !== null && v.available <= 0);
              const elegida = picked[i] === val;
              return (
                <button
                  key={val}
                  type="button"
                  className={`talla-chip${elegida ? " sel" : ""}${imposible || agotada ? " atc-off" : ""}`}
                  onClick={() => pick(i, val)}
                  disabled={imposible || agotada}
                  aria-pressed={elegida}
                  title={agotada ? "Agotada" : undefined}
                >
                  {val}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {preciosDistintos ? (
        <p className="atc-price">
          {selected ? formatCents(selected.priceCents) : `Desde ${formatCents(Math.min(...variants.map((v) => v.priceCents)))}`}
        </p>
      ) : null}

      <div className="atc-qty">
        <span className="lb-talla-label">Cantidad</span>
        <div className="ci-qty">
          <button
            type="button"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            disabled={pending || qty <= 1}
            aria-label="Quitar una unidad"
          >
            −
          </button>
          <span>{qty}</span>
          <button
            type="button"
            onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
            disabled={pending || qty >= maxQty}
            aria-label="Añadir una unidad"
          >
            +
          </button>
        </div>
      </div>

      <button
        className="btn btn-ink atc-add"
        type="button"
        onClick={onAdd}
        disabled={pending || agotadoTodo}
      >
        {agotadoTodo ? "Agotado" : pending ? "Añadiendo…" : "Añadir al carrito"}
      </button>

      {agotadoTodo ? (
        <p className="atc-sold">
          Se agotó por ahora. Escríbenos por DM y te avisamos cuando vuelva.
        </p>
      ) : null}

      {!agotadoTodo && selected && selected.available !== null && selected.available <= 5 ? (
        <p className="atc-low">
          Quedan {selected.available} {selected.available === 1 ? "unidad" : "unidades"}
        </p>
      ) : null}
    </div>
  );
}
