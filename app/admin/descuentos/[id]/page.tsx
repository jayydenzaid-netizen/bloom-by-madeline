import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { idsAplicables } from "@/lib/discounts";
import { Card, DataTable, EmptyState, Money, type Column } from "../../_components/ui";
import DiscountForm, { type DescuentoEditable } from "../_components/DiscountForm";
import "../descuentos.css";

/**
 * Ficha de un código: el formulario de edición arriba y, debajo, el historial
 * de usos — quién lo usó, en qué pedido y cuándo.
 *
 * El historial no es decoración: es lo que permite responder "¿este código de
 * un uso por clienta se lo gastó ya?" sin abrir la base de datos, y lo que se
 * pierde si el código se borra (por eso la confirmación de borrado lo dice).
 */

export const dynamic = "force-dynamic";

const FECHA = new Intl.DateTimeFormat("es-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Date → "yyyy-mm-dd" en hora LOCAL, que es lo que espera un <input type="date">. */
function aInputFecha(fecha: Date | null): string {
  if (!fecha) return "";
  const dosDigitos = (n: number) => String(n).padStart(2, "0");
  return `${fecha.getFullYear()}-${dosDigitos(fecha.getMonth() + 1)}-${dosDigitos(fecha.getDate())}`;
}

type FilaUso = {
  id: string;
  email: string;
  usedAt: Date;
  orderId: string;
  numero: string | null;
  totalCents: number | null;
};

export default async function DescuentoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  // En Next 15 params y searchParams son promesas: hay que esperarlas.
  const { id } = await params;
  const sp = await searchParams;
  const recienCreado = (Array.isArray(sp.guardado) ? sp.guardado[0] : sp.guardado) === "1";

  const descuento = await db.discount.findUnique({ where: { id } });
  if (!descuento) notFound();

  const [colecciones, productos, usos] = await Promise.all([
    db.collection.findMany({ orderBy: [{ position: "asc" }, { title: "asc" }], select: { id: true, title: true } }),
    db.product.findMany({
      where: { status: { not: "archived" } },
      orderBy: { title: "asc" },
      take: 500,
      select: { id: true, title: true },
    }),
    db.discountUsage.findMany({ where: { discountId: id }, orderBy: { usedAt: "desc" }, take: 200 }),
  ]);

  // DiscountUsage guarda el id del pedido pero no tiene relación con Order (a
  // propósito: un pedido borrado no debe llevarse el historial por delante), así
  // que los números de pedido se buscan aparte.
  const pedidos = await db.order.findMany({
    where: { id: { in: usos.map((u) => u.orderId) } },
    select: { id: true, number: true, totalCents: true },
  });
  const porId = new Map(pedidos.map((p) => [p.id, p]));

  const filas: FilaUso[] = usos.map((u) => {
    const pedido = porId.get(u.orderId);
    return {
      id: u.id,
      email: u.email,
      usedAt: u.usedAt,
      orderId: u.orderId,
      numero: pedido?.number ?? null,
      totalCents: pedido?.totalCents ?? null,
    };
  });

  const editable: DescuentoEditable = {
    id: descuento.id,
    code: descuento.code,
    title: descuento.title,
    type: descuento.type,
    value: descuento.value,
    minSubtotalCents: descuento.minSubtotalCents,
    appliesTo: descuento.appliesTo,
    appliesToIds: idsAplicables(descuento),
    oncePerCustomer: descuento.oncePerCustomer,
    usageLimit: descuento.usageLimit,
    usageCount: descuento.usageCount,
    startsAt: aInputFecha(descuento.startsAt),
    endsAt: aInputFecha(descuento.endsAt),
    isActive: descuento.isActive,
  };

  const columnas: Column<FilaUso>[] = [
    {
      key: "clienta",
      header: "Clienta",
      primary: true,
      render: (u) => <span>{u.email || "Sin correo"}</span>,
    },
    {
      key: "pedido",
      header: "Pedido",
      render: (u) =>
        u.numero ? (
          <Link className="adm-link" href={`/admin/pedidos/${u.orderId}`}>
            {u.numero}
          </Link>
        ) : (
          <span className="adm-muted adm-small">Pedido borrado</span>
        ),
    },
    {
      key: "cuando",
      header: "Cuándo",
      hideOnMobile: true,
      render: (u) => <span className="adm-small">{FECHA.format(u.usedAt)}</span>,
    },
    {
      key: "total",
      header: "Total del pedido",
      align: "right",
      render: (u) =>
        u.totalCents === null ? <span className="adm-muted">—</span> : <Money cents={u.totalCents} tone="muted" />,
    },
  ];

  return (
    <>
      <DiscountForm
        descuento={editable}
        colecciones={colecciones}
        productos={productos}
        recienCreado={recienCreado}
      />

      <div style={{ marginTop: 20 }}>
        <Card
          title="Quién lo ha usado"
          flush
          footer={
            <span className="adm-muted adm-small">
              {descuento.usageCount} {descuento.usageCount === 1 ? "uso" : "usos"} en total
              {usos.length >= 200 ? " · se enseñan los 200 más recientes" : ""}
            </span>
          }
        >
          <DataTable<FilaUso>
            columns={columnas}
            rows={filas}
            rowKey={(u) => u.id}
            empty={
              <EmptyState
                title="Todavía no lo ha usado nadie"
                text="Aquí saldrá quién lo usó, en qué pedido y cuándo, en cuanto alguien lo escriba al pagar."
              />
            }
          />
        </Card>
      </div>
    </>
  );
}
