import { Fragment, type ReactNode } from "react";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { cargarPortada, type KindOrdenable } from "@/lib/home-content";
import { DEFAULT_SETTINGS, getSettings, type StoreSettings } from "@/lib/settings";
import { type ProductCardItem } from "./_components/ProductCard";
import {
  Banner,
  Boutique,
  Cita,
  Coleccion,
  ComoComprar,
  Filosofia,
  Hero,
  InstagramGrid,
  Preloader,
  Visitanos,
  type InspiracionItem,
} from "./_components/HomeSections";
import "./home.css";

/**
 * Portada.
 *
 * Es el mismo sitio editorial que está en producción (`legacy/index.html`), pero
 * ya no lleva nada escrito a fuego:
 *
 *  · las prendas salen del catálogo,
 *  · los datos del negocio —dirección, horario, Instagram— salen de Ajustes,
 *  · y los textos y fotos del escaparate salen de /admin/contenido, con el
 *    contenido de siempre como valor por defecto (ver `lib/home-content.ts`).
 *
 * Con la tabla de bloques vacía esta página se pinta EXACTAMENTE igual que
 * antes: la portada nunca depende de que haya algo configurado.
 *
 * La página entera es Server Component. El único JavaScript de la portada es el
 * del layout (cajón del carrito, revelado al hacer scroll): ni el preloader lo
 * necesita.
 */

/** Cuántas piezas caben en la portada antes de mandar a /tienda: dos filas de 4. */
const MAX_EN_PORTADA = 8;

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://bloom-by-madeline.vercel.app";

/**
 * Coordenadas reales de la boutique, tal y como estaban en el sitio viejo.
 * Solo se usan mientras la dirección de Ajustes siga siendo esa: un mapa que
 * apunta a otra calle es peor que no tener mapa.
 */
const GEO = { lat: 39.3819428, lon: -84.5505473 };
const MAP_EMBED =
  "https://www.openstreetmap.org/export/embed.html?bbox=-84.5585%2C39.3769%2C-84.5425%2C39.3869&layer=mapnik";

export default async function HomePage() {
  const settings = await getSettings();
  const portada = await cargarPortada(settings);
  const cabeceras = await headers();

  // El telón de marca es para el primer pintado, no para cada vez que se vuelve a
  // la portada desde /tienda. Se distingue por el `Accept`: una navegación real del
  // navegador pide `text/html`, mientras que el router (y su prefetch) piden el
  // payload RSC sin pedir HTML. La cabecera `RSC`, que sería lo obvio, Next no la
  // deja ver desde headers() — comprobado volcando headers().keys().
  // Si algún día dejara de distinguirse, lo peor que pasa es que el telón salga de
  // más: nunca tapa nada, porque va con pointer-events:none.
  const cargaCompleta = (cabeceras.get("accept") || "").includes("text/html");

  // El storefront solo enseña lo publicado. Lo más reciente primero, como en
  // cualquier "nuevas llegadas".
  const activos = await db.product.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "desc" },
    take: MAX_EN_PORTADA,
    select: {
      slug: true,
      title: true,
      priceCents: true,
      compareAtCents: true,
      tagsJson: true,
      images: { select: { url: true, alt: true }, orderBy: { position: "asc" }, take: 1 },
      variants: { select: { option1: true, stock: true, trackStock: true }, orderBy: { position: "asc" } },
    },
  });

  const productos: ProductCardItem[] = activos.map((p) => ({
    slug: p.slug,
    title: p.title,
    priceCents: p.priceCents,
    compareAtCents: p.compareAtCents,
    imageUrl: p.images[0]?.url ?? null,
    imageAlt: p.images[0]?.alt ?? null,
    meta: lineaMeta(p.tagsJson, p.variants),
    // Solo está agotado si TODAS sus variantes llevan control de stock y están a
    // cero: en dropshipping lo normal es vender sin inventario propio.
    soldOut:
      p.variants.length > 0 && p.variants.every((v) => v.trackStock && v.stock <= 0),
  }));

  // Sin nada publicado la portada no puede enseñar una rejilla vacía: se cae a la
  // galería de inspiración con las prendas que aún esperan precio, igual que hace
  // hoy el sitio en producción (la foto lleva al DM, que es como vende ahora).
  const inspiracion: InspiracionItem[] =
    productos.length > 0 ? [] : await galeriaDeInspiracion();

  const igHandle = settings.instagram.replace(/^@/, "");
  const igUrl = `https://www.instagram.com/${igHandle}/`;
  const direccionConocida = settings.address === DEFAULT_SETTINGS.address;

  // Cada sección movible, lista para pintar. El orden y qué se pinta lo decide
  // `portada.orden`, que ya viene ordenado por `position` y sin lo apagado: así
  // apagar «cita» desde el panel es literalmente no pintarla, sin huecos.
  const secciones: Record<KindOrdenable, ReactNode> = {
    coleccion: (
      <Coleccion contenido={portada.coleccion} productos={productos} inspiracion={inspiracion} />
    ),
    cita: <Cita contenido={portada.cita} />,
    filosofia: <Filosofia contenido={portada.filosofia} />,
    boutique: <Boutique contenido={portada.boutique} />,
    comoComprar: <ComoComprar contenido={portada.comoComprar} />,
    visitanos: (
      <Visitanos
        contenido={portada.visitanos}
        address={settings.address}
        hours={settings.hours}
        igHandle={igHandle}
        mapEmbedUrl={direccionConocida ? MAP_EMBED : null}
      />
    ),
    instagram: <InstagramGrid contenido={portada.instagram} />,
    banner: <Banner contenido={portada.banner} />,
  };

  return (
    <>
      {cargaCompleta ? <Preloader /> : null}

      {/* El hero no es opcional: una portada sin hero no es una portada. */}
      <Hero
        contenido={portada.hero}
        marquee={portada.marquee}
        igUrl={igUrl}
        igHandle={igHandle}
      />

      {portada.orden.map((kind) => (
        <Fragment key={kind}>{secciones[kind]}</Fragment>
      ))}

      <JsonLd data={fichaDelNegocio(settings, igUrl, direccionConocida)} />
      {productos.length > 0 ? <JsonLd data={listaDeProductos(productos, settings)} /> : null}
    </>
  );
}

/* ═══════════ DATOS ═══════════ */

type VarianteMinima = { option1: string | null; stock: number; trackStock: boolean };

/**
 * La línea corta bajo el título: "Negro · Lunares — S / M / L". Se arma con los
 * mismos datos que el sitio viejo escribía a mano en `data-meta`: los tags del
 * producto y las tallas que existen de verdad como variante.
 */
function lineaMeta(tagsJson: string, variantes: VarianteMinima[]): string | null {
  let tags: string[] = [];
  try {
    const crudo: unknown = JSON.parse(tagsJson || "[]");
    // `demo` es una marca interna del seed para poder borrar los productos de
    // prueba; a la clienta no le dice nada.
    if (Array.isArray(crudo)) {
      tags = crudo.filter((t): t is string => typeof t === "string" && t.toLowerCase() !== "demo");
    }
  } catch {
    /* tagsJson corrupto: se pinta la ficha sin tags antes que romper la portada */
  }

  const tallas = [...new Set(variantes.map((v) => v.option1).filter((t): t is string => !!t))];

  return [tags.join(" · "), tallas.join(" / ")].filter(Boolean).join(" — ") || null;
}

/** Prendas reales todavía en borrador (sin precio): sirven de escaparate. */
async function galeriaDeInspiracion(): Promise<InspiracionItem[]> {
  const borradores = await db.product.findMany({
    where: { status: "draft", images: { some: {} } },
    orderBy: { createdAt: "asc" },
    take: MAX_EN_PORTADA,
    select: {
      title: true,
      tagsJson: true,
      images: { select: { url: true, alt: true }, orderBy: { position: "asc" }, take: 1 },
      variants: { select: { option1: true, stock: true, trackStock: true }, orderBy: { position: "asc" } },
    },
  });

  return borradores
    .filter((p) => !!p.images[0])
    .map((p) => ({
      imageUrl: p.images[0]!.url,
      imageAlt: p.images[0]!.alt || p.title,
      title: p.title,
      meta: lineaMeta(p.tagsJson, p.variants),
    }));
}

/* ═══════════ DATOS ESTRUCTURADOS (schema.org) ═══════════ */

/**
 * Ficha del negocio para Google. Viene del `<script>` que ya tenía
 * `legacy/index.html`, pero alimentada por Ajustes.
 *
 * Lo que no se puede saber, no se declara: si Madeline cambia la dirección, se
 * dejan de emitir las coordenadas (eran las de la calle antigua), y si cambia el
 * horario se deja de emitir `openingHoursSpecification` — el texto libre de
 * Ajustes no se puede traducir a horas con garantías, y un horario falso en
 * Google manda a una clienta a una puerta cerrada.
 */
function fichaDelNegocio(
  settings: StoreSettings,
  igUrl: string,
  direccionConocida: boolean,
): Record<string, unknown> {
  const ficha: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "ClothingStore",
    name: settings.storeName,
    description:
      "Boutique de moda femenina — tendencias exclusivas y estilo casual elegante. Envíos a todo Estados Unidos.",
    image: `${SITE}/assets/og.jpg`,
    url: `${SITE}/`,
    priceRange: "$$",
    currenciesAccepted: settings.currency,
    address: direccionSchema(settings.address),
    sameAs: [igUrl],
  };

  if (direccionConocida) {
    ficha.geo = { "@type": "GeoCoordinates", latitude: GEO.lat, longitude: GEO.lon };
  }
  if (settings.hours === DEFAULT_SETTINGS.hours) {
    ficha.openingHoursSpecification = [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Thursday", "Friday", "Saturday"],
        opens: "13:00",
        closes: "20:00",
      },
    ];
  }
  if (settings.email) ficha.email = settings.email;
  if (settings.phone) ficha.telephone = settings.phone;

  return ficha;
}

/** "1305 Grand Blvd, Hamilton, OH 45011" → PostalAddress con sus partes. */
function direccionSchema(address: string): Record<string, unknown> {
  const partes = address
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const estadoYCp = partes.length >= 3 ? /^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(partes[2]) : null;

  if (estadoYCp) {
    return {
      "@type": "PostalAddress",
      streetAddress: partes[0],
      addressLocality: partes[1],
      addressRegion: estadoYCp[1].toUpperCase(),
      postalCode: estadoYCp[2],
      addressCountry: "US",
    };
  }
  // Formato desconocido: mejor una dirección en una sola línea que inventarse
  // ciudad o código postal.
  return { "@type": "PostalAddress", streetAddress: address, addressCountry: "US" };
}

/** Las piezas publicadas, para que Google las entienda como catálogo. */
function listaDeProductos(
  productos: ProductCardItem[],
  settings: StoreSettings,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Nuevas llegadas",
    numberOfItems: productos.length,
    itemListElement: productos.map((p, i) => {
      const url = `${SITE}/producto/${p.slug}`;
      const item: Record<string, unknown> = { "@type": "Product", name: p.title, url };

      if (p.imageUrl) item.image = p.imageUrl.startsWith("/") ? `${SITE}${p.imageUrl}` : p.imageUrl;
      if (p.meta) item.description = p.meta;
      if (p.priceCents > 0) {
        item.offers = {
          "@type": "Offer",
          url,
          priceCurrency: settings.currency,
          // schema.org pide el número desnudo ("45.99"); formatCents() devuelve
          // "$45.99" y el símbolo invalidaría el dato. Es la única conversión de
          // centavos que no pasa por money.ts, y es para máquinas, no para la vista.
          price: (p.priceCents / 100).toFixed(2),
          availability: p.soldOut ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
        };
      }
      return { "@type": "ListItem", position: i + 1, item };
    }),
  };
}

/** El `<` escapado evita que un dato con "</script>" dentro cierre la etiqueta. */
function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
