"use client";

import { useMemo, useState, useTransition } from "react";
import { Badge, Button } from "../../_components/ui";
import { guardarSeo, type ArchivoGenerado, type ResultadoSeo } from "../actions";

/**
 * Los componentes de CLIENTE del módulo de herramientas.
 *
 * Van los tres en este fichero porque el reparto de trabajo de este repo me
 * asignó una lista cerrada de ficheros (hay varios agentes tocando el mismo
 * árbol a la vez y un fichero suelto de más es un conflicto seguro). Son los
 * únicos trozos del módulo que necesitan JavaScript en el navegador:
 *
 *  - `SeoPanel`: edición en línea con contador de caracteres en vivo y vista
 *    previa de Google. Sin cliente no hay «en vivo».
 *  - `BotonDescarga`: recibe el fichero del Server Action y lo guarda en el
 *    móvil o el escritorio. Se hace así, y no con un enlace a una ruta, porque
 *    la copia lleva pedidos y datos de clientas: por el Server Action solo pasa
 *    quien tiene sesión.
 *  - `BotonCopiar`: copiar el mensaje al portapapeles para pegarlo en el DM de
 *    Instagram, que es por donde Bloom vende de verdad.
 *
 * Todo lo demás de la pantalla es Server Component y funciona sin JavaScript.
 */

/* ═══════════════════════════ descarga de ficheros ═══════════════════════════ */

export function BotonDescarga({
  accion,
  etiqueta,
  tipoMime,
  variante = "primary",
}: {
  /** Server Action que genera el fichero. */
  accion: () => Promise<ArchivoGenerado>;
  etiqueta: string;
  tipoMime: string;
  variante?: "primary" | "ghost";
}) {
  const [trabajando, empezar] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState<string | null>(null);

  function descargar() {
    setError(null);
    setListo(null);
    empezar(async () => {
      const resultado = await accion();
      if (!resultado.ok) {
        setError(resultado.error);
        return;
      }

      // Blob + enlace temporal: es la única forma de que el navegador guarde un
      // fichero que no viene de una URL. El objeto se libera enseguida para no
      // dejar la copia entera colgando en memoria.
      const blob = new Blob([resultado.contenido], { type: tipoMime });
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = resultado.nombre;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);

      setListo(`${resultado.nombre} · ${Math.max(1, Math.round(resultado.bytes / 1024))} KB`);
    });
  }

  return (
    <div className="hrr-descarga">
      <Button type="button" variant={variante} onClick={descargar} disabled={trabajando}>
        {trabajando ? "Preparando…" : etiqueta}
      </Button>
      {listo ? <span className="hrr-ok-inline">Descargado: {listo}</span> : null}
      {error ? <span className="hrr-err-inline">{error}</span> : null}
    </div>
  );
}

/* ═══════════════════════════ copiar al portapapeles ═══════════════════════════ */

export function BotonCopiar({ texto, etiqueta = "Copiar mensaje" }: { texto: string; etiqueta?: string }) {
  const [copiado, setCopiado] = useState(false);
  const [fallo, setFallo] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setFallo(false);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      // Safari en iOS niega el portapapeles si la pestaña no está en primer
      // plano. En vez de mentir con un "copiado" falso, se dice la verdad.
      setFallo(true);
    }
  }

  return (
    <div className="hrr-descarga">
      <Button type="button" variant="ghost" size="sm" onClick={copiar}>
        {copiado ? "Copiado" : etiqueta}
      </Button>
      {fallo ? <span className="hrr-err-inline">Tu navegador no dejó copiar: selecciona el texto a mano.</span> : null}
    </div>
  );
}

/* ═══════════════════════════ panel de SEO ═══════════════════════════ */

export type ItemSeo = {
  tipo: "producto" | "pagina";
  id: string;
  titulo: string;
  ruta: string;
  seoTitle: string;
  seoDescription: string;
  /** Estado del contenido, para no editar el SEO de algo que nadie ve. */
  publico: boolean;
  etiquetaEstado: string;
};

export type LimitesSeo = {
  tituloMin: number;
  tituloMax: number;
  descripcionMin: number;
  descripcionMax: number;
};

type EstadoCampo = "falta" | "corto" | "ok" | "largo";

function evaluar(texto: string, min: number, max: number): EstadoCampo {
  const largo = texto.trim().length;
  if (largo === 0) return "falta";
  if (largo < min) return "corto";
  if (largo > max) return "largo";
  return "ok";
}

const TONO: Record<EstadoCampo, "danger" | "warning" | "success"> = {
  falta: "danger",
  corto: "warning",
  largo: "warning",
  ok: "success",
};

const PALABRA: Record<EstadoCampo, string> = {
  falta: "Falta",
  corto: "Corto",
  largo: "Se corta",
  ok: "Bien",
};

/** Lo que Google enseña de verdad: corta por caracteres y pone puntos suspensivos. */
function recortar(texto: string, max: number): string {
  const limpio = texto.trim();
  return limpio.length > max ? `${limpio.slice(0, max - 1).trimEnd()}…` : limpio;
}

export function SeoPanel({
  items,
  limites,
  base,
  nombreTienda,
}: {
  items: ItemSeo[];
  limites: LimitesSeo;
  /** Dominio del sitio, para que la vista previa se parezca a Google. */
  base: string;
  nombreTienda: string;
}) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const [borrador, setBorrador] = useState<{ titulo: string; descripcion: string }>({ titulo: "", descripcion: "" });
  const [guardados, setGuardados] = useState<Record<string, { seoTitle: string; seoDescription: string }>>({});
  const [aviso, setAviso] = useState<{ id: string; texto: string; malo: boolean } | null>(null);
  const [soloPendientes, setSoloPendientes] = useState(false);
  const [guardando, empezar] = useTransition();

  // Lo guardado en esta sesión manda sobre lo que llegó del servidor: así la
  // fila se actualiza al instante sin recargar la pantalla entera.
  const filas = useMemo(
    () =>
      items.map((i) => {
        const cambio = guardados[i.id];
        return cambio ? { ...i, seoTitle: cambio.seoTitle, seoDescription: cambio.seoDescription } : i;
      }),
    [items, guardados],
  );

  const pendientes = filas.filter(
    (i) =>
      evaluar(i.seoTitle, limites.tituloMin, limites.tituloMax) !== "ok" ||
      evaluar(i.seoDescription, limites.descripcionMin, limites.descripcionMax) !== "ok",
  );

  const visibles = soloPendientes ? pendientes : filas;

  function abrir(item: ItemSeo) {
    setAviso(null);
    setAbierto(item.id);
    setBorrador({ titulo: item.seoTitle, descripcion: item.seoDescription });
  }

  function guardar(item: ItemSeo) {
    empezar(async () => {
      const resultado: ResultadoSeo = await guardarSeo({
        tipo: item.tipo,
        id: item.id,
        seoTitle: borrador.titulo,
        seoDescription: borrador.descripcion,
      });

      if (!resultado.ok) {
        setAviso({ id: item.id, texto: resultado.error, malo: true });
        return;
      }

      setGuardados((previo) => ({
        ...previo,
        [item.id]: { seoTitle: borrador.titulo.trim(), seoDescription: borrador.descripcion.trim() },
      }));
      setAbierto(null);
      setAviso({ id: item.id, texto: "Guardado.", malo: false });
    });
  }

  if (items.length === 0) {
    return (
      <p className="hrr-pista">
        Todavía no hay productos ni páginas que revisar. En cuanto publiques algo aparecerá aquí para ponerle título y
        descripción de Google.
      </p>
    );
  }

  return (
    <div className="hrr-seo">
      <div className="hrr-seo-barra">
        <span className="adm-small">
          {pendientes.length === 0 ? (
            <>Todo tiene título y descripción de la longitud correcta.</>
          ) : (
            <>
              <strong>{pendientes.length}</strong> de {filas.length} necesitan un repaso.
            </>
          )}
        </span>
        <label className="hrr-check">
          <input type="checkbox" checked={soloPendientes} onChange={(e) => setSoloPendientes(e.target.checked)} />
          Enseñar solo los que faltan
        </label>
      </div>

      <ul className="hrr-seo-lista">
        {visibles.map((item) => {
          const estadoTitulo = evaluar(item.seoTitle, limites.tituloMin, limites.tituloMax);
          const estadoDesc = evaluar(item.seoDescription, limites.descripcionMin, limites.descripcionMax);
          const editando = abierto === item.id;

          const tituloPrevio = (editando ? borrador.titulo : item.seoTitle).trim() || `${item.titulo} · ${nombreTienda}`;
          const descPrevia =
            (editando ? borrador.descripcion : item.seoDescription).trim() ||
            "Sin descripción: Google se inventará un trozo de la página, y casi nunca elige el bueno.";

          return (
            <li key={`${item.tipo}-${item.id}`} className="hrr-seo-fila">
              <div className="hrr-seo-cab">
                <div className="hrr-seo-quien">
                  <span className="hrr-seo-titulo">{item.titulo}</span>
                  <span className="hrr-seo-ruta">{item.ruta}</span>
                </div>
                <div className="hrr-seo-marcas">
                  <Badge tone={item.publico ? "success" : "neutral"}>{item.etiquetaEstado}</Badge>
                  <Badge tone={TONO[estadoTitulo]}>
                    Título: {PALABRA[estadoTitulo]} · {item.seoTitle.trim().length}
                  </Badge>
                  <Badge tone={TONO[estadoDesc]}>
                    Descripción: {PALABRA[estadoDesc]} · {item.seoDescription.trim().length}
                  </Badge>
                  <Button
                    type="button"
                    size="sm"
                    variant={editando ? "ghost" : "primary"}
                    onClick={() => (editando ? setAbierto(null) : abrir(item))}
                  >
                    {editando ? "Cerrar" : "Editar"}
                  </Button>
                </div>
              </div>

              {/* Vista previa: lo que verá quien busque en Google. */}
              <div className="hrr-google">
                <div className="hrr-google-url">
                  {base}
                  <span>{item.ruta}</span>
                </div>
                <div className="hrr-google-tit">{recortar(tituloPrevio, limites.tituloMax)}</div>
                <div className="hrr-google-desc">{recortar(descPrevia, limites.descripcionMax)}</div>
              </div>

              {editando ? (
                <div className="hrr-seo-editor">
                  <label className="adm-field-lbl" htmlFor={`t-${item.id}`}>
                    Título en Google
                  </label>
                  <input
                    id={`t-${item.id}`}
                    value={borrador.titulo}
                    maxLength={200}
                    placeholder={`${item.titulo} · ${nombreTienda}`}
                    onChange={(e) => setBorrador((b) => ({ ...b, titulo: e.target.value }))}
                  />
                  <div className={`hrr-contador is-${evaluar(borrador.titulo, limites.tituloMin, limites.tituloMax)}`}>
                    {borrador.titulo.trim().length} caracteres · lo ideal entre {limites.tituloMin} y {limites.tituloMax}
                  </div>

                  <label className="adm-field-lbl" htmlFor={`d-${item.id}`}>
                    Descripción en Google
                  </label>
                  <textarea
                    id={`d-${item.id}`}
                    rows={3}
                    maxLength={400}
                    value={borrador.descripcion}
                    placeholder="Una frase que dé ganas de entrar: qué es, para quién, y por qué merece el clic."
                    onChange={(e) => setBorrador((b) => ({ ...b, descripcion: e.target.value }))}
                  />
                  <div
                    className={`hrr-contador is-${evaluar(
                      borrador.descripcion,
                      limites.descripcionMin,
                      limites.descripcionMax,
                    )}`}
                  >
                    {borrador.descripcion.trim().length} caracteres · lo ideal entre {limites.descripcionMin} y{" "}
                    {limites.descripcionMax}
                  </div>

                  <div className="adm-row">
                    <Button type="button" size="sm" onClick={() => guardar(item)} disabled={guardando}>
                      {guardando ? "Guardando…" : "Guardar"}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAbierto(null)}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : null}

              {aviso && aviso.id === item.id ? (
                <p className={aviso.malo ? "hrr-err-inline" : "hrr-ok-inline"}>{aviso.texto}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {visibles.length === 0 ? <p className="hrr-pista">No queda ninguno pendiente. Bien hecho.</p> : null}
    </div>
  );
}
