import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ensureSeedAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { buscar } from "@/lib/search";
import { formatCents } from "@/lib/money";
import { getAdminConRol } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";
import Breadcrumbs from "./_components/Breadcrumbs";
import CommandPalette, { BotonBuscar, type AccionRapida, type ResultadoBusqueda } from "./_components/CommandPalette";
import Sidebar from "./_components/Sidebar";
import LoginPage from "./login/page";
import "./admin.css";

export const metadata: Metadata = {
  title: "Panel",
  // El panel jamás debe acabar en Google, ni siquiera la pantalla de login.
  robots: { index: false, follow: false },
};

// Todo el panel lee cookies y base de datos: cachearlo enseñaría datos viejos
// o, peor, los de otra sesión.
export const dynamic = "force-dynamic";

/**
 * Ruta que se está pidiendo.
 *
 * En App Router un layout NO recibe el pathname, y en Next 15 la carga directa
 * de un documento no trae ninguna cabecera con la ruta (comprobado: solo
 * host/x-forwarded-*). Quien la pone es middleware.ts, en `x-pathname`.
 *
 * Es una pista para saber a dónde redirigir y qué migas de pan pintar, nunca la
 * base de la seguridad: `next-url` la manda el cliente y se podría falsificar.
 * Quien decide si se entra o no es la sesión, no esta función.
 */
async function currentPath(): Promise<string | null> {
  const h = await headers();
  const raw = h.get("x-pathname") || h.get("next-url") || h.get("x-invoke-path") || h.get("x-matched-path");
  if (!raw) return null;
  // `next-url` puede traer query o incluso una URL entera.
  const path = raw.startsWith("http") ? new URL(raw).pathname : raw.split("?")[0];
  return path || null;
}

/** El nombre de la tienda es cosmético: si la BD aún no existe, no se cae el panel. */
async function storeName(): Promise<string> {
  try {
    const settings = await getSettings();
    return settings.storeName || "Bloom";
  } catch {
    return "Bloom";
  }
}

/* ───────────────────── atajos del buscador global ───────────────────── */

const ESTADO_PRODUCTO: Record<string, string> = {
  draft: "Borrador",
  active: "Activo",
  archived: "Archivado",
};

const ESTADO_PAGO: Record<string, string> = {
  pending: "Por cobrar",
  paid: "Pagado",
  refunded: "Reembolsado",
  cancelled: "Cancelado",
};

/**
 * Lo que la paleta ofrece antes de que escribas nada. Es el "qué puedo hacer"
 * del panel en una lista, y respeta los permisos: una ayudante no ve atajos a
 * pantallas que le van a rebotar.
 */
function atajos(rol: "owner" | "staff"): AccionRapida[] {
  const comunes: AccionRapida[] = [
    {
      id: "producto-nuevo",
      titulo: "Nuevo producto",
      detalle: "Crear una ficha a mano",
      href: "/admin/productos/nuevo",
      claves: "crear anadir añadir alta articulo artículo prenda vestido",
    },
    {
      id: "importar",
      titulo: "Importar de proveedor",
      detalle: "Traer una ficha de AliExpress o Alibaba",
      href: "/admin/importar",
      claves: "aliexpress alibaba dropshipping traer proveedor bookmarklet",
    },
    {
      id: "mostrador",
      titulo: "Abrir mostrador",
      detalle: "Cobrar una venta en la boutique",
      href: "/admin/pos",
      claves: "caja cobrar pos venta tienda fisica física efectivo",
    },
    {
      id: "por-cobrar",
      titulo: "Pedidos por cobrar",
      detalle: "Los que aún no han pagado",
      href: "/admin/pedidos?estado=pendiente",
      claves: "pendiente cobro pagar deuda",
    },
    {
      id: "por-enviar",
      titulo: "Pedidos por enviar",
      detalle: "Pagados y sin preparar",
      href: "/admin/pedidos?estado=por-enviar",
      claves: "envio envío preparar paquete despachar",
    },
    {
      id: "resenas-pendientes",
      titulo: "Reseñas por revisar",
      detalle: "Aprobarlas o descartarlas",
      href: "/admin/resenas?estado=pending",
      claves: "opiniones comentarios valoraciones moderar",
    },
    {
      id: "inventario",
      titulo: "Inventario",
      detalle: "Cuántas unidades queda de cada talla",
      href: "/admin/inventario",
      claves: "stock existencias tallas almacen almacén",
    },
    {
      id: "cuenta",
      titulo: "Tu cuenta",
      detalle: "Tu nombre, tu contraseña y tus sesiones",
      href: "/admin/cuenta",
      claves: "contrasena contraseña perfil password salir",
    },
  ];

  if (rol !== "owner") return comunes;

  return [
    ...comunes,
    {
      id: "descuento-nuevo",
      titulo: "Nuevo código de descuento",
      detalle: "Una promoción con su código",
      href: "/admin/descuentos/nuevo",
      claves: "cupon cupón promocion promoción rebaja oferta",
    },
    {
      id: "informes",
      titulo: "Informes",
      detalle: "Cuánto vendes y cuánto te queda limpio",
      href: "/admin/informes",
      claves: "ventas ganancia beneficio margen estadisticas estadísticas",
    },
    {
      id: "portada",
      titulo: "Portada de la tienda",
      detalle: "Cambiar textos y fotos del escaparate",
      href: "/admin/contenido",
      claves: "inicio home escaparate bloques secciones",
    },
    {
      id: "ajustes",
      titulo: "Ajustes",
      detalle: "Datos de la tienda, precios, envío y cobros",
      href: "/admin/ajustes",
      claves: "configuracion configuración precios margen pago",
    },
  ];
}

/* ─────────────────────────────── layout ─────────────────────────────── */

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Primer arranque tras clonar el repo: sin esto no existiría ninguna cuenta
  // y no habría manera de entrar. Nunca pisa un admin ya creado.
  await ensureSeedAdmin().catch(() => {});

  // getAdminConRol trae además el rol y devuelve null si la cuenta está
  // desactivada: apagar a alguien en /admin/equipo tiene que echarle del panel
  // al instante, no cuando le caduque la cookie.
  const admin = await getAdminConRol().catch(() => null);
  const path = await currentPath();
  // Sin cabecera de ruta (si alguien borra middleware.ts) se asume que NO es el
  // login: se prefiere un bucle de redirecciones — ruidoso y evidente — antes
  // que servir datos del panel a quien no ha iniciado sesión.
  const onLogin = path !== null && path.startsWith("/admin/login");

  if (!admin) {
    // Aquí SOLO vale redirigir. Devolver el login sin renderizar `children` no
    // basta: Next renderiza igualmente la página hija y la manda dentro del
    // payload RSC, así que una petición sin sesión a /admin se llevaba el
    // dashboard entero incrustado en el HTML. redirect() aborta el render y no
    // sale nada. Medido con curl, no supuesto.
    if (!onLogin) redirect("/admin/login");

    // Ya estamos en /admin/login: aquí sí se pinta el formulario. Es el mismo
    // componente que exporta la página, y así se pinta aunque falte la cabecera.
    return (
      <div className="adm-auth">
        <LoginPage />
      </div>
    );
  }

  // Con sesión abierta el login no pinta nada: se manda al panel.
  if (onLogin) redirect("/admin");

  /**
   * Buscador global. Es una Server Action y no una ruta de API por dos motivos:
   * no hay que inventarse un endpoint que luego alguien tenga que proteger, y
   * la sesión se vuelve a comprobar AQUÍ dentro — una Server Action es un POST
   * público como cualquier otro, y sin esta línea sería un buscador de pedidos
   * y correos de clientas abierto a cualquiera que conociera su id.
   */
  async function buscarEnPanel(consulta: string): Promise<ResultadoBusqueda[]> {
    "use server";

    const sesion = await getAdminConRol().catch(() => null);
    if (!sesion) return [];

    const q = consulta.trim().slice(0, 60);
    if (q.length < 2) return [];

    try {
      const [productos, pedidos, clientas] = await Promise.all([
        db.product.findMany({
          where: { title: buscar(q) },
          orderBy: { updatedAt: "desc" },
          take: 5,
          select: { id: true, title: true, status: true, priceCents: true },
        }),
        db.order.findMany({
          where: { OR: [{ number: buscar(q) }, { name: buscar(q) }, { email: buscar(q) }] },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, number: true, name: true, email: true, totalCents: true, paymentStatus: true },
        }),
        db.customer.findMany({
          where: { OR: [{ name: buscar(q) }, { email: buscar(q) }] },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, name: true, email: true },
        }),
      ]);

      return [
        ...pedidos.map((p) => ({
          id: p.id,
          tipo: "pedido" as const,
          titulo: p.number,
          detalle: `${p.name || p.email || "sin nombre"} · ${formatCents(p.totalCents)} · ${
            ESTADO_PAGO[p.paymentStatus] ?? p.paymentStatus
          }`,
          href: `/admin/pedidos/${p.id}`,
        })),
        ...productos.map((p) => ({
          id: p.id,
          tipo: "producto" as const,
          titulo: p.title,
          detalle: `${ESTADO_PRODUCTO[p.status] ?? p.status} · ${
            p.priceCents > 0 ? formatCents(p.priceCents) : "sin precio"
          }`,
          href: `/admin/productos/${p.id}`,
        })),
        ...clientas.map((c) => ({
          id: c.id,
          tipo: "clienta" as const,
          titulo: c.name || c.email,
          detalle: c.name ? c.email : "sin nombre guardado",
          href: `/admin/clientes/${c.id}`,
        })),
      ];
    } catch {
      // La BD puede no estar montada todavía; el buscador se queda mudo en vez
      // de tumbar la pantalla en la que esté trabajando.
      return [];
    }
  }

  return (
    <div className="adm-shell">
      <Sidebar adminName={admin.name || admin.email} storeName={await storeName()} rol={admin.role} />

      <div className="adm-main">
        {/* Solo se ve en móvil, donde el sidebar baja a barra inferior y la
            marca —y el buscador— se quedarían sin sitio. */}
        <header className="adm-topbar">
          <b>Bloom · Panel</b>
          <div className="adm-topbar-acciones">
            <BotonBuscar variante="topbar" />
            <a href="/" target="_blank" rel="noreferrer">
              Ver tienda
            </a>
          </div>
        </header>

        <main className="adm-content">
          <Breadcrumbs path={path} />
          {children}
        </main>
      </div>

      {/* Se monta una sola vez para todo el panel. Cerrada no pinta ni un nodo. */}
      <CommandPalette buscar={buscarEnPanel} acciones={atajos(admin.role)} />
    </div>
  );
}
