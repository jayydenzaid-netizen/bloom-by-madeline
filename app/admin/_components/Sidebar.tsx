"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { BotonBuscar } from "./CommandPalette";

/**
 * Navegación del panel.
 *
 * Es cliente porque necesita saber la ruta activa (usePathname) y abrir/cerrar
 * los grupos; no hace ninguna otra cosa.
 *
 * El orden NO es alfabético ni "por importancia técnica": es el orden en que
 * Madeline trabaja de verdad. Abre el panel, mira qué ha entrado (Resumen),
 * despacha lo que hay que despachar (Pedidos), toca catálogo (Productos), trae
 * cosas nuevas (Importar) y, jueves a sábado de 1 a 8, cobra en el mostrador
 * (Mostrador). Todo lo demás se consulta de vez en cuando y vive más abajo.
 *
 * En escritorio es la columna oscura de la izquierda, con los grupos plegables
 * y el grupo del enlace activo abierto. Por debajo de 900 px se convierte en
 * barra inferior con lo del día a día —Resumen · Pedidos · Mostrador ·
 * Productos— y una hoja "Más" con el menú COMPLETO, agrupado igual. Un menú
 * hamburguesa arriba obligaría a dos toques para cada sección, y ella despacha
 * pedidos con el teléfono en una mano.
 *
 * Permisos: lo que es solo de la dueña (`soloDuena`) ni se pinta para una
 * ayudante. Los criterios salen de lib/permissions.ts — descuentos, informes,
 * ajustes, contenido, equipo y actividad son de owner. Enseñar un enlace que va
 * a rebotar es peor que no enseñarlo.
 */

const s = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/* ─────────────────────────────── iconos ─────────────────────────────── */

const I = {
  casa: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M3 10.5 12 3l9 7.5" />
      <path {...s} d="M5 9.5V21h14V9.5" />
      <path {...s} d="M10 21v-6h4v6" />
    </svg>
  ),
  bolsa: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M6 7h12l1.2 12.2a1.5 1.5 0 0 1-1.5 1.8H6.3a1.5 1.5 0 0 1-1.5-1.8Z" />
      <path {...s} d="M9 10V6.5a3 3 0 0 1 6 0V10" />
    </svg>
  ),
  carrito: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M3 4h2.2l2.3 11h9.8l2-7.5H6.4" />
      <circle {...s} cx="9" cy="19" r="1.4" />
      <circle {...s} cx="17" cy="19" r="1.4" />
    </svg>
  ),
  caja: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M12 3 4 7v10l8 4 8-4V7Z" />
      <path {...s} d="m4 7 8 4 8-4" />
      <path {...s} d="M12 11v10" />
    </svg>
  ),
  cuadros: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect {...s} x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect {...s} x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect {...s} x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect {...s} x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  ),
  percha: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M12 7a2 2 0 1 1 2-2" />
      <path {...s} d="M12 7v2.2L3.6 15.6A1.5 1.5 0 0 0 4.5 18h15a1.5 1.5 0 0 0 .9-2.4L12 9.2" />
    </svg>
  ),
  estrella: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="m12 4 2.4 5 5.4.7-3.9 3.8 1 5.4-4.9-2.6-4.9 2.6 1-5.4L4.2 9.7 9.6 9Z" />
    </svg>
  ),
  descarga: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M12 3v12" />
      <path {...s} d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path {...s} d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17" />
    </svg>
  ),
  caja_registradora: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect {...s} x="3" y="10" width="18" height="10" rx="1.6" />
      <path {...s} d="M7 10V6.5A1.5 1.5 0 0 1 8.5 5h7A1.5 1.5 0 0 1 17 6.5V10" />
      <path {...s} d="M9 14.5h6" />
    </svg>
  ),
  persona: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle {...s} cx="12" cy="8" r="3.5" />
      <path {...s} d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  ),
  etiqueta: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M4 11.5V4.8A.8.8 0 0 1 4.8 4h6.7l8 8-7.5 7.5Z" />
      <circle {...s} cx="8.3" cy="8.3" r="1.3" />
    </svg>
  ),
  grafica: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M4 20V4" />
      <path {...s} d="M4 20h16" />
      <path {...s} d="M8 17V11" />
      <path {...s} d="M13 17V7" />
      <path {...s} d="M18 17v-4" />
    </svg>
  ),
  escaparate: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M4 9h16v10.5a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5Z" />
      <path {...s} d="M4 9 5.5 4h13L20 9" />
      <path {...s} d="M9.5 20v-6h5v6" />
    </svg>
  ),
  documento: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M6 3h8l4 4v14H6Z" />
      <path {...s} d="M14 3v4h4" />
      <path {...s} d="M9 12h6M9 16h6" />
    </svg>
  ),
  lista: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  ),
  imagen: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect {...s} x="3.5" y="5" width="17" height="14" rx="1.8" />
      <circle {...s} cx="9" cy="10" r="1.6" />
      <path {...s} d="m4.5 17 4.5-4 4 3.2 3-2.6 3.5 3.4" />
    </svg>
  ),
  engranaje: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle {...s} cx="12" cy="12" r="3" />
      <path
        {...s}
        d="M19.5 12a7.5 7.5 0 0 0-.12-1.3l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2.3-1.3L14.4 3H9.6l-.4 2.5a7.6 7.6 0 0 0-2.3 1.3l-2.3-1-2 3.4 2 1.5a7.5 7.5 0 0 0 0 2.6l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 2.3 1.3l.4 2.5h4.8l.4-2.5a7.6 7.6 0 0 0 2.3-1.3l2.3 1 2-3.4-2-1.5c.08-.42.12-.86.12-1.3Z"
      />
    </svg>
  ),
  camion: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M3 6.5h10.5v10H3Z" />
      <path {...s} d="M13.5 10H17l3 3v3.5h-6.5Z" />
      <circle {...s} cx="7" cy="18" r="1.5" />
      <circle {...s} cx="17" cy="18" r="1.5" />
    </svg>
  ),
  sobre: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect {...s} x="3" y="5.5" width="18" height="13" rx="1.6" />
      <path {...s} d="m3.6 7 8.4 6 8.4-6" />
    </svg>
  ),
  llave: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...s} d="M10.5 10.5a4 4 0 1 0-3 3l1.5 1.5V17h2v2h2v2h3v-3.6Z" />
    </svg>
  ),
  reloj: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle {...s} cx="12" cy="12" r="8.5" />
      <path {...s} d="M12 7v5.3l3.2 2" />
    </svg>
  ),
  tarjeta: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect {...s} x="3" y="6" width="18" height="13" rx="2" />
      <path {...s} d="M3 10.5h18" />
      <path {...s} d="M7 15h4" />
    </svg>
  ),
} satisfies Record<string, ReactNode>;

/* ────────────────────────────── el mapa ────────────────────────────── */

type Item = {
  href: string;
  label: string;
  icon: ReactNode;
  /** Coincidencia exacta: /admin cuelga de la raíz y si no, siempre estaría activo. */
  exact?: boolean;
  /** Vive en la barra inferior del móvil. El resto, en la hoja "Más". */
  primary?: boolean;
  /** Solo la dueña. Ver lib/permissions.ts. */
  soloDuena?: boolean;
};

type Entrada =
  | { tipo: "link"; item: Item }
  | { tipo: "grupo"; id: string; label: string; icon: ReactNode; soloDuena?: boolean; items: Item[] };

const NAV: Entrada[] = [
  { tipo: "link", item: { href: "/admin", label: "Resumen", icon: I.casa, exact: true, primary: true } },

  {
    tipo: "grupo",
    id: "pedidos",
    label: "Pedidos",
    icon: I.bolsa,
    items: [
      { href: "/admin/pedidos", label: "Pedidos", icon: I.bolsa, primary: true },
      { href: "/admin/carritos", label: "Carritos abandonados", icon: I.carrito },
    ],
  },

  {
    tipo: "grupo",
    id: "catalogo",
    label: "Productos",
    icon: I.caja,
    items: [
      { href: "/admin/productos", label: "Productos", icon: I.caja, primary: true },
      { href: "/admin/colecciones", label: "Colecciones", icon: I.cuadros },
      { href: "/admin/inventario", label: "Inventario", icon: I.percha },
      { href: "/admin/resenas", label: "Reseñas", icon: I.estrella },
    ],
  },

  { tipo: "link", item: { href: "/admin/importar", label: "Importar", icon: I.descarga } },
  { tipo: "link", item: { href: "/admin/pos", label: "Mostrador", icon: I.caja_registradora, primary: true } },
  { tipo: "link", item: { href: "/admin/clientes", label: "Clientas", icon: I.persona } },
  { tipo: "link", item: { href: "/admin/descuentos", label: "Descuentos", icon: I.etiqueta, soloDuena: true } },
  { tipo: "link", item: { href: "/admin/informes", label: "Informes", icon: I.grafica, soloDuena: true } },

  {
    tipo: "grupo",
    id: "tienda",
    label: "Tienda",
    icon: I.escaparate,
    soloDuena: true,
    items: [
      { href: "/admin/contenido", label: "Portada", icon: I.escaparate, soloDuena: true },
      { href: "/admin/paginas", label: "Páginas", icon: I.documento, soloDuena: true },
      { href: "/admin/menus", label: "Menús", icon: I.lista, soloDuena: true },
      { href: "/admin/medios", label: "Medios", icon: I.imagen, soloDuena: true },
    ],
  },

  {
    tipo: "grupo",
    id: "ajustes",
    label: "Ajustes",
    icon: I.engranaje,
    soloDuena: true,
    items: [
      { href: "/admin/ajustes", label: "Ajustes", icon: I.engranaje, soloDuena: true },
      { href: "/admin/pagos", label: "Pagos", icon: I.tarjeta, soloDuena: true },
      { href: "/admin/envios", label: "Envíos", icon: I.camion, soloDuena: true },
      { href: "/admin/plantillas", label: "Plantillas", icon: I.sobre, soloDuena: true },
      { href: "/admin/herramientas", label: "Herramientas", icon: I.llave, soloDuena: true },
      { href: "/admin/equipo", label: "Equipo", icon: I.persona, soloDuena: true },
      { href: "/admin/actividad", label: "Actividad", icon: I.reloj, soloDuena: true },
    ],
  },
];

/** Rutas que existen pero no salen en el menú: se llega a ellas desde su sitio. */
const ACTIVA_TAMBIEN: Record<string, string> = {
  // El detalle de un movimiento de stock sigue siendo Inventario.
  "/admin/inventario/movimientos": "/admin/inventario",
};

function esActivo(pathname: string, item: Item): boolean {
  if (item.exact) return pathname === item.href;
  if (ACTIVA_TAMBIEN[pathname] === item.href) return true;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/* ────────────────────────────── componente ────────────────────────────── */

export default function Sidebar({
  adminName,
  storeName,
  rol,
}: {
  adminName: string;
  storeName: string;
  rol: "owner" | "staff";
}) {
  const pathname = usePathname() || "/admin";
  const [hojaAbierta, setHojaAbierta] = useState(false);
  // Solo guarda los grupos que la usuaria ha tocado a mano. Los demás siguen la
  // regla automática: abierto si contiene la pantalla en la que estás.
  const [tocados, setTocados] = useState<Record<string, boolean>>({});

  const puedeVer = (soloDuena?: boolean) => !soloDuena || rol === "owner";
  const entradas = NAV.filter((e) => puedeVer(e.tipo === "link" ? e.item.soloDuena : e.soloDuena)).map((e) =>
    e.tipo === "grupo" ? { ...e, items: e.items.filter((i) => puedeVer(i.soloDuena)) } : e,
  );

  const cerrarHoja = () => setHojaAbierta(false);

  const enlace = (item: Item, dentroDeGrupo: boolean) => {
    const activo = esActivo(pathname, item);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={[
          "adm-navlink",
          dentroDeGrupo ? "is-child" : "",
          item.primary ? "is-primary" : "",
          activo ? "is-active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-current={activo ? "page" : undefined}
        onClick={cerrarHoja}
      >
        {item.icon}
        <span>{item.label}</span>
      </Link>
    );
  };

  /** El sidebar de escritorio: grupos plegables. */
  const navEscritorio = entradas.map((entrada) => {
    if (entrada.tipo === "link") return enlace(entrada.item, false);

    const contieneActivo = entrada.items.some((i) => esActivo(pathname, i));
    const abierto = tocados[entrada.id] ?? contieneActivo;

    return (
      <div key={entrada.id} className={`adm-navgroup${abierto ? " is-open" : ""}`}>
        <button
          type="button"
          className={`adm-navlink adm-navgroup-head${contieneActivo && !abierto ? " has-active" : ""}`}
          aria-expanded={abierto}
          onClick={() => setTocados((t) => ({ ...t, [entrada.id]: !abierto }))}
        >
          {entrada.icon}
          <span>{entrada.label}</span>
          <svg className="adm-navgroup-chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path {...s} d="m8.5 5 7 7-7 7" />
          </svg>
        </button>
        <div className="adm-navgroup-items" hidden={!abierto}>
          {entrada.items.map((item) => enlace(item, true))}
        </div>
      </div>
    );
  });

  /**
   * La barra inferior del móvil: lista PLANA de lo del día a día.
   *
   * Se pinta aparte y no reaprovechando los grupos por un motivo concreto: un
   * grupo plegado se oculta con el atributo `hidden`, y `[hidden]` es sagrado
   * en este proyecto (regla 4 del contrato). Si "Pedidos" viviera dentro del
   * grupo plegable, cerrar el grupo en escritorio lo haría desaparecer también
   * de la barra del teléfono. Duplicar cuatro enlaces sale mucho más barato que
   * pelearse con `[hidden]` — que es justo la pelea que provocó el P0.
   */
  const primarios = entradas.flatMap((entrada) =>
    entrada.tipo === "link" ? (entrada.item.primary ? [entrada.item] : []) : entrada.items.filter((i) => i.primary),
  );

  /** La hoja "Más" del móvil: el menú entero, sin plegar, con sus títulos. */
  const navHoja = entradas.map((entrada) =>
    entrada.tipo === "link" ? (
      enlace(entrada.item, false)
    ) : (
      <div key={entrada.id} className="adm-sheet-group">
        <p className="adm-sheet-group-title">{entrada.label}</p>
        {entrada.items.map((item) => enlace(item, false))}
      </div>
    ),
  );

  return (
    <>
      <aside className="adm-side">
        <div className="adm-side-brand">
          <span className="adm-side-mark" aria-hidden="true">
            B
          </span>
          <span className="adm-side-name">
            <b>{storeName}</b>
            <span>Panel</span>
          </span>
        </div>

        {/* En escritorio esta es la vía visible al buscador; en móvil se ve el
            botón de la barra de arriba (los dos abren la misma paleta). */}
        <div className="adm-side-search">
          <BotonBuscar variante="sidebar" />
        </div>

        <nav className="adm-side-nav" aria-label="Secciones del panel">
          {navEscritorio}
        </nav>

        {/* Solo existe por debajo de 900 px. En escritorio está display:none. */}
        <nav className="adm-side-bar" aria-label="Accesos rápidos">
          {primarios.map((item) => enlace(item, false))}
        </nav>

        <button
          type="button"
          className="adm-navlink adm-more"
          onClick={() => setHojaAbierta((v) => !v)}
          aria-expanded={hojaAbierta}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" fill="currentColor" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
            <circle cx="19" cy="12" r="1.6" fill="currentColor" />
          </svg>
          <span>Más</span>
        </button>

        <div className="adm-side-foot">
          {/* "Tu cuenta" no está en el menú: se llega desde aquí, que es donde
              una persona busca su propio nombre. */}
          <Link
            href="/admin/cuenta"
            className={`adm-side-user${pathname.startsWith("/admin/cuenta") ? " is-active" : ""}`}
            aria-current={pathname.startsWith("/admin/cuenta") ? "page" : undefined}
            onClick={cerrarHoja}
          >
            <b>{adminName}</b>
            {rol === "owner" ? "Dueña · ver tu cuenta" : "Ayudante · ver tu cuenta"}
          </Link>
          <div className="adm-side-links">
            <Link href="/" target="_blank" rel="noreferrer">
              Ver tienda
            </Link>
            <LogoutButton />
          </div>
        </div>
      </aside>

      {/* [hidden] gana siempre (globals.css): así la hoja cerrada no puede
          quedarse como capa invisible tapando los clicks. Es el mismo fallo que
          costó un P0 en producción, y por eso se comprueba con
          document.elementFromPoint en qa/, no con una captura. */}
      <div className="adm-sheet-back" hidden={!hojaAbierta} onClick={cerrarHoja} />
      <div className="adm-sheet" hidden={!hojaAbierta}>
        <div className="adm-sheet-scroll">{navHoja}</div>
        <div className="adm-sheet-foot">
          <Link href="/admin/cuenta" className="adm-sheet-cuenta" onClick={cerrarHoja}>
            {adminName}
          </Link>
          <div className="adm-side-links">
            <Link href="/" target="_blank" rel="noreferrer">
              Ver tienda
            </Link>
            <LogoutButton />
          </div>
        </div>
      </div>
    </>
  );
}

/** Salir va por POST: un <a> a /admin/logout lo dispararía cualquier precarga. */
function LogoutButton() {
  return (
    <form action="/admin/logout" method="post">
      <button type="submit">Salir</button>
    </form>
  );
}
