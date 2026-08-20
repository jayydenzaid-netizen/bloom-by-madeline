import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { Badge, Card, DataTable, EmptyState, Money, PageHeader, StatCard, type Column } from "../_components/ui";
import { PosTerminal, type PosColeccion, type PosProducto } from "./_components/PosTerminal";
import "./pos.css";

/**
 * MOSTRADOR — la pantalla que se usa mientras la boutique está abierta.
 *
 * Madeline abre de jueves a sábado, de 1 a 8, y cobra en mano. Hasta ahora esas
 * ventas no entraban en ningún sitio: el stock del panel y el del armario se
 * separaban cada fin de semana, y con el stock mal ningún informe vale nada.
 * Aquí se cobra igual que en el escaparate y contra la MISMA base de datos.
 *
 * La pantalla tiene dos mitades:
 *  1. el terminal (catálogo + ticket), que es lo que se toca todo el día;
 *  2. el cierre de caja, que es lo que ella mira al bajar la persiana.
 */

export const dynamic = "force-dynamic";

export default async function PosPage() {
  // Cada pantalla comprueba su sesión: en Next 15 una página se renderiza aunque
  // el layout no la pinte, y el resultado viaja igual dentro del payload RSC.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const inicioDeHoy = new Date();
  inicioDeHoy.setHours(0, 0, 0, 0);

  const [productosBd, coleccionesBd, ajustes, ventasHoy] = await Promise.all([
    db.product.findMany({
      where: { status: "active" },
      orderBy: { title: "asc" },
      select: {
        id: true,
        title: true,
        priceCents: true,
        images: { orderBy: { position: "asc" }, take: 1, select: { url: true } },
        variants: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            title: true,
            sku: true,
            priceCents: true,
            stock: true,
            trackStock: true,
            imageUrl: true,
          },
        },
        collections: { select: { collectionId: true } },
      },
    }),
    db.collection.findMany({
      where: { isVisible: true },
      orderBy: [{ position: "asc" }, { title: "asc" }],
      select: { id: true, title: true },
    }),
    getSettings(),
    db.order.findMany({
      where: { channel: "pos", createdAt: { gte: inicioDeHoy } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        number: true,
        name: true,
        totalCents: true,
        paymentMethod: true,
        paymentStatus: true,
        createdAt: true,
      },
    }),
  ]);

  // Un producto sin ninguna variante con precio no se puede cobrar: enseñarlo en
  // la rejilla solo sirve para que Madeline lo toque y no pase nada. Se cuentan
  // aparte para poder decirle dónde arreglarlo.
  const productos: PosProducto[] = productosBd
    .filter((p) => p.variants.some((v) => v.priceCents > 0))
    .map((p) => {
      const conPrecio = p.variants.filter((v) => v.priceCents > 0);
      return {
        id: p.id,
        titulo: p.title,
        imagen: p.images[0]?.url ?? null,
        desdeCents: conPrecio.reduce((min, v) => Math.min(min, v.priceCents), Number.MAX_SAFE_INTEGER),
        variantes: p.variants.map((v) => ({
          id: v.id,
          titulo: v.title,
          sku: v.sku,
          precioCents: v.priceCents,
          stock: v.stock,
          trackStock: v.trackStock,
          imagen: v.imageUrl,
        })),
        coleccionIds: p.collections.map((c) => c.collectionId),
      };
    });

  const sinPrecio = productosBd.length - productos.length;

  const colecciones: PosColeccion[] = coleccionesBd.map((c) => ({ id: c.id, titulo: c.title }));

  /* ── cierre de caja del día ── */

  const efectivoCents = sumar(ventasHoy, (o) => o.paymentStatus === "paid" && o.paymentMethod === "cash");
  const tarjetaCents = sumar(ventasHoy, (o) => o.paymentStatus === "paid" && o.paymentMethod !== "cash");
  const apuntadoCents = sumar(ventasHoy, (o) => o.paymentStatus !== "paid");
  const cobradoCents = efectivoCents + tarjetaCents;

  const columnas: Column<(typeof ventasHoy)[number]>[] = [
    {
      key: "numero",
      header: "Ticket",
      primary: true,
      render: (o) => (
        <a className="adm-link" href={`/admin/pedidos/${o.id}`}>
          {o.number}
        </a>
      ),
    },
    {
      key: "hora",
      header: "Hora",
      render: (o) =>
        o.createdAt.toLocaleTimeString("es-US", { hour: "numeric", minute: "2-digit" }),
    },
    { key: "cliente", header: "Clienta", hideOnMobile: true, render: (o) => o.name || "—" },
    {
      key: "pago",
      header: "Cobro",
      render: (o) =>
        o.paymentStatus !== "paid" ? (
          <Badge tone="warning">Apuntado</Badge>
        ) : o.paymentMethod === "cash" ? (
          <Badge tone="success">Efectivo</Badge>
        ) : (
          <Badge tone="info">Tarjeta</Badge>
        ),
    },
    { key: "total", header: "Total", align: "right", render: (o) => <Money cents={o.totalCents} /> },
  ];

  return (
    <>
      <PageHeader
        title="Mostrador"
        subtitle="Cobra en la boutique: el stock baja y la venta entra en los mismos informes que la tienda web."
      />

      {productos.length === 0 ? (
        <Card title="Todavía no hay nada que vender aquí">
          <EmptyState
            title="Ningún producto activo con precio"
            text="El mostrador solo enseña productos activos y con precio puesto. Activa una pieza y ponle precio, y aparecerá aquí al instante."
            action={
              <a className="adm-btn adm-btn-primary adm-btn-md" href="/admin/productos">
                Ir a Productos
              </a>
            }
          />
        </Card>
      ) : (
        <>
          {sinPrecio > 0 ? (
            <p className="pos-aviso pos-aviso-info pos-noprint">
              {sinPrecio === 1
                ? "Hay 1 producto activo que no sale aquí porque no tiene precio."
                : `Hay ${sinPrecio} productos activos que no salen aquí porque no tienen precio.`}{" "}
              <a className="adm-link" href="/admin/productos?aviso=sin-precio">
                Ponles precio
              </a>
              .
            </p>
          ) : null}

          <PosTerminal
            productos={productos}
            colecciones={colecciones}
            boutique={{
              nombre: ajustes.storeName,
              direccion: ajustes.address,
              horario: ajustes.hours,
              instagram: ajustes.instagram,
              telefono: ajustes.phone,
            }}
          />
        </>
      )}

      <section className="pos-cierre pos-noprint">
        <Card
          title="Cierre de caja de hoy"
          actions={<span className="adm-small adm-muted">Solo ventas de mostrador</span>}
        >
          <div className="adm-grid">
            <StatCard
              label="Cobrado hoy"
              value={<Money cents={cobradoCents} />}
              hint="Efectivo + tarjeta"
              tone="accent"
            />
            <StatCard label="En efectivo" value={<Money cents={efectivoCents} />} hint="Lo que debe haber en la caja" />
            <StatCard label="Con tarjeta" value={<Money cents={tarjetaCents} />} hint="Cobrado en tu terminal de Square" />
            <StatCard
              label="Apuntado"
              value={<Money cents={apuntadoCents} />}
              hint="Se lo llevaron sin pagar todavía"
              tone={apuntadoCents > 0 ? "warning" : "default"}
            />
            <StatCard label="Tickets" value={String(ventasHoy.length)} hint="Ventas cerradas hoy" />
          </div>
        </Card>

        <Card title="Tickets de hoy" flush>
          <DataTable
            columns={columnas}
            rows={ventasHoy}
            rowKey={(o) => o.id}
            empty={
              <EmptyState
                title="Todavía no has cobrado nada hoy"
                text="En cuanto cierres la primera venta aparecerá aquí, con la hora y la forma de cobro."
              />
            }
          />
        </Card>
      </section>
    </>
  );
}

/* ─────────────────────────── utilidades ─────────────────────────── */

type VentaResumen = { totalCents: number; paymentMethod: string; paymentStatus: string };

/** Suma los totales de las ventas que cumplen la condición. */
function sumar<T extends VentaResumen>(ventas: T[], cumple: (venta: T) => boolean): number {
  return ventas.reduce((suma, venta) => (cumple(venta) ? suma + venta.totalCents : suma), 0);
}
