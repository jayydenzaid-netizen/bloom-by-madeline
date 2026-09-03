import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import type {
  ContenidoBanner,
  ContenidoBoutique,
  ContenidoCita,
  ContenidoColeccion,
  ContenidoComoComprar,
  ContenidoExclusividad,
  ContenidoFilosofia,
  ContenidoHero,
  ContenidoInstagram,
  ContenidoMarquee,
  ContenidoVisitanos,
} from "@/lib/home-content";
import { formatCents } from "@/lib/money";
import ProductCard, { type ProductCardItem } from "./ProductCard";

/**
 * Las secciones editoriales de la portada, portadas una a una desde
 * `legacy/index.html`. El marcado es deliberadamente idéntico al del sitio que
 * está en producción: las clases (`.hero`, `.marquee`, `.paso`…) ya existen en
 * `globals.css` y ese CSS costó meses de pulido, así que aquí no se reinventa
 * nada.
 *
 * Lo que cambió: los textos y las fotos ya NO están escritos aquí dentro. Llegan
 * en `contenido`, que sale de `lib/home-content.ts` (los valores de siempre) con
 * encima lo que Madeline haya escrito en /admin/contenido. Este fichero solo
 * sabe PINTAR; qué se pinta lo decide el contenido.
 *
 * Todo son Server Components: la portada no necesita ni una línea de JavaScript
 * propio. Lo poco que se mueve (revelado al hacer scroll, nav sólida, cajón del
 * carrito) ya lo pone el proveedor del layout.
 */

/** Espacio fino (U+2009): separa las letras de "B L O O M" sin romper la palabra.
 *  Se escribe escapado porque un carácter invisible se pierde en cualquier copia. */
const FINO = " ";

/* ═══════════ FORMATO DE TEXTO ═══════════ */

/**
 * El mini-formato que puede escribir Madeline en el panel:
 *
 *   · un salto de línea  → un renglón nuevo (`<br>`),
 *   · `*algo*`           → cursiva (la serif elegante cuando es un titular),
 *   · `**algo**`         → negrita.
 *
 * No se interpreta HTML a propósito: lo que ella escribe se pinta como TEXTO,
 * así que pegar `<script>` desde cualquier sitio no puede hacer nada. Por eso
 * aquí no hay ni un `dangerouslySetInnerHTML`.
 */
type Enfasis = "titular" | "texto";

function conFormato(valor: string, enfasis: Enfasis = "texto"): ReactNode {
  const lineas = valor.split("\n");
  return lineas.map((linea, i) => (
    <Fragment key={i}>
      {i > 0 ? <br /> : null}
      {trozos(linea, enfasis)}
    </Fragment>
  ));
}

function trozos(linea: string, enfasis: Enfasis): ReactNode[] {
  const salida: ReactNode[] = [];
  const marcas = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let desde = 0;
  let m: RegExpExecArray | null;

  while ((m = marcas.exec(linea)) !== null) {
    if (m.index > desde) salida.push(linea.slice(desde, m.index));
    if (m[1] !== undefined) {
      salida.push(<strong key={m.index}>{m[1]}</strong>);
    } else {
      // En los titulares la cursiva es la serif de la marca; en un párrafo
      // corriente es un énfasis normal, exactamente como en el sitio de hoy.
      salida.push(
        <em key={m.index} className={enfasis === "titular" ? "serif-it" : undefined}>
          {m[2]}
        </em>,
      );
    }
    desde = m.index + m[0].length;
  }
  if (desde < linea.length) salida.push(linea.slice(desde));
  return salida;
}

/* ═══════════ PRELOADER ═══════════ */

/**
 * Telón de marca del primer pintado.
 *
 * Se apaga SOLO con CSS (ver `home.css`): el del sitio viejo dependía de un
 * `window.onload` en JavaScript, y un telón a pantalla completa que depende de JS
 * es exactamente la receta del P0 que ya se sufrió aquí. Además va con
 * `pointer-events: none` desde el primer frame, así que aunque alguien lo dejara
 * visible para siempre, la tienda seguiría siendo clicable.
 */
export function Preloader() {
  return (
    <div className="preloader home-preloader" aria-hidden="true">
      <div className="preloader-inner">
        <svg className="preloader-lotus" viewBox="0 0 120 104" fill="none" aria-hidden="true">
          <use href="#lotus" />
        </svg>
        <span className="preloader-word">
          B{FINO}L{FINO}O{FINO}O{FINO}M
        </span>
      </div>
    </div>
  );
}

/* ═══════════ HERO ═══════════ */

export function Hero({
  contenido,
  marquee,
  igUrl,
  igHandle,
}: {
  contenido: ContenidoHero;
  marquee: ContenidoMarquee;
  igUrl: string;
  igHandle: string;
}) {
  return (
    <section className="hero">
      <svg className="hero-watermark" viewBox="0 0 120 104" aria-hidden="true">
        <use href="#lotus" />
      </svg>

      <div className="hero-grid">
        {/* En móvil `.hero-copy` es `display: contents` y estos hijos se reordenan
            para que la FOTO aparezca antes del texto largo. Por eso no se pueden
            envolver en más divs: romperían ese orden. */}
        <div className="hero-copy">
          <p className="overline reveal">{contenido.overline}</p>
          <h1 className="hero-title">{renglonesDelTitular(contenido.titulo)}</h1>
          <p className="hero-sub reveal">{conFormato(contenido.parrafo)}</p>
          <div className="hero-ctas reveal">
            <Link className="btn btn-ink" href={contenido.ctaUrl}>
              {contenido.ctaLabel}
            </Link>
            <a className="btn btn-ghost" href={igUrl} target="_blank" rel="noopener">
              @{igHandle}
            </a>
          </div>
          <ul className="hero-stats reveal">
            {contenido.datos.map((dato) => (
              <li key={dato.valor + dato.etiqueta}>
                <strong>{dato.valor}</strong>
                <span>{dato.etiqueta}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="hero-visual">
          {/* `data-parallax` lo leía main.js en el sitio viejo. Se conserva como
              contrato del efecto por si vuelve, pero el hero ya vive sin él: el
              movimiento que de verdad se nota es el Ken Burns, que es CSS. */}
          <figure className="hero-arch" data-parallax="0.06">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img src={contenido.foto.url} alt={contenido.foto.alt} loading="eager" />
          </figure>
          <figure className="hero-polaroid" data-parallax="0.12">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img src={contenido.polaroid.url} alt={contenido.polaroid.alt} />
          </figure>
          <div className="hero-badge" aria-hidden="true">
            <svg viewBox="0 0 100 100">
              <defs>
                <path id="circlePath" d="M50,50 m-37,0 a37,37 0 1,1 74,0 a37,37 0 1,1 -74,0" />
              </defs>
              <text>
                <textPath href="#circlePath">{contenido.insignia}</textPath>
              </text>
            </svg>
            <svg className="badge-lotus" viewBox="0 0 120 104">
              <use href="#lotus" />
            </svg>
          </div>
          <span className="hero-pill">
            <i aria-hidden="true">✿</i> {contenido.pastilla}
          </span>
        </div>
      </div>

      {marquee.visible ? <Marquee frases={marquee.frases} /> : null}
    </section>
  );
}

/**
 * El titular grande: un renglón por línea. Una línea entera marcada con
 * asteriscos se pinta en la cursiva serif —es el remate del diseño— y lo hace
 * con la clase en el propio `<span>` de la línea, que es como está hoy en
 * producción y como lo esperan las animaciones de `globals.css`.
 */
function renglonesDelTitular(titulo: string): ReactNode {
  return titulo.split("\n").map((linea, i) => {
    const entera = /^\*([^*]+)\*$/.exec(linea.trim());
    return (
      <span className="line" key={i}>
        {entera ? (
          <span className="serif-it">{entera[1]}</span>
        ) : (
          <span>{trozos(linea, "titular")}</span>
        )}
      </span>
    );
  });
}

/** Cinta que corre bajo el hero. Es decorativa: `aria-hidden` y texto duplicado
 *  para que el bucle no enseñe el corte. */
function Marquee({ frases }: { frases: string[] }) {
  // La animación desplaza el track un 50%: la lista tiene que ir DUPLICADA
  // exacta o el bucle daría un salto visible al reiniciarse.
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {[...frases, ...frases].map((frase, i) => (
          // El ✿ es hermano del texto, no hijo: la cinta es un flex con gap y
          // meterlo dentro del span se comería la separación.
          <Fragment key={`${frase}-${i}`}>
            <span>{frase}</span>
            <i>✿</i>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/* ═══════════ COLECCIÓN ═══════════ */

/** Foto de una prenda todavía sin precio: se enseña como inspiración, nunca como
 *  producto comprable. */
export type InspiracionItem = {
  imageUrl: string;
  imageAlt: string;
  title: string;
  meta: string | null;
};

/**
 * "01 — La Colección". Tiene dos caras y las dos tienen que verse dignas:
 *
 *  · con productos publicados → rejilla real que lleva a cada ficha;
 *  · sin ninguno → galería de inspiración que lleva al DM, que es exactamente
 *    como vende hoy la boutique. Una rejilla vacía nunca es una opción.
 */
export function Coleccion({
  contenido,
  productos,
  inspiracion,
}: {
  contenido: ContenidoColeccion;
  productos: ProductCardItem[];
  inspiracion: InspiracionItem[];
}) {
  const hayTienda = productos.length > 0;

  return (
    <section className="section coleccion" id="coleccion">
      <div className="section-head">
        <div>
          <p className="overline reveal">{contenido.overline}</p>
          <h2 className="reveal">{conFormato(contenido.titulo, "titular")}</h2>
        </div>
        <p className="section-note reveal">{conFormato(contenido.nota)}</p>
      </div>

      {hayTienda ? (
        <>
          {/* Las tarjetas son hijas DIRECTAS de la rejilla: el marco pétalo
              alterna con :nth-child(even) y un div intermedio rompería el ritmo. */}
          <div className="product-grid">
            {productos.map((p) => (
              <ProductCard key={p.slug} product={p} />
            ))}
          </div>

          {/* El sitio viejo remataba mandando al DM porque no había tienda. Ahora
              sí la hay, así que el remate lleva al catálogo completo. */}
          <div className="coleccion-cta reveal">
            <p>{contenido.tiendaNota}</p>
            <Link className="btn btn-ink" href={contenido.tiendaUrl}>
              {contenido.tiendaLabel}
            </Link>
          </div>
        </>
      ) : (
        <>
          {inspiracion.length > 0 ? (
            <div className="product-grid">
              {inspiracion.map((pieza) => (
                <a
                  className="product product-insp reveal"
                  key={pieza.imageUrl + pieza.title}
                  href={contenido.dmUrl}
                  target="_blank"
                  rel="noopener"
                >
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
                    <img src={pieza.imageUrl} alt={pieza.imageAlt} loading="lazy" />
                    <figcaption>
                      <span>Preguntar por DM</span>
                    </figcaption>
                  </figure>
                  <h3>{pieza.title}</h3>
                  {pieza.meta ? <p className="product-meta">{pieza.meta}</p> : null}
                  {/* Sin precio no se inventa nada: se dice cómo conseguirlo. */}
                  <p className="pc-price">
                    <em>Consulta el precio por DM</em>
                  </p>
                </a>
              ))}
            </div>
          ) : null}

          <div className="coleccion-cta reveal">
            <p>{contenido.dmNota}</p>
            <a className="btn btn-ink" href={contenido.dmUrl} target="_blank" rel="noopener">
              {contenido.dmLabel}
            </a>
          </div>
        </>
      )}
    </section>
  );
}

/* ═══════════ CITA ═══════════ */

export function Cita({ contenido }: { contenido: ContenidoCita }) {
  return (
    <section className="quote">
      <svg className="quote-lotus reveal" viewBox="0 0 120 104" aria-hidden="true">
        <use href="#lotus" />
      </svg>
      <blockquote className="reveal">{conFormato(contenido.texto)}</blockquote>
    </section>
  );
}

/* ═══════════ FILOSOFÍA ═══════════ */

export function Filosofia({ contenido }: { contenido: ContenidoFilosofia }) {
  return (
    <section className="section filosofia" id="filosofia">
      <div className="filosofia-grid">
        <div className="filosofia-copy">
          <p className="overline overline-light reveal">{contenido.overline}</p>
          <h2 className="reveal">{conFormato(contenido.titulo, "titular")}</h2>
          {contenido.intro ? (
            <p className="filosofia-sub reveal">{conFormato(contenido.intro)}</p>
          ) : null}
          {contenido.texto ? (
            <p className="filosofia-text reveal">{conFormato(contenido.texto)}</p>
          ) : null}
        </div>
        <ol className="filosofia-list">
          {contenido.palabras.map((palabra, i) => (
            <li className="reveal" key={palabra}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              {palabra}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ═══════════ PIEZAS CONTADAS (escasez real) ═══════════ */

/** Una pieza a punto de agotarse, con las unidades que quedan DE VERDAD. */
export type PiezaEscasa = {
  slug: string;
  title: string;
  imageUrl: string | null;
  priceCents: number;
  compareAtCents: number | null;
  /** Unidades que quedan sumando todas las tallas. */
  quedan: number;
  /** Tallas que aún tienen alguna unidad: "S · M". */
  tallas: string;
};

/**
 * Escasez HONESTA: los números salen del inventario, no de un contador
 * inventado que baja solo. Si Madeline repone, el bloque desaparece; si no
 * queda nada por debajo del umbral, tampoco se pinta. Un «¡solo quedan 2!»
 * falso se nota y quema la confianza de la clienta, que es justo lo que esta
 * boutique no se puede permitir.
 */
export function Exclusividad({
  contenido,
  piezas,
}: {
  contenido: ContenidoExclusividad;
  piezas: PiezaEscasa[];
}) {
  if (piezas.length === 0) return null;

  return (
    <section className="section escasez" id="escasez">
      <div className="section-head">
        <div>
          <p className="overline reveal">{contenido.overline}</p>
          <h2 className="reveal">{conFormato(contenido.titulo, "titular")}</h2>
        </div>
        <p className="section-note reveal">{conFormato(contenido.intro)}</p>
      </div>

      <ul className="escasez-grid">
        {piezas.map((p) => {
          const ultima = p.quedan === 1;
          const rebajado = !!p.compareAtCents && p.compareAtCents > p.priceCents;
          return (
            <li className="escasez-item reveal" key={p.slug}>
              <Link href={`/producto/${p.slug}`}>
                <span className="escasez-foto">
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- fotos del almacén de la tienda
                    <img src={p.imageUrl} alt={p.title} loading="lazy" />
                  ) : (
                    <span className="cd-noimg" aria-hidden="true" />
                  )}
                  <span className={ultima ? "escasez-sello es-ultima" : "escasez-sello"}>
                    {ultima ? "Última unidad" : `Quedan ${p.quedan}`}
                  </span>
                </span>

                <h3>{p.title}</h3>
                <p className="escasez-tallas">{p.tallas}</p>
                <p className="escasez-precio">
                  {rebajado ? <s>{formatCents(p.compareAtCents as number)}</s> : null}
                  <strong>{formatCents(p.priceCents)}</strong>
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ═══════════ LA BOUTIQUE ═══════════ */

export function Boutique({ contenido }: { contenido: ContenidoBoutique }) {
  return (
    <section className="section boutique" id="boutique">
      <div className="boutique-grid">
        <div className="boutique-visual">
          <figure className="boutique-main reveal" data-parallax="0.05">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img src={contenido.foto.url} alt={contenido.foto.alt} loading="lazy" />
          </figure>
          <figure className="boutique-small reveal">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img src={contenido.fotoPequena.url} alt={contenido.fotoPequena.alt} loading="lazy" />
          </figure>
        </div>
        <div className="boutique-copy">
          <p className="overline reveal">{contenido.overline}</p>
          <h2 className="reveal">{conFormato(contenido.titulo, "titular")}</h2>
          <p className="reveal">{conFormato(contenido.texto)}</p>
          <ul className="boutique-features">
            {contenido.ventajas.map((v) => (
              <li className="reveal" key={v.titulo}>
                <strong>{v.titulo}</strong>
                {v.texto}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ═══════════ CÓMO COMPRAR ═══════════ */

export function ComoComprar({ contenido }: { contenido: ContenidoComoComprar }) {
  return (
    <section className="section como-comprar">
      <div className="section-head">
        <div>
          <p className="overline reveal">{contenido.overline}</p>
          <h2 className="reveal">{conFormato(contenido.titulo, "titular")}</h2>
        </div>
      </div>
      <div className="pasos">
        {contenido.pasos.map((paso, i) => (
          <div className="paso reveal" key={paso.titulo}>
            <svg className="paso-lotus" viewBox="0 0 120 104" aria-hidden="true">
              <use href="#lotus" />
            </svg>
            <span className="paso-num">{String(i + 1).padStart(2, "0")}</span>
            <h3>{paso.titulo}</h3>
            {/* La dirección y el horario del primer paso salen de Ajustes: si
                Madeline los cambia allí, cambian aquí sin tocar código. */}
            <p>{conFormato(paso.texto)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══════════ VISÍTANOS ═══════════ */

export function Visitanos({
  contenido,
  address,
  hours,
  igHandle,
  mapEmbedUrl,
}: {
  contenido: ContenidoVisitanos;
  address: string;
  hours: string;
  igHandle: string;
  /** `null` cuando la dirección ya no es la que tiene coordenadas conocidas:
   *  antes que enseñar un mapa que apunta a otro sitio, no se enseña mapa. */
  mapEmbedUrl: string | null;
}) {
  const [direccion, ...restoDireccion] = address.split(",");
  const [horarioDias, ...restoHorario] = hours.split("·");

  return (
    <section className="section visitanos" id="visitanos">
      <div className="visitanos-grid">
        <div className="visitanos-card reveal">
          <p className="overline">{contenido.overline}</p>
          <h2>{conFormato(contenido.titulo, "titular")}</h2>
          <dl className="visitanos-info">
            <div>
              <dt>Dirección</dt>
              {/* La dirección se parte por la coma para conservar las dos líneas
                  del diseño original sin exigir un formato concreto en Ajustes. */}
              <dd>
                {direccion.trim()}
                {restoDireccion.length > 0 ? (
                  <>
                    <br />
                    {restoDireccion.join(",").trim()}
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Horario</dt>
              <dd>
                {horarioDias.trim()}
                {restoHorario.length > 0 ? (
                  <>
                    <br />
                    {restoHorario.join("·").trim()}
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>Pedidos &amp; Envíos</dt>
              <dd>
                Instagram DM
                <br />@{igHandle}
              </dd>
            </div>
          </dl>
          <div className="visitanos-ctas">
            <a className="btn btn-ink" href={contenido.mapaUrl} target="_blank" rel="noopener">
              {contenido.mapaLabel}
            </a>
            <a className="btn btn-ghost" href={contenido.dmUrl} target="_blank" rel="noopener">
              {contenido.dmLabel}
            </a>
          </div>
          <p className="visitanos-note">{conFormato(contenido.nota)}</p>
        </div>

        {mapEmbedUrl ? (
          <a
            className="visitanos-map reveal"
            href={contenido.mapaUrl}
            target="_blank"
            rel="noopener"
            aria-label={`Abrir en Google Maps: ${address}`}
          >
            <iframe
              title={`Mapa de la boutique Bloom by Madeline en ${address}`}
              src={mapEmbedUrl}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
            <span className="map-pin" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" />
              </svg>
            </span>
            <span className="map-cta">Ver en el mapa →</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}

/* ═══════════ INSTAGRAM ═══════════ */

/**
 * Fotos reales de sus publicaciones, ya en el repo, y ahora editables desde el
 * panel. No es un feed en vivo: la API de Instagram exige una app aprobada y la
 * boutique no la tiene.
 */
export function InstagramGrid({ contenido }: { contenido: ContenidoInstagram }) {
  return (
    <section className="section instagram">
      <div className="ig-head reveal">
        <p className="overline">{contenido.overline}</p>
        <h2>{conFormato(contenido.titulo, "titular")}</h2>
        <p className="ig-sub">{conFormato(contenido.subtitulo)}</p>
      </div>
      <div className="ig-grid">
        {contenido.fotos.map((foto) => (
          <a
            className="reveal"
            key={foto.url}
            href={contenido.ctaUrl}
            target="_blank"
            rel="noopener"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img src={foto.url} alt={foto.alt} loading="lazy" />
          </a>
        ))}
      </div>
      <div className="ig-cta reveal">
        <a className="btn btn-ink" href={contenido.ctaUrl} target="_blank" rel="noopener">
          {contenido.ctaLabel}
        </a>
      </div>
    </section>
  );
}

/* ═══════════ FRANJA DE AVISO ═══════════ */

/**
 * La tira para anunciar algo puntual (rebajas, horario especial). No existe en
 * el sitio de hoy: nace apagada y en blanco, así que mientras Madeline no
 * escriba nada aquí no se pinta absolutamente nada.
 *
 * Usa solo clases que ya existen (`.section`, `.overline`, `.btn`): el módulo no
 * puede tocar `globals.css`, y una sección con CSS inventado a medias se vería
 * peor que no tenerla.
 */
export function Banner({ contenido }: { contenido: ContenidoBanner }) {
  if (!contenido.texto && !contenido.linkLabel) return null;

  return (
    <section className="section banner-aviso" style={{ textAlign: "center" }}>
      {contenido.texto ? <p className="overline reveal">{conFormato(contenido.texto)}</p> : null}
      {contenido.linkLabel && contenido.linkUrl ? (
        <Link className="btn btn-ghost" href={contenido.linkUrl}>
          {contenido.linkLabel}
        </Link>
      ) : null}
    </section>
  );
}
