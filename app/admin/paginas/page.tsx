import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { textoPlano } from "@/lib/markdown";
import { Badge, Button, Card, DataTable, EmptyState, PageHeader, type Column } from "../_components/ui";
import { cambiarEstadoPagina, crearPaginasBasicas, moverPagina } from "./actions";
import "../contenido/contenido.css";

/**
 * Lista de páginas de contenido.
 *
 * Las cuatro que toda tienda necesita (envíos, devoluciones, sobre nosotros,
 * términos) no existen todavía en Bloom, así que la pantalla no se limita a
 * enseñar una tabla vacía: ofrece crearlas en borrador con un texto de partida.
 */
export const dynamic = "force-dynamic";

/** Las cuatro básicas, para saber cuáles siguen faltando. */
const BASICAS = ["envios-y-entregas", "cambios-y-devoluciones", "sobre-nosotros", "terminos-y-privacidad"];

const fecha = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short", year: "numeric" });

type Fila = {
  id: string;
  slug: string;
  title: string;
  content: string;
  status: string;
  showInFooter: boolean;
  updatedAt: Date;
  indice: number;
  total: number;
};

type Props = {
  searchParams: Promise<{ ok?: string }>;
};

export default async function PaginasPage({ searchParams }: Props) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const paginas = await db.page.findMany({ orderBy: [{ position: "asc" }, { title: "asc" }] });

  const faltan = BASICAS.filter((slug) => !paginas.some((p) => p.slug === slug));
  const publicadas = paginas.filter((p) => p.status === "published").length;

  const filas: Fila[] = paginas.map((p, i) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    content: p.content,
    status: p.status,
    showInFooter: p.showInFooter,
    updatedAt: p.updatedAt,
    indice: i,
    total: paginas.length,
  }));

  const columnas: Column<Fila>[] = [
    {
      key: "titulo",
      header: "Página",
      primary: true,
      render: (p) => (
        <>
          <Link className="adm-link" href={`/admin/paginas/${p.id}`}>
            {p.title}
          </Link>
          <div className="cnt-avance">{textoPlano(p.content, 90) || "Sin texto todavía."}</div>
        </>
      ),
    },
    {
      key: "estado",
      header: "Estado",
      render: (p) =>
        p.status === "published" ? <Badge tone="success">Publicada</Badge> : <Badge tone="neutral">Borrador</Badge>,
    },
    {
      key: "pie",
      header: "En el pie",
      hideOnMobile: true,
      render: (p) => (p.showInFooter ? <Badge tone="info">Sí</Badge> : <span className="adm-muted">No</span>),
    },
    {
      key: "direccion",
      header: "Dirección",
      hideOnMobile: true,
      render: (p) => <span className="cnt-url">/pagina/{p.slug}</span>,
    },
    {
      key: "actualizada",
      header: "Cambiada",
      hideOnMobile: true,
      render: (p) => <span className="adm-muted">{fecha.format(p.updatedAt)}</span>,
    },
    {
      key: "acciones",
      header: "Orden",
      align: "right",
      render: (p) => (
        <div className="cnt-acciones">
          <form action={moverPagina} className="cnt-forma">
            <input type="hidden" name="id" value={p.id} />
            <input type="hidden" name="direccion" value="arriba" />
            <button className="cnt-flecha" type="submit" disabled={p.indice === 0} aria-label={`Subir ${p.title}`}>
              ↑
            </button>
          </form>
          <form action={moverPagina} className="cnt-forma">
            <input type="hidden" name="id" value={p.id} />
            <input type="hidden" name="direccion" value="abajo" />
            <button
              className="cnt-flecha"
              type="submit"
              disabled={p.indice === p.total - 1}
              aria-label={`Bajar ${p.title}`}
            >
              ↓
            </button>
          </form>
          <form action={cambiarEstadoPagina} className="cnt-forma">
            <input type="hidden" name="id" value={p.id} />
            <Button type="submit" variant="ghost" size="sm">
              {p.status === "published" ? "Retirar" : "Publicar"}
            </Button>
          </form>
          <Button href={`/admin/paginas/${p.id}`} size="sm">
            Editar
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Páginas"
        subtitle={
          paginas.length > 0
            ? `${paginas.length} páginas · ${publicadas} publicadas`
            : "Envíos, devoluciones, sobre nosotros, condiciones… lo que la clienta busca antes de comprar"
        }
        actions={<Button href="/admin/paginas/nueva">Nueva página</Button>}
      />

      {sp.ok === "basicas" ? (
        <div className="cnt-aviso cnt-aviso-ok">
          Listo. Están en borrador: ábrelas, rellena lo que pone <strong>[POR CONFIRMAR]</strong> y publícalas cuando
          estén a tu gusto.
        </div>
      ) : null}
      {sp.ok === "publicada" ? <div className="cnt-aviso cnt-aviso-ok">Página publicada: ya se puede ver en la web.</div> : null}
      {sp.ok === "retirada" ? (
        <div className="cnt-aviso cnt-aviso-info">Página retirada. Vuelve a ser un borrador que solo ves tú.</div>
      ) : null}
      {sp.ok === "borrada" ? <div className="cnt-aviso cnt-aviso-info">Página borrada.</div> : null}

      {faltan.length > 0 ? (
        <Card title="Las páginas que toda tienda necesita">
          <p className="cnt-pista">
            Te faltan {faltan.length} de las cuatro páginas que la gente busca antes de comprar: envíos y entregas,
            cambios y devoluciones, sobre nosotros, y términos y privacidad. Te las creamos en{" "}
            <strong>borrador</strong>, con un texto de partida y marcado con <strong>[POR CONFIRMAR]</strong> todo lo
            que solo sabes tú (tus plazos, tu política real). No se publica nada hasta que tú lo digas.
          </p>
          <form action={crearPaginasBasicas}>
            <Button type="submit">Crear las {faltan.length} páginas que faltan</Button>
          </form>
        </Card>
      ) : null}

      <Card title="Tus páginas" flush>
        <DataTable
          columns={columnas}
          rows={filas}
          rowKey={(p) => p.id}
          empty={
            <EmptyState
              title="Todavía no hay páginas"
              text="Empieza por las cuatro básicas de arriba, o crea la tuya desde cero."
              action={<Button href="/admin/paginas/nueva">Nueva página</Button>}
            />
          }
        />
      </Card>
    </>
  );
}
