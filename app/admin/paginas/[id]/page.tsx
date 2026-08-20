import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge, Button, Card, PageHeader } from "../../_components/ui";
import { EditorPagina } from "../../contenido/_components/BlockEditor";
import { eliminarPagina } from "../actions";
import "../../contenido/contenido.css";

/**
 * Editor de una página existente.
 *
 * El borrado vive aquí abajo y en dos pasos: un enlace discreto abre la tarjeta
 * de aviso, y solo entonces aparece el botón rojo. Borrar una página se hace una
 * vez en la vida y no tiene vuelta atrás; equivocarse debe costar dos gestos.
 */
export const dynamic = "force-dynamic";

type Props = {
  // En Next 15 params y searchParams son promesas.
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; borrar?: string }>;
};

export default async function EditarPaginaPage({ params, searchParams }: Props) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const pagina = await db.page.findUnique({ where: { id } });
  if (!pagina) notFound();

  const publicada = pagina.status === "published";

  return (
    <>
      <PageHeader
        title={pagina.title}
        subtitle={
          <>
            {publicada ? <Badge tone="success">Publicada</Badge> : <Badge tone="neutral">Borrador</Badge>}{" "}
            <span className="cnt-url">/pagina/{pagina.slug}</span>
          </>
        }
        actions={
          publicada ? (
            <a
              className="adm-btn adm-btn-ghost adm-btn-md"
              href={`/pagina/${pagina.slug}`}
              target="_blank"
              rel="noreferrer"
            >
              Ver en la web
            </a>
          ) : (
            <Button href="/admin/paginas" variant="ghost">
              Volver a la lista
            </Button>
          )
        }
      />

      {sp.ok === "creada" ? (
        <div className="cnt-aviso cnt-aviso-ok">
          Página creada. Sigue en borrador: cuando esté a tu gusto, cámbiala a «Publicada» y guarda.
        </div>
      ) : null}

      <EditorPagina
        pagina={{
          id: pagina.id,
          slug: pagina.slug,
          title: pagina.title,
          content: pagina.content,
          status: pagina.status,
          seoTitle: pagina.seoTitle ?? "",
          seoDescription: pagina.seoDescription ?? "",
          showInFooter: pagina.showInFooter,
        }}
      />

      {sp.borrar === "1" ? (
        <Card title="Borrar la página">
          <div className="cnt-peligro">
            <h3>¿Seguro que quieres borrar «{pagina.title}»?</h3>
            <p>
              Desaparece para siempre, con su texto. Si solo quieres que deje de verse en la web, no hace falta
              borrarla: cámbiala a borrador y listo.
            </p>
            <form action={eliminarPagina} className="cnt-barra">
              <input type="hidden" name="id" value={pagina.id} />
              <Button type="submit" variant="danger">
                Sí, borrar esta página
              </Button>
              <Button href={`/admin/paginas/${pagina.id}`} variant="ghost">
                No, dejarla
              </Button>
            </form>
          </div>
        </Card>
      ) : (
        <p className="cnt-pista">
          ¿Ya no la necesitas?{" "}
          <Link className="adm-link" href={`/admin/paginas/${pagina.id}?borrar=1`}>
            Borrar esta página
          </Link>
          . (Para que deje de verse basta con dejarla en borrador.)
        </p>
      )}
    </>
  );
}
