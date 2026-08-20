import { Fragment } from "react";
import Link from "next/link";
import ProductCard, { type ProductCardItem } from "./ProductCard";

/**
 * Las secciones editoriales de la portada, portadas una a una desde
 * `legacy/index.html`. El marcado es deliberadamente idéntico al del sitio que
 * está en producción: las clases (`.hero`, `.marquee`, `.paso`…) ya existen en
 * `globals.css` y ese CSS costó meses de pulido, así que aquí no se reinventa
 * nada — solo se sustituyen los datos escritos a mano por los de la tienda.
 *
 * Todo son Server Components: la portada no necesita ni una línea de JavaScript
 * propio. Lo poco que se mueve (revelado al hacer scroll, nav sólida, cajón del
 * carrito) ya lo pone el proveedor del layout.
 */

/** Espacio fino: separa las letras de "B L O O M" sin romper la palabra. */
const FINO = " ";
/** Espacio duro para que "casual elegante" y "para ti" no se partan en dos líneas. */
const DURO = " ";

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
  igUrl,
  igHandle,
  address,
}: {
  igUrl: string;
  igHandle: string;
  address: string;
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
          <p className="overline reveal">Boutique de moda femenina · Hamilton, Ohio</p>
          <h1 className="hero-title">
            <span className="line">
              <span>Elevamos</span>
            </span>
            <span className="line">
              <span>tu estilo</span>
            </span>
            <span className="line">
              <span className="serif-it">casual{DURO}elegante.</span>
            </span>
          </h1>
          <p className="hero-sub reveal">
            Tendencias exclusivas seleccionadas a mano, nuevas llegadas cada semana y una atención
            que se siente como ir de compras con tu mejor amiga.
          </p>
          <div className="hero-ctas reveal">
            <Link className="btn btn-ink" href="/#coleccion">
              Ver nuevas llegadas
            </Link>
            <a className="btn btn-ghost" href={igUrl} target="_blank" rel="noopener">
              @{igHandle}
            </a>
          </div>
          <ul className="hero-stats reveal">
            <li>
              <strong>2,880+</strong>
              <span>seguidoras</span>
            </li>
            <li>
              <strong>S · M · L</strong>
              <span>tallas disponibles</span>
            </li>
            <li>
              <strong>USA</strong>
              <span>envíos a todo el país</span>
            </li>
          </ul>
        </div>

        <div className="hero-visual">
          {/* `data-parallax` lo leía main.js en el sitio viejo. Se conserva como
              contrato del efecto por si vuelve, pero el hero ya vive sin él: el
              movimiento que de verdad se nota es el Ken Burns, que es CSS. */}
          <figure className="hero-arch" data-parallax="0.06">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img
              src="/assets/post-03-vestido-negro-olivo.jpg"
              alt="Vestido midi a rayas oliva y crema en maniquí dentro de la boutique Bloom by Madeline"
              loading="eager"
            />
          </figure>
          <figure className="hero-polaroid" data-parallax="0.12">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img src="/assets/post-05-vestido-blanco.jpg" alt="Vestido mini verde lima en la boutique" />
          </figure>
          <div className="hero-badge" aria-hidden="true">
            <svg viewBox="0 0 100 100">
              <defs>
                <path id="circlePath" d="M50,50 m-37,0 a37,37 0 1,1 74,0 a37,37 0 1,1 -74,0" />
              </defs>
              <text>
                <textPath href="#circlePath">ENVÍOS A TODO USA · BLOOM ·</textPath>
              </text>
            </svg>
            <svg className="badge-lotus" viewBox="0 0 120 104">
              <use href="#lotus" />
            </svg>
          </div>
          <span className="hero-pill">
            <i aria-hidden="true">✿</i> Nuevas llegadas esta semana
          </span>
        </div>
      </div>

      <Marquee address={address} />
    </section>
  );
}

/** Cinta que corre bajo el hero. Es decorativa: `aria-hidden` y texto duplicado
 *  para que el bucle no enseñe el corte. */
function Marquee({ address }: { address: string }) {
  const items = [
    "Nuevas llegadas cada semana",
    "Tallas S · M · L",
    "Envíos a todo USA",
    "Pedidos por Instagram DM",
    // La dirección la manda Ajustes; las comas se vuelven puntos medios para
    // que respire igual que el resto de la cinta.
    address.replace(/,\s*/g, " · "),
  ];

  // La animación desplaza el track un 50%: la lista tiene que ir DUPLICADA
  // exacta o el bucle daría un salto visible al reiniciarse.
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {[...items, ...items].map((texto, i) => (
          // El ✿ es hermano del texto, no hijo: la cinta es un flex con gap y
          // meterlo dentro del span se comería la separación.
          <Fragment key={`${texto}-${i}`}>
            <span>{texto}</span>
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
  productos,
  inspiracion,
  dmUrl,
}: {
  productos: ProductCardItem[];
  inspiracion: InspiracionItem[];
  dmUrl: string;
}) {
  const hayTienda = productos.length > 0;

  return (
    <section className="section coleccion" id="coleccion">
      <div className="section-head">
        <div>
          <p className="overline reveal">01 — La Colección</p>
          <h2 className="reveal">
            Nuevas <em className="serif-it">llegadas</em>
          </h2>
        </div>
        <p className="section-note reveal">
          Cada pieza nombrada como una flor,
          <br />
          porque aquí todo florece.
          <br />
          <strong>Pedidos por DM · respuesta el mismo día.</strong>
        </p>
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
            <p>Esto es solo una parte — en la tienda está todo.</p>
            <Link className="btn btn-ink" href="/tienda">
              Ver toda la tienda
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
                  href={dmUrl}
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
            <p>¿Viste algo en nuestro Instagram que te enamoró?</p>
            <a className="btn btn-ink" href={dmUrl} target="_blank" rel="noopener">
              Escríbenos por DM y te lo apartamos
            </a>
          </div>
        </>
      )}
    </section>
  );
}

/* ═══════════ CITA ═══════════ */

export function Cita() {
  return (
    <section className="quote">
      <svg className="quote-lotus reveal" viewBox="0 0 120 104" aria-hidden="true">
        <use href="#lotus" />
      </svg>
      <blockquote className="reveal">
        «{FINO}Cada prenda cuenta una historia…
        <br />
        <em>haz que la tuya brille con estilo.</em>
        {FINO}»
      </blockquote>
    </section>
  );
}

/* ═══════════ FILOSOFÍA ═══════════ */

export function Filosofia() {
  return (
    <section className="section filosofia" id="filosofia">
      <div className="filosofia-grid">
        <div className="filosofia-copy">
          <p className="overline overline-light reveal">02 — Nuestra Filosofía</p>
          <h2 className="reveal">
            Vestir con <em className="serif-it">intención</em>
          </h2>
          <p className="filosofia-sub reveal">(No es moda… es presencia.)</p>
          <p className="filosofia-text reveal">
            En Bloom no seguimos tendencias por seguirlas. Seleccionamos cada pieza pensando en la
            mujer que la va a llevar: su día, su cuerpo, su momento. Porque cuando te vistes con
            intención, no entras a un lugar — <em>floreces en él</em>.
          </p>
        </div>
        <ol className="filosofia-list">
          <li className="reveal">
            <span>01</span>Coherencia
          </li>
          <li className="reveal">
            <span>02</span>Identidad
          </li>
          <li className="reveal">
            <span>03</span>Presencia
          </li>
          <li className="reveal">
            <span>04</span>Intención
          </li>
        </ol>
      </div>
    </section>
  );
}

/* ═══════════ LA BOUTIQUE ═══════════ */

export function Boutique() {
  return (
    <section className="section boutique" id="boutique">
      <div className="boutique-grid">
        <div className="boutique-visual">
          <figure className="boutique-main reveal" data-parallax="0.05">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img
              src="/assets/boutique-interior.jpg"
              alt="Interior de la boutique Bloom by Madeline: logo de loto en la pared y mostrador"
              loading="lazy"
            />
          </figure>
          <figure className="boutique-small reveal">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img
              src="/assets/post-09-coleccion-exclusiva.jpg"
              alt="Escaparate de Bloom by Madeline con letrero de neón OPEN"
              loading="lazy"
            />
          </figure>
        </div>
        <div className="boutique-copy">
          <p className="overline reveal">03 — La Boutique</p>
          <h2 className="reveal">
            Un espacio pensado <em className="serif-it">para{DURO}ti</em>
          </h2>
          <p className="reveal">
            En pleno Grand Blvd de Hamilton, nuestra boutique es ese lugar donde entras «solo a
            mirar» y sales sintiéndote otra. Pruébate todo, pide opinión y deja que armemos tu
            outfit juntas.
          </p>
          <ul className="boutique-features">
            <li className="reveal">
              <strong>Atención personalizada</strong>Te ayudamos a encontrar tu look, sin prisa y sin
              presión.
            </li>
            <li className="reveal">
              <strong>Pruébatelo antes de llevarlo</strong>Probador en tienda para que salgas segura
              de tu compra.
            </li>
            <li className="reveal">
              <strong>Nuevas llegadas semanales</strong>Cada semana llegan piezas nuevas — y vuelan
              rápido.
            </li>
            <li className="reveal">
              <strong>Apartados por DM</strong>¿La viste en Instagram? Escríbenos y te la
              reservamos.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ═══════════ CÓMO COMPRAR ═══════════ */

export function ComoComprar({ address, hours }: { address: string; hours: string }) {
  return (
    <section className="section como-comprar">
      <div className="section-head">
        <div>
          <p className="overline reveal">04 — Cómo Comprar</p>
          <h2 className="reveal">
            Tan fácil como <em className="serif-it">enamorarse</em>
          </h2>
        </div>
      </div>
      <div className="pasos">
        <div className="paso reveal">
          <svg className="paso-lotus" viewBox="0 0 120 104" aria-hidden="true">
            <use href="#lotus" />
          </svg>
          <span className="paso-num">01</span>
          <h3>Visítanos en la boutique</h3>
          {/* Dirección y horario salen de Ajustes: si Madeline los cambia en el
              panel, cambian aquí sin tocar código. */}
          <p>
            {address}. Pruébate todo lo que quieras — {hours.toLowerCase()}.
          </p>
        </div>
        <div className="paso reveal">
          <svg className="paso-lotus" viewBox="0 0 120 104" aria-hidden="true">
            <use href="#lotus" />
          </svg>
          <span className="paso-num">02</span>
          <h3>O pide por Instagram DM</h3>
          <p>
            ¿Viste una pieza en nuestro perfil? Mándanos un mensaje con la foto y tu talla, y te
            confirmamos al momento.
          </p>
        </div>
        <div className="paso reveal">
          <svg className="paso-lotus" viewBox="0 0 120 104" aria-hidden="true">
            <use href="#lotus" />
          </svg>
          <span className="paso-num">03</span>
          <h3>Envíos a todo USA</h3>
          <p>
            ¿No estás en Ohio? No importa. Hacemos envíos a todo Estados Unidos — tu look llega
            hasta tu puerta.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ═══════════ VISÍTANOS ═══════════ */

export function Visitanos({
  address,
  hours,
  igHandle,
  dmUrl,
  mapsUrl,
  mapEmbedUrl,
}: {
  address: string;
  hours: string;
  igHandle: string;
  dmUrl: string;
  mapsUrl: string;
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
          <p className="overline">05 — Visítanos</p>
          <h2>
            Te esperamos
            <br />
            en <em className="serif-it">Hamilton</em>
          </h2>
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
            <a className="btn btn-ink" href={mapsUrl} target="_blank" rel="noopener">
              Cómo llegar
            </a>
            <a className="btn btn-ghost" href={dmUrl} target="_blank" rel="noopener">
              Enviar DM
            </a>
          </div>
          <p className="visitanos-note">
            El horario puede variar — confírmalo siempre en nuestro Instagram.
          </p>
        </div>

        {mapEmbedUrl ? (
          <a
            className="visitanos-map reveal"
            href={mapsUrl}
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

/** Fotos reales de sus publicaciones, ya en el repo. No es un feed en vivo:
 *  la API de Instagram exige una app aprobada y la boutique no la tiene. */
const IG_POSTS = [
  { src: "/assets/post-02-tendencia.jpg", alt: "Publicación de Instagram: set de lunares" },
  { src: "/assets/post-08-look-perfecto.jpg", alt: "Publicación de Instagram: top de plumas lila" },
  { src: "/assets/post-10-vestido-orange.jpg", alt: "Publicación de Instagram: vestido naranja" },
  { src: "/assets/post-12-vestido-coral.jpg", alt: "Publicación de Instagram: vestido durazno" },
];

export function InstagramGrid({ igUrl, igHandle }: { igUrl: string; igHandle: string }) {
  return (
    <section className="section instagram">
      <div className="ig-head reveal">
        <p className="overline">Síguenos</p>
        <h2>
          <em className="serif-it">Enamórate</em> en Instagram
        </h2>
        <p className="ig-sub">
          Únete a más de <strong>2,880 seguidoras</strong> que ven las nuevas llegadas antes que
          nadie.
        </p>
      </div>
      <div className="ig-grid">
        {IG_POSTS.map((post) => (
          <a className="reveal" key={post.src} href={igUrl} target="_blank" rel="noopener">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto local servida tal cual, sin optimizador */}
            <img src={post.src} alt={post.alt} loading="lazy" />
          </a>
        ))}
      </div>
      <div className="ig-cta reveal">
        <a className="btn btn-ink" href={igUrl} target="_blank" rel="noopener">
          Seguir a @{igHandle}
        </a>
      </div>
    </section>
  );
}
