import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { db } from "@/lib/db";
import { DESCRIPCION_ROL, ETIQUETA_ROL, ETIQUETA_SECCION, requireSesion } from "@/lib/permissions";
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
import {
  enviarCambiarContrasena,
  enviarCambiarNombre,
  enviarCerrarOtrasSesiones,
  enviarCerrarUnaSesion,
} from "./actions";
import "../equipo/equipo.css";

/**
 * Tu cuenta — la única pantalla del módulo que ve todo el mundo.
 *
 * Hace tres cosas y las tres son de una persona sobre sí misma: cómo se llama,
 * su contraseña y en qué dispositivos tiene el panel abierto.
 *
 * También es donde aterriza quien intenta entrar en una sección de la dueña:
 * `requireOwner()` redirige aquí con `?sinPermiso=<sección>` y arriba se pinta
 * la explicación. Es mejor que un 403 en blanco, que a una persona no técnica
 * no le dice absolutamente nada.
 *
 * Los estilos se importan de ../equipo/equipo.css: es el fichero de este
 * módulo (Equipo · Tu cuenta · Actividad) y las tres pantallas comparten
 * piezas. admin.css no se toca.
 */

export const dynamic = "force-dynamic";

const fechaLarga = new Intl.DateTimeFormat("es-US", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const EXITO: Record<string, string> = {
  nombre: "Nombre actualizado.",
  clave: "Contraseña cambiada. Se cerraron tus sesiones en los demás dispositivos.",
  "sesiones-cerradas": "Listo: solo sigue abierta la sesión de este dispositivo.",
  "sesion-cerrada": "Sesión cerrada.",
};

const FALLO: Record<string, string> = {
  "sin-sesion": "Tu sesión ha caducado. Vuelve a entrar en el panel.",
  datos: "Revisa los datos: falta algo o no tiene el formato correcto.",
  "clave-actual": "La contraseña actual no es correcta.",
  "clave-debil":
    "Esa contraseña es demasiado fácil. Necesita 10 caracteres o más, con letras y algún número " +
    "(o 16 caracteres si prefieres una frase), y no puede llevar dentro tu nombre ni tu correo.",
  "no-coincide": "Las dos contraseñas nuevas no son iguales.",
  "clave-repetida": "Esa es la contraseña que ya tenías. Elige una distinta.",
  "sesion-actual": "Esa es la sesión de este dispositivo. Para cerrarla usa «Salir» en el menú.",
  error: "No se pudo guardar. Inténtalo otra vez.",
};

type SesionFila = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  esActual: boolean;
};

function uno(params: Record<string, string | string[] | undefined>, clave: string): string {
  const bruto = params[clave];
  return (Array.isArray(bruto) ? bruto[0] : bruto)?.trim() ?? "";
}

export default async function CuentaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await requireSesion();
  const params = await searchParams;

  const ok = uno(params, "ok");
  const error = uno(params, "error");
  const sinPermiso = uno(params, "sinPermiso");

  const jar = await cookies();
  const tokenActual = jar.get(SESSION_COOKIE)?.value ?? "";

  const ahora = new Date();
  const sesiones = await db.session.findMany({
    where: { userId: admin.id, expiresAt: { gt: ahora } },
    orderBy: { createdAt: "desc" },
    // El token se usa solo para saber cuál es la de este dispositivo; nunca se pinta.
    select: { id: true, token: true, createdAt: true, expiresAt: true },
  });

  const filas: SesionFila[] = sesiones.map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    esActual: Boolean(tokenActual) && s.token === tokenActual,
  }));

  const otras = filas.filter((s) => !s.esActual).length;

  const columnas: Column<SesionFila>[] = [
    {
      key: "inicio",
      header: "Sesión iniciada",
      primary: true,
      render: (s) => (
        <span className="eq-nombre">
          {fechaLarga.format(s.createdAt)}
          {s.esActual ? <Badge tone="info">Este dispositivo</Badge> : null}
        </span>
      ),
    },
    {
      key: "caduca",
      header: "Caduca",
      hideOnMobile: true,
      render: (s) => <span className="adm-small">{fechaLarga.format(s.expiresAt)}</span>,
    },
    {
      key: "accion",
      header: "Acción",
      align: "right",
      render: (s) =>
        s.esActual ? (
          <span className="adm-muted adm-small">Estás aquí</span>
        ) : (
          <form action={enviarCerrarUnaSesion}>
            <input type="hidden" name="id" value={s.id} />
            <Button type="submit" variant="ghost" size="sm">
              Cerrar
            </Button>
          </form>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Tu cuenta"
        subtitle="Tu nombre, tu contraseña y los dispositivos donde tienes el panel abierto."
        actions={
          admin.role === "owner" ? (
            <Button href="/admin/equipo" variant="ghost">
              Equipo
            </Button>
          ) : null
        }
      />

      {sinPermiso ? (
        <p className="eq-aviso is-error" role="alert">
          La sección <strong>{ETIQUETA_SECCION[sinPermiso] ?? "que intentabas abrir"}</strong> es solo para la dueña
          de la tienda. Tu cuenta es de ayudante: puedes con pedidos, productos e inventario. Si necesitas entrar
          ahí, pídeselo a Madeline.
        </p>
      ) : null}

      {ok && EXITO[ok] ? (
        <p className="eq-aviso is-ok" role="status">
          {EXITO[ok]}
        </p>
      ) : null}
      {error ? (
        <p className="eq-aviso is-error" role="alert">
          {FALLO[error] ?? "No se pudo completar la acción."}
        </p>
      ) : null}

      <div className="adm-cols-2">
        <Card title="Tus datos">
          <dl className="eq-datos">
            <dt>Correo</dt>
            <dd>{admin.email}</dd>
            <dt>Rol</dt>
            <dd>
              <Badge tone={admin.role === "owner" ? "success" : "neutral"}>{ETIQUETA_ROL[admin.role]}</Badge>
            </dd>
          </dl>
          <p className="adm-muted adm-small">{DESCRIPCION_ROL[admin.role]}</p>

          <form action={enviarCambiarNombre}>
            <Field label="Nombre" htmlFor="nombre" required hint="Es el que aparece en el panel y en Actividad.">
              <input id="nombre" name="nombre" type="text" defaultValue={admin.name} required maxLength={60} />
            </Field>
            <Button type="submit" variant="ghost">
              Guardar nombre
            </Button>
          </form>

          <p className="adm-muted adm-small">
            El correo no se cambia desde aquí: es con lo que entras. Si hace falta cambiarlo, se crea una cuenta
            nueva desde Equipo y se desactiva la vieja.
          </p>
        </Card>

        <Card title="Contraseña">
          <p className="eq-nota">
            Para cambiarla hace falta la que usas ahora. Al guardar, <strong>se cerrarán tus sesiones en los demás
            dispositivos</strong>: si cambias la contraseña es porque quieres echar a alguien.
          </p>

          <form action={enviarCambiarContrasena}>
            <Field label="Contraseña actual" htmlFor="actual" required>
              <input id="actual" name="actual" type="password" autoComplete="current-password" required />
            </Field>

            <Field
              label="Contraseña nueva"
              htmlFor="nueva"
              required
              hint="Mínimo 10 caracteres con letras y algún número. Una frase larga (16+) también vale."
            >
              <input id="nueva" name="nueva" type="password" autoComplete="new-password" required minLength={10} />
            </Field>

            <Field label="Repite la nueva" htmlFor="repetida" required>
              <input
                id="repetida"
                name="repetida"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
              />
            </Field>

            <Button type="submit">Cambiar contraseña</Button>
          </form>
        </Card>
      </div>

      <Card
        title="Dispositivos con el panel abierto"
        flush
        actions={
          otras > 0 ? (
            <form action={enviarCerrarOtrasSesiones}>
              <Button type="submit" variant="ghost" size="sm">
                Cerrar las {otras === 1 ? "otra" : `otras ${otras}`}
              </Button>
            </form>
          ) : null
        }
      >
        <DataTable
          columns={columnas}
          rows={filas}
          rowKey={(s) => s.id}
          empty={
            <EmptyState
              title="Ninguna sesión abierta"
              text="Ni siquiera esta, lo cual es raro. Si acabas de entrar, recarga la página."
            />
          }
        />
      </Card>
    </>
  );
}
