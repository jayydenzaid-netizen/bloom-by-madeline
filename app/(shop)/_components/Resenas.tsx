import Estrellas from "./Estrellas";
import type { ResumenPuntuacion } from "@/lib/reviews";
import "../resenas.css";

/**
 * Reseñas en el escaparate.
 *
 * Madeline modera en `/admin/reseñas` y hasta ahora eso no llegaba a ninguna
 * parte: aprobaba y la tienda seguía sin enseñar nada. Este componente es el
 * otro extremo del cable.
 *
 * Dos reglas mandan sobre el diseño:
 *
 *  1. **Solo aprobadas.** Quien llama pasa ya la lista filtrada (`resenasAprobadas`
 *     de `lib/reviews`); aquí no hay ninguna forma de colar una pendiente.
 *  2. **Sin reseñas no hay sección.** Nada de "0 valoraciones" ni de bloque
 *     vacío: una ficha que anuncia que nadie ha opinado vende menos que una que
 *     no menciona el tema. Los dos componentes devuelven `null` y la página
 *     queda EXACTAMENTE como estaba antes de existir este fichero.
 *
 * Server Component: no hay estado ni eventos, es marcado. `Estrellas` tampoco
 * lleva "use client", así que nada de esto viaja como JavaScript.
 */

export type ResenaVista = {
  id: string;
  authorName: string;
  rating: number;
  title: string;
  body: string;
  source: string;
  isVerified: boolean;
  createdAt: Date;
};

/** Mismo locale que `formatCents`: textos en español, números a la americana. */
const NOTA = new Intl.NumberFormat("es-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const MES = new Intl.DateTimeFormat("es-US", { month: "long", year: "numeric", timeZone: "UTC" });

function plural(total: number): string {
  return total === 1 ? "reseña" : "reseñas";
}

/**
 * Resumen compacto para poner junto al precio o bajo la descripción: estrellas,
 * nota y enlace al bloque de abajo. Es el sitio donde una valoración convierte,
 * porque se lee antes de decidir la talla.
 */
export function ResumenResenas({ resumen }: { resumen: ResumenPuntuacion }) {
  if (resumen.total <= 0) return null;

  return (
    <a className="rs-mini" href="#resenas">
      <Estrellas valor={resumen.media} tamano="md" mostrarNumero={false} />
      <span className="rs-mini-txt">
        {NOTA.format(resumen.media)} · {resumen.total} {plural(resumen.total)}
      </span>
    </a>
  );
}

/** Bloque completo: nota media grande y las reseñas aprobadas, una a una. */
export default function Resenas({
  resumen,
  resenas,
}: {
  resumen: ResumenPuntuacion;
  resenas: ResenaVista[];
}) {
  // El resumen y la lista salen de la misma consulta filtrada por "approved",
  // pero si por lo que fuera llegara un resumen con total > 0 y cero reseñas
  // que enseñar, pintar la cabecera sola sería peor que no pintar nada.
  if (resenas.length === 0 || resumen.total <= 0) return null;

  return (
    <section className="rs reveal" id="resenas" aria-labelledby="rs-titulo">
      <div className="section-head">
        <div>
          <p className="overline">Lo que dicen</p>
          <h2 id="rs-titulo">
            Reseñas de <span className="serif-it">clientas</span>
          </h2>
        </div>

        <div className="rs-nota">
          <span className="rs-nota-num">{NOTA.format(resumen.media)}</span>
          <span className="rs-nota-detalle">
            <Estrellas valor={resumen.media} tamano="lg" mostrarNumero={false} />
            <span className="rs-nota-txt">
              {resumen.total} {plural(resumen.total)} · sobre 5
            </span>
          </span>
        </div>
      </div>

      <div className="rs-lista">
        {resenas.map((resena) => (
          <article className="rs-card" key={resena.id}>
            <header className="rs-card-cab">
              <Estrellas
                valor={resena.rating}
                tamano="sm"
                mostrarNumero={false}
                className="rs-card-estrellas"
              />
              <span className="rs-card-fecha">{MES.format(resena.createdAt)}</span>
            </header>

            {resena.title ? <h3 className="rs-card-titulo">{resena.title}</h3> : null}
            {resena.body ? <p className="rs-card-texto">{resena.body}</p> : null}

            <footer className="rs-card-pie">
              <span className="rs-card-autora">{resena.authorName}</span>
              {/* Solo se etiqueta el origen cuando decirlo aporta contexto real a
                  la compradora. "Mostrador / a mano" es vocabulario del panel: en
                  la tienda no significa nada y parecería una excusa. */}
              {resena.source === "instagram" ? <span className="rs-card-chip">Instagram</span> : null}
              {resena.isVerified ? <span className="rs-card-chip es-ok">Compra verificada</span> : null}
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}
