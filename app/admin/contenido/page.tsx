import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { textoPlano } from "@/lib/markdown";
import { Badge, Button, Card, EmptyState, PageHeader } from "../_components/ui";
import { alternarBloque, moverBloque, restaurarBloque, sembrarBloques } from "./actions";
import { BlockEditor, type BloqueEditable } from "./_components/BlockEditor";
import "./contenido.css";

/**
 * Editor de la portada.
 *
 * La pantalla es una lista de secciones en el mismo orden en que se ven en la
 * web, no un formulario gigante: Madeline no piensa en "registros", piensa en
 * "la parte de las fotos de Instagram". Cada fila dice qué es, enseña un avance
 * de su texto y se puede subir, bajar, apagar o abrir.
 *
 * Nada se borra desde aquí. Un bloque se apaga; el texto original se puede
 * recuperar, y la recuperación pide confirmación en una segunda pantalla.
 */
export const dynamic = "force-dynamic";

/** Nombre humano y ubicación de cada bloque. */
const NOMBRES: Record<string, { nombre: string; donde: string }> = {
  hero: { nombre: "Portada — titular", donde: "Lo primero que se ve al abrir la web." },
  marquee: { nombre: "Cinta deslizante", donde: "La banda oscura con frases que se mueve sola." },
  coleccion: { nombre: "Nuevas llegadas", donde: "La rejilla de prendas. Las prendas salen del catálogo; aquí se editan los textos." },
  cita: { nombre: "Frase destacada", donde: "La frase grande en cursiva entre dos secciones." },
  filosofia: { nombre: "Filosofía", donde: "La sección oscura con las cuatro palabras." },
  boutique: { nombre: "La boutique", donde: "Las fotos de la tienda y la lista de ventajas." },
  comoComprar: { nombre: "Cómo comprar", donde: "Los tres pasos numerados." },
  visitanos: { nombre: "Visítanos", donde: "La tarjeta con el mapa. La dirección y el horario salen de Ajustes." },
  instagram: { nombre: "Instagram", donde: "La rejilla de fotos del final." },
  banner: { nombre: "Franja de aviso", donde: "Una tira para anunciar algo puntual. Normalmente apagada." },
};

function nombreDe(kind: string): { nombre: string; donde: string } {
  return NOMBRES[kind] ?? { nombre: kind, donde: "Sección de la portada." };
}

/** dataJson guarda `{ items: string[] }`; un JSON roto no puede tumbar la pantalla. */
function leerItems(dataJson: string): string[] {
  try {
    const crudo: unknown = JSON.parse(dataJson || "{}");
    if (crudo && typeof crudo === "object" && Array.isArray((crudo as { items?: unknown }).items)) {
      return ((crudo as { items: unknown[] }).items).filter((i): i is string => typeof i === "string");
    }
  } catch {
    /* se edita como si estuviera vacío: mejor eso que una pantalla en blanco */
  }
  return [];
}

type Props = {
  // En Next 15 searchParams es una promesa.
  searchParams: Promise<{ bloque?: string; ok?: string; restaurar?: string }>;
};

export default async function ContenidoPage({ searchParams }: Props) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const bloques = await db.homeBlock.findMany({ orderBy: [{ position: "asc" }, { kind: "asc" }] });

  const abierto = sp.bloque ? bloques.find((b) => b.id === sp.bloque) ?? null : null;
  const visibles = bloques.filter((b) => b.isVisible).length;

  const editable: BloqueEditable | null = abierto
    ? {
        id: abierto.id,
        kind: abierto.kind,
        nombre: nombreDe(abierto.kind).nombre,
        title: abierto.title,
        subtitle: abierto.subtitle,
        body: abierto.body,
        imageUrl: abierto.imageUrl ?? "",
        linkUrl: abierto.linkUrl ?? "",
        linkLabel: abierto.linkLabel,
        items: leerItems(abierto.dataJson),
      }
    : null;

  return (
    <>
      <PageHeader
        title="Portada"
        subtitle={
          bloques.length > 0
            ? `Las secciones de tu página de inicio, en el orden en que se ven · ${visibles} de ${bloques.length} encendidas`
            : "Las secciones de tu página de inicio: textos, fotos y en qué orden salen"
        }
        actions={
          <a className="adm-btn adm-btn-ghost adm-btn-md" href="/" target="_blank" rel="noreferrer">
            Ver la portada
          </a>
        }
      />

      {sp.ok === "sembrado" ? (
        <div className="cnt-aviso cnt-aviso-ok">
          Listo: la portada ya se puede editar desde aquí, con los textos que tiene hoy la web.
        </div>
      ) : null}
      {sp.ok === "restaurado" ? (
        <div className="cnt-aviso cnt-aviso-ok">Se volvió a poner el texto original de esa sección.</div>
      ) : null}

      {bloques.length === 0 ? (
        <Card>
          <EmptyState
            title="Todavía no puedes editar la portada"
            text="Tu web ya tiene una portada escrita. Pulsa el botón y la copiamos aquí tal cual está, para que puedas cambiar textos, fotos y el orden sin tocar nada más. No cambia nada de lo que ve la clienta."
            action={
              <form action={sembrarBloques}>
                <Button type="submit">Traer los textos de mi web</Button>
              </form>
            }
          />
        </Card>
      ) : null}

      {editable ? (
        <div id={`bloque-${editable.id}`}>
          <BlockEditor bloque={editable} />

          {sp.restaurar === "1" ? (
            <Card title="Volver al texto original">
              <div className="cnt-peligro">
                <h3>¿Seguro que quieres deshacer tus cambios en esta sección?</h3>
                <p>
                  Se borrará lo que hayas escrito en «{editable.nombre}» y volverá el texto que tenía la web al
                  principio. Las demás secciones no se tocan.
                </p>
                <form action={restaurarBloque} className="cnt-barra">
                  <input type="hidden" name="id" value={editable.id} />
                  <Button type="submit" variant="danger">
                    Sí, volver al texto original
                  </Button>
                  <Button href={`/admin/contenido?bloque=${editable.id}`} variant="ghost">
                    No, dejarlo como está
                  </Button>
                </form>
              </div>
            </Card>
          ) : (
            <p className="cnt-pista">
              ¿Lo has dejado peor que estaba?{" "}
              <Link className="adm-link" href={`/admin/contenido?bloque=${editable.id}&restaurar=1`}>
                Volver al texto original de esta sección
              </Link>
              .
            </p>
          )}
        </div>
      ) : null}

      {bloques.length > 0 ? (
        <Card title="Secciones de la portada" flush>
          <div className="cnt-lista">
            {bloques.map((b, i) => {
              const info = nombreDe(b.kind);
              const items = leerItems(b.dataJson);
              const avance =
                textoPlano([b.title, b.subtitle, b.body].filter(Boolean).join(" · "), 120) ||
                textoPlano(items.join(" · "), 120);

              return (
                <div key={b.id} id={`bloque-${b.id}`} className={`cnt-fila${b.isVisible ? "" : " is-oculta"}`}>
                  <div className="cnt-thumb">
                    {b.imageUrl ? (
                      // Foto real del bloque: se reconoce antes que cualquier texto.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={b.imageUrl} alt="" />
                    ) : (
                      <span aria-hidden="true">{i + 1}</span>
                    )}
                  </div>

                  <div className="cnt-cuerpo">
                    <div className="cnt-titulo">
                      <Link className="adm-link" href={`/admin/contenido?bloque=${b.id}`}>
                        {info.nombre}
                      </Link>
                      {b.isVisible ? <Badge tone="success">Se ve</Badge> : <Badge tone="neutral">Apagada</Badge>}
                    </div>
                    <div className="cnt-donde">{info.donde}</div>
                    <div className="cnt-avance">{avance}</div>
                  </div>

                  <div className="cnt-acciones">
                    <form action={moverBloque} className="cnt-forma">
                      <input type="hidden" name="id" value={b.id} />
                      <input type="hidden" name="direccion" value="arriba" />
                      <button className="cnt-flecha" type="submit" disabled={i === 0} aria-label={`Subir ${info.nombre}`}>
                        ↑
                      </button>
                    </form>
                    <form action={moverBloque} className="cnt-forma">
                      <input type="hidden" name="id" value={b.id} />
                      <input type="hidden" name="direccion" value="abajo" />
                      <button
                        className="cnt-flecha"
                        type="submit"
                        disabled={i === bloques.length - 1}
                        aria-label={`Bajar ${info.nombre}`}
                      >
                        ↓
                      </button>
                    </form>
                    <form action={alternarBloque} className="cnt-forma">
                      <input type="hidden" name="id" value={b.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        {b.isVisible ? "Apagar" : "Encender"}
                      </Button>
                    </form>
                    <Button href={`/admin/contenido?bloque=${b.id}`} size="sm">
                      Editar
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {bloques.length > 0 ? (
        <p className="cnt-pista">
          Las prendas de «Nuevas llegadas» salen solas del catálogo, y la dirección, el horario y el Instagram salen de{" "}
          <Link className="adm-link" href="/admin/ajustes">
            Ajustes
          </Link>
          . Aquí se editan los textos y las fotos fijas de la portada.
        </p>
      ) : null}
    </>
  );
}
