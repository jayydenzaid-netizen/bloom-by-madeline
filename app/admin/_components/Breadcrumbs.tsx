import Link from "next/link";
import { db } from "@/lib/db";

/**
 * Migas de pan de las pantallas de detalle.
 *
 * Vive en el layout y no dentro de cada página a propósito: hay veinticinco
 * pantallas y ninguna debería tener que acordarse de pintar su propia miga.
 * El layout ya sabe la ruta (`x-pathname`, lo pone middleware.ts), así que la
 * miga se deduce de la URL y sale sola en todas.
 *
 * Solo aparece a partir del segundo nivel (`/admin/pedidos/BLM-1001`,
 * `/admin/productos/nuevo`). En las pantallas de primer nivel sobra: para eso
 * está el sidebar, y una miga que diga "Panel › Pedidos" encima de un título
 * que ya dice "Pedidos" es ruido.
 *
 * Cuando el último tramo es un id, se busca el nombre de verdad: "Panel ›
 * Pedidos › BLM-1004" sirve; "Panel › Pedidos › cmf3x9…" no le dice nada a
 * nadie. Es una lectura por clave primaria y va en paralelo con el resto del
 * render.
 */

/** Secciones de primer nivel. El texto es el mismo que usa el sidebar. */
const SECCIONES: Record<string, string> = {
  pedidos: "Pedidos",
  carritos: "Carritos abandonados",
  productos: "Productos",
  colecciones: "Colecciones",
  inventario: "Inventario",
  resenas: "Reseñas",
  importar: "Importar",
  pos: "Mostrador",
  clientes: "Clientas",
  descuentos: "Descuentos",
  informes: "Informes",
  contenido: "Portada",
  paginas: "Páginas",
  menus: "Menús",
  medios: "Medios",
  ajustes: "Ajustes",
  envios: "Envíos",
  plantillas: "Plantillas",
  herramientas: "Herramientas",
  equipo: "Equipo",
  actividad: "Actividad",
  cuenta: "Tu cuenta",
};

/** Tramos que NO son un id sino una subpantalla con nombre propio. */
const SUBSECCIONES: Record<string, string> = {
  nuevo: "Nuevo",
  nueva: "Nueva",
  "nueva-prenda": "Añadir prenda",
  movimientos: "Movimientos",
};

type Miga = { label: string; href?: string };

/** Nombre legible de la ficha que se está mirando. Nunca revienta la página. */
async function nombreDeFicha(seccion: string, id: string): Promise<string | null> {
  try {
    switch (seccion) {
      case "pedidos": {
        const fila = await db.order.findUnique({ where: { id }, select: { number: true } });
        return fila?.number ?? null;
      }
      case "productos": {
        const fila = await db.product.findUnique({ where: { id }, select: { title: true } });
        return fila?.title ?? null;
      }
      case "clientes": {
        const fila = await db.customer.findUnique({ where: { id }, select: { name: true, email: true } });
        return fila ? fila.name || fila.email : null;
      }
      case "descuentos": {
        const fila = await db.discount.findUnique({ where: { id }, select: { code: true } });
        return fila?.code ?? null;
      }
      case "paginas": {
        const fila = await db.page.findUnique({ where: { id }, select: { title: true } });
        return fila?.title ?? null;
      }
      default:
        return null;
    }
  } catch {
    // Base de datos caída o id con formato raro: la miga se degrada a "Detalle"
    // y la pantalla sigue funcionando. Una miga no puede tumbar una página.
    return null;
  }
}

export default async function Breadcrumbs({ path }: { path: string | null }) {
  if (!path || !path.startsWith("/admin")) return null;

  const tramos = path.split("/").filter(Boolean).slice(1); // fuera el "admin"
  if (tramos.length < 2) return null;

  const [seccion, segundo] = tramos;
  const etiquetaSeccion = SECCIONES[seccion];
  if (!etiquetaSeccion) return null; // ruta desconocida: mejor nada que una miga inventada

  const migas: Miga[] = [
    { label: "Panel", href: "/admin" },
    { label: etiquetaSeccion, href: `/admin/${seccion}` },
  ];

  const subseccion = SUBSECCIONES[segundo];
  if (subseccion) {
    migas.push({ label: subseccion });
  } else {
    const nombre = await nombreDeFicha(seccion, segundo);
    migas.push({ label: nombre ?? "Detalle" });
  }

  const ultima = migas.length - 1;

  return (
    <nav className="adm-crumbs" aria-label="Dónde estás">
      <ol>
        {migas.map((miga, i) => (
          <li key={`${miga.label}-${i}`}>
            {miga.href && i !== ultima ? (
              <Link href={miga.href}>{miga.label}</Link>
            ) : (
              <span aria-current="page">{miga.label}</span>
            )}
            {i !== ultima ? (
              <span className="adm-crumbs-sep" aria-hidden="true">
                ›
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
