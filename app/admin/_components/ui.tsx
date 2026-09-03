import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { formatCents } from "@/lib/money";

/**
 * Primitivas del panel. Son la única forma autorizada de pintar cabeceras,
 * tarjetas, tablas, botones y avisos dentro de /admin: si cada pantalla se
 * inventa su marcado, el panel deja de parecer una sola herramienta.
 *
 * Este módulo NO lleva "use client" a propósito: así se puede usar tal cual en
 * Server Components (el caso normal) y también dentro de un componente cliente,
 * donde entonces sí admite onClick y compañía.
 *
 * Documentación de uso para el resto del equipo: /_ADMIN_UI.md
 */

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ───────────────────────────── PageHeader ───────────────────────────── */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="adm-pagehead">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="adm-pagehead-actions">{actions}</div> : null}
    </header>
  );
}

/* ─────────────────────────────── Card ───────────────────────────────── */

export function Card({
  title,
  children,
  footer,
  actions,
  flush = false,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Contenido a la derecha del título (un enlace "ver todo", un filtro...). */
  actions?: ReactNode;
  /** Quita el padding del cuerpo: para tablas que van pegadas al borde. */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={cx("adm-card", className)}>
      {title || actions ? (
        <div className="adm-card-head">
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="adm-row">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cx("adm-card-body", flush && "is-flush")}>{children}</div>
      {footer ? <div className="adm-card-foot">{footer}</div> : null}
    </section>
  );
}

/* ────────────────────────────── Button ──────────────────────────────── */

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Si se pasa, se pinta un <Link> con el mismo aspecto que el botón. */
  href?: string;
  block?: boolean;
  children: ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  href,
  block = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  const cls = cx("adm-btn", `adm-btn-${variant}`, `adm-btn-${size}`, block && "adm-btn-block", className);

  if (href) {
    // Los atributos sobrantes (target, rel, title...) valen igual en un ancla;
    // el cast es necesario porque TS tipó el resto como props de <button>.
    const anchorProps = rest as unknown as React.AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <Link href={href} className={cls} {...anchorProps}>
        {children}
      </Link>
    );
  }

  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}

/* ─────────────────────────────── Badge ──────────────────────────────── */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`adm-badge adm-badge-${tone}`}>{children}</span>;
}

/* ───────────────────────────── DataTable ────────────────────────────── */

export type Column<T> = {
  /** Identificador único de la columna dentro de la tabla. */
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  /** Etiqueta que se muestra en móvil si `header` no es texto plano. */
  label?: string;
  align?: "left" | "center" | "right";
  width?: string;
  /** Columna que hace de título de la tarjeta en móvil. Marca solo una. */
  primary?: boolean;
  /** Se oculta al colapsar a tarjetas: datos secundarios que estorban en móvil. */
  hideOnMobile?: boolean;
};

export function DataTable<T>({
  columns,
  rows,
  empty,
  rowKey,
  caption,
}: {
  columns: Column<T>[];
  rows: T[];
  /** Qué pintar si no hay filas: un texto o un <EmptyState/> entero. */
  empty?: ReactNode;
  rowKey?: (row: T, index: number) => string;
  caption?: string;
}) {
  if (rows.length === 0) {
    return <div className="adm-dt-empty">{empty ?? "No hay nada que mostrar todavía."}</div>;
  }

  return (
    <div className="adm-dt">
      <table>
        {caption ? <caption className="adm-dt-empty">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={cx(col.align && `adm-al-${col.align}`, col.hideOnMobile && "adm-dt-hide-m")}
                style={col.width ? ({ width: col.width } as CSSProperties) : undefined}
                scope="col"
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : i}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  // data-label alimenta el ::before de la vista móvil; sin él la
                  // tarjeta sería una lista de valores sin decir de qué son.
                  data-label={col.primary ? "" : col.label ?? (typeof col.header === "string" ? col.header : "")}
                  className={cx(
                    col.align && `adm-al-${col.align}`,
                    col.primary && "adm-dt-primary",
                    col.hideOnMobile && "adm-dt-hide-m",
                  )}
                >
                  {col.render(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ──────────────────────────── EmptyState ────────────────────────────── */

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="adm-empty">
      {icon ? <div className="adm-empty-icon">{icon}</div> : null}
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      {action ? <div className="adm-empty-action">{action}</div> : null}
    </div>
  );
}

/* ─────────────────────────────── Field ──────────────────────────────── */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  required = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  required?: boolean;
}) {
  return (
    <div className={cx("adm-field", error ? "has-error" : null)}>
      <label className="adm-field-lbl" htmlFor={htmlFor}>
        {label}
        {required ? <span className="adm-field-req"> *</span> : null}
      </label>
      {children}
      {hint && !error ? <div className="adm-field-hint">{hint}</div> : null}
      {error ? <div className="adm-field-err">{error}</div> : null}
    </div>
  );
}

/* ─────────────────────────────── Money ──────────────────────────────── */

/** Única forma de pintar dinero en el panel: centavos enteros → "$45.99". */
export function Money({ cents, tone }: { cents: number | null | undefined; tone?: "muted" | "strong" }) {
  return (
    <span className={cx("adm-money", tone === "muted" && "adm-money-muted", tone === "strong" && "adm-money-strong")}>
      {formatCents(cents ?? 0)}
    </span>
  );
}

/* ───────────────────────────── StatCard ─────────────────────────────── */

export type StatTone = "default" | "accent" | "success" | "warning" | "danger";

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
}) {
  return (
    <div className={cx("adm-stat", tone !== "default" && `adm-stat-${tone}`)}>
      <span className="adm-stat-label">{label}</span>
      <span className="adm-stat-value">{value}</span>
      {hint ? <span className="adm-stat-hint">{hint}</span> : null}
    </div>
  );
}

/* ─────────────────────────────── Paso ───────────────────────────────── */

/**
 * Un trozo de trabajo con principio y fin, no «una tarjeta más».
 *
 * Sale del alta de prendas (`/admin/productos/nueva-prenda`), que es la pantalla
 * que mejor funciona del panel. Acertaba por tres decisiones, y son las que este
 * componente obliga a tomar:
 *
 *  1. `numero` — el orden es el orden en el que ELLA trabaja, no el del modelo
 *     de datos. Si no puedes numerar los pasos, probablemente estás volcando una
 *     tabla en vez de acompañar una tarea.
 *  2. `titulo` — una PREGUNTA en su idioma («¿Cómo te encuentran?»), no el
 *     nombre de la columna («Datos de contacto»).
 *  3. `ayuda` — la CONSECUENCIA, no la definición. «Esto sale en el pie de la
 *     web» vale; «campo de texto libre» no.
 *
 * `pie` es donde va el botón de guardar de ese paso: cada paso guarda lo suyo,
 * así que equivocarse en uno nunca pisa lo demás.
 */
export function Paso({
  numero,
  titulo,
  ayuda,
  children,
  pie,
}: {
  numero?: number | string;
  titulo: ReactNode;
  ayuda?: ReactNode;
  children: ReactNode;
  pie?: ReactNode;
}) {
  return (
    <section className="adm-paso">
      <h2 className="adm-paso-cab">
        {numero !== undefined ? <span className="adm-paso-num">{numero}</span> : null}
        <span>{titulo}</span>
      </h2>
      {ayuda ? <p className="adm-paso-ayuda">{ayuda}</p> : null}
      {children}
      {pie ? <div className="adm-paso-pie">{pie}</div> : null}
    </section>
  );
}

/* ─────────────────────────────── Ficha ──────────────────────────────── */

/**
 * Elegir tocando, en vez de un desplegable.
 *
 * Un `<select>` en un móvil abre la rueda del sistema y esconde las opciones
 * hasta que la abres; estas fichas se ven todas a la vez. Va sobre un
 * checkbox/radio de verdad, así que funciona **sin JavaScript** — importa,
 * porque la boutique tiene mala cobertura y el panel se abre desde el móvil.
 */
export function Ficha({
  name,
  value,
  tipo = "checkbox",
  defaultChecked,
  children,
}: {
  name: string;
  value?: string;
  tipo?: "checkbox" | "radio";
  defaultChecked?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="adm-chip">
      <input type={tipo} name={name} value={value} defaultChecked={defaultChecked} />
      <span>{children}</span>
    </label>
  );
}
