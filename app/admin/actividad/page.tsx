import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { enlaceEntidad, etiquetaAccion, etiquetaEntidad, tonoAccion } from "@/lib/activity";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/permissions";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  PageHeader,
  type Column,
} from "../_components/ui";
import "../equipo/equipo.css";

/**
 * Actividad — la pantalla que responde a «¿quién cambió este precio?».
 *
 * Es solo lectura y solo para la dueña: aquí se ve todo lo que ha tocado cada
 * persona, incluidos los intentos de entrada fallidos.
 *
 * Los filtros viajan por la URL con un formulario GET normal, sin JavaScript,
 * así que "lo que hizo Ana en agosto" es un enlace que se puede guardar o
 * mandar por mensaje. En Next 15 `searchParams` es una promesa: hay que await.
 */

export const dynamic = "force-dynamic";

const POR_PAGINA = 40;

const fechaHora = new Intl.DateTimeFormat("es-US", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

type Filtros = {
  usuario: string;
  entidad: string;
  desde: string;
  hasta: string;
  pagina: number;
};

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function uno(params: Record<string, string | string[] | undefined>, clave: string): string {
  const bruto = params[clave];
  return (Array.isArray(bruto) ? bruto[0] : bruto)?.trim() ?? "";
}

function leerFiltros(params: Record<string, string | string[] | undefined>): Filtros {
  const pagina = Number.parseInt(uno(params, "pagina") || "1", 10);
  const desde = uno(params, "desde");
  const hasta = uno(params, "hasta");

  return {
    usuario: uno(params, "usuario").toLowerCase().slice(0, 160),
    entidad: uno(params, "entidad").slice(0, 40),
    // Una fecha con formato raro se ignora en vez de romper la consulta.
    desde: FECHA_ISO.test(desde) ? desde : "",
    hasta: FECHA_ISO.test(hasta) ? hasta : "",
    pagina: Number.isFinite(pagina) && pagina > 0 ? pagina : 1,
  };
}

function enlace(filtros: Filtros, cambios: Partial<Filtros>): string {
  const f = { ...filtros, ...cambios };
  const qs = new URLSearchParams();
  if (f.usuario) qs.set("usuario", f.usuario);
  if (f.entidad) qs.set("entidad", f.entidad);
  if (f.desde) qs.set("desde", f.desde);
  if (f.hasta) qs.set("hasta", f.hasta);
  if (f.pagina > 1) qs.set("pagina", String(f.pagina));
  const cadena = qs.toString();
  return cadena ? `/admin/actividad?${cadena}` : "/admin/actividad";
}

type Linea = {
  id: string;
  createdAt: Date;
  userEmail: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
};

export default async function ActividadPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await requireOwner("actividad");
  const filtros = leerFiltros(await searchParams);

  // Los intentos de entrada anónimos se guardan con userEmail "" (lib/activity.ts).
  // Sin un valor propio, su <option> chocaba con «Todo el mundo» (ambos value="")
  // y filtrar por «El sistema» no filtraba nada. Este centinela los distingue.
  const FILTRO_SISTEMA = "__sistema__";

  const where: Prisma.ActivityLogWhereInput = {};
  if (filtros.usuario === FILTRO_SISTEMA) where.userEmail = "";
  else if (filtros.usuario) where.userEmail = filtros.usuario;
  if (filtros.entidad) where.entityType = filtros.entidad;
  if (filtros.desde || filtros.hasta) {
    where.createdAt = {
      ...(filtros.desde ? { gte: new Date(`${filtros.desde}T00:00:00`) } : {}),
      // Hasta el final del día elegido: si no, "hasta el 12" dejaría fuera todo
      // lo que pasó el día 12, que es justo lo que la gente espera ver.
      ...(filtros.hasta ? { lte: new Date(`${filtros.hasta}T23:59:59.999`) } : {}),
    };
  }

  const [total, lineas, usuarios, entidades] = await Promise.all([
    db.activityLog.count({ where }),
    db.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filtros.pagina - 1) * POR_PAGINA,
      take: POR_PAGINA,
      select: {
        id: true,
        createdAt: true,
        userEmail: true,
        action: true,
        entityType: true,
        entityId: true,
        summary: true,
      },
    }),
    db.activityLog.groupBy({ by: ["userEmail"], _count: { _all: true }, orderBy: { userEmail: "asc" } }),
    db.activityLog.groupBy({ by: ["entityType"], _count: { _all: true }, orderBy: { entityType: "asc" } }),
  ]);

  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const hayFiltro = Boolean(filtros.usuario || filtros.entidad || filtros.desde || filtros.hasta);

  const columnas: Column<Linea>[] = [
    {
      key: "cuando",
      header: "Cuándo",
      primary: true,
      render: (l) => <span>{fechaHora.format(l.createdAt)}</span>,
    },
    {
      key: "quien",
      header: "Quién",
      render: (l) => (
        <span className="eq-quien">
          <span>{l.userEmail || "El sistema"}</span>
          {l.userEmail === admin.email ? <span className="adm-muted adm-small">tú</span> : null}
        </span>
      ),
    },
    {
      key: "accion",
      header: "Acción",
      render: (l) => <Badge tone={tonoAccion(l.action)}>{etiquetaAccion(l.action)}</Badge>,
    },
    {
      key: "sobre",
      header: "Sobre qué",
      render: (l) => {
        const destino = enlaceEntidad(l.entityType, l.entityId);
        const etiqueta = etiquetaEntidad(l.entityType);
        return destino ? (
          <Link className="adm-link" href={destino}>
            {etiqueta}
          </Link>
        ) : (
          <span className="adm-muted">{etiqueta}</span>
        );
      },
    },
    {
      key: "resumen",
      header: "Qué pasó",
      render: (l) => <span className="eq-resumen">{l.summary || "—"}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Actividad"
        subtitle="Todo lo que se ha tocado en el panel, con fecha y nombre. Aquí se ve quién cambió qué."
        actions={
          <Button href="/admin/equipo" variant="ghost">
            Equipo
          </Button>
        }
      />

      <Card title="Filtrar">
        <form className="eq-filtros" method="get" action="/admin/actividad">
          <Field label="Quién" htmlFor="usuario">
            <select id="usuario" name="usuario" defaultValue={filtros.usuario}>
              <option value="">Todo el mundo</option>
              {usuarios.map((u) => (
                <option key={u.userEmail || "sistema"} value={u.userEmail || FILTRO_SISTEMA}>
                  {u.userEmail || "El sistema"} ({u._count._all})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Sobre qué" htmlFor="entidad">
            <select id="entidad" name="entidad" defaultValue={filtros.entidad}>
              <option value="">Todo</option>
              {entidades.map((e) => (
                <option key={e.entityType} value={e.entityType}>
                  {etiquetaEntidad(e.entityType)} ({e._count._all})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Desde" htmlFor="desde">
            <input id="desde" name="desde" type="date" defaultValue={filtros.desde} />
          </Field>

          <Field label="Hasta" htmlFor="hasta">
            <input id="hasta" name="hasta" type="date" defaultValue={filtros.hasta} />
          </Field>

          <div className="eq-filtros-botones">
            <Button type="submit" size="sm">
              Filtrar
            </Button>
            {hayFiltro ? (
              <Button href="/admin/actividad" variant="ghost" size="sm">
                Quitar filtros
              </Button>
            ) : null}
          </div>
        </form>
      </Card>

      <Card
        title="Historial"
        flush
        footer={
          <div className="eq-paginacion">
            <span>
              {total} {total === 1 ? "movimiento" : "movimientos"} · página {filtros.pagina} de {paginas}
            </span>
            <span className="adm-row">
              {filtros.pagina > 1 ? (
                <Button href={enlace(filtros, { pagina: filtros.pagina - 1 })} variant="ghost" size="sm">
                  Anteriores
                </Button>
              ) : null}
              {filtros.pagina < paginas ? (
                <Button href={enlace(filtros, { pagina: filtros.pagina + 1 })} variant="ghost" size="sm">
                  Siguientes
                </Button>
              ) : null}
            </span>
          </div>
        }
      >
        <DataTable
          columns={columnas}
          rows={lineas}
          rowKey={(l) => l.id}
          empty={
            hayFiltro ? (
              <EmptyState
                title="Nada con esos filtros"
                text="Prueba a ampliar las fechas o a quitar el filtro de persona."
                action={
                  <Button href="/admin/actividad" variant="ghost">
                    Quitar filtros
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="Todavía no hay historial"
                text="En cuanto alguien cambie un precio, marque un pedido o entre en el panel, aparecerá aquí."
                action={<Button href="/admin/productos">Ir a productos</Button>}
              />
            )
          }
        />
      </Card>
    </>
  );
}
