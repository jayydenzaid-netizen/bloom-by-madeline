"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";
import { Badge, Button, DataTable, EmptyState, Money, type Column } from "../../_components/ui";
import { REASON_LABELS, STOCK_REASONS } from "@/lib/inventory";
import { aplicarLote, type EstadoInventario } from "../actions";
import { AjusteRapido } from "./AjusteRapido";

// Igual que en AjusteRapido: un fichero "use server" solo puede exportar
// funciones asíncronas, así que el estado inicial no puede vivir en actions.ts.
const ESTADO_INICIAL: EstadoInventario = {};

/**
 * Tabla del inventario: una fila por variante, con edición del stock en la
 * propia fila y ajuste en lote de lo que se seleccione.
 *
 * Es cliente por dos cosas que no se pueden hacer sin JavaScript sin ensuciar
 * el marcado: la selección de filas (que enciende la barra de lote) y la
 * descarga del CSV. La tabla en sí es la `DataTable` del panel, que en móvil se
 * convierte sola en tarjetas — Madeline despacha desde el teléfono.
 */

export type FilaInventario = {
  variantId: string;
  productId: string;
  productTitle: string;
  productStatus: string;
  variantTitle: string;
  sku: string;
  stock: number;
  trackStock: boolean;
  costCents: number | null;
  priceCents: number;
  imagen: string | null;
};

export function StockTable({
  filas,
  umbral,
  csv,
  nombreCsv,
  hayFiltro,
  sinInventario,
}: {
  filas: FilaInventario[];
  /** A partir de aquí (incluido) una variante cuenta como "bajo mínimo". */
  umbral: number;
  /** CSV de TODO lo filtrado, no solo de esta página. Lo arma el servidor. */
  csv: string;
  nombreCsv: string;
  hayFiltro: boolean;
  /** true cuando la tienda no tiene ni una variante: cambia el mensaje vacío. */
  sinInventario: boolean;
}) {
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [estado, enviarLote, pendienteLote] = useActionState(aplicarLote, ESTADO_INICIAL);

  const contables = useMemo(() => filas.filter((f) => f.trackStock).map((f) => f.variantId), [filas]);

  // Si cambia el filtro o la página, la selección de antes ya no está en
  // pantalla: mantenerla sería aplicar un ajuste a filas que no se ven.
  useEffect(() => {
    setSeleccion((previa) => previa.filter((id) => contables.includes(id)));
  }, [contables]);

  // Tras un lote correcto se limpia la selección: dejarla marcada invita a
  // pulsar dos veces y a restar dos veces.
  useEffect(() => {
    if (estado.ok) setSeleccion([]);
  }, [estado]);

  function alternar(id: string) {
    setSeleccion((previa) => (previa.includes(id) ? previa.filter((x) => x !== id) : [...previa, id]));
  }

  function alternarTodas() {
    setSeleccion((previa) => (previa.length === contables.length ? [] : contables));
  }

  function descargarCsv() {
    // El ﻿ es para que Excel reconozca el UTF-8 y no destroce los acentos.
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement("a");
    enlace.href = url;
    enlace.download = nombreCsv;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);
  }

  const columnas: Column<FilaInventario>[] = [
    {
      key: "sel",
      header: (
        <input
          className="inv-check"
          type="checkbox"
          checked={contables.length > 0 && seleccion.length === contables.length}
          onChange={alternarTodas}
          disabled={contables.length === 0}
          aria-label="Seleccionar todas las variantes con control de esta página"
        />
      ),
      label: "Seleccionar",
      width: "36px",
      render: (f) =>
        f.trackStock ? (
          <input
            className="inv-check"
            type="checkbox"
            checked={seleccion.includes(f.variantId)}
            onChange={() => alternar(f.variantId)}
            aria-label={`Seleccionar ${f.productTitle} ${f.variantTitle}`}
          />
        ) : (
          <span className="adm-muted">—</span>
        ),
    },
    {
      key: "producto",
      header: "Producto",
      primary: true,
      render: (f) => (
        <span className="inv-prod">
          {f.imagen ? (
            /* eslint-disable-next-line @next/next/no-img-element -- las fotos de
               proveedor viven en CDNs que no están declaradas en next.config. */
            <img className="adm-thumb" src={f.imagen} alt="" />
          ) : (
            <span className="inv-thumb-vacio">SIN FOTO</span>
          )}
          <span className="inv-prod-txt">
            <Link className="adm-link" href={`/admin/productos/${f.productId}`}>
              {f.productTitle || "Producto sin título"}
            </Link>
            <span className="inv-prod-var">{f.variantTitle || "Estándar"}</span>
          </span>
        </span>
      ),
    },
    {
      key: "sku",
      header: "SKU",
      hideOnMobile: true,
      render: (f) => (f.sku ? <span className="inv-sku">{f.sku}</span> : <span className="adm-muted">—</span>),
    },
    {
      key: "control",
      header: "Control",
      render: (f) =>
        f.trackStock ? <Badge tone="info">Se cuenta</Badge> : <Badge tone="neutral">Del proveedor</Badge>,
    },
    {
      key: "stock",
      header: "Stock",
      align: "right",
      render: (f) => {
        if (!f.trackStock) return <span className="inv-sin-control">No se cuenta</span>;
        const clase = f.stock <= 0 ? "inv-num inv-num-cero" : f.stock <= umbral ? "inv-num inv-num-bajo" : "inv-num";
        return <span className={clase}>{f.stock}</span>;
      },
    },
    {
      key: "coste",
      header: "Coste",
      align: "right",
      hideOnMobile: true,
      render: (f) =>
        f.costCents === null ? <span className="adm-muted adm-small">Sin poner</span> : <Money cents={f.costCents} tone="muted" />,
    },
    {
      key: "valor",
      header: "Valor a coste",
      align: "right",
      hideOnMobile: true,
      render: (f) => {
        if (!f.trackStock || f.costCents === null || f.stock <= 0) return <span className="adm-muted">—</span>;
        return <Money cents={f.stock * f.costCents} />;
      },
    },
    {
      key: "ajuste",
      header: "Ajustar",
      align: "right",
      width: "230px",
      render: (f) =>
        f.trackStock ? (
          <AjusteRapido
            variantId={f.variantId}
            stock={f.stock}
            etiqueta={`${f.productTitle} ${f.variantTitle}`}
          />
        ) : (
          <Link className="adm-link adm-small" href={`/admin/productos/${f.productId}`}>
            Activar el control
          </Link>
        ),
    },
  ];

  return (
    <>
      {estado.error ? <div className="inv-aviso inv-aviso-error">{estado.error}</div> : null}
      {estado.ok && estado.mensaje ? <div className="inv-aviso inv-aviso-ok">{estado.mensaje}</div> : null}

      <div className="inv-barra">
        <Button type="button" variant="ghost" size="sm" onClick={descargarCsv}>
          Descargar CSV
        </Button>
        <span className="adm-muted adm-small">
          Se descarga todo lo que hay con el filtro puesto, no solo esta página.
        </span>
      </div>

      {seleccion.length > 0 ? (
        <form action={enviarLote} className="inv-lote">
          <input type="hidden" name="idsJson" value={JSON.stringify(seleccion)} />

          <span className="inv-lote-cuenta">
            {seleccion.length} {seleccion.length === 1 ? "variante" : "variantes"}
          </span>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="lote-modo">
              Qué hacer
            </label>
            <select id="lote-modo" name="modo" defaultValue="sumar">
              <option value="sumar">Sumar unidades</option>
              <option value="restar">Restar unidades</option>
              <option value="fijar">Dejarlas todas en…</option>
            </select>
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="lote-valor">
              Unidades
            </label>
            <input id="lote-valor" name="valor" type="number" min={0} step={1} defaultValue={1} inputMode="numeric" />
          </div>

          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="lote-razon">
              Motivo
            </label>
            <select id="lote-razon" name="razon" defaultValue="restock">
              {STOCK_REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABELS[r]}
                </option>
              ))}
            </select>
          </div>

          <div className="adm-field inv-lote-nota">
            <label className="adm-field-lbl" htmlFor="lote-nota">
              Nota (opcional)
            </label>
            <input id="lote-nota" name="nota" type="text" maxLength={300} placeholder="Caja del 14 de marzo…" />
          </div>

          <Button type="submit" size="sm" disabled={pendienteLote}>
            {pendienteLote ? "Aplicando…" : "Aplicar a las seleccionadas"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSeleccion([])}>
            Quitar selección
          </Button>
        </form>
      ) : null}

      <DataTable<FilaInventario>
        columns={columnas}
        rows={filas}
        rowKey={(f) => f.variantId}
        empty={
          sinInventario ? (
            <EmptyState
              icon={<IconCajas />}
              title="Todavía no hay nada que contar"
              text="El inventario se llena solo: cada variante de cada producto aparece aquí en cuanto el producto existe. Trae el primer producto y vuelve."
              action={
                <>
                  <Button href="/admin/productos/nuevo">Crear un producto</Button>
                  <Button href="/admin/importar" variant="ghost">
                    Importar de proveedor
                  </Button>
                </>
              }
            />
          ) : hayFiltro ? (
            <EmptyState
              icon={<IconLupa />}
              title="Ninguna variante con ese filtro"
              text="Puede ser una buena noticia: si buscabas las agotadas, es que no hay ninguna."
              action={
                <Button href="/admin/inventario" variant="ghost">
                  Ver todo el inventario
                </Button>
              }
            />
          ) : (
            "No hay variantes que mostrar."
          )
        }
      />
    </>
  );
}

/* ─────────────────────────────── iconos ─────────────────────────────── */

function IconCajas() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3 8h18v12H3z" strokeLinejoin="round" />
      <path d="M3 8l2-4h14l2 4M12 8v12" strokeLinejoin="round" />
    </svg>
  );
}

function IconLupa() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" strokeLinecap="round" />
    </svg>
  );
}
