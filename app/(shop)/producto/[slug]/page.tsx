import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import AvisoVistaPrevia from "@/app/(shop)/_components/AvisoVistaPrevia";
import ProductCard from "@/app/(shop)/_components/ProductCard";
import SelectorVariante, { type VarianteFicha } from "@/app/(shop)/_components/SelectorVariante";
import { type ImagenGaleria } from "@/app/(shop)/_components/Galeria";
import { opcionesDe, tarjetaDeProducto, estaAgotado } from "@/app/(shop)/_components/Filtros";
import Resenas, { ResumenResenas, type ResenaVista } from "@/app/(shop)/_components/Resenas";
import { resenasAprobadas, resumenDeProducto, type ResumenPuntuacion } from "@/lib/reviews";
import "../../catalogo.css";

/**
 * Ficha de producto.
 *
 * Un producto en borrador o archivado NO existe aquí: devuelve 404. Es la misma
 * regla que aplica el catálogo, y tiene que valer también cuando alguien llega
 * con el enlace directo de un producto que Madeline despublicó.
 *
 * ÚNICA excepción: `?vista=previa` con sesión de admin válida. Sirve para que
 * Madeline vea cómo queda una pieza recién importada antes de ponerla a la
 * venta, que es lo que hace Shopify y lo que ella espera. La llave es la cookie
 * de sesión y nada más: sin token en la URL ni «si conoces el enlace lo ves».
 * Un borrador puede llevar el precio a medias o fotos que aún no son suyas, así
 * que no puede quedar accesible a quien pruebe slugs.
 */
export const dynamic = "force-dynamic";

const SITIO = process.env.NEXT_PUBLIC_SITE_URL || "https://bloom-by-madeline.vercel.app";

type Props = {
  // En Next 15 params y searchParams son promesas.
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ vista?: string | string[] }>;
};

/**
 * ¿Se pidió la vista previa Y quien la pide puede verla?
 *
 * Devuelve `false` sin sesión, que es lo que hace que la página se comporte
 * exactamente igual que antes (404) para cualquiera que no sea Madeline.
 */
async function vistaPreviaAutorizada(searchParams: Props["searchParams"]): Promise<boolean> {
  const { vista } = await searchParams;
  if (vista !== "previa") return false;
  return (await getAdmin()) !== null;
}

async function buscarProducto(slug: string, incluirNoPublicados = false) {
  const producto = await db.product.findUnique({
    where: { slug },
    include: {
      images: { orderBy: { position: "asc" } },
      variants: { orderBy: { position: "asc" } },
      collections: {
        orderBy: { position: "asc" },
        include: { collection: { select: { slug: true, title: true, isVisible: true } } },
      },
    },
  });

  if (!producto) return null;
  // El escaparate solo enseña "active": draft y archived son cosa del panel.
  return producto.status === "active" || incluirNoPublicados ? producto : null;
}

/**
 * Precio decimal para schema.org. Google no acepta "$45.99": quiere "45.99".
 * Es el ÚNICO sitio donde el dinero no pasa por formatCents, y es porque el
 * destinatario es una máquina, no la clienta.
 */
function precioSchema(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  // Se vuelve a comprobar la sesión aquí y no se comparte con la página: Next
  // ejecuta `generateMetadata` y el componente por separado, y esta función no
  // puede fiarse de que la otra ya haya mirado. Son dos consultas de más, y solo
  // en las visitas con `?vista=previa`, que son las de Madeline.
  const vistaPrevia = await vistaPreviaAutorizada(searchParams);
  const producto = await buscarProducto(slug, vistaPrevia);
  if (!producto) return { title: "Pieza no encontrada" };

  // Una ficha en vista previa no se indexa NUNCA, ni siquiera la de un producto
  // que ya está activo: sería la misma pieza en dos direcciones distintas.
  if (vistaPrevia) {
    return {
      title: { absolute: `Vista previa · ${producto.title}` },
      robots: { index: false, follow: false, nocache: true },
    };
  }

  const descripcion =
    producto.seoDescription ||
    producto.description.replace(/\s+/g, " ").trim().slice(0, 155) ||
    `${producto.title} en Bloom by Madeline, boutique de moda femenina en Hamilton, Ohio.`;

  const foto = producto.images[0];

  return {
    // El seoTitle que escribe Madeline en el panel ya es el título completo: si se
    // dejara pasar por la plantilla del layout saldría "… · Bloom by Madeline" dos veces.
    title: producto.seoTitle ? { absolute: producto.seoTitle } : producto.title,
    description: descripcion,
    alternates: { canonical: `/producto/${producto.slug}` },
    openGraph: {
      type: "website",
      title: `${producto.title} · Bloom by Madeline`,
      description: descripcion,
      url: `/producto/${producto.slug}`,
      // La primera foto del producto es la que se ve al compartir por DM.
      ...(foto ? { images: [{ url: foto.url, alt: foto.alt || producto.title }] } : {}),
    },
  };
}

export default async function ProductoPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const vistaPrevia = await vistaPreviaAutorizada(searchParams);
  const producto = await buscarProducto(slug, vistaPrevia);
  if (!producto) notFound();

  // La banda solo aparece cuando lo que se está viendo NO es lo que ve la
  // clienta. Si la pieza ya está activa, la vista previa y la página pública son
  // la misma cosa y el aviso sería ruido — y una mentira.
  const avisarNoPublicado = vistaPrevia && producto.status !== "active";

  const settings = await getSettings();
  const optionNames: string[] = leerLista(producto.optionNamesJson);
  const etiquetas: string[] = leerLista(producto.tagsJson);
  const { tallas, colores } = opcionesDe(producto);
  const agotado = estaAgotado(producto.variants);

  // Galería: las fotos del producto y, detrás, las fotos propias de variantes que
  // no estén ya en la lista. Sin esto, elegir un color con foto propia no tendría
  // ninguna imagen a la que saltar.
  const imagenes: ImagenGaleria[] = producto.images.map((img) => ({
    url: img.url,
    alt: img.alt || producto.title,
  }));
  for (const v of producto.variants) {
    if (v.imageUrl && !imagenes.some((img) => img.url === v.imageUrl)) {
      imagenes.push({ url: v.imageUrl, alt: `${producto.title} — ${v.title}` });
    }
  }

  const variantes: VarianteFicha[] = producto.variants.map((v) => ({
    id: v.id,
    title: v.title,
    optionValues: [v.option1, v.option2, v.option3],
    priceCents: v.priceCents,
    compareAtCents: v.compareAtCents,
    // trackStock false = el proveedor tiene el stock: no hay tope que enseñar.
    available: v.trackStock ? v.stock : null,
    imageUrl: v.imageUrl,
  }));

  const colecciones = producto.collections
    .map((cp) => cp.collection)
    .filter((c) => c.isVisible);

  const relacionados = await buscarRelacionados(
    producto.id,
    producto.collections.map((cp) => cp.collectionId),
  );

  // Reseñas: las dos consultas van en paralelo porque no dependen entre sí. El
  // resumen se pide aparte de la lista a propósito — la lista está recortada a
  // 12 y la media tiene que salir de TODAS las aprobadas, no de la primera página.
  const [resumen, resenas]: [ResumenPuntuacion, ResenaVista[]] = await Promise.all([
    resumenDeProducto(producto.id),
    resenasAprobadas(producto.id, 12),
  ]);

  const fichaTecnica: { termino: string; valor: string }[] = [];
  if (producto.productType) fichaTecnica.push({ termino: "Tipo", valor: producto.productType });
  if (tallas.length) fichaTecnica.push({ termino: "Tallas", valor: tallas.join(" · ") });
  if (colores.length) fichaTecnica.push({ termino: "Colores", valor: colores.join(" · ") });
  if (producto.vendor) fichaTecnica.push({ termino: "Marca", valor: producto.vendor });
  if (etiquetas.length) fichaTecnica.push({ termino: "Etiquetas", valor: etiquetas.join(" · ") });

  return (
    <div className="shop-page section">
      {avisarNoPublicado ? <AvisoVistaPrevia estado={producto.status} productId={producto.id} /> : null}

      <p className="pf-migas">
        <Link href="/tienda">Tienda</Link>
        {colecciones[0] ? (
          <>
            <i>/</i>
            <Link href={`/coleccion/${colecciones[0].slug}`}>{colecciones[0].title}</Link>
          </>
        ) : null}
        <i>/</i>
        <span>{producto.title}</span>
      </p>

      <SelectorVariante
        titulo={producto.title}
        imagenes={imagenes}
        optionNames={optionNames}
        variantes={variantes}
        precioBaseCents={producto.priceCents}
        compareAtCents={producto.compareAtCents}
        info={
          <>
            {producto.productType ? (
              <p className="overline pf-tipo">{producto.productType}</p>
            ) : null}
            <h1 className="pf-titulo">{producto.title}</h1>
          </>
        }
        debajo={
          <>
            {settings.shippingNotice ? (
              <p className="pf-envio">
                <strong>Envío:</strong> {settings.shippingNotice}
                {settings.freeShippingOverCents > 0 ? (
                  <> Envío gratis a partir de {formatCents(settings.freeShippingOverCents)}.</>
                ) : null}
              </p>
            ) : null}

            {producto.description ? (
              <>
                <hr className="pf-sep" />
                <p className="pf-desc">{producto.description}</p>
              </>
            ) : null}

            {/* Nota media junto a la descripción, con enlace al bloque de abajo.
                Si no hay reseñas aprobadas devuelve null y aquí no queda ni un
                hueco: la ficha se ve igual que antes de existir las reseñas. */}
            <ResumenResenas resumen={resumen} />

            {fichaTecnica.length ? (
              <dl className="pf-ficha">
                {fichaTecnica.map((fila) => (
                  <div key={fila.termino}>
                    <dt>{fila.termino}</dt>
                    <dd>{fila.valor}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {colecciones.length ? (
              <div className="pf-cols">
                {colecciones.map((c) => (
                  <Link key={c.slug} className="pf-col-tag" href={`/coleccion/${c.slug}`}>
                    {c.title}
                  </Link>
                ))}
              </div>
            ) : null}
          </>
        }
      />

      <Resenas resumen={resumen} resenas={resenas} />

      {relacionados.length ? (
        <section className="pf-rel reveal">
          <div className="section-head">
            <div>
              <p className="overline">Sigue mirando</p>
              <h2>
                También te <span className="serif-it">gustará</span>
              </h2>
            </div>
          </div>
          <div className="product-grid">
            {relacionados.map((p) => (
              <ProductCard key={p.slug} product={tarjetaDeProducto(p)} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Sin datos estructurados en la vista previa de algo sin publicar: son
          para Google, y Google no debe tener noticia de una pieza que todavía
          no está a la venta (la página va con noindex por lo mismo). */}
      {avisarNoPublicado ? null : (
        <JsonLdProducto
          producto={{
            slug: producto.slug,
            title: producto.title,
            description: producto.description,
            vendor: producto.vendor,
            priceCents: producto.priceCents,
            imagenes: imagenes.map((i) => i.url),
            agotado,
          }}
          variantes={producto.variants.map((v) => ({
            sku: v.sku,
            priceCents: v.priceCents,
            disponible: !v.trackStock || v.stock > 0,
          }))}
          moneda={settings.currency}
          resumen={resumen}
          resenas={resenas}
        />
      )}
    </div>
  );
}

// ─────────────────────────────── auxiliares ───────────────────────────────

function leerLista(json: string): string[] {
  try {
    const datos: unknown = JSON.parse(json);
    return Array.isArray(datos) ? datos.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Otras piezas activas de las mismas colecciones. Cuatro: una fila justa. */
async function buscarRelacionados(productId: string, collectionIds: string[]) {
  if (!collectionIds.length) return [];
  return db.product.findMany({
    where: {
      status: "active",
      id: { not: productId },
      collections: { some: { collectionId: { in: collectionIds } } },
    },
    select: {
      slug: true,
      title: true,
      productType: true,
      optionNamesJson: true,
      priceCents: true,
      compareAtCents: true,
      images: { select: { url: true, alt: true }, orderBy: { position: "asc" }, take: 1 },
      variants: {
        select: { option1: true, option2: true, option3: true, stock: true, trackStock: true, priceCents: true },
        orderBy: { position: "asc" },
      },
    },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    take: 4,
  });
}

/**
 * Datos estructurados. Es lo que hace que la pieza salga en Google con su foto y
 * su precio; sin `offers` con precio y disponibilidad reales, Google la ignora.
 * Si el producto todavía no tiene precio se publica la ficha SIN oferta: mejor
 * sin precio que con un $0.00 que luego hay que desmentir.
 */
function JsonLdProducto({
  producto,
  variantes,
  moneda,
  resumen,
  resenas,
}: {
  producto: {
    slug: string;
    title: string;
    description: string;
    vendor: string;
    priceCents: number;
    imagenes: string[];
    agotado: boolean;
  };
  variantes: { sku: string; priceCents: number; disponible: boolean }[];
  moneda: string;
  resumen: ResumenPuntuacion;
  resenas: ResenaVista[];
}) {
  const url = `${SITIO}/producto/${producto.slug}`;
  const disponibilidad = `https://schema.org/${producto.agotado ? "OutOfStock" : "InStock"}`;
  const precios = variantes.map((v) => v.priceCents).filter((p) => p > 0);

  const datos: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: producto.title,
    url,
    ...(producto.description ? { description: producto.description } : {}),
    ...(producto.imagenes.length
      ? { image: producto.imagenes.map((u) => (u.startsWith("http") ? u : `${SITIO}${u}`)) }
      : {}),
    ...(producto.vendor ? { brand: { "@type": "Brand", name: producto.vendor } } : {}),
  };

  // Valoración agregada SOLO si hay reseñas aprobadas de verdad. Un
  // aggregateRating sin reseñas detrás es una estrella inventada en el resultado
  // de Google: fraude ante el buscador (penalización manual por "reseñas
  // falsas") y, sobre todo, ante quien pincha creyendo que alguien la compró.
  if (resumen.total > 0 && resenas.length > 0) {
    datos.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: resumen.media.toFixed(1),
      reviewCount: resumen.total,
      bestRating: "5",
      worstRating: "1",
    };
    // Las reseñas individuales son las mismas que ve la compradora en la ficha,
    // no un extracto distinto: lo que Google indexa y lo que se lee coinciden.
    datos.review = resenas.slice(0, 5).map((r) => ({
      "@type": "Review",
      author: { "@type": "Person", name: r.authorName },
      datePublished: r.createdAt.toISOString().slice(0, 10),
      reviewRating: { "@type": "Rating", ratingValue: String(r.rating), bestRating: "5", worstRating: "1" },
      ...(r.title ? { name: r.title } : {}),
      ...(r.body ? { reviewBody: r.body } : {}),
    }));
  }

  if (precios.length > 1 && new Set(precios).size > 1) {
    datos.offers = {
      "@type": "AggregateOffer",
      priceCurrency: moneda,
      lowPrice: precioSchema(Math.min(...precios)),
      highPrice: precioSchema(Math.max(...precios)),
      offerCount: variantes.length,
      availability: disponibilidad,
      url,
    };
  } else if (precios.length || producto.priceCents > 0) {
    datos.offers = {
      "@type": "Offer",
      priceCurrency: moneda,
      price: precioSchema(precios.length ? Math.min(...precios) : producto.priceCents),
      availability: disponibilidad,
      itemCondition: "https://schema.org/NewCondition",
      url,
    };
  }

  return (
    <script
      type="application/ld+json"
      // El "<" escapado impide que una descripción con HTML cierre el <script>.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(datos).replace(/</g, "\\u003c") }}
    />
  );
}
