"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { formatCents, parseToCents } from "@/lib/money";
import { Button, EmptyState, Field } from "../../_components/ui";
import { cobrarVenta, type EstadoVenta, type MetodoPos } from "../actions";
import { PosTicket, type PosBoutique } from "./PosTicket";

/**
 * TERMINAL DEL MOSTRADOR.
 *
 * Se usa de pie, con prisa, con una clienta delante y casi siempre desde el
 * teléfono. De ahí las tres decisiones que mandan sobre todo lo demás:
 *
 *  - **Se toca, no se teclea.** El catálogo es una rejilla de fotos grandes; el
 *    buscador es un atajo, no el camino. Todo lo que se pulsa mide 48 px o más.
 *  - **El ticket siempre a la vista.** En escritorio va a la derecha; en móvil
 *    vive en una barra fija abajo que se despliega. Nunca hay que "buscar" el
 *    total.
 *  - **Cobrar son dos gestos.** Se abre el panel de cobro y ahí dentro está el
 *    botón que cierra la venta: así no se crea un pedido por un roce con el
 *    pulgar. Y con el ticket vacío el botón ni siquiera se puede pulsar.
 *
 * Es cliente porque aquí hay interacción de verdad (montar el ticket, cambiar
 * cantidades, calcular el cambio). La venta la cierra un Server Action.
 */

/* ─────────────────────────────── tipos ─────────────────────────────── */

export type PosVariante = {
  id: string;
  titulo: string;
  sku: string;
  precioCents: number;
  stock: number;
  trackStock: boolean;
  imagen: string | null;
};

export type PosProducto = {
  id: string;
  titulo: string;
  imagen: string | null;
  /** Precio de la variante más barata: lo que se enseña en la rejilla. */
  desdeCents: number;
  variantes: PosVariante[];
  coleccionIds: string[];
};

export type PosColeccion = { id: string; titulo: string };

type Linea = {
  variantId: string;
  titulo: string;
  variante: string;
  sku: string;
  precioCents: number;
  cantidad: number;
  /** Copia del stock en el momento de cargar la pantalla, para frenar en seco. */
  stock: number;
  trackStock: boolean;
};

type ModoDescuento = "none" | "amount" | "percent";

// El estado inicial se declara aquí y no en actions.ts: un fichero "use server"
// solo puede exportar funciones asíncronas.
const ESTADO_INICIAL: EstadoVenta = {};

/** Billetes con los que se paga de verdad en un mostrador de Ohio. */
const BILLETES = [2000, 4000, 5000, 10000];

/* ───────────────────────────── componente ───────────────────────────── */

export function PosTerminal({
  productos,
  colecciones,
  boutique,
}: {
  productos: PosProducto[];
  colecciones: PosColeccion[];
  boutique: PosBoutique;
}) {
  const [estado, enviar, pendiente] = useActionState(cobrarVenta, ESTADO_INICIAL);

  const [busqueda, setBusqueda] = useState("");
  const [coleccion, setColeccion] = useState("");
  const [lineas, setLineas] = useState<Linea[]>([]);

  /** Producto abierto en el panel de tallas (solo si tiene más de una variante). */
  const [eligiendo, setEligiendo] = useState<PosProducto | null>(null);
  /** Panel de cobro abierto. */
  const [cobrando, setCobrando] = useState(false);
  /** En móvil, el ticket desplegado sobre la rejilla. */
  const [ticketAbierto, setTicketAbierto] = useState(false);
  /** Segundo toque para vaciar: nada destructivo a un solo clic. */
  const [confirmaVaciar, setConfirmaVaciar] = useState(false);

  const [modoDescuento, setModoDescuento] = useState<ModoDescuento>("none");
  const [valorDescuento, setValorDescuento] = useState("");
  const [motivoDescuento, setMotivoDescuento] = useState("");

  const [metodo, setMetodo] = useState<MetodoPos>("cash");
  const [entregado, setEntregado] = useState("");
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [nota, setNota] = useState("");

  /** Número del ticket que Madeline ya cerró en pantalla, para no reabrirlo. */
  const [ticketVisto, setTicketVisto] = useState<string | null>(null);

  const ticket = estado.ticket && estado.ticket.numero !== ticketVisto ? estado.ticket : null;

  // Cuando la venta se guarda, el mostrador se vacía solo: la siguiente clienta
  // ya está esperando y arrastrar el ticket anterior es como se cobra dos veces.
  useEffect(() => {
    if (!estado.ticket) return;
    setLineas([]);
    setModoDescuento("none");
    setValorDescuento("");
    setMotivoDescuento("");
    setEntregado("");
    setNombre("");
    setTelefono("");
    setNota("");
    setCobrando(false);
    setTicketAbierto(false);
  }, [estado.ticket]);

  /* ── cálculos del ticket ── */

  const subtotalCents = lineas.reduce((suma, l) => suma + l.precioCents * l.cantidad, 0);
  const piezas = lineas.reduce((n, l) => n + l.cantidad, 0);

  const descuentoCents = calcularDescuento(modoDescuento, valorDescuento, subtotalCents);
  const totalCents = Math.max(0, subtotalCents - descuentoCents);
  const descuentoPasado = descuentoCents > subtotalCents;

  const entregadoCents = entregado.trim() ? parseToCents(entregado) : null;
  const cambioCents = entregadoCents === null ? null : entregadoCents - totalCents;

  /* ── catálogo filtrado ── */

  const visibles = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    return productos.filter((p) => {
      if (coleccion && !p.coleccionIds.includes(coleccion)) return false;
      if (!texto) return true;
      if (p.titulo.toLowerCase().includes(texto)) return true;
      return p.variantes.some(
        (v) => v.sku.toLowerCase().includes(texto) || v.titulo.toLowerCase().includes(texto),
      );
    });
  }, [productos, busqueda, coleccion]);

  /* ── acciones sobre el ticket ── */

  function abrir(producto: PosProducto) {
    const vendibles = producto.variantes.filter((v) => disponible(v));
    // Una sola talla no merece un panel: se añade de una vez.
    if (producto.variantes.length === 1 && vendibles.length === 1) {
      añadir(producto, vendibles[0]);
      return;
    }
    setEligiendo(producto);
  }

  function añadir(producto: PosProducto, variante: PosVariante) {
    setLineas((previas) => {
      const i = previas.findIndex((l) => l.variantId === variante.id);
      if (i >= 0) {
        const copia = [...previas];
        const linea = copia[i];
        copia[i] = { ...linea, cantidad: topar(linea, linea.cantidad + 1) };
        return copia;
      }
      return [
        ...previas,
        {
          variantId: variante.id,
          titulo: producto.titulo,
          variante: variante.titulo,
          sku: variante.sku,
          precioCents: variante.precioCents,
          cantidad: 1,
          stock: variante.stock,
          trackStock: variante.trackStock,
        },
      ];
    });
    setEligiendo(null);
    setConfirmaVaciar(false);
  }

  function cambiarCantidad(variantId: string, paso: 1 | -1) {
    setLineas((previas) =>
      previas
        .map((l) => (l.variantId === variantId ? { ...l, cantidad: topar(l, l.cantidad + paso) } : l))
        // Bajar de 1 quita la línea: es el gesto natural y no destruye nada
        // guardado, solo un ticket que todavía no existe en la base de datos.
        .filter((l) => l.cantidad > 0),
    );
  }

  function quitar(variantId: string) {
    setLineas((previas) => previas.filter((l) => l.variantId !== variantId));
  }

  function vaciar() {
    setLineas([]);
    setModoDescuento("none");
    setValorDescuento("");
    setMotivoDescuento("");
    setConfirmaVaciar(false);
  }

  function cerrarVenta() {
    const fd = new FormData();
    fd.set("lineas", JSON.stringify(lineas.map((l) => ({ variantId: l.variantId, cantidad: l.cantidad }))));
    fd.set("metodo", metodo);
    fd.set("descuentoModo", modoDescuento);
    fd.set("descuentoValor", modoDescuento === "none" ? "" : valorDescuento);
    fd.set("descuentoMotivo", motivoDescuento);
    fd.set("entregadoCents", metodo === "cash" ? entregado : "");
    fd.set("nombre", nombre);
    fd.set("telefono", telefono);
    fd.set("nota", nota);
    enviar(fd);
  }

  /** Motivos por los que el botón de cobrar no debe dejarse pulsar. */
  const impedimento = razonParaNoCobrar({
    lineas: lineas.length,
    totalCents,
    descuentoPasado,
    modoDescuento,
    motivoDescuento,
    metodo,
    nombre,
    pendiente,
  });

  /* ───────────────────────────── pintado ───────────────────────────── */

  return (
    <div className="pos-terminal">
      {ticket ? (
        <PosTicket
          ticket={ticket}
          boutique={boutique}
          onNueva={() => setTicketVisto(ticket.numero)}
        />
      ) : null}

      {estado.error ? (
        <p className="pos-aviso pos-aviso-error pos-noprint" role="alert">
          {estado.error}
        </p>
      ) : null}

      <div className="pos-cols pos-noprint">
        {/* ── catálogo ── */}
        <section className="pos-catalogo">
          <div className="pos-filtros">
            <Field label="Buscar por nombre o SKU" htmlFor="pos-busca">
              <input
                id="pos-busca"
                type="search"
                inputMode="search"
                autoComplete="off"
                placeholder="Vestido, BLM-042…"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
              />
            </Field>

            {colecciones.length > 0 ? (
              <Field label="Colección" htmlFor="pos-coleccion">
                <select id="pos-coleccion" value={coleccion} onChange={(e) => setColeccion(e.target.value)}>
                  <option value="">Todas</option>
                  {colecciones.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.titulo}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>

          {visibles.length === 0 ? (
            <EmptyState
              title="Nada con esa búsqueda"
              text="Prueba con otra palabra, o quita el filtro de colección. Solo aparecen los productos activos: si una pieza no sale, actívala en Productos."
              action={
                busqueda || coleccion ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setBusqueda("");
                      setColeccion("");
                    }}
                  >
                    Ver todo el catálogo
                  </Button>
                ) : (
                  <Button variant="ghost" href="/admin/productos">
                    Ir a Productos
                  </Button>
                )
              }
            />
          ) : (
            <div className="pos-rejilla">
              {visibles.map((p) => {
                const hay = p.variantes.some((v) => disponible(v));
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="pos-card"
                    onClick={() => abrir(p)}
                    disabled={!hay}
                    title={hay ? p.titulo : `${p.titulo} — sin existencias`}
                  >
                    <span className="pos-card-foto">
                      {/* <img> a pelo y no next/image: es una miniatura del panel
                          y la foto puede venir de un proveedor externo. */}
                      {p.imagen ? (
                        <img src={p.imagen} alt="" loading="lazy" />
                      ) : (
                        <span className="pos-card-sinfoto">Sin foto</span>
                      )}
                    </span>
                    <span className="pos-card-tit">{p.titulo}</span>
                    <span className="pos-card-pie">
                      <span className="pos-card-precio">{formatCents(p.desdeCents)}</span>
                      <span className="pos-card-stock">{etiquetaExistencias(p)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* ── ticket ── */}
        <aside className={`pos-ticket ${ticketAbierto ? "is-abierto" : ""}`} aria-label="Ticket de la venta">
          <div className="pos-ticket-cab">
            <h2>Ticket</h2>
            <button
              type="button"
              className="pos-cerrar-hoja"
              onClick={() => setTicketAbierto(false)}
              aria-label="Ocultar el ticket"
            >
              ✕
            </button>
          </div>

          {lineas.length === 0 ? (
            <p className="pos-ticket-vacio">
              Toca una pieza del catálogo para empezar. Nada se guarda hasta que cobres.
            </p>
          ) : (
            <ul className="pos-lineas">
              {lineas.map((l) => (
                <li key={l.variantId} className="pos-linea">
                  <div className="pos-linea-txt">
                    <span className="pos-linea-tit">{l.titulo}</span>
                    <span className="pos-linea-var">
                      {l.variante}
                      {l.sku ? ` · ${l.sku}` : ""}
                    </span>
                    <span className="pos-linea-precio">{formatCents(l.precioCents)} c/u</span>
                  </div>

                  <div className="pos-linea-ctl">
                    <button
                      type="button"
                      className="pos-paso"
                      onClick={() => cambiarCantidad(l.variantId, -1)}
                      aria-label={`Quitar una unidad de ${l.titulo} ${l.variante}`}
                    >
                      −
                    </button>
                    <span className="pos-linea-cant" aria-label="Cantidad">
                      {l.cantidad}
                    </span>
                    <button
                      type="button"
                      className="pos-paso"
                      onClick={() => cambiarCantidad(l.variantId, 1)}
                      disabled={l.trackStock && l.cantidad >= l.stock}
                      aria-label={`Añadir una unidad de ${l.titulo} ${l.variante}`}
                    >
                      +
                    </button>
                  </div>

                  <div className="pos-linea-fin">
                    <span className="pos-linea-total">{formatCents(l.precioCents * l.cantidad)}</span>
                    <button
                      type="button"
                      className="pos-quitar"
                      onClick={() => quitar(l.variantId)}
                      aria-label={`Quitar ${l.titulo} ${l.variante} del ticket`}
                    >
                      Quitar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {lineas.length > 0 ? (
            <>
              <div className="pos-descuento">
                <div className="pos-seg" role="group" aria-label="Descuento del mostrador">
                  {(
                    [
                      ["none", "Sin descuento"],
                      ["amount", "Importe $"],
                      ["percent", "Porcentaje %"],
                    ] as [ModoDescuento, string][]
                  ).map(([modo, etiqueta]) => (
                    <button
                      key={modo}
                      type="button"
                      className={`pos-seg-btn ${modoDescuento === modo ? "is-activo" : ""}`}
                      onClick={() => {
                        setModoDescuento(modo);
                        if (modo === "none") {
                          setValorDescuento("");
                          setMotivoDescuento("");
                        }
                      }}
                    >
                      {etiqueta}
                    </button>
                  ))}
                </div>

                {modoDescuento !== "none" ? (
                  <div className="pos-descuento-campos">
                    <Field
                      label={modoDescuento === "amount" ? "Cuánto rebajas ($)" : "Cuánto rebajas (%)"}
                      htmlFor="pos-descuento-valor"
                    >
                      <input
                        id="pos-descuento-valor"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={modoDescuento === "amount" ? "5.00" : "10"}
                        value={valorDescuento}
                        onChange={(e) => setValorDescuento(e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Motivo"
                      htmlFor="pos-descuento-motivo"
                      hint="Queda escrito en el pedido."
                    >
                      <input
                        id="pos-descuento-motivo"
                        type="text"
                        autoComplete="off"
                        placeholder="Amiga de la casa, tara pequeña…"
                        value={motivoDescuento}
                        onChange={(e) => setMotivoDescuento(e.target.value)}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>

              <div className="pos-sumas">
                <div>
                  <span>
                    Subtotal · {piezas} {piezas === 1 ? "pieza" : "piezas"}
                  </span>
                  <span>{formatCents(subtotalCents)}</span>
                </div>
                {descuentoCents > 0 ? (
                  <div className={descuentoPasado ? "pos-suma-mal" : ""}>
                    <span>Descuento</span>
                    <span>−{formatCents(descuentoCents)}</span>
                  </div>
                ) : null}
                <div className="pos-suma-total">
                  <span>Total</span>
                  <span>{formatCents(totalCents)}</span>
                </div>
              </div>

              {descuentoPasado ? (
                <p className="pos-aviso pos-aviso-error">
                  El descuento es mayor que el ticket. Bájalo: no se puede cobrar en negativo.
                </p>
              ) : null}

              <div className="pos-ticket-acciones">
                <Button block onClick={() => setCobrando(true)} disabled={pendiente || descuentoPasado}>
                  Cobrar {formatCents(totalCents)}
                </Button>

                {confirmaVaciar ? (
                  <div className="pos-confirma">
                    <span>¿Vaciar el ticket entero?</span>
                    <Button size="sm" variant="danger" onClick={vaciar}>
                      Sí, vaciar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmaVaciar(false)}>
                      No
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" block onClick={() => setConfirmaVaciar(true)}>
                    Vaciar ticket
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </aside>
      </div>

      {/* ── barra fija de móvil: el total siempre visible ── */}
      <div className={`pos-barra pos-noprint ${lineas.length > 0 ? "is-visible" : ""}`}>
        <div className="pos-barra-txt">
          <strong>{formatCents(totalCents)}</strong>
          <span>
            {piezas} {piezas === 1 ? "pieza" : "piezas"}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setTicketAbierto(true)}>
          Ver ticket
        </Button>
        <Button size="sm" onClick={() => setCobrando(true)} disabled={pendiente || descuentoPasado}>
          Cobrar
        </Button>
      </div>

      {/* ── panel de tallas ── */}
      {eligiendo ? (
        <div
          className="pos-modal pos-noprint"
          role="dialog"
          aria-modal="true"
          aria-label={`Elegir talla de ${eligiendo.titulo}`}
        >
          <div className="pos-modal-caja">
            <header className="pos-modal-cab">
              <h2>{eligiendo.titulo}</h2>
              <button type="button" className="pos-cerrar-hoja" onClick={() => setEligiendo(null)} aria-label="Cerrar">
                ✕
              </button>
            </header>
            <p className="pos-modal-texto">Toca la talla que se lleva.</p>
            <div className="pos-tallas">
              {eligiendo.variantes.map((v) => {
                const hay = disponible(v);
                return (
                  <button
                    key={v.id}
                    type="button"
                    className="pos-talla"
                    disabled={!hay}
                    onClick={() => añadir(eligiendo, v)}
                  >
                    <span className="pos-talla-tit">{v.titulo || "Única"}</span>
                    <span className="pos-talla-precio">{formatCents(v.precioCents)}</span>
                    <span className="pos-talla-stock">
                      {!v.trackStock ? "Sin control de stock" : hay ? `Quedan ${v.stock}` : "Agotada"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {/* ── panel de cobro ── */}
      {cobrando ? (
        <div className="pos-modal pos-noprint" role="dialog" aria-modal="true" aria-label="Cobrar la venta">
          <div className="pos-modal-caja">
            <header className="pos-modal-cab">
              <h2>Cobrar {formatCents(totalCents)}</h2>
              <button type="button" className="pos-cerrar-hoja" onClick={() => setCobrando(false)} aria-label="Cerrar">
                ✕
              </button>
            </header>

            <div className="pos-metodos" role="group" aria-label="Forma de cobro">
              {(
                [
                  ["cash", "Efectivo"],
                  ["card", "Tarjeta"],
                  ["apuntado", "Apuntado"],
                ] as [MetodoPos, string][]
              ).map(([valor, etiqueta]) => (
                <button
                  key={valor}
                  type="button"
                  className={`pos-metodo ${metodo === valor ? "is-activo" : ""}`}
                  onClick={() => setMetodo(valor)}
                >
                  {etiqueta}
                </button>
              ))}
            </div>

            {metodo === "cash" ? (
              <div className="pos-efectivo">
                <Field label="¿Cuánto te dio?" htmlFor="pos-entregado">
                  <input
                    id="pos-entregado"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="40.00"
                    value={entregado}
                    onChange={(e) => setEntregado(e.target.value)}
                  />
                </Field>

                <div className="pos-billetes">
                  <button type="button" className="pos-billete" onClick={() => setEntregado(exacto(totalCents))}>
                    Justo
                  </button>
                  {BILLETES.filter((b) => b >= totalCents).map((b) => (
                    <button key={b} type="button" className="pos-billete" onClick={() => setEntregado(exacto(b))}>
                      {formatCents(b)}
                    </button>
                  ))}
                </div>

                <div className={`pos-cambio ${cambioCents !== null && cambioCents < 0 ? "is-falta" : ""}`}>
                  {cambioCents === null ? (
                    <span>Escribe lo que te dio y te digo el cambio.</span>
                  ) : cambioCents < 0 ? (
                    <>
                      <span>Faltan</span>
                      <strong>{formatCents(Math.abs(cambioCents))}</strong>
                    </>
                  ) : (
                    <>
                      <span>Cambio a devolver</span>
                      <strong>{formatCents(cambioCents)}</strong>
                    </>
                  )}
                </div>
              </div>
            ) : null}

            {metodo === "card" ? (
              <p className="pos-aviso pos-aviso-ojo">
                <strong>Esta pantalla NO cobra la tarjeta.</strong> Pasa la tarjeta en tu terminal de Square
                como siempre y, cuando el terminal diga que se aprobó, confirma aquí para dejar la venta
                registrada y descontar el stock.
              </p>
            ) : null}

            {metodo === "apuntado" ? (
              <p className="pos-aviso pos-aviso-info">
                Se la lleva ahora y te paga después. El pedido queda como <strong>por cobrar</strong> en
                Pedidos, y el stock baja igual porque la ropa ya salió del armario.
              </p>
            ) : null}

            <div className="pos-datos">
              <Field
                label="Nombre de la clienta"
                htmlFor="pos-nombre"
                required={metodo === "apuntado"}
                hint={
                  metodo === "apuntado"
                    ? "Obligatorio para apuntar: si no, no sabrás a quién cobrarle."
                    : "Opcional. Ayuda a encontrar el ticket después."
                }
              >
                <input
                  id="pos-nombre"
                  type="text"
                  autoComplete="off"
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                />
              </Field>

              <Field label="Teléfono" htmlFor="pos-telefono" hint="Opcional.">
                <input
                  id="pos-telefono"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  value={telefono}
                  onChange={(e) => setTelefono(e.target.value)}
                />
              </Field>

              <Field label="Nota" htmlFor="pos-nota" hint="Opcional: se guarda en el pedido.">
                <input
                  id="pos-nota"
                  type="text"
                  autoComplete="off"
                  value={nota}
                  onChange={(e) => setNota(e.target.value)}
                />
              </Field>
            </div>

            {impedimento ? <p className="pos-aviso pos-aviso-error">{impedimento}</p> : null}

            <div className="pos-modal-pie">
              <Button block disabled={Boolean(impedimento) || pendiente} onClick={cerrarVenta}>
                {pendiente ? "Guardando…" : textoBotonCobrar(metodo, totalCents)}
              </Button>
              <Button variant="ghost" block onClick={() => setCobrando(false)} disabled={pendiente}>
                Volver al ticket
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── utilidades ─────────────────────────── */

/** Una variante se puede vender si no controla stock o si le queda alguna. */
function disponible(v: PosVariante): boolean {
  return v.precioCents > 0 && (!v.trackStock || v.stock > 0);
}

/** Nunca se pasa del stock real: prometer lo que no hay se paga en devoluciones. */
function topar(linea: Linea, cantidad: number): number {
  const tope = linea.trackStock ? Math.max(0, linea.stock) : 99;
  return Math.min(Math.max(0, cantidad), tope);
}

function etiquetaExistencias(p: PosProducto): string {
  const conControl = p.variantes.filter((v) => v.trackStock);
  if (conControl.length === 0) return "Sin control";
  const total = conControl.reduce((n, v) => n + Math.max(0, v.stock), 0);
  if (total === 0) return "Agotado";
  return `${total} en tienda`;
}

function calcularDescuento(modo: ModoDescuento, texto: string, subtotalCents: number): number {
  if (modo === "none" || !texto.trim()) return 0;
  if (modo === "percent") {
    const pct = Number.parseFloat(texto);
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    return Math.round((subtotalCents * Math.min(pct, 1000)) / 100);
  }
  const cents = parseToCents(texto);
  return cents !== null && cents > 0 ? cents : 0;
}

/** Centavos -> el texto que espera el campo de efectivo ("40.00"). */
function exacto(cents: number): string {
  return (cents / 100).toFixed(2);
}

function textoBotonCobrar(metodo: MetodoPos, totalCents: number): string {
  if (metodo === "cash") return `Cobrado en efectivo · ${formatCents(totalCents)}`;
  if (metodo === "card") return `Ya se aprobó en Square · registrar ${formatCents(totalCents)}`;
  return `Apuntar ${formatCents(totalCents)}`;
}

/**
 * Devuelve el motivo por el que NO se puede cerrar la venta, o null si todo está
 * en orden. Es lo mismo que valida el servidor, dicho antes de pulsar: el
 * servidor manda, pero enterarse después de tocar "Cobrar" es peor experiencia.
 */
function razonParaNoCobrar(v: {
  lineas: number;
  totalCents: number;
  descuentoPasado: boolean;
  modoDescuento: ModoDescuento;
  motivoDescuento: string;
  metodo: MetodoPos;
  nombre: string;
  pendiente: boolean;
}): string | null {
  if (v.pendiente) return null;
  if (v.lineas === 0) return "El ticket está vacío: añade al menos una pieza.";
  if (v.descuentoPasado) return "El descuento es mayor que el ticket.";
  if (v.totalCents < 0) return "El total no puede ser negativo.";
  if (v.modoDescuento !== "none" && v.motivoDescuento.trim().length < 2) {
    return "Escribe el motivo del descuento.";
  }
  if (v.metodo === "apuntado" && v.nombre.trim().length < 2) {
    return "Para apuntar la venta hace falta el nombre de la clienta.";
  }
  return null;
}
