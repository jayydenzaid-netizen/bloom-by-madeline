import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { listarCarpetas, listarMedios, sanearCarpeta } from "@/lib/media";
import { Card, PageHeader } from "../_components/ui";
import MediaGrid from "./_components/MediaGrid";
import "./medios.css";

/**
 * Biblioteca de medios.
 *
 * La idea que manda: una foto se sube UNA vez y se reutiliza en el producto, en
 * la portada y en las páginas. Madeline hace las fotos con el teléfono en el
 * mostrador, así que la pantalla está pensada para ese gesto: arrastrar o
 * elegir, ver que subió, y seguir.
 *
 * El buscador y el filtro por carpeta son un formulario GET, no estado de
 * cliente: la búsqueda queda en la URL (se puede guardar en favoritos) y
 * funciona aunque el JavaScript tarde en cargar.
 */

export const dynamic = "force-dynamic";

type Busqueda = Record<string, string | string[] | undefined>;

function unico(valor: string | string[] | undefined): string {
  return Array.isArray(valor) ? (valor[0] ?? "") : (valor ?? "");
}

export default async function PaginaMedios({ searchParams }: { searchParams: Promise<Busqueda> }) {
  // Cada pantalla comprueba su propia sesión: en Next 15 una página se renderiza
  // aunque el layout decida no pintarla, y el HTML viaja igual en el payload.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const parametros = await searchParams;
  const consulta = unico(parametros.q).trim();
  const carpetaCruda = unico(parametros.carpeta);
  // "__todas" es el estado por defecto del selector; "" (cadena vacía) es la
  // carpeta real "sin carpeta", que sí es un filtro.
  const filtrandoCarpeta = parametros.carpeta !== undefined && carpetaCruda !== "__todas";
  const carpeta = filtrandoCarpeta ? sanearCarpeta(carpetaCruda) : null;

  const [medios, carpetas] = await Promise.all([
    listarMedios({ consulta, carpeta }),
    listarCarpetas(),
  ]);

  const total = carpetas.reduce((suma, c) => suma + c.total, 0);
  const nombresCarpetas = carpetas.map((c) => c.folder).filter(Boolean);

  const subtitulo =
    total === 0
      ? "Todavía no hay fotos guardadas"
      : `${total} ${total === 1 ? "imagen guardada" : "imágenes guardadas"} · se reutilizan en productos, portada y páginas`;

  return (
    <>
      <PageHeader title="Medios" subtitle={subtitulo} />

      <Card title="Buscar">
        {/* Formulario GET: sin JavaScript sigue funcionando y la URL es compartible. */}
        <form method="get" className="med-filtros">
          <div className="adm-field med-filtros-campo">
            <label className="adm-field-lbl" htmlFor="med-q">
              Nombre de la foto
            </label>
            <input id="med-q" name="q" type="search" defaultValue={consulta} placeholder="vestido, botas…" />
          </div>
          <div className="adm-field">
            <label className="adm-field-lbl" htmlFor="med-carpeta">
              Carpeta
            </label>
            <select id="med-carpeta" name="carpeta" defaultValue={filtrandoCarpeta ? carpeta ?? "" : "__todas"}>
              <option value="__todas">Todas</option>
              <option value="">Sin carpeta</option>
              {nombresCarpetas.map((nombre) => (
                <option key={nombre} value={nombre}>
                  {nombre}
                </option>
              ))}
            </select>
          </div>
          <div className="adm-field">
            <button type="submit" className="adm-btn adm-btn-ghost adm-btn-md">
              Filtrar
            </button>
          </div>
        </form>

        {carpetas.length > 0 ? (
          <div className="med-carpetas">
            <Link className={`med-chip${!filtrandoCarpeta ? " is-activa" : ""}`} href="/admin/medios">
              Todas <span className="med-chip-num">{total}</span>
            </Link>
            {carpetas.map((c) => {
              const activa = filtrandoCarpeta && carpeta === c.folder;
              const destino = `/admin/medios?carpeta=${encodeURIComponent(c.folder)}`;
              return (
                <Link key={c.folder || "__sin"} className={`med-chip${activa ? " is-activa" : ""}`} href={destino}>
                  {c.folder || "Sin carpeta"} <span className="med-chip-num">{c.total}</span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </Card>

      <MediaGrid medios={medios} carpetas={nombresCarpetas} carpetaActiva={carpeta ?? ""} />
    </>
  );
}
