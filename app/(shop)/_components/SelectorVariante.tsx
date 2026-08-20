"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatCents } from "@/lib/money";
import AddToCart from "./AddToCart";
import Galeria, { type ImagenGaleria } from "./Galeria";
import { useShopUI } from "./CartDrawer";

/**
 * Parte interactiva de la ficha: galería + elección de variante + añadir.
 *
 * Vive todo junto porque hay un solo dato compartido —qué variante está
 * elegida— y de él dependen dos cosas: qué foto enseña la galería (una variante
 * con foto propia hace saltar la imagen) y qué se añade al carrito.
 *
 * El botón, la cantidad, el aviso de stock y el toast NO se reimplementan: los
 * pone AddToCart, que ya es el componente compartido de la tienda. Se le entrega
 * la variante ya resuelta (`optionNames` vacío) para que no dibuje un segundo
 * juego de chips encima del de aquí.
 *
 * El texto de la ficha (título, precio, descripción) llega ya renderizado desde
 * el servidor por las ranuras `info` y `debajo`: no hay motivo para mandarlo al
 * navegador como JavaScript.
 */

export type VarianteFicha = {
  id: string;
  title: string;
  /** [option1, option2, option3] — en el MISMO orden que optionNames. */
  optionValues: (string | null)[];
  priceCents: number;
  compareAtCents: number | null;
  /** Unidades disponibles. null = sin control de stock (lo tiene el proveedor). */
  available: number | null;
  imageUrl: string | null;
};

export default function SelectorVariante({
  titulo,
  imagenes,
  optionNames,
  variantes,
  precioBaseCents,
  compareAtCents,
  info,
  debajo,
}: {
  titulo: string;
  imagenes: ImagenGaleria[];
  optionNames: string[];
  variantes: VarianteFicha[];
  /** Precio del producto. Se usa cuando no hay variantes con precio propio. */
  precioBaseCents: number;
  compareAtCents: number | null;
  info: ReactNode;
  debajo?: ReactNode;
}) {
  const { toast } = useShopUI();
  const [indiceFoto, setIndiceFoto] = useState(0);
  const [elegido, setElegido] = useState<(string | null)[]>(() => optionNames.map(() => null));
  const [idSuelto, setIdSuelto] = useState<string | null>(null);
  const [sacudir, setSacudir] = useState(false);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  const modo: "opciones" | "lista" | "unica" | "vacio" =
    variantes.length === 0
      ? "vacio"
      : optionNames.length > 0
        ? "opciones"
        : variantes.length > 1
          ? "lista" // producto sin nombres de opción pero con varias variantes
          : "unica";

  /** Valores por opción, en el orden en que aparecen en las variantes. */
  const grupos = useMemo(
    () =>
      optionNames.map((nombre, i) => {
        const valores: string[] = [];
        for (const v of variantes) {
          const valor = v.optionValues[i];
          if (valor && !valores.includes(valor)) valores.push(valor);
        }
        return { nombre, valores };
      }),
    [optionNames, variantes],
  );

  /** Variantes que siguen siendo posibles si en la opción `i` se elige `valor`. */
  const compatibles = (i: number, valor: string) =>
    variantes.filter(
      (v) =>
        v.optionValues[i] === valor &&
        optionNames.every((_, j) => j === i || elegido[j] === null || v.optionValues[j] === elegido[j]),
    );

  const seleccionada = useMemo(() => {
    if (modo === "unica") return variantes[0] ?? null;
    if (modo === "lista") return variantes.find((v) => v.id === idSuelto) ?? null;
    if (modo !== "opciones") return null;
    if (elegido.some((v) => v === null)) return null;
    return variantes.find((v) => optionNames.every((_, i) => v.optionValues[i] === elegido[i])) ?? null;
  }, [modo, variantes, idSuelto, elegido, optionNames]);

  // Elegir una variante con foto propia mueve la galería a esa foto. Solo salta
  // si la foto está en la galería: si no, se quedaría en un índice inexistente.
  const fotoVariante = seleccionada?.imageUrl ?? null;
  useEffect(() => {
    if (!fotoVariante) return;
    const i = imagenes.findIndex((img) => img.url === fotoVariante);
    if (i >= 0) setIndiceFoto(i);
  }, [fotoVariante, imagenes]);

  useEffect(() => {
    return () => {
      if (temporizador.current) clearTimeout(temporizador.current);
    };
  }, []);

  const elegir = (i: number, valor: string) => {
    setElegido((previo) => {
      const siguiente = [...previo];
      siguiente[i] = siguiente[i] === valor ? null : valor;
      return siguiente;
    });
  };

  /** Mismo aviso que da AddToCart cuando falta una opción, pero sobre estos chips. */
  const avisarFalta = () => {
    const pendiente =
      modo === "lista" ? "una opción" : optionNames.find((_, i) => elegido[i] === null)?.toLowerCase() ?? "talla";
    toast(`Elige ${pendiente} ✿`);
    setSacudir(true);
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => setSacudir(false), 500);
  };

  const agotadoTodo =
    variantes.length > 0 && variantes.every((v) => v.available !== null && v.available <= 0);

  // El precio grande vive aquí y no en el servidor porque cambia con la variante
  // elegida: en dropshipping una XL puede costar más que una S.
  const preciosReales = variantes.map((v) => v.priceCents).filter((p) => p > 0);
  const variados = new Set(preciosReales).size > 1;
  const precio =
    seleccionada && seleccionada.priceCents > 0
      ? seleccionada.priceCents
      : preciosReales.length
        ? Math.min(...preciosReales)
        : precioBaseCents;
  const comparar = (seleccionada ? seleccionada.compareAtCents : null) ?? compareAtCents;
  const rebajado = precio > 0 && comparar !== null && comparar > precio;
  const ahorro = rebajado ? Math.round((1 - precio / comparar) * 100) : 0;

  return (
    <div className="pf-top">
      <Galeria imagenes={imagenes} activa={indiceFoto} onActiva={setIndiceFoto} titulo={titulo} />

      <div className="pf-info">
        {info}

        <p className="pf-precio">
          {precio > 0 ? (
            <>
              {variados && !seleccionada ? <span className="pf-desde">Desde</span> : null}
              <strong>{formatCents(precio)}</strong>
              {rebajado ? (
                <>
                  <s>{formatCents(comparar)}</s>
                  {ahorro > 0 ? <span className="pf-ahorro">Ahorras {ahorro}%</span> : null}
                </>
              ) : null}
            </>
          ) : (
            // Nunca se inventa una cifra: el contrato lo prohíbe y la clienta lo agradece.
            <em>Precio por confirmar</em>
          )}
        </p>

        {modo === "opciones" ? (
          <div className="atc">
            {grupos.map((grupo, i) => (
              <div className="atc-group" key={grupo.nombre}>
                <p className="lb-talla-label">{grupo.nombre}</p>
                <div className={sacudir ? "lb-tallas shake" : "lb-tallas"}>
                  {grupo.valores.map((valor) => {
                    const posibles = compatibles(i, valor);
                    // Una combinación que no existe o está agotada se ve, pero
                    // apagada: la clienta tiene que entender que la pieza existe
                    // y que ese talle no está, no creer que nunca se hizo.
                    const imposible = posibles.length === 0;
                    const agotada =
                      !imposible && posibles.every((v) => v.available !== null && v.available <= 0);
                    const activa = elegido[i] === valor;
                    return (
                      <button
                        key={valor}
                        type="button"
                        className={`talla-chip${activa ? " sel" : ""}${imposible || agotada ? " atc-off" : ""}`}
                        onClick={() => elegir(i, valor)}
                        disabled={imposible || agotada}
                        aria-pressed={activa}
                        title={agotada ? "Agotada" : imposible ? "Esa combinación no existe" : undefined}
                      >
                        {valor}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {modo === "lista" ? (
          <div className="atc">
            <div className="atc-group">
              <p className="lb-talla-label">Opción</p>
              <div className={sacudir ? "lb-tallas shake" : "lb-tallas"}>
                {variantes.map((v) => {
                  const agotada = v.available !== null && v.available <= 0;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className={`talla-chip${idSuelto === v.id ? " sel" : ""}${agotada ? " atc-off" : ""}`}
                      onClick={() => setIdSuelto((previo) => (previo === v.id ? null : v.id))}
                      disabled={agotada}
                      aria-pressed={idSuelto === v.id}
                      title={agotada ? "Agotada" : undefined}
                    >
                      {v.title}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {/* Con la variante resuelta manda AddToCart; mientras falte elegir, el
            botón solo sirve para avisar de qué falta. */}
        {modo === "vacio" || seleccionada ? (
          <AddToCart
            key={seleccionada?.id ?? "sin-variantes"}
            optionNames={[]}
            variants={seleccionada ? [seleccionada] : []}
          />
        ) : (
          <div className="atc">
            <button
              className="btn btn-ink atc-add"
              type="button"
              onClick={avisarFalta}
              disabled={agotadoTodo}
            >
              {agotadoTodo ? "Agotado" : "Añadir al carrito"}
            </button>
            {agotadoTodo ? (
              <p className="atc-sold">
                Se agotó por ahora. Escríbenos por DM y te avisamos cuando vuelva.
              </p>
            ) : null}
          </div>
        )}

        {debajo}
      </div>
    </div>
  );
}
