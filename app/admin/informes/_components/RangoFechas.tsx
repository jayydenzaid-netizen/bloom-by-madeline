"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

/**
 * Controles del informe: el selector de rango y el botón de exportar.
 *
 * El rango **siempre viaja en la URL**. Así Madeline puede guardarse en
 * marcadores "el mes pasado", o mandarle el enlace a quien le lleva las cuentas
 * y que vea exactamente lo mismo. Por eso los atajos son enlaces de verdad
 * (`<Link>`) y el rango personalizado es un formulario GET: funcionan aunque el
 * navegador no ejecute JavaScript, y el botón "atrás" hace lo que se espera.
 *
 * El fichero es cliente por una sola cosa: el CSV se arma en el navegador con
 * un Blob, porque el panel no expone (ni debe exponer) una ruta pública que
 * escupa las ventas de la tienda. El resto del componente se renderiza en el
 * servidor igual que cualquier otro.
 *
 * ⚠️ Aquí NO se importa nada de `lib/reports.ts`. Aunque solo se quisiera la
 * lista de atajos, ese módulo importa Prisma, y un import desde un componente
 * cliente lo arrastraría al paquete del navegador: la ruta deja de servirse.
 * Por eso los atajos llegan como prop desde el servidor.
 */

export function RangoFechas({
  atajos,
  activo,
  desde,
  hasta,
  hoy,
}: {
  /** Botones de periodo, en el orden en que se pintan. */
  atajos: readonly { readonly key: string; readonly label: string }[];
  /** Clave del atajo activo, o "personalizado". */
  activo: string;
  /** "2026-08-01" — valor por defecto de los campos del rango a medida. */
  desde: string;
  /** "2026-08-19" — último día INCLUIDO, que es como lo entiende una persona. */
  hasta: string;
  /** Tope de los selectores de fecha: no se piden informes del futuro. */
  hoy: string;
}) {
  return (
    <div className="inf-rango">
      <div className="inf-atajos" role="group" aria-label="Periodo del informe">
        {atajos.map((a) => (
          <Link
            key={a.key}
            href={`/admin/informes?rango=${a.key}`}
            className={`inf-atajo${activo === a.key ? " is-activo" : ""}`}
            aria-current={activo === a.key ? "true" : undefined}
          >
            {a.label}
          </Link>
        ))}
      </div>

      <details className="inf-custom" open={activo === "personalizado"}>
        <summary className="inf-atajo inf-atajo-custom">Fechas concretas</summary>
        <form method="get" action="/admin/informes" className="inf-custom-form">
          <label className="adm-field" htmlFor="inf-desde">
            <span className="adm-field-lbl">Desde</span>
            <input id="inf-desde" type="date" name="desde" defaultValue={desde} max={hoy} required />
          </label>
          <label className="adm-field" htmlFor="inf-hasta">
            <span className="adm-field-lbl">Hasta</span>
            <input id="inf-hasta" type="date" name="hasta" defaultValue={hasta} max={hoy} required />
          </label>
          <button type="submit" className="adm-btn adm-btn-ghost adm-btn-sm inf-custom-ok">
            Ver este periodo
          </button>
        </form>
      </details>
    </div>
  );
}

export function BotonCSV({
  csv,
  nombre,
  etiqueta,
  filas,
  registrar,
}: {
  /** Informe ya construido en el servidor: la pantalla y el fichero no pueden discrepar. */
  csv: string;
  /** Nombre del fichero que verá en Descargas. */
  nombre: string;
  /** Periodo en texto, para el registro de actividad. */
  etiqueta: string;
  /** Número de días exportados, para el registro de actividad. */
  filas: number;
  /** Server Action que deja constancia de la descarga en el historial. */
  registrar: (datos: { etiqueta: string; filas: number }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [descargado, setDescargado] = useState(false);
  const [, iniciar] = useTransition();

  function descargar() {
    // El BOM no es decorativo: sin él, Excel en Windows abre el CSV en ANSI y
    // "Vestido de algodón" se convierte en "Vestido de algodÃ³n".
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement("a");
    enlace.href = url;
    enlace.download = nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    // Liberar el objeto antes de que el navegador TERMINE de bajarlo cancela la
    // descarga, y el fichero no llega nunca a la carpeta de Descargas. Cuatro
    // segundos bastan en un CSV de unos kB, pero un teléfono con la batería al
    // límite puede tardar más y el fallo sería mudo, así que se espera un
    // minuto: lo único que se retiene mientras tanto son esos mismos kB.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

    setDescargado(true);
    // Exportar las ventas de la tienda es una acción que conviene poder rastrear.
    iniciar(() => {
      void registrar({ etiqueta, filas });
    });
  }

  return (
    <button type="button" className="adm-btn adm-btn-ghost adm-btn-sm" onClick={descargar}>
      {descargado ? "Descargado ✓" : "Exportar CSV"}
    </button>
  );
}
