import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { redirigirSiHay } from "@/lib/seo";
import { db } from "@/lib/db";
import {
  Catalogo,
  cargarCatalogo,
  leerParams,
  type BusquedaEntrante,
} from "@/app/(shop)/_components/Filtros";
import "../../catalogo.css";

/**
 * Una colección es el mismo catálogo con la rejilla acotada, no otra pantalla:
 * los mismos filtros, el mismo orden y la misma paginación. Lo único que cambia
 * es que la colección la manda la ruta y no un parámetro.
 */
export const dynamic = "force-dynamic";

type Props = {
  // En Next 15 params y searchParams son promesas.
  params: Promise<{ slug: string }>;
  searchParams: Promise<BusquedaEntrante>;
};

async function buscarColeccion(slug: string) {
  const coleccion = await db.collection.findUnique({
    where: { slug },
    select: { slug: true, title: true, description: true, isVisible: true, imageUrl: true },
  });
  // Una colección oculta no existe para el escaparate.
  return coleccion && coleccion.isVisible ? coleccion : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const coleccion = await buscarColeccion(slug);
  if (!coleccion) return { title: "Colección no encontrada" };

  return {
    title: coleccion.title,
    description: coleccion.description || `${coleccion.title} · Bloom by Madeline`,
    alternates: { canonical: `/coleccion/${coleccion.slug}` },
    openGraph: {
      title: `${coleccion.title} · Bloom by Madeline`,
      description: coleccion.description || undefined,
      url: `/coleccion/${coleccion.slug}`,
      ...(coleccion.imageUrl ? { images: [{ url: coleccion.imageUrl, alt: coleccion.title }] } : {}),
    },
  };
}

export default async function ColeccionPage({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  const coleccion = await buscarColeccion(slug);
  if (!coleccion) {
    await redirigirSiHay(`/coleccion/${slug}`);
    notFound();
  }

  // Aquí la colección la fija la ruta: el parámetro `col` no pinta nada.
  const filtros = { ...leerParams(sp), col: "" };
  const datos = await cargarCatalogo(filtros, { coleccionSlug: coleccion.slug });

  return (
    <div className="shop-page section">
      <header className="section-head">
        <div>
          <p className="overline">Colección</p>
          <h2>{coleccion.title}</h2>
          {coleccion.description ? <p className="cat-intro">{coleccion.description}</p> : null}
        </div>
        <p className="section-note">
          <Link href="/tienda">Ver todo el catálogo →</Link>
        </p>
      </header>

      <Catalogo
        base={`/coleccion/${coleccion.slug}`}
        params={filtros}
        datos={datos}
        mostrarColecciones={false}
      />
    </div>
  );
}
