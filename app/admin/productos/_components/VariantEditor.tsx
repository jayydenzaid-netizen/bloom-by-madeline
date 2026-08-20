"use client";

import { useState } from "react";
import { applyPricing, formatCents, margin, parseToCents, type PricingRule } from "@/lib/money";
import { Badge, Button, DataTable, type Column } from "../../_components/ui";
import type { VarianteDraft } from "../actions";

/**
 * Editor de variantes: la parrilla donde de verdad se decide si un producto
 * merece la pena. Por eso el margen es una columna fija y no un dato escondido.
 *
 * Las cantidades de dinero se guardan aquí como TEXTO, tal cual lo escribe
 * Madeline ("45.99", "45,99", "$45.99"), y solo se convierten a centavos con
 * parseToCents al calcular o al enviar. Si guardáramos centavos en el estado,
 * borrar el punto decimal para reescribir el precio multiplicaría el número por
 * cien delante de sus ojos.
 */

export type Fila = {
  /** Clave estable de React: sobrevive a reordenar y regenerar. */
  key: string;
  /** null = variante nueva. */
  id: string | null;
  /** Valores de opción en el orden de optionNames. */
  opciones: string[];
  sku: string;
  precio: string;
  coste: string;
  compara: string;
  stock: string;
  trackStock: boolean;
  /** Foto propia de la variante. El importador la rellena; aquí solo se
   *  conserva para no borrarla sin querer al guardar. */
  imageUrl: string | null;
};

export type Opcion = { nombre: string; valores: string };

let contador = 0;
function nuevaClave(): string {
  contador += 1;
  return `v${contador}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Centavos → texto editable. La vista SIEMPRE usa formatCents; esto es solo el
 *  valor de un input, donde un "$" delante estorbaría al escribir. */
function aTexto(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

export function filaVacia(opciones: string[] = []): Fila {
  return {
    key: nuevaClave(),
    id: null,
    opciones,
    sku: "",
    precio: "",
    coste: "",
    compara: "",
    stock: "0",
    trackStock: false,
    imageUrl: null,
  };
}

export function filaDesdeVariante(v: {
  id: string;
  sku: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  priceCents: number;
  compareAtCents: number | null;
  costCents: number | null;
  stock: number;
  trackStock: boolean;
  imageUrl: string | null;
}): Fila {
  return {
    key: nuevaClave(),
    id: v.id,
    opciones: [v.option1, v.option2, v.option3].filter((x): x is string => Boolean(x)),
    sku: v.sku,
    precio: v.priceCents > 0 ? aTexto(v.priceCents) : "",
    coste: aTexto(v.costCents),
    compara: aTexto(v.compareAtCents),
    stock: String(v.stock),
    trackStock: v.trackStock,
    imageUrl: v.imageUrl,
  };
}

function claveCombinacion(valores: string[]): string {
  return JSON.stringify(valores);
}

/** Una fila "tiene contenido" si ya existe en la base o si alguien escribió algo
 *  en ella: es lo que distingue perder trabajo de tirar un hueco vacío. */
function tieneContenido(fila: Fila): boolean {
  return Boolean(
    fila.id ||
      fila.sku.trim() ||
      fila.precio.trim() ||
      fila.coste.trim() ||
      fila.compara.trim() ||
      (Number.parseInt(fila.stock, 10) || 0) !== 0,
  );
}

export function tituloDeFila(fila: Fila): string {
  return fila.opciones.filter(Boolean).join(" / ") || "Estándar";
}

/** Traduce lo que se ve en pantalla al contrato que espera el Server Action. */
export function filaAVariante(fila: Fila): VarianteDraft {
  return {
    id: fila.id,
    title: tituloDeFila(fila),
    sku: fila.sku.trim(),
    option1: fila.opciones[0]?.trim() || null,
    option2: fila.opciones[1]?.trim() || null,
    option3: fila.opciones[2]?.trim() || null,
    priceCents: Math.max(0, parseToCents(fila.precio) ?? 0),
    compareAtCents: parseToCents(fila.compara),
    costCents: parseToCents(fila.coste),
    stock: Number.parseInt(fila.stock, 10) || 0,
    trackStock: fila.trackStock,
    imageUrl: fila.imageUrl,
  };
}

/* ───────────────────────────── componente ───────────────────────────── */

type Props = {
  opciones: Opcion[];
  filas: Fila[];
  pricing: PricingRule;
  onOpciones: (opciones: Opcion[]) => void;
  onFilas: (filas: Fila[]) => void;
};

type ColumnaLote = "precio" | "coste" | "stock" | "sku";

export default function VariantEditor({ opciones, filas, pricing, onOpciones, onFilas }: Props) {
  const [columna, setColumna] = useState<ColumnaLote>("precio");
  const [valorLote, setValorLote] = useState("");
  const [porcentaje, setPorcentaje] = useState("10");
  const [pendiente, setPendiente] = useState<{ filas: Fila[]; quitadas: string[] } | null>(null);
  const [nota, setNota] = useState<string | null>(null);

  const esDinero = columna === "precio" || columna === "coste";

  function editar(key: string, campo: keyof Fila, valor: string | boolean) {
    onFilas(filas.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }

  /* ── opciones (Talla, Color…) ── */

  function cambiarOpcion(indice: number, campo: keyof Opcion, valor: string) {
    onOpciones(opciones.map((o, i) => (i === indice ? { ...o, [campo]: valor } : o)));
  }

  function anadirOpcion() {
    if (opciones.length >= 3) return; // el esquema solo guarda option1..option3
    onOpciones([...opciones, { nombre: "", valores: "" }]);
  }

  function quitarOpcion(indice: number) {
    onOpciones(opciones.filter((_, i) => i !== indice));
  }

  /* ── generación de combinaciones ── */

  function calcularCombinaciones(): { filas: Fila[]; quitadas: string[] } | null {
    const activas = opciones
      .map((o) => ({
        nombre: o.nombre.trim(),
        valores: [...new Set(o.valores.split(",").map((v) => v.trim()).filter(Boolean))],
      }))
      .filter((o) => o.nombre && o.valores.length > 0);

    if (activas.length === 0) return null;

    let combos: string[][] = [[]];
    for (const opcion of activas) {
      combos = combos.flatMap((base) => opcion.valores.map((valor) => [...base, valor]));
    }

    // Plantilla: si ya había precio y coste puestos, la variante nueva nace con
    // ellos. Regenerar por añadir una talla no debe borrar el trabajo hecho.
    const plantilla = filas[0];
    // La clave de una combinación es su lista de valores serializada: unir con
    // un separador cualquiera se rompería en cuanto una talla lo contuviera.
    const previas = new Map(filas.map((f) => [claveCombinacion(f.opciones), f]));
    const resultado = combos.map((combo) => {
      const existente = previas.get(claveCombinacion(combo));
      if (existente) return { ...existente, opciones: combo };
      return {
        ...filaVacia(combo),
        precio: plantilla?.precio ?? "",
        coste: plantilla?.coste ?? "",
        compara: plantilla?.compara ?? "",
        stock: plantilla?.stock ?? "0",
        trackStock: plantilla?.trackStock ?? false,
      };
    });

    const clavesNuevas = new Set(combos.map(claveCombinacion));
    // Solo se avisa de lo que duele perder: una fila ya guardada o una en la que
    // alguien escribió algo. La fila en blanco con la que nace un producto nuevo
    // desaparece sin dar la lata.
    const quitadas = filas
      .filter((f) => !clavesNuevas.has(claveCombinacion(f.opciones)) && tieneContenido(f))
      .map(tituloDeFila);

    return { filas: resultado, quitadas };
  }

  function generar() {
    const calculo = calcularCombinaciones();
    setNota(null);
    if (!calculo) {
      setNota("Escribe al menos el nombre de una opción y sus valores separados por comas.");
      return;
    }
    // Solo se pide confirmación si de verdad se va a perder algo.
    if (calculo.quitadas.length > 0) {
      setPendiente(calculo);
      return;
    }
    onFilas(calculo.filas);
    setNota(`${calculo.filas.length} variantes en la tabla.`);
  }

  function confirmarGenerar() {
    if (!pendiente) return;
    onFilas(pendiente.filas);
    setNota(`${pendiente.filas.length} variantes en la tabla.`);
    setPendiente(null);
  }

  /* ── edición de una columna entera ── */

  function aplicarValor() {
    const texto = valorLote.trim();
    if (!texto && columna !== "sku") return;
    onFilas(
      filas.map((f) => {
        if (columna === "sku") return { ...f, sku: texto };
        if (columna === "stock") return { ...f, stock: String(Number.parseInt(texto, 10) || 0) };
        const cents = parseToCents(texto);
        return { ...f, [columna]: cents === null ? f[columna] : aTexto(cents) };
      }),
    );
    setNota(`Columna ${columna} igualada en las ${filas.length} variantes.`);
  }

  function ajustarPorcentaje() {
    const pct = Number.parseFloat(porcentaje.replace(",", "."));
    if (!Number.isFinite(pct) || !esDinero) return;
    onFilas(
      filas.map((f) => {
        const cents = parseToCents(f[columna]);
        if (cents === null) return f;
        return { ...f, [columna]: aTexto(Math.max(0, Math.round(cents * (1 + pct / 100)))) };
      }),
    );
    setNota(`${columna} ajustado un ${pct > 0 ? "+" : ""}${pct}%.`);
  }

  function precioDesdeCoste() {
    let sinCoste = 0;
    onFilas(
      filas.map((f) => {
        const coste = parseToCents(f.coste);
        if (coste === null || coste <= 0) {
          sinCoste += 1;
          return f;
        }
        return { ...f, precio: aTexto(applyPricing(coste, pricing)) };
      }),
    );
    setNota(
      sinCoste > 0
        ? `Precios calculados con la regla de la tienda. ${sinCoste} variantes se quedaron igual porque no tienen coste.`
        : "Precios calculados con la regla de la tienda (editable en Ajustes).",
    );
  }

  const columnas: Column<Fila>[] = [
    {
      key: "titulo",
      header: "Variante",
      primary: true,
      render: (f) => (
        <span>
          {tituloDeFila(f)}
          {f.id ? null : (
            <>
              {" "}
              <Badge tone="info">Nueva</Badge>
            </>
          )}
        </span>
      ),
    },
    {
      key: "sku",
      header: "SKU",
      hideOnMobile: true,
      render: (f) => (
        <input
          className="cat-vt-txt"
          type="text"
          value={f.sku}
          onChange={(e) => editar(f.key, "sku", e.target.value)}
          aria-label={`SKU de ${tituloDeFila(f)}`}
        />
      ),
    },
    {
      key: "coste",
      header: "Coste",
      align: "right",
      render: (f) => (
        <input
          className="cat-vt-in"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={f.coste}
          onChange={(e) => editar(f.key, "coste", e.target.value)}
          aria-label={`Coste de ${tituloDeFila(f)}`}
        />
      ),
    },
    {
      key: "precio",
      header: "Precio",
      align: "right",
      render: (f) => (
        <input
          className="cat-vt-in"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={f.precio}
          onChange={(e) => editar(f.key, "precio", e.target.value)}
          aria-label={`Precio de ${tituloDeFila(f)}`}
        />
      ),
    },
    {
      key: "margen",
      header: "Margen",
      align: "right",
      render: (f) => <CeldaMargen fila={f} />,
    },
    {
      key: "stock",
      header: "Stock",
      align: "right",
      render: (f) => (
        <span className="cat-margen">
          <input
            className="cat-vt-in-sm"
            type="text"
            inputMode="numeric"
            value={f.stock}
            onChange={(e) => editar(f.key, "stock", e.target.value)}
            aria-label={`Stock de ${tituloDeFila(f)}`}
          />
          <label className="cat-track">
            <input
              type="checkbox"
              checked={f.trackStock}
              onChange={(e) => editar(f.key, "trackStock", e.target.checked)}
            />
            controlar
          </label>
        </span>
      ),
    },
    {
      key: "quitar",
      header: "",
      label: "Acciones",
      align: "right",
      render: (f) => (
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={() => onFilas(filas.filter((x) => x.key !== f.key))}
        >
          Quitar
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div className="cat-opciones">
        {opciones.map((opcion, i) => (
          <div className="cat-opcion" key={`opcion-${i}`}>
            <div className="adm-field cat-opcion-nombre">
              <label className="adm-field-lbl" htmlFor={`opcion-nombre-${i}`}>
                Opción {i + 1}
              </label>
              <input
                id={`opcion-nombre-${i}`}
                type="text"
                placeholder="Talla"
                value={opcion.nombre}
                onChange={(e) => cambiarOpcion(i, "nombre", e.target.value)}
              />
            </div>
            <div className="adm-field cat-opcion-valores">
              <label className="adm-field-lbl" htmlFor={`opcion-valores-${i}`}>
                Valores (separados por comas)
              </label>
              <input
                id={`opcion-valores-${i}`}
                type="text"
                placeholder="S, M, L, XL"
                value={opcion.valores}
                onChange={(e) => cambiarOpcion(i, "valores", e.target.value)}
              />
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => quitarOpcion(i)}>
              Quitar opción
            </Button>
          </div>
        ))}

        <div className="adm-row">
          {opciones.length < 3 ? (
            <Button type="button" variant="ghost" size="sm" onClick={anadirOpcion}>
              Añadir opción
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={generar}>
            Generar todas las combinaciones
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onFilas([...filas, filaVacia(opciones.map(() => ""))])}
          >
            Añadir variante suelta
          </Button>
        </div>
      </div>

      {pendiente ? (
        <div className="cat-aviso cat-aviso-warn">
          Al generar quedarán {pendiente.filas.length} variantes y desaparecerán {pendiente.quitadas.length}:{" "}
          {pendiente.quitadas.slice(0, 8).join(", ")}
          {pendiente.quitadas.length > 8 ? "…" : ""}. Sus precios y su stock se pierden.
          <div className="adm-row" style={{ marginTop: 10 }}>
            <Button type="button" variant="danger" size="sm" onClick={confirmarGenerar}>
              Sí, generar
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPendiente(null)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : null}

      {nota ? <p className="adm-muted adm-small">{nota}</p> : null}

      <div className="cat-bulk">
        <span className="cat-lote-etiqueta">Columna entera</span>
        <select
          value={columna}
          onChange={(e) => setColumna(e.target.value as ColumnaLote)}
          aria-label="Columna a editar en lote"
        >
          <option value="precio">Precio</option>
          <option value="coste">Coste</option>
          <option value="stock">Stock</option>
          <option value="sku">SKU</option>
        </select>
        <input
          type="text"
          value={valorLote}
          placeholder={esDinero ? "0.00" : "valor"}
          onChange={(e) => setValorLote(e.target.value)}
          aria-label="Valor para toda la columna"
        />
        <Button type="button" variant="ghost" size="sm" onClick={aplicarValor}>
          Poner en todas
        </Button>
        <span className="cat-bulk-sep" />
        <input
          type="text"
          inputMode="decimal"
          value={porcentaje}
          onChange={(e) => setPorcentaje(e.target.value)}
          aria-label="Porcentaje de ajuste"
          disabled={!esDinero}
        />
        <Button type="button" variant="ghost" size="sm" onClick={ajustarPorcentaje} disabled={!esDinero}>
          Ajustar %
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={precioDesdeCoste}>
          Precio desde el coste (×{pricing.multiplier})
        </Button>
      </div>

      <DataTable<Fila>
        columns={columnas}
        rows={filas}
        rowKey={(f) => f.key}
        empty="Este producto no tiene variantes todavía. Genera las combinaciones o añade una suelta."
      />
    </div>
  );
}

/* ───────────────────────────── margen ───────────────────────────── */

function CeldaMargen({ fila }: { fila: Fila }) {
  const precio = parseToCents(fila.precio) ?? 0;
  const coste = parseToCents(fila.coste);
  const { cents, percent } = margin(precio, coste);

  if (cents === null || percent === null) {
    return <span className="adm-muted">—</span>;
  }

  // Los umbrales son solo una señal visual para leer la tabla de un vistazo:
  // con la regla por defecto de la tienda (×2.6 + $5) el margen ronda el 65 %.
  const tono = percent < 0 ? "cat-margen-malo" : percent < 35 ? "cat-margen-justo" : "cat-margen-bueno";

  return (
    <span className={`cat-margen ${tono}`}>
      <span className="adm-money">{formatCents(cents)}</span>
      <span className="cat-margen-pct">{percent}%</span>
    </span>
  );
}
