import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { redirigirSiHay } from "@/lib/seo";
import { getSettings } from "@/lib/settings";
import { db } from "@/lib/db";
import { markdownAHtml, textoPlano } from "@/lib/markdown";

/**
 * Páginas de contenido del escaparate: envíos, devoluciones, sobre nosotros,
 * términos… Todas viven en esta única ruta y las escribe Madeline desde el
 * panel en markdown ligero.
 *
 * Solo se sirve lo `published`. Un borrador NO es "una página que no enlazamos":
 * es una página que no existe, y por eso responde 404 igual que un slug
 * inventado — si respondiera distinto, la dirección de un borrador se podría
 * adivinar probando.
 *
 * El HTML sale de `markdownAHtml`, que escapa la entrada ANTES de formatear;
 * por eso aquí se puede usar dangerouslySetInnerHTML sin abrir un XSS. Es la
 * única forma de pintar contenido de la usuaria en el sitio público.
 */
export const dynamic = "force-dynamic";

type Props = {
  // En Next 15 params es una promesa.
  params: Promise<{ slug: string }>;
};

async function buscarPagina(slug: string) {
  const pagina = await db.page.findUnique({ where: { slug } });
  return pagina && pagina.status === "published" ? pagina : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const pagina = await buscarPagina(slug);
  if (!pagina) return { title: "Página no encontrada" };

  const descripcion = pagina.seoDescription || textoPlano(pagina.content, 155);

  return {
    title: pagina.seoTitle || pagina.title,
    description: descripcion || undefined,
    alternates: { canonical: `/pagina/${pagina.slug}` },
    openGraph: {
      title: `${pagina.seoTitle || pagina.title} · Bloom by Madeline`,
      description: descripcion || undefined,
      url: `/pagina/${pagina.slug}`,
      type: "article",
    },
  };
}

const fecha = new Intl.DateTimeFormat("es-US", { day: "numeric", month: "long", year: "numeric" });

export default async function PaginaPublica({ params }: Props) {
  const { slug } = await params;
  const pagina = await buscarPagina(slug);
  if (!pagina) {
    await redirigirSiHay(`/pagina/${slug}`);
    notFound();
  }

  const settings = await getSettings();
  const html = markdownAHtml(pagina.content);

  return (
    <div className="shop-page section">
      {/* React 19 iza este <style> a <head> y lo deduplica por `href`. Se hace
          así, y no con un .css nuevo, porque globals.css no se toca (es la
          identidad del sitio) y estos estilos solo existen en esta ruta. */}
      <style href="pagina-contenido" precedence="default">{ESTILOS}</style>

      <article className="pg">
        <p className="overline">Bloom by Madeline</p>
        <h1 className="pg-titulo">{pagina.title}</h1>

        {html ? (
          <div className="pg-md" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <p className="pg-vacia">Esta página todavía no tiene texto.</p>
        )}

        <footer className="pg-pie">
          <p>Última actualización: {fecha.format(pagina.updatedAt)}</p>
          <p>
            ¿Te queda alguna duda? Escríbenos por{" "}
            <a href={settings.instagramDm} target="_blank" rel="noopener noreferrer">
              Instagram
            </a>{" "}
            o pásate por la boutique.
          </p>
          <Link className="btn btn-ghost btn-sm" href="/tienda">
            Volver a la tienda
          </Link>
        </footer>
      </article>
    </div>
  );
}

/**
 * Tipografía de lectura larga. El `h2` de globals.css mide hasta 58 px y va en
 * mayúsculas: perfecto para un titular de sección, ilegible para una política de
 * envíos. Aquí se reajusta SOLO dentro de `.pg-md`, sin tocar nada global.
 */
const ESTILOS = `
.pg { max-width: 760px; margin: 0 auto; }
.pg-titulo {
  font-family: var(--sans);
  font-weight: 300;
  font-size: clamp(30px, 4.4vw, 46px);
  letter-spacing: .04em;
  text-transform: uppercase;
  line-height: 1.12;
  margin-bottom: clamp(26px, 4vw, 40px);
}
.pg-md { font-size: 16px; line-height: 1.85; color: var(--ink-soft); }
.pg-md h2 {
  font-family: var(--serif);
  font-size: clamp(24px, 3vw, 32px);
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  line-height: 1.25;
  color: var(--ink);
  margin: 46px 0 16px;
}
.pg-md h3 {
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 400;
  letter-spacing: .22em;
  text-transform: uppercase;
  color: var(--ink);
  margin: 34px 0 12px;
}
.pg-md h4 {
  font-family: var(--sans);
  font-size: 15px;
  font-weight: 500;
  color: var(--ink);
  margin: 26px 0 8px;
}
.pg-md > :first-child { margin-top: 0; }
.pg-md p { margin-bottom: 18px; }
.pg-md strong { color: var(--ink); font-weight: 500; }
.pg-md em { font-family: var(--serif); font-style: italic; font-size: 1.08em; }
.pg-md ul, .pg-md ol { margin: 0 0 20px; padding-left: 22px; }
.pg-md li { margin-bottom: 9px; }
.pg-md li::marker { color: var(--clay); }
.pg-md a { color: var(--clay); text-decoration: underline; text-underline-offset: 3px; }
.pg-md a:hover { color: var(--ink); }
.pg-md blockquote {
  margin: 0 0 20px;
  padding: 4px 0 4px 20px;
  border-left: 1px solid var(--clay);
  font-family: var(--serif);
  font-style: italic;
  font-size: 1.15em;
  color: var(--ink);
}
.pg-md hr { border: 0; border-top: 1px solid rgba(22,21,19,.14); margin: 38px 0; }
.pg-md code {
  font-size: .92em;
  background: rgba(22,21,19,.06);
  border-radius: 4px;
  padding: 1px 6px;
}
.pg-vacia { color: var(--stone); font-style: italic; }
.pg-pie {
  margin-top: clamp(48px, 7vw, 84px);
  padding-top: 26px;
  border-top: 1px solid rgba(22,21,19,.14);
  font-size: 13.5px;
  line-height: 1.9;
  color: var(--stone);
}
.pg-pie p { margin-bottom: 6px; }
.pg-pie a { color: var(--clay); text-decoration: underline; text-underline-offset: 3px; }
.pg-pie .btn { margin-top: 18px; }
`;
