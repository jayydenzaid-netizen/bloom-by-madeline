"use client";

import { useActionState, useMemo, useState } from "react";
import {
  computeDiscountCents,
  evaluateDiscount,
  generateCode,
  normalizarCodigo,
  type DescuentoBase,
} from "@/lib/discounts";
import { formatCents, parseToCents } from "@/lib/money";
import { Badge, Button, Card, Field, PageHeader } from "../../_components/ui";
import { accionDescuento, guardarDescuento, type EstadoDescuento } from "../actions";
import "../descuentos.css";

/**
 * Editor de un código de descuento: la misma pantalla sirve para crear y para
 * editar, porque son el mismo contrato.
 *
 * La pieza importante es la VISTA PREVIA EN VIVO: Madeline teclea un subtotal
 * de ejemplo y ve, en dólares, cuánto se descuenta y cuánto pagaría la clienta.
 * Es la única forma de que la diferencia entre "20 %" y "20 dólares" se entienda
 * de un vistazo, sin tener que explicársela por teléfono.
 *
 * El cálculo NO se reimplementa aquí: se llama a las mismas funciones de
 * lib/discounts.ts que usará la caja. Si la vista previa y el cobro pudieran
 * discrepar, la vista previa no serviría de nada.
 */

export type DescuentoEditable = {
  id: string;
  code: string;
  title: string;
  type: string;
  value: number;
  minSubtotalCents: number;
  appliesTo: string;
  appliesToIds: string[];
  oncePerCustomer: boolean;
  usageLimit: number;
  usageCount: number;
  /** "yyyy-mm-dd" o "" — ya convertido a hora local por la página. */
  startsAt: string;
  endsAt: string;
  isActive: boolean;
};

type Opcion = { id: string; title: string };

type Props = {
  descuento: DescuentoEditable | null;
  colecciones: Opcion[];
  productos: Opcion[];
  /** Mensaje de la redirección que sigue a crear el código. */
  recienCreado?: boolean;
};

/** Centavos → "45.99" para meterlos dentro de un <input>, sin dividir a mano. */
function centavosAInput(cents: number): string {
  if (!cents) return "";
  return formatCents(cents).replace(/[^0-9.]/g, "");
}

export default function DiscountForm({ descuento, colecciones, productos, recienCreado = false }: Props) {
  const [estado, enviar, pendiente] = useActionState<EstadoDescuento, FormData>(guardarDescuento, {});

  const [code, setCode] = useState(descuento?.code ?? "");
  const [title, setTitle] = useState(descuento?.title ?? "");
  const [type, setType] = useState(descuento?.type ?? "percentage");

  // Porcentaje e importe viven en dos estados distintos a propósito: si Madeline
  // prueba "20 %" y luego "20 dólares", al volver atrás no se le pierde el valor
  // que ya había escrito.
  const [valorPct, setValorPct] = useState(
    descuento && descuento.type === "percentage" ? String(descuento.value) : "",
  );
  const [valorFijo, setValorFijo] = useState(
    descuento && descuento.type === "fixed" ? centavosAInput(descuento.value) : "",
  );

  const [minSubtotal, setMinSubtotal] = useState(centavosAInput(descuento?.minSubtotalCents ?? 0));
  const [appliesTo, setAppliesTo] = useState(descuento?.appliesTo ?? "all");
  const [ids, setIds] = useState<string[]>(descuento?.appliesToIds ?? []);
  const [busqueda, setBusqueda] = useState("");
  const [usageLimit, setUsageLimit] = useState(descuento?.usageLimit ? String(descuento.usageLimit) : "");
  const [oncePerCustomer, setOncePerCustomer] = useState(descuento?.oncePerCustomer ?? false);
  const [startsAt, setStartsAt] = useState(descuento?.startsAt ?? "");
  const [endsAt, setEndsAt] = useState(descuento?.endsAt ?? "");
  const [isActive, setIsActive] = useState(descuento?.isActive ?? true);

  // Subtotal de ejemplo de la vista previa. $50 es una compra típica de la
  // boutique; es solo el punto de partida, se puede cambiar.
  const [subtotalEjemplo, setSubtotalEjemplo] = useState("50.00");

  const valorEnBruto = type === "percentage" ? Number.parseInt(valorPct || "0", 10) || 0 : parseToCents(valorFijo) ?? 0;

  /**
   * Descuento sintético para la vista previa: se toman los valores del
   * formulario pero se ignoran fechas, estado y usos, porque lo que la pantalla
   * está explicando es la ARITMÉTICA del código, no su calendario.
   */
  const previsualizado: DescuentoBase = useMemo(
    () => ({
      id: descuento?.id ?? "preview",
      code: normalizarCodigo(code) || "CÓDIGO",
      title,
      type,
      value: valorEnBruto,
      minSubtotalCents: parseToCents(minSubtotal) ?? 0,
      appliesTo,
      appliesToIdsJson: JSON.stringify(ids),
      oncePerCustomer,
      usageLimit: 0,
      usageCount: 0,
      startsAt: null,
      endsAt: null,
      isActive: true,
    }),
    [descuento?.id, code, title, type, valorEnBruto, minSubtotal, appliesTo, ids, oncePerCustomer],
  );

  const subtotalCents = Math.max(0, parseToCents(subtotalEjemplo) ?? 0);
  // Sin `lineas`, lib/discounts asume que toda la compra es elegible: es
  // exactamente lo que hace falta aquí, donde no hay carrito ninguno.
  const descontado = computeDiscountCents(previsualizado, subtotalCents);
  const veredicto = evaluateDiscount(previsualizado, { subtotalCents });
  const esEnvioGratis = type === "free_shipping";
  const totalPreview = Math.max(0, subtotalCents - descontado);

  const errores = estado.errores ?? {};
  const catalogo = appliesTo === "collection" ? colecciones : productos;
  const filtrado = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const lista = q ? catalogo.filter((o) => o.title.toLowerCase().includes(q)) : catalogo;
    return lista.slice(0, 200);
  }, [catalogo, busqueda]);

  function alternarId(id: string): void {
    setIds((actuales) => (actuales.includes(id) ? actuales.filter((x) => x !== id) : [...actuales, id]));
  }

  function cambiarAmbito(nuevo: string): void {
    setAppliesTo(nuevo);
    // Los ids elegidos son de otra lista en cuanto cambia el ámbito: dejarlos
    // puestos guardaría ids de colección en un código de producto.
    setIds([]);
    setBusqueda("");
  }

  return (
    <>
      <form action={enviar}>
        <input type="hidden" name="id" value={descuento?.id ?? ""} />
        <input type="hidden" name="appliesToIdsJson" value={JSON.stringify(appliesTo === "all" ? [] : ids)} />

        <PageHeader
          title={descuento ? descuento.code : "Nuevo código de descuento"}
          subtitle={
            descuento
              ? `Usado ${descuento.usageCount} ${descuento.usageCount === 1 ? "vez" : "veces"}${descuento.title ? ` · ${descuento.title}` : ""}`
              : "Un código que la clienta escribe al pagar y le rebaja el total."
          }
          actions={
            <>
              <Button href="/admin/descuentos" variant="ghost">
                Volver al listado
              </Button>
              <Button type="submit" disabled={pendiente}>
                {pendiente ? "Guardando…" : "Guardar"}
              </Button>
            </>
          }
        />

        {recienCreado ? <div className="desc-aviso desc-aviso-ok">Código creado. Ya se puede repartir.</div> : null}
        {estado.error ? <div className="desc-aviso desc-aviso-error">{estado.error}</div> : null}
        {estado.mensaje ? <div className="desc-aviso desc-aviso-ok">{estado.mensaje}</div> : null}

        <div className="desc-cols">
          <div className="desc-stack">
            <Card title="El código">
              <Field
                label="Código que escribe la clienta"
                htmlFor="code"
                required
                error={errores.code}
                hint="Se compara sin distinguir mayúsculas. Sin espacios ni acentos: hay que poder dictarlo por teléfono."
              >
                <div className="desc-codigo">
                  <input
                    id="code"
                    name="code"
                    type="text"
                    value={code}
                    placeholder="BLOOM-4K2P"
                    autoCapitalize="characters"
                    spellCheck={false}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => setCode(generateCode("BLOOM"))}>
                    Generar
                  </Button>
                </div>
              </Field>

              <Field
                label="Nombre interno"
                htmlFor="title"
                error={errores.title}
                hint="Para acordarte de para qué era. La clienta no lo ve nunca."
              >
                <input
                  id="title"
                  name="title"
                  type="text"
                  value={title}
                  placeholder="Rebajas de agosto"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
            </Card>

            <Card title="Cuánto descuenta">
              <Field label="Tipo de descuento" htmlFor="type">
                <select id="type" name="type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="percentage">Porcentaje sobre la compra (20 %)</option>
                  <option value="fixed">Cantidad fija de dinero ($20.00)</option>
                  <option value="free_shipping">Envío gratis</option>
                </select>
              </Field>

              <div className="desc-par">
                {type === "percentage" ? (
                  <Field label="Porcentaje" htmlFor="value" required error={errores.value} hint="Entre 1 y 100.">
                    <input
                      id="value"
                      name="value"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={100}
                      step={1}
                      value={valorPct}
                      placeholder="20"
                      onChange={(e) => setValorPct(e.target.value)}
                    />
                  </Field>
                ) : null}

                {type === "fixed" ? (
                  <Field
                    label="Dinero que se descuenta"
                    htmlFor="value"
                    required
                    error={errores.value}
                    hint="En dólares, por ejemplo 20.00"
                  >
                    <input
                      id="value"
                      name="value"
                      type="text"
                      inputMode="decimal"
                      value={valorFijo}
                      placeholder="20.00"
                      onChange={(e) => setValorFijo(e.target.value)}
                    />
                  </Field>
                ) : null}

                {type === "free_shipping" ? (
                  // El campo viaja igual para que el Server Action reciba siempre
                  // un "value"; con envío gratis su valor no se usa.
                  <input type="hidden" name="value" value="0" />
                ) : null}

                <Field
                  label="Compra mínima"
                  htmlFor="minSubtotal"
                  error={errores.minSubtotalCents}
                  hint="Déjalo vacío si vale para cualquier compra."
                >
                  <input
                    id="minSubtotal"
                    name="minSubtotal"
                    type="text"
                    inputMode="decimal"
                    value={minSubtotal}
                    placeholder="0.00"
                    onChange={(e) => setMinSubtotal(e.target.value)}
                  />
                </Field>
              </div>
            </Card>

            <Card title="A qué se aplica">
              <Field label="Alcance" htmlFor="appliesTo" error={errores.appliesToIds}>
                <select id="appliesTo" name="appliesTo" value={appliesTo} onChange={(e) => cambiarAmbito(e.target.value)}>
                  <option value="all">Toda la tienda</option>
                  <option value="collection">Solo algunas colecciones</option>
                  <option value="product">Solo algunos productos</option>
                </select>
              </Field>

              {appliesTo !== "all" ? (
                <div className="desc-picker">
                  <input
                    type="search"
                    value={busqueda}
                    placeholder={appliesTo === "collection" ? "Buscar colección…" : "Buscar producto…"}
                    aria-label="Buscar"
                    onChange={(e) => setBusqueda(e.target.value)}
                  />

                  <div className="desc-picker-lista">
                    {filtrado.length === 0 ? (
                      <p className="desc-picker-vacio">
                        {catalogo.length === 0
                          ? appliesTo === "collection"
                            ? "Todavía no hay colecciones creadas."
                            : "Todavía no hay productos en el catálogo."
                          : "Nada con ese nombre."}
                      </p>
                    ) : (
                      filtrado.map((o) => (
                        <label key={o.id} className="desc-picker-item">
                          <input type="checkbox" checked={ids.includes(o.id)} onChange={() => alternarId(o.id)} />
                          <span>{o.title}</span>
                        </label>
                      ))
                    )}
                  </div>

                  <span className="desc-picker-cuenta">
                    {ids.length === 0
                      ? "Nada elegido todavía: el código no descontaría nada."
                      : `${ids.length} ${appliesTo === "collection" ? (ids.length === 1 ? "colección elegida" : "colecciones elegidas") : ids.length === 1 ? "producto elegido" : "productos elegidos"}.`}
                  </span>
                </div>
              ) : null}
            </Card>

            <Card title="Cuándo vale y cuántas veces">
              <div className="desc-par">
                <Field label="Empieza el" htmlFor="startsAt" hint="Vacío = desde ya." error={errores.startsAt}>
                  <input
                    id="startsAt"
                    name="startsAt"
                    type="date"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                  />
                </Field>

                <Field
                  label="Caduca el"
                  htmlFor="endsAt"
                  hint="Vacío = no caduca. Incluye el día entero."
                  error={errores.endsAt}
                >
                  <input id="endsAt" name="endsAt" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </Field>
              </div>

              <Field
                label="Máximo de usos"
                htmlFor="usageLimit"
                error={errores.usageLimit}
                hint={
                  descuento
                    ? `Vacío = sin límite. Ya lleva ${descuento.usageCount} ${descuento.usageCount === 1 ? "uso" : "usos"}.`
                    : "Vacío = sin límite."
                }
              >
                <input
                  id="usageLimit"
                  name="usageLimit"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={usageLimit}
                  placeholder="Sin límite"
                  onChange={(e) => setUsageLimit(e.target.value)}
                />
              </Field>

              <label className="desc-check">
                <input
                  type="checkbox"
                  name="oncePerCustomer"
                  checked={oncePerCustomer}
                  onChange={(e) => setOncePerCustomer(e.target.checked)}
                />
                <span className="desc-check-txt">
                  Una sola vez por clienta
                  <small>Se controla por el correo del pedido. Útil para códigos de bienvenida.</small>
                </span>
              </label>
            </Card>
          </div>

          {/* ── columna lateral: vista previa y estado ────────────────────── */}
          <aside className="desc-stack">
            <Card title="Vista previa">
              <div className="desc-preview">
                <Field
                  label="Si la clienta compra…"
                  htmlFor="subtotalEjemplo"
                  hint="Prueba distintas cantidades para ver cómo queda."
                >
                  <input
                    id="subtotalEjemplo"
                    type="text"
                    inputMode="decimal"
                    value={subtotalEjemplo}
                    onChange={(e) => setSubtotalEjemplo(e.target.value)}
                  />
                </Field>

                <div className="desc-preview-atajos">
                  {["25.00", "50.00", "100.00", "150.00"].map((v) => (
                    <button key={v} type="button" className="desc-atajo" onClick={() => setSubtotalEjemplo(v)}>
                      {formatCents(parseToCents(v) ?? 0)}
                    </button>
                  ))}
                </div>

                <div className="desc-preview-cuentas">
                  <div className="desc-preview-fila">
                    <span>Su compra</span>
                    <span>{formatCents(subtotalCents)}</span>
                  </div>
                  <div className="desc-preview-fila desc-preview-ahorro">
                    <span>Con {normalizarCodigo(code) || "este código"} se ahorra</span>
                    <span>{esEnvioGratis ? "el envío" : `− ${formatCents(descontado)}`}</span>
                  </div>
                  <div className="desc-preview-fila desc-preview-total">
                    <span>Paga</span>
                    <span>{formatCents(totalPreview)}</span>
                  </div>
                </div>

                {!veredicto.ok ? <p className="desc-aviso desc-aviso-warn">{veredicto.reason}</p> : null}

                {esEnvioGratis ? (
                  <p className="desc-preview-nota">
                    El envío gratis no baja el precio de la ropa: lo que desaparece es el coste de envío del pedido.
                  </p>
                ) : null}

                {appliesTo !== "all" ? (
                  <p className="desc-preview-nota">
                    Esta cuenta supone que toda la compra es de lo que elegiste arriba. Si la clienta mete algo más en
                    la bolsa, el descuento solo muerde la parte que entra.
                  </p>
                ) : null}
              </div>
            </Card>

            <Card title="Estado">
              <label className="desc-check">
                <input
                  type="checkbox"
                  name="isActive"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                />
                <span className="desc-check-txt">
                  Código activo
                  <small>
                    {isActive
                      ? "Ahora mismo se puede usar al pagar (si estamos dentro de las fechas)."
                      : "Apagado: nadie puede usarlo, aunque lo tenga escrito."}
                  </small>
                </span>
              </label>

              {descuento && descuento.usageCount > 0 && !isActive ? (
                <p className="desc-aviso desc-aviso-warn" style={{ marginBottom: 0 }}>
                  Este código ya se usó {descuento.usageCount}{" "}
                  {descuento.usageCount === 1 ? "vez" : "veces"}. Al apagarlo dejará de funcionar para quien lo tenga
                  guardado, pero los pedidos ya hechos conservan su descuento.
                </p>
              ) : null}
            </Card>

            {descuento ? (
              <Card title="Resumen">
                <div className="desc-preview-fila">
                  <span>Usos</span>
                  <span>
                    {descuento.usageCount}
                    {descuento.usageLimit > 0 ? ` de ${descuento.usageLimit}` : " (sin límite)"}
                  </span>
                </div>
                <div className="desc-preview-fila" style={{ marginTop: 8 }}>
                  <span>Estado guardado</span>
                  <Badge tone={descuento.isActive ? "success" : "neutral"}>
                    {descuento.isActive ? "Activo" : "Desactivado"}
                  </Badge>
                </div>
              </Card>
            ) : null}
          </aside>
        </div>
      </form>

      {/* Fuera del formulario principal: el HTML no permite anidar dos <form>, y
          borrar no debe compartir envío con guardar. */}
      {descuento ? (
        <form action={accionDescuento} className="desc-peligro">
          <input type="hidden" name="id" value={descuento.id} />
          {/* Se vuelve al LISTADO y no a esta ficha porque la pantalla de
              confirmación de borrado vive en el listado: apuntando aquí, el
              `?borrar=` caía en una página que no lo mira y el aviso no
              llegaba a salir nunca (medido con el formulario sin JavaScript). */}
          <input type="hidden" name="volver" value="/admin/descuentos" />
          {/* La acción va en un campo oculto: con Server Actions de React 19 el
              name/value del botón que envía el formulario no llega al servidor. */}
          <input type="hidden" name="accion" value="borrar" />
          <Card title="Zona peligrosa">
            <div className="adm-row">
              <Button type="submit" variant="danger">
                Borrar este código
              </Button>
              <span className="adm-muted adm-small">
                Se pedirá confirmación. Los pedidos que ya lo usaron conservan su descuento; lo que se pierde es el
                historial de quién lo usó.
              </span>
            </div>
          </Card>
        </form>
      ) : null}
    </>
  );
}

/* ────────────────────────── copiar al portapapeles ────────────────────────── */

/**
 * Botón de copiar el código. Vive en este fichero (y no en uno propio) porque es
 * el único otro trozo de esta sección que necesita ejecutarse en el navegador.
 *
 * `navigator.clipboard` no existe en contextos no seguros (http en el móvil, por
 * ejemplo), así que hay una segunda vía con un textarea oculto: es preferible un
 * método viejo que un botón que no hace nada y no dice por qué.
 */
export function CopiarCodigo({ code }: { code: string }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar(): Promise<void> {
    let hecho = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(code);
        hecho = true;
      }
    } catch {
      hecho = false;
    }

    if (!hecho) {
      const area = document.createElement("textarea");
      area.value = code;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        hecho = document.execCommand("copy");
      } catch {
        hecho = false;
      }
      document.body.removeChild(area);
    }

    if (hecho) {
      setCopiado(true);
      window.setTimeout(() => setCopiado(false), 1800);
    }
  }

  return (
    <button
      type="button"
      className={copiado ? "desc-copiar is-hecho" : "desc-copiar"}
      onClick={copiar}
      title={`Copiar ${code}`}
      aria-label={`Copiar el código ${code}`}
    >
      {copiado ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m5 12 5 5L20 7" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  );
}
