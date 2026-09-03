import { cache } from "react";
import { db } from "@/lib/db";
import { ANCLAS_PORTADA, anclasDePortada, cargarPortada, type EstadoAncla } from "@/lib/home-content";
import { piezasEscasas } from "@/lib/escasez";
import { getSettings } from "@/lib/settings";

/**
 * Navegación del escaparate: los enlaces de la barra de arriba y los del pie.
 *
 * Por qué existe este fichero
 * ───────────────────────────
 * Hasta ahora los enlaces estaban escritos dentro de `SiteNav` y `SiteFooter`, y
 * la pantalla `/admin/menus` guardaba `MenuItem` que nadie leía: Madeline editaba,
 * guardaba, iba a mirar y no pasaba nada. Aquí se junta todo en un único sitio.
 *
 * La regla que manda: **si no hay nada configurado, la web se ve exactamente como
 * hoy.** Por eso los enlaces que estaban escritos en el código no se han borrado,
 * se han movido aquí como VALOR POR DEFECTO. La tabla `MenuItem` vacía devuelve
 * literalmente lo mismo que se veía antes; solo cuando ella guarda sus propios
 * enlaces se sustituyen.
 */

/** Un enlace ya listo para pintar. `externo` decide `<Link>` o `<a target="_blank">`. */
export type EnlaceMenu = {
  href: string;
  label: string;
  externo: boolean;
};

export type ClaveMenu = "main" | "footer";

export const CLAVES_MENU: ClaveMenu[] = ["main", "footer"];

/* ─────────────────────── valores por defecto ─────────────────────── */

/**
 * Los enlaces de la barra de arriba, copiados TAL CUAL de como estaban escritos
 * en `SiteNav`. Mismo texto (incluida la mayúscula de "Llegadas"), mismo orden.
 * Si esto cambia, cambia la web de una clienta real sin que ella lo haya pedido.
 */
export const MENU_PRINCIPAL_POR_DEFECTO: EnlaceMenu[] = [
  { href: "/tienda", label: "Nuevas Llegadas", externo: false },
  // «Últimas piezas» no estaba en el menú original: se añadió cuando la sección
  // de escasez sustituyó a la de Filosofía en la portada. Las dos siguen aquí a
  // propósito — el filtro de más abajo enseña la que de verdad se esté pintando,
  // así que si Madeline vuelve a encender Filosofía su enlace reaparece solo.
  { href: "/#escasez", label: "Últimas piezas", externo: false },
  { href: "/#filosofia", label: "Filosofía", externo: false },
  { href: "/#boutique", label: "La Boutique", externo: false },
  { href: "/#visitanos", label: "Visítanos", externo: false },
];

/**
 * Los enlaces de la columna "Tienda" del pie, copiados tal cual de `SiteFooter`.
 * Las columnas de dirección e Instagram NO son menú: salen de Ajustes y siguen
 * saliendo de Ajustes.
 */
export const MENU_PIE_POR_DEFECTO: EnlaceMenu[] = [
  { href: "/tienda", label: "Ver todas las piezas", externo: false },
  { href: "/carrito", label: "Tu carrito", externo: false },
];

export function menuPorDefecto(menu: ClaveMenu): EnlaceMenu[] {
  return menu === "footer" ? MENU_PIE_POR_DEFECTO : MENU_PRINCIPAL_POR_DEFECTO;
}

/* ─────────────────────── enlaces rotos ─────────────────────── */

/**
 * Un `MenuItem` puede apuntar a una colección o a una página que ya no existe
 * (Madeline la borró) o que dejó de ser pública (volvió a borrador). Dejar ese
 * enlace en la web es peor que no tenerlo: la clienta pulsa y se come un 404.
 *
 * Decisión: **se oculta en la tienda y se avisa en el panel.** No se borra —
 * borrar la fila sería decidir por ella, y el destino puede volver (basta con
 * publicar otra vez la página). Y no se convierte en texto muerto porque un
 * enlace que no lleva a ningún sitio confunde igual.
 */
export type MotivoRoto =
  | "coleccion-inexistente"
  | "coleccion-oculta"
  | "pagina-inexistente"
  | "pagina-borrador"
  | "seccion-apagada"
  | "seccion-vacia"
  | "seccion-inexistente";

export function explicarRoto(motivo: MotivoRoto): string {
  switch (motivo) {
    case "seccion-apagada":
      return "Esa sección de la portada está apagada, así que este enlace no se enseña en la web.";
    case "seccion-vacia":
      return "Ahora mismo no queda ninguna pieza a punto de agotarse, así que esa sección no se está pintando y este enlace no se enseña. Volverá solo cuando el stock baje.";
    case "seccion-inexistente":
      return "Esa parte de la portada ya no existe, así que este enlace no se enseña en la web.";
    case "coleccion-inexistente":
      return "Esa colección ya no existe, así que este enlace no se enseña en la web.";
    case "coleccion-oculta":
      return "Esa colección está apagada, así que este enlace no se enseña en la web.";
    case "pagina-inexistente":
      return "Esa página ya no existe, así que este enlace no se enseña en la web.";
    case "pagina-borrador":
      return "Esa página sigue en borrador. Publícala y el enlace aparecerá solo en la web.";
  }
}

const RE_COLECCION = /^\/coleccion\/([^/?#]+)/i;
const RE_PAGINA = /^\/pagina\/([^/?#]+)/i;
/** `/#escasez`, `#escasez` y `/#escasez?x=1` valen igual: lo que importa es el id. */
const RE_ANCLA = /^\/?#([^/?#]+)$/;

/** Destinos internos que se pueden validar. El resto (/, /tienda, https://…) siempre valen. */
type Destinos = {
  colecciones: Map<string, boolean>; // slug -> isVisible
  paginas: Map<string, string>; // slug -> status
  /** En qué estado está cada ancla de la portada AHORA MISMO. */
  anclas: Map<string, EstadoAncla>;
};

/**
 * `cache` de React memoiza por petición: el nav y el pie se pintan en el mismo
 * render y comparten estas consultas en vez de repetirlas.
 */
const leerDestinos = cache(async (): Promise<Destinos> => {
  const [colecciones, paginas, anclas] = await Promise.all([
    db.collection.findMany({ select: { slug: true, isVisible: true } }),
    db.page.findMany({ select: { slug: true, status: true } }),
    leerAnclas(),
  ]);

  return {
    colecciones: new Map(colecciones.map((c) => [c.slug, c.isVisible])),
    paginas: new Map(paginas.map((p) => [p.slug, p.status])),
    anclas,
  };
});

/**
 * Qué secciones de la portada existen ahora mismo.
 *
 * Son dos consultas pequeñas (los bloques y el catálogo) que se hacen una vez
 * por petición gracias a `cache`, y en la propia portada salen gratis: la página
 * ya pide las dos cosas y comparte el resultado.
 */
const leerAnclas = cache(async (): Promise<Map<string, EstadoAncla>> => {
  try {
    const settings = await getSettings();
    const portada = await cargarPortada(settings);
    const escasas = portada.exclusividad.visible
      ? await piezasEscasas(portada.exclusividad.umbral)
      : [];
    return anclasDePortada(portada.orden, escasas.length > 0);
  } catch {
    // Si no se puede saber, no se esconde nada: un enlace de más molesta menos
    // que una barra de navegación que se queda coja por un fallo pasajero.
    return new Map(ANCLAS_PORTADA.map((a) => [a.ancla, "viva" as EstadoAncla]));
  }
});

function comprobarDestino(url: string, destinos: Destinos): MotivoRoto | null {
  const coleccion = RE_COLECCION.exec(url);
  if (coleccion) {
    const slug = decodeURIComponent(coleccion[1]);
    const visible = destinos.colecciones.get(slug);
    if (visible === undefined) return "coleccion-inexistente";
    return visible ? null : "coleccion-oculta";
  }

  const pagina = RE_PAGINA.exec(url);
  if (pagina) {
    const slug = decodeURIComponent(pagina[1]);
    const estado = destinos.paginas.get(slug);
    if (estado === undefined) return "pagina-inexistente";
    // `/pagina/[slug]` responde 404 a todo lo que no esté publicado.
    return estado === "published" ? null : "pagina-borrador";
  }

  const ancla = RE_ANCLA.exec(url);
  if (ancla) {
    const estado = destinos.anclas.get(decodeURIComponent(ancla[1]));
    if (estado === undefined) return "seccion-inexistente";
    if (estado === "apagada") return "seccion-apagada";
    if (estado === "vacia") return "seccion-vacia";
    return null;
  }

  return null;
}

function esExterno(url: string): boolean {
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(url);
}

/* ─────────────────────── carga para la tienda ─────────────────────── */

const leerItems = cache(async () => {
  return db.menuItem.findMany({
    orderBy: [{ position: "asc" }, { label: "asc" }],
    select: { id: true, menu: true, label: true, url: true, position: true, isVisible: true },
  });
});

/**
 * Los enlaces de un menú, listos para pintar.
 *
 * - Sin nada guardado → los enlaces de siempre (la web no cambia).
 * - Con enlaces guardados → solo los encendidos y cuyo destino existe de verdad.
 * - Si después de filtrar no queda ninguno → otra vez los de siempre. Un menú
 *   vacío deja un hueco en el diseño; es preferible enseñar los de fábrica y
 *   avisar en el panel de lo que está roto que servir una barra a medias.
 *
 * ⚠️ **Los de fábrica también se filtran.** Antes no, y por eso la barra estuvo
 * enseñando «Filosofía» después de que esa sección se apagara en la portada: la
 * clienta pulsaba y no pasaba nada. Que un enlace esté escrito en el código no lo
 * hace verdadero.
 */
export async function cargarMenu(menu: ClaveMenu): Promise<EnlaceMenu[]> {
  const [items, destinos] = await Promise.all([leerItems(), leerDestinos()]);
  const propios = items.filter((i) => i.menu === menu);

  if (propios.length > 0) {
    const enlaces: EnlaceMenu[] = [];
    for (const item of propios) {
      if (!item.isVisible) continue;
      if (comprobarDestino(item.url, destinos)) continue;
      enlaces.push({ href: item.url, label: item.label, externo: esExterno(item.url) });
    }
    if (enlaces.length > 0) return enlaces;
  }

  const defecto = menuPorDefecto(menu).filter((e) => !comprobarDestino(e.href, destinos));
  // `/tienda` no se puede romper, así que esto no debería vaciarse nunca; si
  // pasara, una barra con enlaces imperfectos sigue siendo mejor que ninguna.
  return defecto.length > 0 ? defecto : menuPorDefecto(menu);
}

/**
 * Las páginas publicadas marcadas "sale en el pie".
 *
 * Se listan SIEMPRE, haya menús configurados o no, y en su propio bloque: son la
 * política de devoluciones, los envíos, los términos. Existían desde hace
 * semanas y no había ni un enlace hacia ellas en toda la web — contenido
 * invisible, que es peor que no tenerlo, porque la clienta lo busca y no lo
 * encuentra.
 */
export async function paginasDelPie(): Promise<EnlaceMenu[]> {
  const paginas = await db.page.findMany({
    where: { status: "published", showInFooter: true },
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: { slug: true, title: true },
  });

  return paginas.map((p) => ({ href: `/pagina/${p.slug}`, label: p.title, externo: false }));
}

/* ─────────────────────── revisión para el panel ─────────────────────── */

export type ItemMenuRevisado = {
  id: string;
  menu: string;
  label: string;
  url: string;
  position: number;
  isVisible: boolean;
  /** `null` = el enlace funciona. Si no, por qué la tienda no lo enseña. */
  roto: MotivoRoto | null;
};

/**
 * Todos los enlaces guardados con su diagnóstico, para que el panel pueda decir
 * "esto no se está viendo, y este es el motivo" en vez de enseñar una lista que
 * no se corresponde con la web.
 */
export async function revisarMenus(): Promise<ItemMenuRevisado[]> {
  const [items, destinos] = await Promise.all([leerItems(), leerDestinos()]);
  return items.map((item) => ({ ...item, roto: comprobarDestino(item.url, destinos) }));
}

/**
 * En qué estado está cada sección de la portada, para que el desplegable de
 * `/admin/menus` no ofrezca como destino algo que la web no está pintando.
 */
export async function estadoDeAnclas(): Promise<Map<string, EstadoAncla>> {
  return leerAnclas();
}
