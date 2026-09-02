import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { requireSesion } from "@/lib/permissions";
import { fechaCorteAbandono, valorCarrito } from "@/lib/reviews";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Money,
  PageHeader,
  StatCard,
  type BadgeTone,
  type Column,
} from "./_components/ui";

/**
 * Resumen del panel: la foto de la tienda al abrir por la mañana.
 *
 * Es la pantalla que Madeline mira primero, así que su trabajo no es enseñar
 * números bonitos sino contestar una sola pregunta: **¿qué tengo que hacer
 * hoy?** Por eso todo aviso lleva su enlace directo a la pantalla donde se
 * arregla. Un aviso sin enlace es una preocupación, no una tarea.
 *
 * Todo sale de la base de datos — aquí no hay ni un número simulado. Si algo
 * está a cero es porque de verdad está a cero. Y si no hay nada que hacer, se
 * dice con alegría en vez de enseñar una parrilla de ceros.
 */

export const dynamic = "force-dynamic";

/** Bajo mínimo: el mismo umbral que usa /admin/inventario por defecto. */
const UMBRAL_BAJO = 3;

type LatestOrder = {
  id: string;
  number: string;
  name: string;
  email: string;
  totalCents: number;
  paymentStatus: string;
  fulfillStatus: string;
  createdAt: Date;
};

type Aviso = {
  key: string;
  tone: BadgeTone;
  label: string;
  text: string;
  href: string;
  cta: string;
};

type Atajo = { href: string; titulo: string; texto: string; soloDuena?: boolean };

const fechaCorta = new Intl.DateTimeFormat("es-US", { day: "2-digit", month: "short" });
const mesLargo = new Intl.DateTimeFormat("es-US", { month: "long", year: "numeric" });

const PAGO: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: "Por cobrar", tone: "warning" },
  paid: { label: "Pagado", tone: "success" },
  refunded: { label: "Reembolsado", tone: "info" },
  cancelled: { label: "Cancelado", tone: "danger" },
};

const ENVIO: Record<string, { label: string; tone: BadgeTone }> = {
  unfulfilled: { label: "Por enviar", tone: "neutral" },
  fulfilled: { label: "Enviado", tone: "success" },
  cancelled: { label: "Cancelado", tone: "danger" },
};

/** A dónde se va desde aquí. Cada tarjeta explica para qué sirve la sección. */
const ATAJOS: Atajo[] = [
  { href: "/admin/pos", titulo: "Mostrador", texto: "Cobrar una venta en la boutique, con o sin clienta registrada." },
  { href: "/admin/inventario", titulo: "Inventario", texto: "Cuántas unidades quedan de cada talla y qué hay parado." },
  { href: "/admin/carritos", titulo: "Carritos abandonados", texto: "Lo que estuvo a punto de entrar y no entró." },
  { href: "/admin/resenas", titulo: "Reseñas", texto: "Aprobar las opiniones antes de que salgan en la tienda." },
  { href: "/admin/clientes", titulo: "Clientas", texto: "Quién te compra, cuánto y desde cuándo." },
  { href: "/admin/informes", titulo: "Informes", texto: "Cuánto vendes, qué se vende y cuánto te queda limpio.", soloDuena: true },
  { href: "/admin/descuentos", titulo: "Descuentos", texto: "Códigos de promoción con su fecha y su tope.", soloDuena: true },
  { href: "/admin/contenido", titulo: "Portada", texto: "Los textos y las fotos del escaparate, sin tocar código.", soloDuena: true },
];

export default async function AdminDashboard() {
  // Defensa en profundidad: el layout ya corta el paso, pero en App Router una
  // página se renderiza aunque su layout no la pinte (y viaja en el payload
  // RSC). Cada pantalla del panel comprueba la sesión por su cuenta: es una
  // sola consulta y es la diferencia entre proteger y aparentar que se protege.
  const admin = await requireSesion();
  const esDuena = admin.role === "owner";

  const ahora = new Date();
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);

  let datos;
  try {
    datos = await cargarDatos(inicioMes);
  } catch (error) {
    // Repo recién clonado sin `npm run db:push`: mejor decirlo que soltar un
    // stack de Prisma en la cara de Madeline.
    return (
      <>
        <PageHeader title="Resumen" subtitle="La foto de tu tienda" />
        <Card>
          <EmptyState
            icon={<IconAviso />}
            title="La base de datos todavía no responde"
            text={
              <>
                Ejecuta <code>npm run db:push</code> y luego <code>npm run db:seed</code> en la carpeta del proyecto.
                Detalle técnico: {error instanceof Error ? error.message : "error desconocido"}.
              </>
            }
          />
        </Card>
      </>
    );
  }

  const {
    ventasMes,
    pedidosMes,
    porCobrar,
    porEnviar,
    activos,
    borradores,
    archivados,
    totalProductos,
    ultimos,
  } = datos;

  const avisos = construirAvisos(datos);
  const atajos = ATAJOS.filter((a) => !a.soloDuena || esDuena);

  const acciones = (
    <>
      <Button href="/admin/productos/nueva-prenda">Añadir prenda</Button>
      <Button href="/admin/importar" variant="ghost">
        Importar de proveedor
      </Button>
    </>
  );

  // Tienda vacía: en vez de una parrilla de ceros, el camino para empezar.
  if (totalProductos === 0) {
    return (
      <>
        <PageHeader title="Resumen" subtitle={`La foto de ${mesLargo.format(ahora)}`} actions={acciones} />
        <Card>
          <EmptyState
            icon={<IconCaja />}
            title="Aún no hay productos en la tienda"
            text="El catálogo está vacío, así que el escaparate no muestra nada. Puedes sembrar los productos que ya existen en el sitio antiguo con npm run db:seed, o traer el primero directamente de AliExpress o Alibaba."
            action={
              <>
                <Button href="/admin/importar">Importar el primero</Button>
                <Button href="/admin/productos/nueva-prenda" variant="ghost">
                  Crearlo a mano
                </Button>
              </>
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Resumen" subtitle={`La foto de ${mesLargo.format(ahora)}`} actions={acciones} />

      <div className="adm-grid">
        <StatCard
          label="Ventas del mes"
          value={<Money cents={ventasMes} />}
          hint={`${pedidosMes} ${pedidosMes === 1 ? "pedido cobrado" : "pedidos cobrados"}`}
          tone="accent"
        />
        <StatCard
          label="Por cobrar"
          value={porCobrar}
          hint={porCobrar > 0 ? "Pedidos pendientes de pago" : "Nada pendiente de cobro"}
          tone={porCobrar > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Por enviar"
          value={porEnviar}
          hint={porEnviar > 0 ? "Pagados y sin preparar" : "Todo lo pagado está enviado"}
          tone={porEnviar > 0 ? "warning" : "success"}
        />
        <StatCard
          label="Catálogo activo"
          value={activos}
          hint={`${borradores} en borrador · ${archivados} archivados`}
        />
      </div>

      {avisos.length > 0 ? (
        <Card title="Requiere tu atención" flush>
          <div className="adm-alerts">
            {avisos.map((aviso) => (
              <div className="adm-alert" key={aviso.key}>
                <span className="adm-alert-text">
                  <Badge tone={aviso.tone}>{aviso.label}</Badge>
                  {aviso.text}
                </span>
                <Link className="adm-alert-cta" href={aviso.href}>
                  {aviso.cta}
                </Link>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        /* Cero avisos es una buena noticia, no una tabla vacía. */
        <Card title="Requiere tu atención">
          <div className="adm-allgood">
            <span className="adm-allgood-icon" aria-hidden="true">
              <IconCheck />
            </span>
            <span>
              <b>Todo al día.</b>
              <span>
                No hay pedidos sin atender, ni productos sin precio, ni reseñas esperando. Buen momento para subir
                algo nuevo.
              </span>
            </span>
          </div>
        </Card>
      )}

      <Card
        title="Últimos pedidos"
        flush
        actions={
          <Button href="/admin/pedidos" variant="ghost" size="sm">
            Ver todos
          </Button>
        }
      >
        <DataTable<LatestOrder>
          columns={COLUMNAS_PEDIDOS}
          rows={ultimos}
          rowKey={(pedido) => pedido.id}
          empty={
            <EmptyState
              icon={<IconBolsa />}
              title="Todavía no hay pedidos"
              text="Cuando alguien compre en la tienda, el pedido aparecerá aquí con su número BLM. También puedes cobrar una venta del mostrador y entrará por aquí."
              action={<Button href="/admin/pos">Abrir el mostrador</Button>}
            />
          }
        />
      </Card>

      {/* El panel tiene veinticinco pantallas: esto es el índice de las que no
          salen en los avisos, cada una con una línea que dice para qué sirve. */}
      <Card title="Ir a">
        <div className="adm-quick">
          {atajos.map((atajo) => (
            <Link key={atajo.href} href={atajo.href}>
              <b>{atajo.titulo}</b>
              <span>{atajo.texto}</span>
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}

/* ─────────────────────────── datos ─────────────────────────── */

type Datos = Awaited<ReturnType<typeof cargarDatos>>;

async function cargarDatos(inicioMes: Date) {
  // Un carrito abandonado es exactamente lo mismo que cuenta /admin/carritos:
  // con líneas, no recuperado, no descartado a mano y parado más de 6 horas.
  // Si las dos pantallas contaran distinto, la cifra del resumen dejaría de
  // significar nada.
  const carritoAbandonado: Prisma.CartWhereInput = {
    AND: [
      { items: { some: {} } },
      { NOT: { note: { startsWith: "[descartado" } } },
      { recoveredOrderId: null },
      { updatedAt: { lt: fechaCorteAbandono() } },
    ],
  };

  const [
    mes,
    porCobrar,
    porEnviar,
    porEstado,
    sinStock,
    bajoStock,
    sinPrecioActivos,
    sinPrecioBorradores,
    resenasPendientes,
    importesListos,
    importesFallidos,
    abandonados,
    ultimos,
    totalProductos,
  ] = await Promise.all([
    // Solo cuenta lo cobrado: un pedido "pendiente" no es una venta todavía.
    db.order.aggregate({
      _sum: { totalCents: true },
      _count: { _all: true },
      where: { paymentStatus: "paid", createdAt: { gte: inicioMes } },
    }),
    db.order.count({ where: { paymentStatus: "pending" } }),
    db.order.count({ where: { paymentStatus: "paid", fulfillStatus: "unfulfilled" } }),
    db.product.groupBy({ by: ["status"], _count: { _all: true } }),
    // Solo molesta el stock de lo que se controla: en dropshipping casi todo
    // va con trackStock=false porque el inventario lo tiene el proveedor.
    db.productVariant.count({ where: { trackStock: true, stock: { lte: 0 } } }),
    db.productVariant.count({ where: { trackStock: true, stock: { gt: 0, lte: UMBRAL_BAJO } } }),
    // Sin precio y ACTIVO es lo urgente: se ve en la tienda y no se puede
    // comprar. Sin precio y en borrador solo es trabajo pendiente.
    db.product.count({ where: { status: "active", priceCents: { lte: 0 } } }),
    db.product.count({ where: { status: "draft", priceCents: { lte: 0 } } }),
    db.review.count({ where: { status: "pending" } }),
    db.importJob.count({ where: { status: "ready" } }),
    db.importJob.count({ where: { status: "failed" } }),
    db.cart.findMany({
      where: carritoAbandonado,
      select: { id: true, items: { select: { quantity: true, variant: { select: { priceCents: true } } } } },
    }),
    db.order.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        number: true,
        name: true,
        email: true,
        totalCents: true,
        paymentStatus: true,
        fulfillStatus: true,
        createdAt: true,
      },
    }),
    db.product.count(),
  ]);

  const cuenta = (estado: string) => porEstado.find((fila) => fila.status === estado)?._count._all ?? 0;

  const valorAbandonado = abandonados.reduce(
    (total, carrito) =>
      total +
      valorCarrito(carrito.items.map((i) => ({ quantity: i.quantity, priceCents: i.variant?.priceCents ?? 0 }))),
    0,
  );

  return {
    ventasMes: mes._sum.totalCents ?? 0,
    pedidosMes: mes._count._all,
    porCobrar,
    porEnviar,
    activos: cuenta("active"),
    borradores: cuenta("draft"),
    archivados: cuenta("archived"),
    totalProductos,
    sinStock,
    bajoStock,
    sinPrecioActivos,
    sinPrecioBorradores,
    resenasPendientes,
    importesListos,
    importesFallidos,
    carritosAbandonados: abandonados.length,
    valorAbandonado,
    ultimos: ultimos as LatestOrder[],
  };
}

/**
 * Los avisos, en el orden en que importan: primero lo que cuesta dinero ahora
 * mismo (algo que no se puede comprar, algo cobrado sin enviar), luego lo que
 * es trabajo pendiente. Cada uno lleva su enlace al sitio donde se arregla.
 */
function construirAvisos(n: Datos): Aviso[] {
  const avisos: Aviso[] = [];
  const plural = (cantidad: number, singular: string, varios: string) =>
    cantidad === 1 ? singular : varios.replace("{n}", String(cantidad));

  if (n.sinPrecioActivos > 0) {
    avisos.push({
      key: "sin-precio-activo",
      tone: "danger",
      label: "Precio",
      text: plural(
        n.sinPrecioActivos,
        "1 producto está en la tienda sin precio: se ve pero no se puede comprar.",
        "{n} productos están en la tienda sin precio: se ven pero no se pueden comprar.",
      ),
      href: "/admin/productos?estado=active&aviso=sin-precio",
      cta: "Ponerles precio",
    });
  }

  if (n.porEnviar > 0) {
    avisos.push({
      key: "por-enviar",
      tone: "warning",
      label: "Envío",
      text: plural(
        n.porEnviar,
        "1 pedido pagado está sin preparar.",
        "{n} pedidos pagados están sin preparar.",
      ),
      href: "/admin/pedidos?estado=por-enviar",
      cta: "Prepararlos",
    });
  }

  if (n.porCobrar > 0) {
    avisos.push({
      key: "por-cobrar",
      tone: "warning",
      label: "Cobro",
      text: plural(n.porCobrar, "1 pedido sigue pendiente de pago.", "{n} pedidos siguen pendientes de pago."),
      href: "/admin/pedidos?estado=pendiente",
      cta: "Revisar pedidos",
    });
  }

  if (n.sinStock > 0) {
    avisos.push({
      key: "sin-stock",
      tone: "danger",
      label: "Agotado",
      text: plural(
        n.sinStock,
        "1 variante con control de stock está agotada.",
        "{n} variantes con control de stock están agotadas.",
      ),
      href: "/admin/productos?aviso=sin-stock",
      cta: "Ver agotados",
    });
  }

  if (n.bajoStock > 0) {
    avisos.push({
      key: "bajo-stock",
      tone: "warning",
      label: "Quedan pocas",
      text: plural(
        n.bajoStock,
        `1 variante tiene ${UMBRAL_BAJO} unidades o menos.`,
        `{n} variantes tienen ${UMBRAL_BAJO} unidades o menos.`,
      ),
      href: "/admin/inventario?filtro=bajo",
      cta: "Ver inventario",
    });
  }

  if (n.resenasPendientes > 0) {
    avisos.push({
      key: "resenas",
      tone: "info",
      label: "Reseñas",
      text: plural(
        n.resenasPendientes,
        "1 reseña espera que la apruebes para salir en la tienda.",
        "{n} reseñas esperan que las apruebes para salir en la tienda.",
      ),
      href: "/admin/resenas?estado=pending",
      cta: "Revisarlas",
    });
  }

  if (n.carritosAbandonados > 0) {
    avisos.push({
      key: "carritos",
      tone: "info",
      label: "Carritos",
      text: plural(
        n.carritosAbandonados,
        `1 carrito se quedó a medias con ${formatCents(n.valorAbandonado)} dentro.`,
        `{n} carritos se quedaron a medias con ${formatCents(n.valorAbandonado)} dentro.`,
      ),
      href: "/admin/carritos",
      cta: "Escribirles",
    });
  }

  if (n.importesListos > 0) {
    avisos.push({
      key: "importaciones",
      tone: "info",
      label: "Importador",
      text: plural(
        n.importesListos,
        "1 producto importado espera tu revisión antes de publicarse.",
        "{n} productos importados esperan tu revisión antes de publicarse.",
      ),
      href: "/admin/importar",
      cta: "Revisarlos",
    });
  }

  if (n.importesFallidos > 0) {
    avisos.push({
      key: "importaciones-fallidas",
      tone: "danger",
      label: "Importador",
      text: plural(
        n.importesFallidos,
        "1 importación se quedó a medias y no llegó a traer la ficha.",
        "{n} importaciones se quedaron a medias y no llegaron a traer la ficha.",
      ),
      href: "/admin/importar",
      cta: "Ver qué pasó",
    });
  }

  if (n.sinPrecioBorradores > 0) {
    avisos.push({
      key: "sin-precio-borrador",
      tone: "neutral",
      label: "Precio",
      text: plural(
        n.sinPrecioBorradores,
        "1 borrador no tiene precio todavía.",
        "{n} borradores no tienen precio todavía.",
      ),
      href: "/admin/productos?estado=draft&aviso=sin-precio",
      cta: "Ponerles precio",
    });
  }

  if (n.borradores > 0) {
    avisos.push({
      key: "borradores",
      tone: "neutral",
      label: "Borradores",
      text: plural(
        n.borradores,
        "1 producto sigue en borrador y no se ve en la tienda.",
        "{n} productos siguen en borrador y no se ven en la tienda.",
      ),
      href: "/admin/productos?estado=draft",
      cta: "Publicarlos",
    });
  }

  return avisos;
}

/* ─────────────────────── tabla de pedidos ─────────────────────── */

const COLUMNAS_PEDIDOS: Column<LatestOrder>[] = [
  {
    key: "number",
    header: "Pedido",
    primary: true,
    render: (pedido) => (
      <Link className="adm-link" href={`/admin/pedidos/${pedido.id}`}>
        {pedido.number}
      </Link>
    ),
  },
  {
    key: "cliente",
    header: "Clienta",
    render: (pedido) => (
      <span>
        {pedido.name || "—"}
        <br />
        <span className="adm-muted adm-small">{pedido.email}</span>
      </span>
    ),
  },
  {
    key: "estado",
    header: "Estado",
    render: (pedido) => {
      const pago = PAGO[pedido.paymentStatus] ?? { label: pedido.paymentStatus, tone: "neutral" as BadgeTone };
      const envio = ENVIO[pedido.fulfillStatus] ?? { label: pedido.fulfillStatus, tone: "neutral" as BadgeTone };
      return (
        <span className="adm-row">
          <Badge tone={pago.tone}>{pago.label}</Badge>
          <Badge tone={envio.tone}>{envio.label}</Badge>
        </span>
      );
    },
  },
  {
    key: "fecha",
    header: "Fecha",
    hideOnMobile: true,
    render: (pedido) => <span className="adm-muted">{fechaCorta.format(pedido.createdAt)}</span>,
  },
  {
    key: "total",
    header: "Total",
    align: "right",
    render: (pedido) => <Money cents={pedido.totalCents} tone="strong" />,
  },
];

/* ─────────────────────────── iconos ─────────────────────────── */

function IconCaja() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 4 7v10l8 4 8-4V7Z" />
      <path d="m4 7 8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  );
}

function IconBolsa() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 7h12l1.2 12.2a1.5 1.5 0 0 1-1.5 1.8H6.3a1.5 1.5 0 0 1-1.5-1.8Z" />
      <path d="M9 10V6.5a3 3 0 0 1 6 0V10" />
    </svg>
  );
}

function IconAviso() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4 2.5 20h19Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.4h.01" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}
