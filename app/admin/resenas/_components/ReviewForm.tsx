"use client";

import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Button } from "../../_components/ui";
import { accionEnLote, borrarResena, crearResena, moderarResena } from "../actions";
import {
  limpiarCarritos,
  marcarAvisada,
  marcarDescartado,
  marcarRecuperado,
  restaurarCarrito,
} from "../../carritos/actions";
import type { EstadoFormulario } from "../actions";
import { ETIQUETA_ORIGEN, ORIGENES_RESENA } from "@/lib/reviews";
import "../resenas.css";

/**
 * Todas las piezas con interacción real de los módulos "Reseñas" y "Carritos".
 *
 * Están juntas en un único fichero cliente a propósito: es el único fichero
 * cliente asignado a este módulo, y partirlo obligaría a crear ficheros fuera
 * de la lista mientras otros agentes trabajan en el mismo repo. Cada bloque
 * está separado y documentado; las pantallas siguen siendo Server Components y
 * solo montan estos componentes donde de verdad hace falta JavaScript.
 *
 * Regla de la casa aplicada aquí: **ningún botón destructivo actúa al primer
 * clic**. Borrar siempre pasa por un "¿Seguro?" explícito.
 */

const FORMULARIO_INICIAL: EstadoFormulario = { estado: "idle" };

/* ════════════════════════════ piezas comunes ════════════════════════════ */

function Aviso({ estado }: { estado: EstadoFormulario }) {
  if (estado.estado === "idle") return null;
  const ok = estado.estado === "ok";
  return (
    <p className={`rev-aviso ${ok ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
      {ok ? estado.mensaje : estado.error}
    </p>
  );
}

/** Aviso suelto para las acciones que no van por formulario. */
function AvisoTexto({ texto, ok }: { texto: string; ok: boolean }) {
  if (!texto) return null;
  return (
    <span className={`rev-aviso rev-aviso-inline ${ok ? "is-ok" : "is-error"}`} role="status" aria-live="polite">
      {texto}
    </span>
  );
}

/* ════════════════════════ 1 · alta de reseña ════════════════════════ */

export type ProductoOpcion = { id: string; title: string };

/**
 * Alta manual de una reseña REAL. Va dentro de un <details> para que no ocupe
 * media pantalla del teléfono cuando lo que Madeline viene a hacer es moderar.
 */
export function ReviewForm({ productos }: { productos: ProductoOpcion[] }) {
  const [estado, accion, pendiente] = useActionState(crearResena, FORMULARIO_INICIAL);
  const formRef = useRef<HTMLFormElement>(null);

  // Al guardar bien, el formulario se vacía: si no, la siguiente reseña saldría
  // con el nombre de la clienta anterior.
  useEffect(() => {
    if (estado.estado === "ok") formRef.current?.reset();
  }, [estado]);

  return (
    <details className="rev-alta">
      <summary>
        <span className="rev-alta-titulo">Añadir una reseña</span>
        <span className="adm-muted adm-small">Copia aquí lo que te escribió una clienta de verdad</span>
      </summary>

      <form ref={formRef} action={accion} className="rev-form">
        <p className="rev-nota">
          Solo reseñas <strong>reales</strong>: lo que te dejaron en tu destacado de Instagram, por DM o en el
          mostrador. Inventar una opinión es ilegal en Estados Unidos (la FTC multa por reseñas falsas) y además se
          nota.
        </p>

        <Aviso estado={estado} />

        <div className="rev-form-fila">
          <label className="adm-field rev-crece">
            <span className="adm-field-lbl">
              Nombre de la clienta <span className="adm-field-req">*</span>
            </span>
            <input name="autora" maxLength={60} required placeholder="Ashley R." autoComplete="off" />
            <span className="adm-field-hint">Como quiera que se le vea en la tienda. Vale solo el nombre.</span>
          </label>

          <fieldset className="adm-field rev-fieldset">
            <legend className="adm-field-lbl">Puntuación</legend>
            <SelectorPuntuacion />
          </fieldset>
        </div>

        <label className="adm-field">
          <span className="adm-field-lbl">Titular (opcional)</span>
          <input name="titulo" maxLength={80} placeholder="Me quedó perfecto" autoComplete="off" />
        </label>

        <label className="adm-field">
          <span className="adm-field-lbl">
            Lo que escribió <span className="adm-field-req">*</span>
          </span>
          <textarea name="texto" rows={4} maxLength={1200} required placeholder="Pega aquí su mensaje, tal cual." />
        </label>

        <div className="rev-form-fila">
          <label className="adm-field rev-crece">
            <span className="adm-field-lbl">¿De qué producto habla?</span>
            <select name="productoId" defaultValue="">
              <option value="">De la boutique en general</option>
              {productos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <span className="adm-field-hint">Si eliges producto, la reseña sale en su ficha.</span>
          </label>

          <label className="adm-field rev-crece">
            <span className="adm-field-lbl">¿De dónde salió?</span>
            <select name="origen" defaultValue="instagram">
              {ORIGENES_RESENA.map((o) => (
                <option key={o} value={o}>
                  {ETIQUETA_ORIGEN[o]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="rev-check-lbl">
          <input type="checkbox" name="verificada" />
          <span>Es una clienta que compró de verdad (se marca como «compra verificada»)</span>
        </label>

        <label className="rev-check-lbl">
          <input type="checkbox" name="publicar" defaultChecked />
          <span>Publicarla ya en la tienda (si lo dejas sin marcar queda pendiente)</span>
        </label>

        <div className="adm-row">
          <Button type="submit" disabled={pendiente}>
            {pendiente ? "Guardando…" : "Guardar reseña"}
          </Button>
        </div>
      </form>
    </details>
  );
}

/**
 * Cinco estrellas de verdad, no un desplegable: se toca más rápido en el móvil.
 * El truco del orden invertido (5→1 en el DOM, `row-reverse` en CSS) permite
 * pintar "todas las estrellas hasta la elegida" con CSS puro.
 */
function SelectorPuntuacion() {
  return (
    <div className="rev-stars">
      {[5, 4, 3, 2, 1].map((n) => (
        <span key={n} className="rev-star">
          <input
            type="radio"
            id={`puntuacion-${n}`}
            name="puntuacion"
            value={n}
            defaultChecked={n === 5}
            required
          />
          <label htmlFor={`puntuacion-${n}`} aria-label={`${n} ${n === 1 ? "estrella" : "estrellas"}`}>
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
              <path
                d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z"
                fill="currentColor"
              />
            </svg>
          </label>
        </span>
      ))}
    </div>
  );
}

/* ════════════════════ 2 · moderación fila a fila ════════════════════ */

/**
 * Botones de una reseña. No van en un <form>: la fila vive dentro del
 * formulario de acciones en lote y anidar formularios es HTML inválido (el
 * navegador se come el de dentro y el botón deja de hacer nada).
 */
export function AccionesResena({ id, estado, autora }: { id: string; estado: string; autora: string }) {
  const [pendiente, iniciar] = useTransition();
  const [aviso, setAviso] = useState<{ texto: string; ok: boolean }>({ texto: "", ok: true });
  const [confirmando, setConfirmando] = useState(false);

  function lanzar(fn: () => Promise<{ ok: boolean; mensaje?: string; error?: string }>) {
    iniciar(async () => {
      const r = await fn();
      setAviso({ texto: r.ok ? (r.mensaje ?? "Hecho.") : (r.error ?? "No se pudo."), ok: r.ok });
    });
  }

  return (
    <div className="rev-acciones">
      {estado !== "approved" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pendiente}
          onClick={() => lanzar(() => moderarResena({ id, estado: "approved" }))}
        >
          Aprobar
        </Button>
      ) : null}

      {estado !== "rejected" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pendiente}
          onClick={() => lanzar(() => moderarResena({ id, estado: "rejected" }))}
        >
          Rechazar
        </Button>
      ) : null}

      {estado !== "pending" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pendiente}
          onClick={() => lanzar(() => moderarResena({ id, estado: "pending" }))}
        >
          A pendientes
        </Button>
      ) : null}

      {/* Borrar nunca actúa al primer clic: primero pregunta. */}
      {confirmando ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={pendiente}
            onClick={() => {
              setConfirmando(false);
              lanzar(() => borrarResena(id));
            }}
          >
            Sí, borrar la de {autora}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmando(false)}>
            Cancelar
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" variant="ghost" disabled={pendiente} onClick={() => setConfirmando(true)}>
          Borrar…
        </Button>
      )}

      <AvisoTexto texto={aviso.texto} ok={aviso.ok} />
    </div>
  );
}

/* ════════════════════════ 3 · acciones en lote ════════════════════════ */

/**
 * Envuelve la tabla en un formulario con casillas. La tabla se sigue pintando
 * en el servidor y llega aquí como `children`: el estado de la selección vive
 * en el DOM, no en React, y así no hay que duplicar la tabla en cliente.
 */
export function BarraLote({ children }: { children: ReactNode }) {
  const [estado, accion, pendiente] = useActionState(accionEnLote, FORMULARIO_INICIAL);
  const [seleccionadas, setSeleccionadas] = useState(0);
  const [confirmando, setConfirmando] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  function contar() {
    const form = formRef.current;
    if (!form) return;
    setSeleccionadas(form.querySelectorAll<HTMLInputElement>('input[name="ids"]:checked').length);
    setConfirmando(false);
  }

  return (
    <form ref={formRef} action={accion} onChange={contar}>
      <div className="rev-lote">
        <span className="rev-lote-info">
          {seleccionadas === 0
            ? "Marca las casillas para aprobar o rechazar varias de golpe."
            : `${seleccionadas} ${seleccionadas === 1 ? "reseña seleccionada" : "reseñas seleccionadas"}`}
        </span>

        <div className="adm-row">
          <button
            type="submit"
            name="accion"
            value="approved"
            className="adm-btn adm-btn-primary adm-btn-sm"
            disabled={pendiente || seleccionadas === 0}
          >
            Aprobar
          </button>
          <button
            type="submit"
            name="accion"
            value="rejected"
            className="adm-btn adm-btn-ghost adm-btn-sm"
            disabled={pendiente || seleccionadas === 0}
          >
            Rechazar
          </button>

          {confirmando ? (
            <>
              <button
                type="submit"
                name="accion"
                value="delete"
                className="adm-btn adm-btn-danger adm-btn-sm"
                disabled={pendiente}
              >
                Sí, borrar {seleccionadas}
              </button>
              <button
                type="button"
                className="adm-btn adm-btn-ghost adm-btn-sm"
                onClick={() => setConfirmando(false)}
              >
                Cancelar
              </button>
            </>
          ) : (
            <button
              type="button"
              className="adm-btn adm-btn-ghost adm-btn-sm"
              disabled={pendiente || seleccionadas === 0}
              onClick={() => setConfirmando(true)}
            >
              Borrar…
            </button>
          )}
        </div>
      </div>

      <Aviso estado={estado} />

      {children}
    </form>
  );
}

/** Casilla de una fila. El `name="ids"` es lo que recoge la acción en lote. */
export function CasillaResena({ id, autora }: { id: string; autora: string }) {
  return (
    <input type="checkbox" name="ids" value={id} className="rev-check" aria-label={`Seleccionar la reseña de ${autora}`} />
  );
}

/** Cabecera de la columna de casillas: marca o desmarca todas las visibles. */
export function CasillaTodas() {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="rev-check"
      aria-label="Seleccionar todas las reseñas de la lista"
      onChange={(e) => {
        const form = ref.current?.form;
        if (!form) return;
        for (const casilla of form.querySelectorAll<HTMLInputElement>('input[name="ids"]')) {
          casilla.checked = e.currentTarget.checked;
        }
        // El onChange del formulario no salta al marcar por código: se avisa a mano.
        form.dispatchEvent(new Event("change", { bubbles: true }));
      }}
    />
  );
}

/* ══════════════════ 4 · carritos: mensaje y acciones ══════════════════ */

export type CarritoAcciones = {
  id: string;
  /** Mensaje ya redactado en el servidor, con nombre, artículos y total. */
  mensaje: string;
  /** Teléfono que dejó la clienta, si lo dejó: habilita el enlace de WhatsApp. */
  telefono?: string | null;
  /** DM de Instagram de la boutique (de Ajustes). */
  instagramDm?: string | null;
  descartado: boolean;
  recuperado: boolean;
};

/**
 * Caja de recuperación de un carrito: el mensaje editable, el botón de copiar y
 * las dos decisiones posibles (recuperado / descartado).
 *
 * No manda nada por su cuenta. Copiar deja el texto en el portapapeles y ya;
 * quien escribe es Madeline, por su canal, que es el DM.
 */
export function MensajeRecuperacion({ carrito }: { carrito: CarritoAcciones }) {
  const [texto, setTexto] = useState(carrito.mensaje);
  const [copiado, setCopiado] = useState(false);
  const [aviso, setAviso] = useState<{ texto: string; ok: boolean }>({ texto: "", ok: true });
  const [pendiente, iniciar] = useTransition();
  const [confirmandoDescarte, setConfirmandoDescarte] = useState(false);
  const [pidiendoPedido, setPidiendoPedido] = useState(false);
  const [numeroPedido, setNumeroPedido] = useState("");

  function lanzar(fn: () => Promise<{ ok: boolean; mensaje?: string; error?: string }>) {
    iniciar(async () => {
      const r = await fn();
      setAviso({ texto: r.ok ? (r.mensaje ?? "Hecho.") : (r.error ?? "No se pudo."), ok: r.ok });
    });
  }

  function confirmarCopia() {
    setCopiado(true);
    setAviso({ texto: "", ok: true });
    window.setTimeout(() => setCopiado(false), 2500);
  }

  /**
   * Copiar tiene tres escalones a propósito, de mejor a peor, porque Madeline
   * abre el panel desde el teléfono y la API moderna de portapapeles se cae en
   * cuanto la página no va por https (una IP de la red de casa, por ejemplo) o
   * el navegador no da permiso:
   *  1. `navigator.clipboard` — lo normal.
   *  2. `document.execCommand("copy")` sobre el texto seleccionado — obsoleta
   *     pero sigue funcionando donde la de arriba está bloqueada.
   *  3. Dejar el texto seleccionado y decirlo, para copiar a mano.
   */
  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      confirmarCopia();
      return;
    } catch {
      // Se sigue al plan B; no es un error que haya que enseñar todavía.
    }

    const area = document.getElementById(`msg-${carrito.id}`) as HTMLTextAreaElement | null;
    area?.focus();
    area?.select();
    try {
      if (document.execCommand("copy")) {
        confirmarCopia();
        return;
      }
    } catch {
      // Ni con la vía antigua: se avisa abajo.
    }
    setAviso({ texto: "Tu navegador no deja copiar solo: el texto ya está seleccionado.", ok: false });
  }

  const wa = carrito.telefono ? soloDigitos(carrito.telefono) : "";

  return (
    <div className="rev-msg-caja">
      <label className="adm-field">
        <span className="adm-field-lbl">Mensaje para recordárselo</span>
        <textarea
          id={`msg-${carrito.id}`}
          rows={5}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          className="rev-msg"
        />
        <span className="adm-field-hint">
          Cámbialo a tu gusto antes de copiarlo. No se envía nada solo: lo mandas tú por DM.
        </span>
      </label>

      <div className="adm-row">
        <Button type="button" size="sm" onClick={copiar}>
          {copiado ? "¡Copiado!" : "Copiar mensaje"}
        </Button>

        {wa ? (
          <a
            className="adm-btn adm-btn-ghost adm-btn-sm"
            href={`https://wa.me/${wa}?text=${encodeURIComponent(texto)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir en WhatsApp
          </a>
        ) : null}

        {carrito.instagramDm ? (
          <a
            className="adm-btn adm-btn-ghost adm-btn-sm"
            href={carrito.instagramDm}
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir Instagram
          </a>
        ) : null}

        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pendiente}
          onClick={() => lanzar(() => marcarAvisada(carrito.id))}
        >
          Ya le escribí
        </Button>
      </div>

      <div className="rev-msg-decision">
        {carrito.recuperado || carrito.descartado ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pendiente}
            onClick={() => lanzar(() => restaurarCarrito(carrito.id))}
          >
            Volver a la lista
          </Button>
        ) : (
          <>
            {pidiendoPedido ? (
              <>
                <input
                  className="rev-input-pedido"
                  value={numeroPedido}
                  onChange={(e) => setNumeroPedido(e.target.value)}
                  placeholder="BLM-1001 (opcional)"
                  aria-label="Número del pedido que salió de este carrito"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={pendiente}
                  onClick={() => {
                    setPidiendoPedido(false);
                    lanzar(() => marcarRecuperado({ id: carrito.id, pedido: numeroPedido }));
                  }}
                >
                  Guardar
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setPidiendoPedido(false)}>
                  Cancelar
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" variant="ghost" disabled={pendiente} onClick={() => setPidiendoPedido(true)}>
                Lo recuperé
              </Button>
            )}

            {confirmandoDescarte ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={pendiente}
                  onClick={() => {
                    setConfirmandoDescarte(false);
                    lanzar(() => marcarDescartado(carrito.id));
                  }}
                >
                  Sí, descartar
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmandoDescarte(false)}>
                  Cancelar
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pendiente}
                onClick={() => setConfirmandoDescarte(true)}
              >
                Descartar…
              </Button>
            )}
          </>
        )}
      </div>

      <AvisoTexto texto={aviso.texto} ok={aviso.ok} />
    </div>
  );
}

/** wa.me quiere el número sin espacios ni signos, con prefijo de país. */
function soloDigitos(telefono: string): string {
  const limpio = telefono.replace(/\D/g, "");
  if (!limpio) return "";
  // 10 dígitos = número de Estados Unidos sin prefijo: se le antepone el 1.
  return limpio.length === 10 ? `1${limpio}` : limpio;
}

/* ════════════════════════ 5 · limpieza de carritos ════════════════════════ */

/**
 * Borrado en bloque. Está al fondo de la pantalla, pide elegir criterio y
 * marcar una casilla: tres gestos deliberados antes de un borrado sin vuelta.
 */
export function LimpiezaCarritos({ vacios }: { vacios: number }) {
  const [estado, accion, pendiente] = useActionState(limpiarCarritos, FORMULARIO_INICIAL);
  const [modo, setModo] = useState<"vacios" | "antiguos">("vacios");

  return (
    <form action={accion} className="rev-limpieza">
      <p className="adm-muted adm-small">
        Cada visita a la tienda crea un carrito, aunque no se meta nada dentro. Esto solo borra basura; los pedidos no
        se tocan nunca.
      </p>

      <div className="rev-form-fila">
        <label className="adm-field rev-crece">
          <span className="adm-field-lbl">Qué borrar</span>
          <select name="modo" value={modo} onChange={(e) => setModo(e.target.value as "vacios" | "antiguos")}>
            <option value="vacios">Carritos vacíos ({vacios})</option>
            <option value="antiguos">Carritos viejos, tengan lo que tengan</option>
          </select>
        </label>

        <label className="adm-field rev-crece">
          <span className="adm-field-lbl">Más viejos que</span>
          <select name="dias" defaultValue="30" disabled={modo === "vacios"}>
            <option value="7">7 días</option>
            <option value="30">30 días</option>
            <option value="90">90 días</option>
            <option value="365">1 año</option>
          </select>
          <span className="adm-field-hint">
            {modo === "vacios" ? "Los vacíos se borran sin mirar la fecha (salvo los de hoy)." : "Nunca borra los de las últimas 24 horas."}
          </span>
        </label>
      </div>

      <label className="rev-check-lbl">
        <input type="checkbox" name="confirmar" />
        <span>Entiendo que esto borra los carritos para siempre.</span>
      </label>

      <Aviso estado={estado} />

      <div className="adm-row">
        <Button type="submit" variant="danger" size="sm" disabled={pendiente}>
          {pendiente ? "Borrando…" : "Borrar carritos"}
        </Button>
      </div>
    </form>
  );
}
