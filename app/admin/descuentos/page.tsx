import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { buscar } from "@/lib/search";
import { describirValor, describirVigencia, estadoDescuento, type ClaveEstado } from "@/lib/discounts";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  StatCard,
  type Column,
} from "../_components/ui";
import { CopiarCodigo } from "./_components/DiscountForm";
import { accionDescuento } from "./actions";
import "./descuentos.css";

/**
 * Listado de códigos de descuento.
 *
 * El estado (Activo / Programado / Caducado / Agotado / Desactivado) NO se lee
 * de ninguna columna: se calcula aquí mismo con la fecha de ahora y los usos que
 * lleva. Un badge guardado a mano miente en cuanto pasa la medianoche.
 *
 * Todo funciona sin JavaScript: los filtros son un formulario GET y las acciones
 * van a Server Actions. Lo único que necesita el navegador es el botón de copiar
 * el código, que si falla no rompe nada.
 */

export const dynamic = "force-dynamic";

/** Tope de seguridad: una boutique no tiene 500 códigos, pero si los tiene, avisamos. */
const TOPE = 300;

type Busqueda = Record<string, string | string[] | undefined>;

export default async function DescuentosPage({ searchParams }: { searchParams: Promise<Busqueda> }) {
  // Cada pantalla comprueba la sesión por su cuenta: en App Router la página se
  // renderiza aunque el layout no la pinte, y el resultado viaja en el payload
  // RSC. Solo redirect() aborta el render de verdad.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const sp = await searchParams;
  const q = uno(sp.q).trim();
  const estadoFiltro = uno(sp.estado);
  const idBorrar = uno(sp.borrar);
  const idDesactivar = uno(sp.desactivar);
  const ahora = new Date();

  /* ── confirmaciones: nada destructivo a un solo clic ─────────────────── */

  if (idBorrar || idDesactivar) {
    const objetivo = await db.discount.findUnique({ where: { id: idBorrar || idDesactivar } });
    if (!objetivo) {
      return (
        <>
          <PageHeader title="Ese código ya no existe" subtitle="Alguien lo borró mientras mirabas la lista." />
          <Card>
            <Button href="/admin/descuentos" variant="ghost">
              Volver al listado
            </Button>
          </Card>
        </>
      );
    }

    const borrando = Boolean(idBorrar);
    const usos = objetivo.usageCount;

    return (
      <>
        <PageHeader
          title={borrando ? "Confirmar el borrado" : "Confirmar que se apaga"}
          subtitle={
            borrando
              ? "Borrar un código es definitivo: no hay papelera."
              : "Apagarlo se puede deshacer cuando quieras."
          }
        />

        <form action={accionDescuento}>
          <input type="hidden" name="id" value={objetivo.id} />
          <input type="hidden" name="accion" value={borrando ? "borrar-confirmado" : "desactivar-confirmado"} />
          <input type="hidden" name="volver" value="/admin/descuentos" />

          <Card
            title={objetivo.code}
            footer={
              <div className="adm-row">
                <Button type="submit" variant="danger">
                  {borrando ? "Sí, borrar el código" : "Sí, apagar el código"}
                </Button>
                <Button href="/admin/descuentos" variant="ghost">
                  Cancelar
                </Button>
              </div>
            }
          >
            <ul className="desc-lista-confirmar">
              <li>
                <b>{describirValor(objetivo)}</b>
                {objetivo.title ? ` · ${objetivo.title}` : ""}
              </li>
              <li className="adm-muted adm-small">{describirVigencia(objetivo, ahora)}</li>
            </ul>

            {usos > 0 ? (
              <p className="desc-aviso desc-aviso-warn" style={{ marginTop: 16, marginBottom: 0 }}>
                Este código ya se usó <b>{usos}</b> {usos === 1 ? "vez" : "veces"}.{" "}
                {borrando ? (
                  <>
                    Los pedidos que lo usaron <b>conservan su descuento</b> y siguen enseñando el código en la ficha
                    del pedido: no se les toca nada. Lo que se pierde es el historial de quién lo usó y cuándo.
                  </>
                ) : (
                  <>
                    Los pedidos ya hechos <b>conservan su descuento</b>. Lo que cambia es que, a partir de ahora, quien
                    lo tenga guardado de una story o de un DM ya no podrá usarlo.
                  </>
                )}
              </p>
            ) : (
              <p className="adm-muted adm-small" style={{ marginTop: 16 }}>
                Todavía no lo ha usado nadie, así que no afecta a ningún pedido.
              </p>
            )}
          </Card>
        </form>
      </>
    );
  }

  /* ── listado ──────────────────────────────────────────────────────────── */

  const where: Prisma.DiscountWhereInput = q
    ? // SQLite compara LIKE sin distinguir mayúsculas para ASCII: no hace falta
      // (ni existe) el `mode: "insensitive"` de Postgres.
      { OR: [{ code: buscar(q) }, { title: buscar(q) }] }
    : {};

  const [encontrados, total, resumen] = await Promise.all([
    db.discount.findMany({ where, orderBy: { createdAt: "desc" }, take: TOPE }),
    db.discount.count(),
    // Los contadores de arriba cuentan SIEMPRE la tienda entera, no lo que haya
    // filtrado el buscador: "Activos ahora: 1" mientras hay doce activos sería
    // una cifra falsa, y esa es la que se acaba repitiendo por teléfono.
    q
      ? db.discount.findMany({
          take: TOPE,
          select: { isActive: true, startsAt: true, endsAt: true, usageLimit: true, usageCount: true },
        })
      : null,
  ]);

  const conEstado = encontrados.map((d) => ({ ...d, estado: estadoDescuento(d, ahora) }));
  const filas = estadoFiltro ? conEstado.filter((d) => d.estado.clave === estadoFiltro) : conEstado;

  const paraContar = (resumen ?? encontrados).map((d) => ({
    clave: estadoDescuento(d, ahora).clave,
    usageCount: d.usageCount,
  }));
  const cuenta = (clave: ClaveEstado) => paraContar.filter((d) => d.clave === clave).length;
  const usosTotales = paraContar.reduce((suma, d) => suma + d.usageCount, 0);
  const mensaje = construirMensaje(uno(sp.hecho), uno(sp.code));

  type Fila = (typeof filas)[number];

  const columnas: Column<Fila>[] = [
    {
      key: "code",
      header: "Código",
      primary: true,
      render: (d) => (
        <span className="desc-codigo">
          <Link className="adm-link desc-codigo-txt" href={`/admin/descuentos/${d.id}`}>
            {d.code}
          </Link>
          <CopiarCodigo code={d.code} />
        </span>
      ),
    },
    {
      key: "valor",
      header: "Descuenta",
      render: (d) => (
        <span className="desc-celda">
          <b>{describirValor(d)}</b>
          {d.title ? <small>{d.title}</small> : null}
          {d.minSubtotalCents > 0 ? <small>Compra mínima {formatearMinimo(d.minSubtotalCents)}</small> : null}
        </span>
      ),
    },
    {
      key: "alcance",
      header: "Aplica a",
      hideOnMobile: true,
      render: (d) => <span className="adm-small adm-muted">{alcanceTexto(d.appliesTo)}</span>,
    },
    {
      key: "usos",
      header: "Usos",
      align: "right",
      render: (d) => (
        <span className="desc-celda">
          <span>
            {d.usageCount}
            {d.usageLimit > 0 ? ` / ${d.usageLimit}` : ""}
          </span>
          {d.usageLimit > 0 ? (
            <span className={d.usageCount >= d.usageLimit ? "desc-usos-barra is-lleno" : "desc-usos-barra"}>
              <span style={{ width: `${Math.min(100, Math.round((d.usageCount / d.usageLimit) * 100))}%` }} />
            </span>
          ) : (
            <small>sin límite</small>
          )}
        </span>
      ),
    },
    {
      key: "vigencia",
      header: "Vigencia",
      hideOnMobile: true,
      render: (d) => <span className="adm-small">{describirVigencia(d, ahora)}</span>,
    },
    {
      key: "estado",
      header: "Estado",
      render: (d) => <Badge tone={d.estado.tone}>{d.estado.label}</Badge>,
    },
    {
      key: "acciones",
      header: "",
      label: "Acciones",
      align: "right",
      render: (d) => (
        // Un formulario por fila: activar y apagar son un clic, pero apagar un
        // código ya usado pasa antes por la pantalla de confirmación (lo decide
        // el Server Action, no el botón).
        //
        // La acción va en un campo oculto y NO en el name/value del botón: con
        // Server Actions de React 19 el name/value del botón que envía no llega
        // al servidor (medido: la acción llegaba vacía y caía en el `default`).
        <form action={accionDescuento}>
          <input type="hidden" name="id" value={d.id} />
          <input type="hidden" name="volver" value={urlConFiltros(sp)} />
          <input type="hidden" name="accion" value={d.isActive ? "desactivar" : "activar"} />
          <Button type="submit" variant="ghost" size="sm">
            {d.isActive ? "Apagar" : "Encender"}
          </Button>
        </form>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Descuentos"
        subtitle={`${total} ${total === 1 ? "código" : "códigos"} · ${usosTotales} ${usosTotales === 1 ? "uso" : "usos"} en total`}
        actions={<Button href="/admin/descuentos/nuevo">Nuevo código</Button>}
      />

      <p className="desc-intro">
        Aquí creas los códigos que las clientas escriben al pagar para llevarse una rebaja. Cada código dice cuánto
        descuenta, a qué se aplica y hasta cuándo vale.
      </p>

      {mensaje ? <div className={`desc-aviso desc-aviso-${mensaje.tono}`}>{mensaje.texto}</div> : null}

      {total > 0 ? (
        <div className="adm-grid">
          <StatCard label="Activos ahora" value={cuenta("activo")} tone="success" hint="Se pueden usar en este momento" />
          <StatCard label="Programados" value={cuenta("programado")} hint="Empiezan más adelante" />
          <StatCard label="Caducados" value={cuenta("caducado")} hint="Se les pasó la fecha" />
          <StatCard
            label="Agotados"
            value={cuenta("agotado")}
            tone={cuenta("agotado") > 0 ? "warning" : "default"}
            hint="Llegaron a su máximo de usos"
          />
        </div>
      ) : null}

      {total > 0 ? (
        <Card title="Buscar">
          <form method="get" action="/admin/descuentos" className="desc-filtros">
            <div className="adm-field desc-filtros-busca">
              <label className="adm-field-lbl" htmlFor="q">
                Código o nombre
              </label>
              <input id="q" name="q" type="search" defaultValue={q} placeholder="BLOOM-4K2P, rebajas…" />
            </div>

            <div className="adm-field">
              <label className="adm-field-lbl" htmlFor="estado">
                Estado
              </label>
              <select id="estado" name="estado" defaultValue={estadoFiltro}>
                <option value="">Todos</option>
                <option value="activo">Activo</option>
                <option value="programado">Programado</option>
                <option value="caducado">Caducado</option>
                <option value="agotado">Agotado</option>
                <option value="apagado">Desactivado</option>
              </select>
            </div>

            <Button type="submit" variant="ghost">
              Aplicar
            </Button>
            <Button href="/admin/descuentos" variant="ghost">
              Limpiar
            </Button>
          </form>
        </Card>
      ) : null}

      <Card
        title="Códigos"
        flush
        footer={
          <span className="adm-muted adm-small">
            {filas.length} {filas.length === 1 ? "código" : "códigos"} en pantalla
            {encontrados.length >= TOPE ? ` · se enseñan los ${TOPE} más recientes` : ""}
          </span>
        }
      >
        <DataTable<Fila>
          columns={columnas}
          rows={filas}
          rowKey={(d) => d.id}
          empty={
            total === 0 ? (
              <EmptyState
                icon={<IconEtiqueta />}
                title="Todavía no hay ningún código"
                text="Un código de descuento es la forma más simple de mover una promoción por Instagram: lo pones en la story, la clienta lo escribe al pagar y ve la rebaja al momento."
                action={<Button href="/admin/descuentos/nuevo">Crear el primero</Button>}
              />
            ) : (
              <EmptyState
                icon={<IconLupa />}
                title="Ningún código con ese filtro"
                text="Prueba a quitar el filtro o a buscar otra cosa."
                action={
                  <Button href="/admin/descuentos" variant="ghost">
                    Ver todos
                  </Button>
                }
              />
            )
          }
        />
      </Card>
    </>
  );
}

/* ─────────────────────────── utilidades ─────────────────────────── */

function uno(valor: string | string[] | undefined): string {
  if (Array.isArray(valor)) return valor[0] ?? "";
  return valor ?? "";
}

function alcanceTexto(appliesTo: string): string {
  switch (appliesTo) {
    case "collection":
      return "Algunas colecciones";
    case "product":
      return "Algunos productos";
    default:
      return "Toda la tienda";
  }
}

/** El mínimo se pinta con la misma función que todo el dinero del panel. */
function formatearMinimo(cents: number): string {
  return describirValor({ type: "fixed", value: cents });
}

function urlConFiltros(sp: Busqueda): string {
  const params = new URLSearchParams();
  for (const clave of ["q", "estado"]) {
    const valor = uno(sp[clave]);
    if (valor) params.set(clave, valor);
  }
  const cadena = params.toString();
  return cadena ? `/admin/descuentos?${cadena}` : "/admin/descuentos";
}

function construirMensaje(
  hecho: string,
  code: string,
): { texto: string; tono: "ok" | "warn" | "info" | "error" } | null {
  switch (hecho) {
    case "activado":
      return { texto: "Código encendido: ya se puede usar al pagar.", tono: "ok" };
    case "desactivado":
      return { texto: "Código apagado. Los pedidos que ya lo usaron no cambian.", tono: "ok" };
    case "borrado":
      return {
        texto: `Código ${code || ""} borrado. Los pedidos que lo usaron conservan su descuento.`.replace("  ", " "),
        tono: "ok",
      };
    case "no-existe":
      return { texto: "Ese código ya no existe.", tono: "info" };
    case "nada":
      return { texto: "No se hizo nada: faltaba decir sobre qué código.", tono: "info" };
    default:
      return null;
  }
}

/* ─────────────────────────── iconos ─────────────────────────── */

function IconEtiqueta() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h8.5l8.1 8.1a1.7 1.7 0 0 1 0 2.3Z" />
      <circle cx="7.5" cy="7.5" r="1.3" />
    </svg>
  );
}

function IconLupa() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}
