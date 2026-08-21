"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { applyPricing, formatCents, margin, parseToCents, type PricingRule } from "@/lib/money";
import { Badge, Button, Card, DataTable, Field, Money, type Column } from "../../_components/ui";
import {
  actualizarProductoExistente,
  guardarBorrador,
  publicarBorrador,
  revisionDelBorrador,
  type EdicionBorrador,
  type ResultadoPublicacion,
} from "../actions";

/**
 * PASO 2 — revisar y ajustar. Y PASO 3 — publicar.
 *
 * Es la pantalla donde se gana o se pierde el dinero: lo que llega del proveedor
 * es un título lleno de palabras clave, treinta fotos (la mitad, tablas de tallas
 * en chino) y unos costes en dólares. Lo que sale de aquí es una ficha de
 * boutique con un margen decidido a conciencia.
 *
 * Todo el cálculo de precios se hace EN EL NAVEGADOR con las mismas funciones que
 * usa el servidor (`applyPricing`, `margin` de lib/money). No es duplicar lógica:
 * es el mismo módulo importado, que no arrastra ni Prisma ni node:*. Gracias a
 * eso, cambiar el multiplicador recalcula la tabla entera al instante, sin ir y
 * volver del servidor con cada tecla — y al publicar se manda el número ya
 * decidido, con `skipPricing`, para que nadie lo recalcule por detrás.
 */

/* ────────────────────────────── contratos ────────────────────────────── */

export type VarianteVista = {
  /** Índice en el borrador guardado. Es la clave con la que el servidor la reconoce. */
  indice: number;
  titulo: string;
  sku: string;
  costCents: number | null;
  priceCents: number | null;
};

/** Lo que contesta el servidor al intentar poner un producto a la venta. */
export type ResultadoActivacion = { ok: boolean; error?: string };

export type BorradorVista = {
  jobId: string;
  proveedorLabel: string;
  metodoLabel: string;
  sourceUrl: string | null;
  titulo: string;
  descripcion: string;
  avisos: string[];
  atributos: [string, string][];
  imagenes: { url: string; alt: string }[];
  variantes: VarianteVista[];
  /** Coste de referencia del producto cuando las variantes vienen sin coste propio. */
  costeMin: number | null;
};

type FilaImagen = { url: string; alt: string; incluida: boolean };

type FilaVariante = {
  indice: number;
  titulo: string;
  sku: string;
  costeTexto: string;
  /** Solo se usa cuando `manual` está activo. */
  precioTexto: string;
  /** El precio manda sobre la regla: o vino escrito en el origen, o lo escribió ella. */
  manual: boolean;
  /** De los manuales, el que venía escrito en el fichero (CSV). Solo para decirlo. */
  origen: boolean;
  incluida: boolean;
};

/** Margen por debajo del cual se avisa. Menos de esto no paga el envío ni el tiempo. */
const MARGEN_MINIMO = 40;

/* ───────────────────────── limpieza de títulos ───────────────────────── */

/**
 * Los títulos de AliExpress no están escritos para una persona, sino para su
 * buscador: «2024 New Fashion Women Summer Dress Elegant Party Sexy Bodycon Dress
 * Hot Sale Free Shipping». Esto quita el ruido reconocible y deja el producto.
 *
 * Es conservador a propósito — solo borra lo que es sistemáticamente basura — y
 * siempre reversible con «deshacer»: preferimos quedarnos cortos a que Madeline
 * descubra dentro de un mes que perdió la palabra que describía la prenda.
 */
const RUIDO = [
  /\b(hot|top)\s+sale\b/gi,
  /\bfree\s+shipping\b/gi,
  /\bdrop\s?shipping\b/gi,
  /\bwholesale\b/gi,
  /\bnew\s+arrivals?\b/gi,
  /\bhigh\s+quality\b/gi,
  /\bbest\s+sell(er|ing)\b/gi,
  /\bin\s+stock\b/gi,
  /\bfactory\s+(price|direct)\b/gi,
  /\bcustom\s+logo\b/gi,
  /\bfor\s+sale\b/gi,
  /\b20(1[0-9]|2[0-9])\b/g,
  /\bnew\b/gi,
];

export function limpiarTitulo(bruto: string): string {
  let texto = bruto;

  // Corchetes y llaves promocionales: 【Hot】, [Free Shipping], (Big Sale).
  texto = texto.replace(/【[^】]*】/g, " ").replace(/\[[^\]]*\]/g, " ");

  for (const patron of RUIDO) texto = texto.replace(patron, " ");

  // Un título de proveedor encadena la misma idea varias veces
  // («Dress Women Dress Summer Dress»). Se deja la primera aparición de cada
  // palabra; el orden original se respeta.
  const vistas = new Set<string>();
  const palabras: string[] = [];
  for (const palabra of texto.split(/\s+/)) {
    const limpia = palabra.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
    if (!limpia) continue;
    if (vistas.has(limpia)) continue;
    vistas.add(limpia);
    palabras.push(palabra);
  }

  let final = palabras.join(" ").replace(/\s*[|,·/-]\s*$/g, "").trim();

  // Un escaparate no enseña títulos de tres renglones: se corta por palabra.
  if (final.length > 70) {
    const corte = final.slice(0, 70);
    final = corte.slice(0, corte.lastIndexOf(" ") > 30 ? corte.lastIndexOf(" ") : 70).trim();
  }

  final = final.replace(/\s{2,}/g, " ").trim();
  if (!final) return bruto.trim();
  return final.charAt(0).toUpperCase() + final.slice(1);
}

/* ──────────────────────────── dinero en inputs ──────────────────────────── */

/**
 * Un `<input>` necesita un número pelado que `parseToCents()` sepa releer, no el
 * «$45.99» de `formatCents()`. Esta función existe SOLO para eso; todo lo que se
 * lee (márgenes, totales) se pinta con <Money/>, que sí usa formatCents.
 */
function centavosATexto(cents: number | null): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

/* ────────────────────────────── el componente ────────────────────────────── */

export default function DraftEditor({
  borrador,
  reglaInicial,
  colecciones,
  existente,
  alActivar,
}: {
  borrador: BorradorVista;
  reglaInicial: PricingRule;
  colecciones: { id: string; title: string }[];
  /** El mismo producto de proveedor ya está en el catálogo. */
  existente: { productId: string; slug: string; title: string; status: string } | null;
  /** Server Action de la pantalla: pasa el producto recién creado a «a la venta». */
  alActivar: (productId: string) => Promise<ResultadoActivacion>;
}) {
  const router = useRouter();

  const [titulo, setTitulo] = useState(borrador.titulo);
  const [tituloPrevio, setTituloPrevio] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState(borrador.descripcion);

  const [imagenes, setImagenes] = useState<FilaImagen[]>(() =>
    borrador.imagenes.map((imagen) => ({ ...imagen, incluida: true })),
  );

  const [filas, setFilas] = useState<FilaVariante[]>(() =>
    borrador.variantes.map((variante) => ({
      indice: variante.indice,
      titulo: variante.titulo,
      sku: variante.sku,
      // Sin coste propio hereda el del producto, igual que hace el pipeline.
      costeTexto: centavosATexto(variante.costCents ?? borrador.costeMin),
      precioTexto: centavosATexto(variante.priceCents),
      // UN PRECIO QUE VIENE ESCRITO EN EL BORRADOR MANDA SOBRE LA REGLA. La regla
      // solo rellena las filas que llegan sin precio. Antes toda fila nacía
      // «no manual» y el input pintaba el precio calculado: un CSV con precio
      // 39.99 y coste 12.00 se publicaba a 36.99 (×2.6 + $5) sin decir nada, y
      // los precios revisados en Excel no llegaban nunca a la tienda.
      // El efecto de abajo afina esto con lo que hay guardado en el job.
      manual: typeof variante.priceCents === "number" && variante.priceCents > 0,
      origen: typeof variante.priceCents === "number" && variante.priceCents > 0,
      incluida: true,
    })),
  );

  const [regla, setRegla] = useState<PricingRule>(reglaInicial);
  const [etiquetas, setEtiquetas] = useState("");
  const [seleccion, setSeleccion] = useState<string[]>([]);
  const [estado, setEstado] = useState<"draft" | "active">("draft");

  const [trabajando, setTrabajando] = useState<"" | "guardando" | "publicando" | "actualizando">("");
  const [resultado, setResultado] = useState<ResultadoPublicacion | null>(null);
  const [duplicado, setDuplicado] = useState(existente);
  const [guardado, setGuardado] = useState(false);

  // Estado del paso 3: se publicó como borrador y desde aquí mismo se puede
  // poner a la venta sin dar la vuelta por la ficha del producto.
  const [activando, setActivando] = useState(false);
  const [activado, setActivado] = useState(false);
  const [errorActivacion, setErrorActivacion] = useState<string | null>(null);

  /* ── recuperar las decisiones de la última vez ── */

  // Si ella ya tocó algo, lo guardado NO la pisa: la carrera dura milisegundos
  // pero perder un clic por eso sería exactamente el fallo que venimos a arreglar.
  const tocado = useRef(false);

  // Las fotos excluidas y las variantes descartadas se piden aparte porque
  // `BorradorVista` —que arma la página— solo trae la ficha del proveedor, no las
  // decisiones. Sin esto, «Guardar y seguir luego» prometía una cosa y hacía otra:
  // al volver, la foto quitada había desaparecido del borrador y la variante
  // descartada estaba otra vez marcada.
  useEffect(() => {
    let vivo = true;
    void revisionDelBorrador(borrador.jobId)
      .then((revision) => {
        if (!vivo || !revision || tocado.current) return;

        const fuera = new Set(revision.imagenesExcluidas ?? []);
        if (fuera.size > 0) {
          setImagenes((prev) => prev.map((imagen, i) => (fuera.has(i) ? { ...imagen, incluida: false } : imagen)));
        }

        const descartadas = new Set(revision.variantesDescartadas ?? []);
        const decididos = revision.preciosDecididos ? new Set(revision.preciosDecididos) : null;
        const delOrigen = revision.preciosDelOrigen ? new Set(revision.preciosDelOrigen) : null;
        setFilas((prev) =>
          prev.map((fila) => ({
            ...fila,
            incluida: descartadas.has(fila.indice) ? false : fila.incluida,
            // El job sabe mejor que la heurística de arriba qué precios se
            // decidieron: Alibaba, por ejemplo, trae `priceCents` ya calculado
            // con la regla por defecto, y eso no es un precio propio.
            manual: decididos ? decididos.has(fila.indice) && fila.precioTexto !== "" : fila.manual,
            origen: delOrigen ? delOrigen.has(fila.indice) : fila.origen,
          })),
        );
      })
      .catch(() => {
        // Sin decisiones guardadas se sigue con lo que trajo el borrador: es peor
        // dejar la pantalla en blanco que empezar la revisión desde cero.
      });
    return () => {
      vivo = false;
    };
  }, [borrador.jobId]);

  /* ── cálculo de precios, en vivo ── */

  const calculadas = useMemo(
    () =>
      filas.map((fila) => {
        const costeCents = parseToCents(fila.costeTexto);
        const precioCents = fila.manual
          ? parseToCents(fila.precioTexto)
          : costeCents !== null
            ? applyPricing(costeCents, regla)
            : null;
        const m = margin(precioCents ?? 0, costeCents);
        return { costeCents, precioCents, margen: m };
      }),
    [filas, regla],
  );

  const incluidas = filas.filter((fila) => fila.incluida);
  /** Filas cuyo precio manda sobre la regla: las que la tienda NO ha calculado. */
  const conPrecioPropio = filas.filter((fila) => fila.incluida && fila.manual).length;

  const totales = useMemo(() => {
    let coste = 0;
    let precio = 0;
    let sinPrecio = 0;
    let bajoMargen = 0;
    filas.forEach((fila, i) => {
      if (!fila.incluida) return;
      const calc = calculadas[i];
      coste += calc.costeCents ?? 0;
      precio += calc.precioCents ?? 0;
      if (calc.precioCents === null || calc.precioCents === 0) sinPrecio += 1;
      if (calc.margen.percent !== null && calc.margen.percent < MARGEN_MINIMO) bajoMargen += 1;
    });
    // Margen del conjunto, no media de márgenes: lo que importa es cuánto queda
    // sobre el total facturado si se vendieran todas las variantes.
    const porcentaje = precio > 0 ? Math.round(((precio - coste) / precio) * 1000) / 10 : null;
    return { coste, precio, ganancia: precio - coste, porcentaje, sinPrecio, bajoMargen };
  }, [filas, calculadas]);

  /* ── acciones sobre el borrador ── */

  function moverImagen(desde: number, salto: number) {
    tocado.current = true;
    setImagenes((prev) => {
      const hasta = desde + salto;
      if (hasta < 0 || hasta >= prev.length) return prev;
      const copia = [...prev];
      const [movida] = copia.splice(desde, 1);
      copia.splice(hasta, 0, movida);
      return copia;
    });
  }

  function cambiarFila(indice: number, cambio: Partial<FilaVariante>) {
    tocado.current = true;
    setFilas((prev) => prev.map((fila) => (fila.indice === indice ? { ...fila, ...cambio } : fila)));
  }

  function edicionActual(): EdicionBorrador {
    return {
      titulo: titulo.trim(),
      descripcion,
      // Van TODAS, con su marca: el borrador tiene que conservar el material del
      // proveedor aunque ella deje fotos fuera. Quitar no es borrar.
      imagenes: imagenes.map(({ url, alt, incluida }) => ({ url, alt, incluida })),
      precios: filas.map((fila, i) => ({
        indice: fila.indice,
        priceCents: calculadas[i].precioCents,
        costCents: calculadas[i].costeCents,
        manual: fila.manual,
        origen: fila.manual && fila.origen,
      })),
      descartadas: filas.filter((fila) => !fila.incluida).map((fila) => fila.indice),
      etiquetas: etiquetas
        .split(",")
        .map((etiqueta) => etiqueta.trim())
        .filter(Boolean),
      colecciones: seleccion,
      estado,
    };
  }

  async function alGuardar() {
    setTrabajando("guardando");
    setGuardado(false);
    try {
      const respuesta = await guardarBorrador(borrador.jobId, edicionActual());
      if (!respuesta.ok) {
        setResultado({ ok: false, error: respuesta.error ?? "No se pudo guardar.", pista: null, duplicado: null });
      } else {
        setGuardado(true);
      }
    } catch (error) {
      setResultado({ ok: false, error: mensaje(error), pista: null, duplicado: null });
    } finally {
      setTrabajando("");
    }
  }

  async function alPublicar(permitirDuplicado = false) {
    setTrabajando("publicando");
    try {
      const respuesta = await publicarBorrador(borrador.jobId, edicionActual(), permitirDuplicado);
      setResultado(respuesta);
      if (!respuesta.ok && respuesta.duplicado) {
        setDuplicado(respuesta.duplicado);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      if (respuesta.ok) router.refresh();
    } catch (error) {
      setResultado({ ok: false, error: mensaje(error), pista: null, duplicado: null });
    } finally {
      setTrabajando("");
    }
  }

  async function alActualizar(productId: string) {
    setTrabajando("actualizando");
    try {
      const respuesta = await actualizarProductoExistente(borrador.jobId, productId, edicionActual());
      setResultado(respuesta);
      if (respuesta.ok) router.refresh();
    } catch (error) {
      setResultado({ ok: false, error: mensaje(error), pista: null, duplicado: null });
    } finally {
      setTrabajando("");
    }
  }

  /* ── PASO 3: ya está publicado ── */

  if (resultado?.ok) {
    // Lo que se acaba de publicar está a la venta si así se pidió, o si desde
    // esta misma pantalla se acaba de activar. Al ACTUALIZAR es distinto: el
    // selector «Cómo se publica» no pinta nada ahí, porque el estado es el que
    // ya tenía el producto — decir «está en borrador» mirando el selector era
    // mentirle a la dueña sobre una ficha que sus clientas están viendo.
    const actualizado = resultado.accion === "actualizado";
    const aLaVenta = actualizado ? duplicado?.status === "active" || activado : estado === "active" || activado;

    // Requisitos para poder venderlo, calculados con lo que hay en pantalla:
    // es exactamente lo que se acaba de mandar al servidor. El servidor los
    // vuelve a comprobar de todas formas.
    const conFoto = imagenes.some((imagen) => imagen.incluida);
    const conPrecio = totales.precio > 0 && totales.sinPrecio === 0;
    const faltaParaVender = [
      conPrecio ? null : "ponerle precio a todas sus variantes",
      conFoto ? null : "dejarle al menos una foto",
    ]
      .filter(Boolean)
      .join(" y ");

    return (
      <Card title="Publicado">
        <div className="imp-resultado">
          <h3>
            {resultado.accion === "creado" ? "Producto creado" : "Producto actualizado"}: «{resultado.titulo}»
          </h3>
          <p>
            {actualizado && aLaVenta
              ? "Sigue a la venta con los datos nuevos: actualizar no le cambia el estado ni la dirección."
              : actualizado
                ? "Sigue en borrador, como estaba: actualizar trae datos y precios, pero no lo pone a la venta."
                : aLaVenta
                  ? "Está activo: ya se ve en la tienda."
                  : "Está en borrador: nadie lo ve todavía. Míralo en vista previa y actívalo cuando esté a tu gusto."}
          </p>

          {resultado.avisos.length > 0 ? (
            <div style={{ textAlign: "left" }}>
              {resultado.avisos.map((aviso, i) => (
                <div className="imp-aviso imp-aviso-warning" key={i}>
                  <div className="imp-aviso-cuerpo">{aviso}</div>
                </div>
              ))}
            </div>
          ) : null}

          {errorActivacion ? (
            <div className="imp-aviso imp-aviso-danger" style={{ textAlign: "left" }}>
              <div className="imp-aviso-cuerpo">{errorActivacion}</div>
            </div>
          ) : null}

          <div className="imp-resultado-acciones">
            {/* Una sola acción principal: mientras se pueda poner a la venta,
                esa es la que manda y la ficha pasa a secundaria. */}
            <Button
              variant={!aLaVenta && !faltaParaVender ? "ghost" : "primary"}
              href={`/admin/productos/${resultado.productId}`}
            >
              Abrir la ficha en el panel
            </Button>

            {/* Se abre en otra pestaña para no perder esta pantalla; <Button href>
                no admite target, así que va como ancla con la clase del panel.
                Y apunta a la vista previa mientras siga en borrador: el
                escaparate solo enseña productos activos, así que «ver en la
                tienda» de un borrador era un 404 garantizado. */}
            <a
              className="adm-btn adm-btn-ghost adm-btn-md"
              href={aLaVenta ? `/producto/${resultado.slug}` : `/producto/${resultado.slug}?vista=previa`}
              target="_blank"
              rel="noreferrer"
            >
              {aLaVenta ? "Ver en la tienda" : "Ver la vista previa"}
            </a>

            {!aLaVenta && faltaParaVender ? (
              <span className="adm-small adm-muted">
                Para ponerlo a la venta falta {faltaParaVender}: hazlo en su ficha.
              </span>
            ) : null}

            {!aLaVenta && !faltaParaVender ? (
              <Button
                type="button"
                disabled={activando}
                onClick={() => {
                  setErrorActivacion(null);
                  setActivando(true);
                  void alActivar(resultado.productId)
                    .then((respuesta) => {
                      if (respuesta.ok) {
                        setActivado(true);
                        router.refresh();
                      } else {
                        setErrorActivacion(respuesta.error ?? "No se pudo poner a la venta.");
                      }
                    })
                    .catch((error: unknown) => setErrorActivacion(mensaje(error)))
                    .finally(() => setActivando(false));
                }}
              >
                {activando ? "Poniéndolo a la venta…" : "Ponerlo a la venta"}
              </Button>
            ) : null}

            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                // Sin recargar: se quita el ?job= y el formulario de arriba queda listo.
                router.push("/admin/importar");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              Importar otro
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  /* ── PASO 2: revisar ── */

  const columnas: Column<FilaVariante>[] = [
    {
      key: "variante",
      header: "Variante",
      primary: true,
      // La casilla de "se vende" va aquí y no en su propia columna: con coste,
      // precio y margen, una quinta columna obligaba a desplazar la tabla a lo
      // ancho dentro del panel lateral, y lo primero que se perdía de vista era
      // justo la casilla.
      render: (fila) => (
        <label className="imp-check">
          <input
            type="checkbox"
            aria-label={`Incluir la variante ${fila.titulo}`}
            checked={fila.incluida}
            onChange={(e) => cambiarFila(fila.indice, { incluida: e.target.checked })}
          />
          <span className={fila.incluida ? undefined : "imp-fuera"}>
            <b>{fila.titulo}</b>
            {fila.sku ? <span className="adm-small adm-muted"> · SKU {fila.sku}</span> : null}
          </span>
        </label>
      ),
    },
    {
      key: "coste",
      header: "Coste",
      align: "right",
      width: "116px",
      render: (fila) => (
        <input
          className="imp-num"
          inputMode="decimal"
          aria-label={`Coste de ${fila.titulo}`}
          value={fila.costeTexto}
          placeholder="—"
          disabled={!fila.incluida}
          onChange={(e) => cambiarFila(fila.indice, { costeTexto: e.target.value })}
        />
      ),
    },
    {
      key: "precio",
      header: "Precio de venta",
      align: "right",
      width: "150px",
      render: (fila, i) => (
        <>
          <input
            className="imp-num"
            inputMode="decimal"
            aria-label={`Precio de venta de ${fila.titulo}`}
            value={fila.manual ? fila.precioTexto : centavosATexto(calculadas[i].precioCents)}
            placeholder="—"
            disabled={!fila.incluida}
            // Escribir aquí desengancha la fila de la regla: es una decisión
            // deliberada de la usuaria y cambiar el multiplicador no debe pisarla.
            // Y deja de ser «el precio del fichero»: ahora es el suyo.
            onChange={(e) => cambiarFila(fila.indice, { manual: true, origen: false, precioTexto: e.target.value })}
          />
          {/* De dónde sale este número, dicho en la propia fila: sin esto, un
              precio traído del CSV y uno calculado por la tienda se ven igual. */}
          {fila.manual ? (
            <button
              type="button"
              className="imp-manual"
              title="Vuelve a calcularlo con la regla de la tienda"
              onClick={() => cambiarFila(fila.indice, { manual: false })}
            >
              {fila.origen ? "precio del fichero" : "precio a mano"} · recalcular
            </button>
          ) : (
            <span className="adm-small adm-muted">calculado</span>
          )}
        </>
      ),
    },
    {
      key: "margen",
      header: "Margen",
      align: "right",
      width: "108px",
      render: (_fila, i) => {
        const { margen } = calculadas[i];
        if (margen.percent === null) return <span className="adm-muted">—</span>;
        const clase = margen.percent < 0 ? "is-negativo" : margen.percent < MARGEN_MINIMO ? "is-bajo" : "";
        return (
          <span className={`imp-margen ${clase}`}>
            {margen.percent}%<small>{formatCents(margen.cents ?? 0)}</small>
          </span>
        );
      },
    },
  ];

  return (
    <>
      {/* ───── duplicado: lo primero de todo, antes de tocar nada ───── */}
      {duplicado ? (
        <div className="imp-aviso imp-aviso-warning">
          <div className="imp-aviso-cuerpo">
            {/* En qué estado está lo que se va a actualizar. No es lo mismo tocar
                un borrador que una ficha que las clientas están viendo ahora. */}
            <b>
              {duplicado.status === "active"
                ? `Ya lo tienes y está a la venta: «${duplicado.title}».`
                : duplicado.status === "archived"
                  ? `Ya lo tienes, archivado: «${duplicado.title}».`
                  : `Ya lo tienes, en borrador: «${duplicado.title}».`}
            </b>
            <p>
              Publicarlo otra vez crearía una segunda ficha del mismo artículo: dos precios distintos y clientas
              comprando la barata. Lo normal es traer los datos nuevos al que ya tienes.
            </p>
            <p className="adm-small">
              Actualizar refresca datos, fotos y precios.{" "}
              {duplicado.status === "active"
                ? "Sigue a la venta: no lo devuelve a borrador ni le cambia la dirección."
                : "No lo pone a la venta: sigue como está hasta que tú lo actives."}
            </p>
            <div className="imp-aviso-acciones">
              <Button size="sm" type="button" disabled={trabajando !== ""} onClick={() => alActualizar(duplicado.productId)}>
                {trabajando === "actualizando" ? "Actualizando…" : "Actualizar el que ya tengo"}
              </Button>
              <Button size="sm" variant="ghost" href={`/admin/productos/${duplicado.productId}`}>
                Ver el producto existente
              </Button>
              <Button size="sm" variant="ghost" href="/admin/importar">
                Cancelar esta importación
              </Button>
            </div>
            <p className="adm-small">
              Si de verdad es otro artículo del mismo proveedor, puedes{" "}
              <button
                type="button"
                className="imp-manual"
                disabled={trabajando !== ""}
                onClick={() => void alPublicar(true)}
              >
                crear una ficha nueva de todas formas
              </button>
              .
            </p>
          </div>
        </div>
      ) : null}

      {/* ───── avisos del adaptador: a la vista, en amarillo ───── */}
      {borrador.avisos.map((aviso, i) => (
        <div className="imp-aviso imp-aviso-warning" key={`w${i}`}>
          <div className="imp-aviso-cuerpo">{aviso}</div>
        </div>
      ))}

      {resultado && !resultado.ok && !resultado.duplicado ? (
        <div className="imp-aviso imp-aviso-danger">
          <div className="imp-aviso-cuerpo">
            <b>{resultado.error}</b>
            {resultado.pista ? <p>{resultado.pista}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="adm-cols-2">
        {/* ─────────────── columna principal ─────────────── */}
        <div>
          <Card
            title="Ficha del producto"
            actions={
              <>
                <Badge tone="info">{borrador.proveedorLabel}</Badge>
                <Badge tone="neutral">{borrador.metodoLabel}</Badge>
              </>
            }
          >
            <Field
              label="Título"
              htmlFor="imp-titulo"
              hint="Es lo que lee la clienta en la tienda. Los proveedores lo llenan de palabras clave para su buscador."
            >
              <input id="imp-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={300} />
            </Field>

            <div className="adm-row" style={{ marginTop: -6, marginBottom: 14 }}>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => {
                  setTituloPrevio(titulo);
                  setTitulo(limpiarTitulo(titulo));
                }}
              >
                Limpiar título
              </Button>
              {tituloPrevio !== null ? (
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setTitulo(tituloPrevio);
                    setTituloPrevio(null);
                  }}
                >
                  Deshacer
                </Button>
              ) : null}
              {borrador.sourceUrl ? (
                <a className="adm-link adm-small" href={borrador.sourceUrl} target="_blank" rel="noreferrer">
                  Ver la ficha original en {borrador.proveedorLabel}
                </a>
              ) : null}
            </div>

            <Field
              label="Descripción"
              htmlFor="imp-desc"
              hint="Lo que trajo el proveedor. Reescríbelo con tus palabras: es lo que separa una boutique de un catálogo copiado."
            >
              <textarea id="imp-desc" rows={7} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
            </Field>

            {borrador.atributos.length > 0 ? (
              <details>
                <summary className="adm-small adm-muted">Ficha técnica del proveedor ({borrador.atributos.length} datos)</summary>
                <ul className="adm-small" style={{ marginTop: 8 }}>
                  {borrador.atributos.map(([clave, valor]) => (
                    <li key={clave}>
                      <b>{clave}:</b> {valor}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Card>

          <Card
            title={`Fotos (${imagenes.filter((imagen) => imagen.incluida).length} de ${imagenes.length})`}
            footer={
              <span className="adm-small adm-muted">
                Pulsa una foto para quitarla o volver a ponerla. La primera incluida es la portada; con las flechas
                cambias el orden. Las que quites se quedan aquí guardadas —no se borran—, así que puedes recuperarlas
                mañana sin volver a importar el producto.
              </span>
            }
          >
            {imagenes.length === 0 ? (
              <p className="adm-muted">La ficha no traía fotos. Podrás subirlas desde el producto una vez publicado.</p>
            ) : (
              <div className="imp-galeria">
                {imagenes.map((imagen, i) => {
                  const esPortada = imagen.incluida && imagenes.findIndex((otra) => otra.incluida) === i;
                  return (
                    <div key={`${imagen.url}-${i}`} className={`imp-foto${imagen.incluida ? "" : " is-fuera"}`}>
                      <button
                        type="button"
                        aria-label={imagen.incluida ? `Quitar la foto ${i + 1}` : `Incluir la foto ${i + 1}`}
                        aria-pressed={imagen.incluida}
                        onClick={() => {
                          tocado.current = true;
                          setImagenes((prev) =>
                            prev.map((otra, j) => (j === i ? { ...otra, incluida: !otra.incluida } : otra)),
                          );
                        }}
                        style={{ display: "block", width: "100%", height: "100%", padding: 0, border: 0, background: "none" }}
                      >
                        {/* <img> a pelo: las fotos viven en el CDN del proveedor y
                            next/image exigiría tener cada dominio en la configuración. */}
                        <img src={imagen.url} alt={imagen.alt || `Foto ${i + 1}`} loading="lazy" referrerPolicy="no-referrer" />
                      </button>
                      {esPortada ? <span className="imp-foto-etq">Portada</span> : null}
                      <span className="imp-foto-orden">
                        <button type="button" aria-label="Mover antes" disabled={i === 0} onClick={() => moverImagen(i, -1)}>
                          ←
                        </button>
                        <button
                          type="button"
                          aria-label="Mover después"
                          disabled={i === imagenes.length - 1}
                          onClick={() => moverImagen(i, 1)}
                        >
                          →
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card
            title={`Variantes y precios (${incluidas.length} de ${filas.length})`}
            flush
            footer={
              <div className="imp-totales">
                <span className="imp-total">
                  Coste total
                  <b>{formatCents(totales.coste)}</b>
                </span>
                <span className="imp-total">
                  Venta total
                  <b>{formatCents(totales.precio)}</b>
                </span>
                <span className="imp-total">
                  Ganancia
                  <b>{formatCents(totales.ganancia)}</b>
                </span>
                <span className="imp-total">
                  Margen medio
                  <b>{totales.porcentaje === null ? "—" : `${totales.porcentaje}%`}</b>
                </span>
              </div>
            }
          >
            <DataTable columns={columnas} rows={filas} rowKey={(fila) => String(fila.indice)} empty="Esta ficha no traía variantes: se creará una única, y le pondrás precio en el producto." />
          </Card>

          {totales.bajoMargen > 0 ? (
            <div className="imp-aviso imp-aviso-warning">
              <div className="imp-aviso-cuerpo">
                <b>
                  {totales.bajoMargen}{" "}
                  {totales.bajoMargen === 1 ? "variante queda" : "variantes quedan"} por debajo del {MARGEN_MINIMO}% de
                  margen.
                </b>
                <p>
                  A ese nivel, el envío, la comisión de pago y una sola devolución se comen la ganancia. Sube el
                  multiplicador o el precio de esas filas antes de publicar.
                </p>
              </div>
            </div>
          ) : null}

          {totales.sinPrecio > 0 ? (
            <div className="imp-aviso imp-aviso-danger">
              <div className="imp-aviso-cuerpo">
                <b>
                  {totales.sinPrecio}{" "}
                  {totales.sinPrecio === 1 ? "variante se quedaría a precio 0" : "variantes se quedarían a precio 0"}.
                </b>
                <p>
                  El proveedor no mandó su coste y aquí no se inventa ningún número. Escribe el coste o el precio de
                  venta a mano, o descarta esas filas.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {/* ─────────────── panel lateral ─────────────── */}
        <div className="imp-lado">
          <Card title="Regla de precio">
            <p className="adm-small adm-muted" style={{ marginTop: 0 }}>
              Se aplica sobre el coste del proveedor. Cambia los números y la tabla se recalcula al instante; lo que
              publiques será exactamente lo que veas.
            </p>

            <div className="imp-regla">
              <Field label="Multiplicar" htmlFor="imp-mult">
                <input
                  id="imp-mult"
                  inputMode="decimal"
                  value={String(regla.multiplier)}
                  onChange={(e) => {
                    const valor = Number.parseFloat(e.target.value.replace(",", "."));
                    setRegla((prev) => ({ ...prev, multiplier: Number.isFinite(valor) ? valor : 0 }));
                  }}
                />
              </Field>

              <Field label="Sumar" htmlFor="imp-suma">
                <input
                  id="imp-suma"
                  inputMode="decimal"
                  value={centavosATexto(regla.addCents)}
                  onChange={(e) => setRegla((prev) => ({ ...prev, addCents: parseToCents(e.target.value) ?? 0 }))}
                />
              </Field>

              <Field label="Terminar en" htmlFor="imp-redondeo">
                <select
                  id="imp-redondeo"
                  value={regla.rounding}
                  onChange={(e) => setRegla((prev) => ({ ...prev, rounding: e.target.value as PricingRule["rounding"] }))}
                >
                  <option value="99">,99</option>
                  <option value="95">,95</option>
                  <option value="whole">Dólar entero</option>
                  <option value="none">Sin redondear</option>
                </select>
              </Field>
            </div>

            <p className="adm-small adm-muted">
              Un coste de {formatCents(2000)} se vendería a <Money cents={applyPricing(2000, regla)} tone="strong" />.
              La regla por defecto se cambia para toda la tienda en <Link className="adm-link" href="/admin/ajustes">Ajustes</Link>.
            </p>

            {/* Que se vea de un vistazo qué precios NO ha puesto la tienda: si el
                fichero traía los suyos, la regla no los toca y hay que decirlo. */}
            {conPrecioPropio > 0 ? (
              <p className="adm-small">
                <b>
                  {conPrecioPropio}{" "}
                  {conPrecioPropio === 1
                    ? "variante trae su propio precio y la regla no la toca"
                    : "variantes traen su propio precio y la regla no las toca"}
                  .
                </b>{" "}
                <button
                  type="button"
                  className="imp-manual"
                  onClick={() => {
                    tocado.current = true;
                    setFilas((prev) => prev.map((fila) => ({ ...fila, manual: false })));
                  }}
                >
                  Recalcularlas todas con la regla
                </button>
              </p>
            ) : null}
          </Card>

          <Card title="Cómo se publica">
            <div className="imp-radio-grupo">
              <label className={`imp-radio${estado === "draft" ? " is-activo" : ""}`}>
                <input type="radio" name="imp-estado" checked={estado === "draft"} onChange={() => setEstado("draft")} />
                <span>
                  <b>Como borrador</b>
                  <small>Entra en el catálogo pero no se ve en la tienda. Lo revisas con calma y lo activas luego.</small>
                </span>
              </label>
              <label className={`imp-radio${estado === "active" ? " is-activo" : ""}`}>
                <input type="radio" name="imp-estado" checked={estado === "active"} onChange={() => setEstado("active")} />
                <span>
                  <b>Activo, a la venta</b>
                  <small>Se ve en la tienda en cuanto pulses publicar. Asegúrate de que fotos y precios están bien.</small>
                </span>
              </label>
            </div>
          </Card>

          <Card title="Colecciones">
            {colecciones.length === 0 ? (
              <p className="adm-small adm-muted">
                Todavía no hay colecciones. Puedes crearlas en <Link className="adm-link" href="/admin/colecciones">Colecciones</Link> y
                asignarlas después.
              </p>
            ) : (
              <div className="imp-lista-check">
                {colecciones.map((coleccion) => (
                  <label className="imp-check" key={coleccion.id}>
                    <input
                      type="checkbox"
                      checked={seleccion.includes(coleccion.id)}
                      onChange={(e) =>
                        setSeleccion((prev) =>
                          e.target.checked ? [...prev, coleccion.id] : prev.filter((id) => id !== coleccion.id),
                        )
                      }
                    />
                    <span>{coleccion.title}</span>
                  </label>
                ))}
              </div>
            )}
          </Card>

          <Card title="Etiquetas">
            <Field label="Separadas por comas" htmlFor="imp-tags" hint="Sirven para buscar y filtrar en el panel. Por ejemplo: vestidos, verano, invitada.">
              <input id="imp-tags" value={etiquetas} onChange={(e) => setEtiquetas(e.target.value)} />
            </Field>
          </Card>

          <Card
            title="Publicar"
            footer={
              guardado ? <span className="adm-small adm-muted">Borrador guardado. Puedes seguir mañana desde el historial.</span> : null
            }
          >
            <Button block type="button" disabled={trabajando !== ""} onClick={() => void alPublicar(false)}>
              {trabajando === "publicando" ? "Publicando…" : estado === "active" ? "Publicar y poner a la venta" : "Publicar como borrador"}
            </Button>
            <div style={{ height: 8 }} />
            <Button block variant="ghost" type="button" disabled={trabajando !== ""} onClick={() => void alGuardar()}>
              {trabajando === "guardando" ? "Guardando…" : "Guardar y seguir luego"}
            </Button>
          </Card>
        </div>
      </div>
    </>
  );
}

function mensaje(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
