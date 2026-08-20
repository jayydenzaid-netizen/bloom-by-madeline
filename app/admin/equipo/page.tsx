import Link from "next/link";
import { db } from "@/lib/db";
import {
  DESCRIPCION_ROL,
  ETIQUETA_ROL,
  ROLES,
  normalizarRol,
  requireOwner,
  type Rol,
} from "@/lib/permissions";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  PageHeader,
  StatCard,
  type Column,
} from "../_components/ui";
import {
  enviarCambiarRol,
  enviarCerrarSesiones,
  enviarCrearCuenta,
  enviarDesactivar,
  enviarDescartarClave,
  enviarReactivar,
  enviarRestablecerClave,
  leerClaveInicial,
} from "./actions";
import "./equipo.css";

/**
 * Equipo — quién puede entrar en el panel.
 *
 * Reservada a la dueña. Está escrita entera como Server Component, sin una
 * línea de JavaScript de cliente, y eso es una decisión, no una limitación:
 *
 *  - Todo lo que puede fastidiar a alguien (desactivar una cuenta, cerrarle las
 *    sesiones, cambiarle la contraseña) pasa por una pantalla de confirmación
 *    con su propio botón. Así **ningún botón destructivo actúa al primer clic**,
 *    ni siquiera con un dedo torpe en el móvil.
 *  - El resultado vuelve en la URL como un código (`?ok=creada`) que aquí se
 *    traduce a castellano. Por la URL no viaja jamás una contraseña.
 */

export const dynamic = "force-dynamic";

const fechaLarga = new Intl.DateTimeFormat("es-US", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/* ─────────────────────────── mensajes ─────────────────────────── */

const EXITO: Record<string, string> = {
  creada: "Cuenta creada. Copia la contraseña de abajo y dásela en mano.",
  "rol-cambiado": "Rol actualizado.",
  desactivada: "Cuenta desactivada. Ya no puede entrar y se le cerraron las sesiones.",
  reactivada: "Cuenta reactivada. Entra con la contraseña de siempre.",
  "sesiones-cerradas": "Sesiones cerradas. Tendrá que volver a entrar.",
  "clave-nueva": "Contraseña nueva generada. Cópiala abajo y dásela en mano.",
};

const FALLO: Record<string, string> = {
  "sin-permiso": "Esta sección es solo para la dueña de la tienda.",
  datos: "Revisa los datos: falta algo o no tiene el formato correcto.",
  "email-duplicado": "Ya hay una cuenta con ese correo.",
  "no-existe": "Esa cuenta ya no existe.",
  "ultimo-owner":
    "No se puede: es la última cuenta de dueña activa. Si la apagas o la conviertes en ayudante, " +
    "nadie podría volver a entrar en Ajustes, Equipo ni Descuentos. Crea antes otra cuenta de dueña.",
  "auto-desactivar": "No puedes desactivar tu propia cuenta. Pídeselo a la otra dueña.",
  "auto-rol": "No puedes cambiarte el rol a ti misma: te quedarías fuera sin poder volver.",
  "auto-sesiones": "Tus propias sesiones se cierran desde «Tu cuenta».",
  "auto-clave": "Tu contraseña se cambia desde «Tu cuenta», donde se te pide la actual.",
  error: "No se pudo guardar. Inténtalo otra vez.",
};

/* ─────────────────────────── datos de la pantalla ─────────────────────────── */

type Cuenta = {
  id: string;
  name: string;
  email: string;
  role: Rol;
  isActive: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  sesiones: number;
};

function uno(params: Record<string, string | string[] | undefined>, clave: string): string {
  const bruto = params[clave];
  return (Array.isArray(bruto) ? bruto[0] : bruto)?.trim() ?? "";
}

export default async function EquipoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Doble cierre: el layout ya exige sesión, esto exige además ser la dueña.
  const admin = await requireOwner("equipo");
  const params = await searchParams;

  const ok = uno(params, "ok");
  const error = uno(params, "error");
  const nuevoId = uno(params, "nuevo");
  const confirmar = uno(params, "confirmar");
  const idConfirmar = uno(params, "id");

  const ahora = new Date();
  const [filas, sesionesPorUsuario] = await Promise.all([
    db.adminUser.findMany({
      orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true, lastLoginAt: true },
    }),
    db.session.groupBy({ by: ["userId"], where: { expiresAt: { gt: ahora } }, _count: { _all: true } }),
  ]);

  const conteo = new Map(sesionesPorUsuario.map((s) => [s.userId, s._count._all]));
  const cuentas: Cuenta[] = filas.map((f) => ({
    ...f,
    role: normalizarRol(f.role),
    sesiones: conteo.get(f.id) ?? 0,
  }));

  const activas = cuentas.filter((c) => c.isActive);
  const duenas = activas.filter((c) => c.role === "owner").length;
  const sesionesAbiertas = cuentas.reduce((total, c) => total + c.sesiones, 0);

  // La contraseña recién generada solo existe en memoria y solo se enseña aquí.
  const claveNueva = nuevoId ? await leerClaveInicial(nuevoId) : null;
  const cuentaNueva = claveNueva ? cuentas.find((c) => c.id === nuevoId) ?? null : null;

  const aConfirmar = idConfirmar ? cuentas.find((c) => c.id === idConfirmar) ?? null : null;

  const columnas: Column<Cuenta>[] = [
    {
      key: "persona",
      header: "Persona",
      primary: true,
      render: (c) => (
        <div className="eq-persona">
          <span className="eq-nombre">
            {c.name || "Sin nombre"}
            {c.id === admin.id ? <Badge tone="info">Tú</Badge> : null}
          </span>
          <span className="adm-muted adm-small">{c.email}</span>
        </div>
      ),
    },
    {
      key: "rol",
      header: "Rol",
      render: (c) =>
        c.id === admin.id ? (
          // La propia cuenta no se puede degradar desde aquí: es la vía más
          // rápida de dejar la tienda sin nadie que pueda entrar en Ajustes.
          <Badge tone="success">{ETIQUETA_ROL[c.role]}</Badge>
        ) : (
          <form action={enviarCambiarRol} className="eq-rol-form">
            <input type="hidden" name="id" value={c.id} />
            <label className="eq-oculto" htmlFor={`rol-${c.id}`}>
              Rol de {c.name || c.email}
            </label>
            <select id={`rol-${c.id}`} name="rol" defaultValue={c.role}>
              {ROLES.map((rol) => (
                <option key={rol} value={rol}>
                  {ETIQUETA_ROL[rol]}
                </option>
              ))}
            </select>
            <Button type="submit" variant="ghost" size="sm">
              Guardar
            </Button>
          </form>
        ),
    },
    {
      key: "estado",
      header: "Estado",
      render: (c) => (c.isActive ? <Badge tone="success">Activa</Badge> : <Badge tone="danger">Desactivada</Badge>),
    },
    {
      key: "acceso",
      header: "Último acceso",
      hideOnMobile: true,
      render: (c) => (
        <span className="adm-small">{c.lastLoginAt ? fechaLarga.format(c.lastLoginAt) : "Nunca ha entrado"}</span>
      ),
    },
    {
      key: "sesiones",
      header: "Sesiones",
      align: "center",
      hideOnMobile: true,
      render: (c) => <span className="adm-small">{c.sesiones}</span>,
    },
    {
      key: "acciones",
      header: "Acciones",
      align: "right",
      render: (c) => (
        <div className="eq-acciones">
          {c.isActive ? (
            <>
              <Link className="adm-link adm-small" href={`/admin/equipo?confirmar=clave&id=${c.id}`}>
                Contraseña nueva
              </Link>
              <Link className="adm-link adm-small" href={`/admin/equipo?confirmar=sesiones&id=${c.id}`}>
                Cerrar sesiones
              </Link>
              <Link className="adm-link adm-small eq-peligro" href={`/admin/equipo?confirmar=desactivar&id=${c.id}`}>
                Desactivar
              </Link>
            </>
          ) : (
            <form action={enviarReactivar}>
              <input type="hidden" name="id" value={c.id} />
              <Button type="submit" variant="ghost" size="sm">
                Reactivar
              </Button>
            </form>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Equipo"
        subtitle="Las personas que pueden entrar en este panel, y qué puede tocar cada una."
        actions={
          <>
            <Button href="/admin/actividad" variant="ghost">
              Ver actividad
            </Button>
            <Button href="/admin/cuenta" variant="ghost">
              Tu cuenta
            </Button>
          </>
        }
      />

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

      {claveNueva && cuentaNueva ? (
        <Card title="Contraseña para entrar">
          <p className="eq-nota">
            Esta contraseña es para <strong>{cuentaNueva.name || cuentaNueva.email}</strong>. Aquí no hay correo
            configurado, así que <strong>tienes que dársela tú en mano</strong> (o por mensaje). Se enseña solo
            ahora: si cierras esta pantalla o pasan 30 minutos, desaparece y habrá que generar otra.
          </p>
          <p className="eq-clave" aria-label="Contraseña inicial">
            {claveNueva}
          </p>
          <p className="adm-muted adm-small">
            Selecciónala con el dedo (o con el ratón) y cópiala. Dile que la cambie desde «Tu cuenta» en cuanto entre.
          </p>
          <form action={enviarDescartarClave} className="eq-fila">
            <input type="hidden" name="id" value={cuentaNueva.id} />
            <Button type="submit" variant="ghost" size="sm">
              Ya la copié, ocúltala
            </Button>
          </form>
        </Card>
      ) : null}

      {aConfirmar ? <Confirmacion cuenta={aConfirmar} accion={confirmar} /> : null}

      <div className="adm-grid">
        <StatCard label="Cuentas activas" value={activas.length} hint={`${cuentas.length} en total`} />
        <StatCard
          label="Dueñas"
          value={duenas}
          tone={duenas > 1 ? "success" : "default"}
          hint={duenas === 1 ? "Solo tú puedes tocar Ajustes" : "Podéis tocar Ajustes"}
        />
        <StatCard label="Sesiones abiertas" value={sesionesAbiertas} hint="Dispositivos dentro del panel ahora" />
      </div>

      <Card title="Cuentas" flush>
        <DataTable
          columns={columnas}
          rows={cuentas}
          rowKey={(c) => c.id}
          empty={<EmptyState title="Sin cuentas" text="Crea la primera cuenta con el formulario de abajo." />}
        />
      </Card>

      <Card title="Dar acceso a alguien">
        <p className="eq-nota">
          Crea una cuenta y el panel te dará una contraseña. <strong>No se envía ningún correo</strong>: se la pasas
          tú y ella la cambia al entrar.
        </p>

        <form action={enviarCrearCuenta}>
          <div className="adm-cols-2">
            <Field label="Nombre" htmlFor="nombre" required hint="Como la llamas tú: «Ana», «mi hermana»…">
              <input id="nombre" name="nombre" type="text" required maxLength={60} autoComplete="off" />
            </Field>

            <Field label="Correo" htmlFor="email" required hint="Con este correo entrará en el panel.">
              <input id="email" name="email" type="email" required maxLength={160} autoComplete="off" />
            </Field>
          </div>

          <Field label="Qué podrá hacer" htmlFor="rol" required hint={DESCRIPCION_ROL.staff}>
            <select id="rol" name="rol" defaultValue="staff">
              {ROLES.map((rol) => (
                <option key={rol} value={rol}>
                  {ETIQUETA_ROL[rol]} — {DESCRIPCION_ROL[rol]}
                </option>
              ))}
            </select>
          </Field>

          <Button type="submit">Crear cuenta</Button>
        </form>
      </Card>

      <Card title="Qué puede hacer cada rol">
        <ul className="eq-roles">
          {ROLES.map((rol) => (
            <li key={rol}>
              <Badge tone={rol === "owner" ? "success" : "neutral"}>{ETIQUETA_ROL[rol]}</Badge>
              <span>{DESCRIPCION_ROL[rol]}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

/* ─────────────────────────── confirmaciones ─────────────────────────── */

/**
 * Segundo paso obligatorio de las acciones que molestan a otra persona.
 * Cada una explica qué va a pasar y qué NO va a pasar, porque el miedo típico
 * ("¿pierdo sus pedidos?") es justo lo que impide usar el panel con soltura.
 */
function Confirmacion({ cuenta, accion }: { cuenta: Cuenta; accion: string }) {
  const quien = cuenta.name || cuenta.email;

  if (accion === "desactivar") {
    return (
      <Card title={`¿Desactivar a ${quien}?`} className="eq-confirm">
        <p className="eq-nota">
          Dejará de poder entrar ahora mismo y se le cerrarán las sesiones abiertas.{" "}
          <strong>No se borra nada</strong>: sus pedidos, sus cambios y su rastro en Actividad siguen ahí, y puedes
          volver a activarla cuando quieras.
        </p>
        <div className="eq-fila">
          <form action={enviarDesactivar}>
            <input type="hidden" name="id" value={cuenta.id} />
            <Button type="submit" variant="danger">
              Sí, desactivar
            </Button>
          </form>
          <Button href="/admin/equipo" variant="ghost">
            No, dejarlo como está
          </Button>
        </div>
      </Card>
    );
  }

  if (accion === "sesiones") {
    return (
      <Card title={`¿Cerrar las sesiones de ${quien}?`} className="eq-confirm">
        <p className="eq-nota">
          Se saldrá del panel en todos sus dispositivos ({cuenta.sesiones} abierta{cuenta.sesiones === 1 ? "" : "s"}).
          Su cuenta y su contraseña siguen valiendo: puede volver a entrar. Es lo que hay que hacer si pierde el móvil.
        </p>
        <div className="eq-fila">
          <form action={enviarCerrarSesiones}>
            <input type="hidden" name="id" value={cuenta.id} />
            <Button type="submit" variant="danger">
              Sí, cerrar sus sesiones
            </Button>
          </form>
          <Button href="/admin/equipo" variant="ghost">
            Cancelar
          </Button>
        </div>
      </Card>
    );
  }

  if (accion === "clave") {
    return (
      <Card title={`¿Generar una contraseña nueva para ${quien}?`} className="eq-confirm">
        <p className="eq-nota">
          La contraseña que tenga ahora dejará de funcionar y se le cerrarán las sesiones. El panel te enseñará la
          nueva una sola vez para que se la des en mano. Úsalo cuando alguien no se acuerde de la suya.
        </p>
        <div className="eq-fila">
          <form action={enviarRestablecerClave}>
            <input type="hidden" name="id" value={cuenta.id} />
            <Button type="submit" variant="danger">
              Sí, generar otra
            </Button>
          </form>
          <Button href="/admin/equipo" variant="ghost">
            Cancelar
          </Button>
        </div>
      </Card>
    );
  }

  return null;
}
