import { Badge, Button, Card, DataTable, EmptyState, type BadgeTone, type Column } from "../../_components/ui";
import { reintentarJob } from "../actions";

/**
 * El historial de importaciones.
 *
 * Es Server Component a propósito: una lista que solo lee datos no necesita
 * JavaScript en el navegador, y los dos botones que sí actúan (reintentar, seguir
 * revisando) funcionan con un `<form>` normal contra una Server Action. Menos
 * código enviado al teléfono de Madeline y una lista que funciona aunque el JS
 * tarde en cargar.
 *
 * Los intentos fallidos NO se esconden. Son la memoria de qué vía funcionó cada
 * día con cada proveedor, que es justo lo que enseña a usar la herramienta.
 */

export type JobVista = {
  id: string;
  provider: string;
  method: string;
  status: string;
  sourceUrl: string | null;
  error: string | null;
  createdAt: Date;
  /** Título leído del borrador, cuando lo hay. */
  titulo: string | null;
  producto: { id: string; slug: string; title: string } | null;
};

const PROVEEDOR: Record<string, string> = {
  aliexpress: "AliExpress",
  alibaba: "Alibaba",
  csv: "CSV",
  manual: "Manual",
};

const METODO: Record<string, string> = {
  url: "Enlace",
  html: "HTML pegado",
  api: "API oficial",
  bookmarklet: "Marcador",
  csv: "Fichero CSV",
  migracion: "Mudanza",
};

const ESTADO: Record<string, { texto: string; tono: BadgeTone }> = {
  pending: { texto: "En cola", tono: "neutral" },
  parsing: { texto: "Leyendo", tono: "info" },
  ready: { texto: "Por revisar", tono: "warning" },
  imported: { texto: "Publicado", tono: "success" },
  failed: { texto: "Falló", tono: "danger" },
};

const FECHA = new Intl.DateTimeFormat("es-US", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export default function JobList({ jobs }: { jobs: JobVista[] }) {
  const columnas: Column<JobVista>[] = [
    {
      key: "producto",
      header: "Producto",
      primary: true,
      render: (job) => (
        <div>
          <b>{job.titulo || job.producto?.title || "Sin título"}</b>
          {job.sourceUrl ? <div className="adm-small adm-muted imp-url-corta">{job.sourceUrl}</div> : null}
          {job.error ? <div className="adm-small" style={{ color: "var(--adm-danger)" }}>{job.error}</div> : null}
        </div>
      ),
    },
    {
      key: "proveedor",
      header: "Proveedor",
      render: (job) => <Badge tone="info">{PROVEEDOR[job.provider] ?? job.provider}</Badge>,
    },
    {
      key: "metodo",
      header: "Vía",
      hideOnMobile: true,
      render: (job) => <span className="adm-small">{METODO[job.method] ?? job.method}</span>,
    },
    {
      key: "estado",
      header: "Estado",
      render: (job) => {
        const estado = ESTADO[job.status] ?? { texto: job.status, tono: "neutral" as BadgeTone };
        return <Badge tone={estado.tono}>{estado.texto}</Badge>;
      },
    },
    {
      key: "fecha",
      header: "Cuándo",
      hideOnMobile: true,
      render: (job) => <span className="adm-small adm-muted">{FECHA.format(job.createdAt)}</span>,
    },
    {
      key: "acciones",
      header: "",
      align: "right",
      label: "Acciones",
      render: (job) => {
        if (job.status === "imported" && job.producto) {
          return (
            <Button size="sm" variant="ghost" href={`/admin/productos/${job.producto.id}`}>
              Ver producto
            </Button>
          );
        }
        if (job.status === "ready") {
          return (
            <Button size="sm" href={`/admin/importar?job=${job.id}`}>
              Seguir revisando
            </Button>
          );
        }
        if (job.status === "failed" && job.sourceUrl) {
          return (
            <form action={reintentarJob}>
              <input type="hidden" name="jobId" value={job.id} />
              <Button size="sm" variant="ghost" type="submit">
                Reintentar
              </Button>
            </form>
          );
        }
        // Un fallo sin enlace (HTML pegado o CSV) no se puede repetir solo: hace
        // falta el material original, así que se dice en vez de ofrecer un botón
        // que no haría nada.
        if (job.status === "failed") {
          return <span className="adm-small adm-muted">Vuelve a pegarlo arriba</span>;
        }
        return null;
      },
    },
  ];

  return (
    <Card
      title="Importaciones recientes"
      flush
      actions={<span className="adm-small adm-muted">Últimas {jobs.length}</span>}
    >
      <DataTable
        columns={columnas}
        rows={jobs}
        rowKey={(job) => job.id}
        empty={
          <EmptyState
            title="Todavía no has importado nada"
            text="Cuando traigas un producto de AliExpress o Alibaba aparecerá aquí, con la vía que usaste y cómo acabó."
          />
        }
      />
    </Card>
  );
}
