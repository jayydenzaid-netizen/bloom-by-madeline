import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge, Button, Card, EmptyState, PageHeader } from "../_components/ui";
import {
  EditorMenu,
  type ItemMenuEditable,
  type OpcionDestino,
} from "../contenido/_components/BlockEditor";
import { alternarItemMenu, eliminarItemMenu, moverItemMenu, sembrarMenus } from "./actions";
import "../contenido/contenido.css";

/**
 * Menús del sitio: los enlaces de arriba y los del pie.
 *
 * Se reordena con flechas, no arrastrando. Arrastrar en un móvil con el pulgar,
 * sobre una lista que además hace scroll, falla la mitad de las veces; una
 * flecha no falla nunca.
 */
export const dynamic = "force-dynamic";

const MENUS: { clave: string; nombre: string; donde: string }[] = [
  { clave: "main", nombre: "Menú de arriba", donde: "La barra fija que se ve en todas las páginas." },
  { clave: "footer", nombre: "Menú del pie", donde: "Los enlaces del final de la página: envíos, devoluciones, condiciones…" },
];

type Props = {
  searchParams: Promise<{ menu?: string; item?: string; borrar?: string; ok?: string }>;
};

export default async function MenusPage({ searchParams }: Props) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const menuActivo = sp.menu === "footer" ? "footer" : "main";

  const [items, colecciones, paginas] = await Promise.all([
    db.menuItem.findMany({ orderBy: [{ menu: "asc" }, { position: "asc" }, { label: "asc" }] }),
    db.collection.findMany({ where: { isVisible: true }, orderBy: { title: "asc" }, select: { title: true, slug: true } }),
    db.page.findMany({ orderBy: { title: "asc" }, select: { title: true, slug: true, status: true } }),
  ]);

  // Destinos que se pueden elegir sin escribir una dirección a mano. Se arman
  // desde la base: si Madeline crea una colección nueva, aparece aquí sola.
  const destinos: OpcionDestino[] = [
    { grupo: "Tu tienda", valor: "/", etiqueta: "Inicio" },
    { grupo: "Tu tienda", valor: "/tienda", etiqueta: "Toda la tienda" },
    { grupo: "Tu tienda", valor: "/carrito", etiqueta: "Carrito" },
    ...colecciones.map((c) => ({
      grupo: "Colecciones",
      valor: `/coleccion/${c.slug}`,
      etiqueta: c.title,
    })),
    ...paginas.map((p) => ({
      grupo: "Páginas",
      valor: `/pagina/${p.slug}`,
      etiqueta: p.status === "published" ? p.title : `${p.title} (todavía en borrador)`,
    })),
    { grupo: "Secciones de la portada", valor: "/#coleccion", etiqueta: "Nuevas llegadas" },
    { grupo: "Secciones de la portada", valor: "/#filosofia", etiqueta: "Filosofía" },
    { grupo: "Secciones de la portada", valor: "/#boutique", etiqueta: "La boutique" },
    { grupo: "Secciones de la portada", valor: "/#visitanos", etiqueta: "Visítanos" },
  ];

  const enEdicion = sp.item ? items.find((i) => i.id === sp.item) ?? null : null;
  const editable: ItemMenuEditable = enEdicion
    ? { id: enEdicion.id, menu: enEdicion.menu, label: enEdicion.label, url: enEdicion.url }
    : { id: null, menu: menuActivo, label: "", url: "" };

  const nombreMenu = (clave: string) => MENUS.find((m) => m.clave === clave)?.nombre ?? clave;

  return (
    <>
      <PageHeader
        title="Menús"
        subtitle="Los enlaces de la barra de arriba y los del pie de la web"
        actions={
          <a className="adm-btn adm-btn-ghost adm-btn-md" href="/" target="_blank" rel="noreferrer">
            Ver la web
          </a>
        }
      />

      {sp.ok === "sembrado" ? (
        <div className="cnt-aviso cnt-aviso-ok">Menús creados con los enlaces que ya tenía tu web.</div>
      ) : null}
      {sp.ok === "creado" ? <div className="cnt-aviso cnt-aviso-ok">Enlace añadido al final del menú.</div> : null}
      {sp.ok === "guardado" ? <div className="cnt-aviso cnt-aviso-ok">Enlace guardado.</div> : null}
      {sp.ok === "quitado" ? <div className="cnt-aviso cnt-aviso-info">Enlace quitado del menú.</div> : null}

      {items.length === 0 ? (
        <Card>
          <EmptyState
            title="Los menús todavía no se editan desde aquí"
            text="Tu web ya tiene sus enlaces de arriba. Pulsa y los copiamos tal cual, para que puedas cambiarlos, ordenarlos o añadir los tuyos."
            action={
              <form action={sembrarMenus}>
                <Button type="submit">Traer los enlaces de mi web</Button>
              </form>
            }
          />
        </Card>
      ) : null}

      {enEdicion && sp.borrar === "1" ? (
        <Card title="Quitar el enlace">
          <div className="cnt-peligro">
            <h3>¿Quitamos «{enEdicion.label}» del {nombreMenu(enEdicion.menu).toLowerCase()}?</h3>
            <p>
              Deja de verse en la web. Si solo quieres esconderlo un tiempo, mejor usa «Apagar»: así lo recuperas con un
              clic y no tienes que volver a escribirlo.
            </p>
            <form action={eliminarItemMenu} className="cnt-barra">
              <input type="hidden" name="id" value={enEdicion.id} />
              <Button type="submit" variant="danger">
                Sí, quitar el enlace
              </Button>
              <Button href={`/admin/menus?menu=${enEdicion.menu}`} variant="ghost">
                No, dejarlo
              </Button>
            </form>
          </div>
        </Card>
      ) : (
        <EditorMenu
          item={editable}
          destinos={destinos}
          titulo={enEdicion ? `Editar «${enEdicion.label}»` : `Añadir un enlace al ${nombreMenu(menuActivo).toLowerCase()}`}
        />
      )}

      {MENUS.map((menu) => {
        const propios = items.filter((i) => i.menu === menu.clave);

        return (
          <Card
            key={menu.clave}
            title={menu.nombre}
            flush={propios.length > 0}
            actions={
              <Button href={`/admin/menus?menu=${menu.clave}`} variant="ghost" size="sm">
                Añadir enlace
              </Button>
            }
          >
            {propios.length === 0 ? (
              <p className="cnt-pista">
                {menu.donde} Todavía no hay enlaces aquí — añádelos con el botón de arriba.
              </p>
            ) : (
              <div className="cnt-lista">
                {propios.map((item, i) => (
                  <div key={item.id} className={`cnt-fila${item.isVisible ? "" : " is-oculta"}`}>
                    <div className="cnt-cuerpo">
                      <div className="cnt-titulo">
                        <Link className="adm-link" href={`/admin/menus?menu=${item.menu}&item=${item.id}`}>
                          {item.label}
                        </Link>
                        {item.isVisible ? <Badge tone="success">Se ve</Badge> : <Badge tone="neutral">Apagado</Badge>}
                      </div>
                      <div className="cnt-url">{item.url}</div>
                    </div>

                    <div className="cnt-acciones">
                      <form action={moverItemMenu} className="cnt-forma">
                        <input type="hidden" name="id" value={item.id} />
                        <input type="hidden" name="direccion" value="arriba" />
                        <button className="cnt-flecha" type="submit" disabled={i === 0} aria-label={`Subir ${item.label}`}>
                          ↑
                        </button>
                      </form>
                      <form action={moverItemMenu} className="cnt-forma">
                        <input type="hidden" name="id" value={item.id} />
                        <input type="hidden" name="direccion" value="abajo" />
                        <button
                          className="cnt-flecha"
                          type="submit"
                          disabled={i === propios.length - 1}
                          aria-label={`Bajar ${item.label}`}
                        >
                          ↓
                        </button>
                      </form>
                      <form action={alternarItemMenu} className="cnt-forma">
                        <input type="hidden" name="id" value={item.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          {item.isVisible ? "Apagar" : "Encender"}
                        </Button>
                      </form>
                      <Button href={`/admin/menus?menu=${item.menu}&item=${item.id}`} size="sm">
                        Editar
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}

      <p className="cnt-pista">
        El pie de la web también enseña solo las páginas marcadas como «sale en el pie» en{" "}
        <Link className="adm-link" href="/admin/paginas">
          Páginas
        </Link>
        .
      </p>
    </>
  );
}
