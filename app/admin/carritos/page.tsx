import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { ANTIGUEDADES, HORAS_ABANDONO, fechaCorteAbandono, valorCarrito } from "@/lib/reviews";
import { Badge, Button, Card, EmptyState, Money, PageHeader, StatCard } from "../_components/ui";
import { LimpiezaCarritos, MensajeRecuperacion } from "../resenas/_components/ReviewForm";
import "../resenas/resenas.css";

/**
 * Carritos abandonados: lo que estuvo a punto de entrar y no entró.
 *
 * Qué NO hace esta pantalla, y es deliberado: no manda correos. No hay servicio
 * de correo configurado en el proyecto, así que un botón "enviar recordatorio"
 * sería un botón que miente. Lo que sí puede hacer Madeline hoy es escribirle
 * ella por DM —su canal real— y para eso la pantalla le deja el mensaje
 * redactado, editable y listo para copiar.
 *
 * La plantilla `EmailTemplate` con clave `abandoned_cart` ya se lee desde aquí:
 * si algún día se edita desde Ajustes, este mensaje la usa sin tocar código.
 */

export const dynamic = "force-dynamic";

const POR_PAGINA = 40;

const fechaHora = new Intl.DateTimeFormat("es-US", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const VISTAS = [
  { key: "abandonados", label: "Abandonados" },
  { key: "avisados", label: "Ya avisados" },
  { key: "recuperados", label: "Recuperados" },
  { key: "descartados", label: "Descartados" },
] as const;

type Vista = (typeof VISTAS)[number]["key"];

/** Marca de descarte: primera línea de Cart.note (ver carritos/actions.ts). */
const MARCA_DESCARTE = "[descartado";

type Busqueda = { vista: Vista; horas: number };

function leerBusqueda(params: Record<string, string | string[] | undefined>): Busqueda {
  const uno = (key: string): string => {
    const raw = params[key];
    return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  };
  const vista = uno("vista");
  const horas = Number.parseInt(uno("horas") || String(HORAS_ABANDONO), 10);

  return {
    vista: (VISTAS.some((v) => v.key === vista) ? vista : "abandonados") as Vista,
    horas: (ANTIGUEDADES as readonly number[]).includes(horas) ? horas : HORAS_ABANDONO,
  };
}

function etiquetaHoras(horas: number): string {
  if (horas < 24) return `${horas} ${horas === 1 ? "hora" : "horas"}`;
  const dias = Math.round(horas / 24);
  return `${dias} ${dias === 1 ? "día" : "días"}`;
}

export default async function CarritosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Defensa en profundidad: aquí se leen correos y teléfonos de visitantes.
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const busqueda = leerBusqueda(await searchParams);
  const corte = fechaCorteAbandono(busqueda.horas);
  const ajustes = await getSettings();

  // Un carrito sin líneas no es dinero perdido: nunca entra en la lista.
  const base: Prisma.CartWhereInput = { items: { some: {} } };
  const noDescartado: Prisma.CartWhereInput = { NOT: { note: { startsWith: MARCA_DESCARTE } } };

  // Las condiciones se combinan con AND explícito y no con spread: dos objetos
  // con `NOT` se pisarían el uno al otro y el filtro saldría mal en silencio.
  const whereAbandonados: Prisma.CartWhereInput = {
    AND: [base, noDescartado, { recoveredOrderId: null }, { updatedAt: { lt: corte } }],
  };

  const where: Prisma.CartWhereInput =
    busqueda.vista === "descartados"
      ? { AND: [base, { note: { startsWith: MARCA_DESCARTE } }] }
      : busqueda.vista === "recuperados"
        ? { AND: [base, { NOT: { recoveredOrderId: null } }] }
        : busqueda.vista === "avisados"
          ? {
              AND: [base, noDescartado, { recoveredOrderId: null }, { NOT: { reminderSentAt: null } }],
            }
          : whereAbandonados;

  const [carritos, plantilla, vacios, abandonadosTodos] = await Promise.all([
    db.cart.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: POR_PAGINA,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        note: true,
        recoveredOrderId: true,
        reminderSentAt: true,
        createdAt: true,
        updatedAt: true,
        items: {
          select: {
            id: true,
            quantity: true,
            // `status` no es decorativo: el mensaje de recuperación acaba en un DM
            // de Instagram y el escaparate solo sirve los productos `active`, así
            // que enlazar a una pieza en borrador o archivada le manda a la clienta
            // un 404. Ver `enlaceDelCarrito()`.
            product: { select: { id: true, title: true, slug: true, status: true } },
            variant: { select: { title: true, priceCents: true } },
          },
        },
      },
    }),
    db.emailTemplate.findUnique({ where: { key: "abandoned_cart" } }),
    db.cart.count({ where: { items: { none: {} } } }),
    // El resumen de arriba siempre habla de los abandonados de verdad, aunque
    // se esté mirando otra pestaña: es la cifra que importa.
    db.cart.findMany({
      where: whereAbandonados,
      select: {
        id: true,
        email: true,
        phone: true,
        reminderSentAt: true,
        items: { select: { quantity: true, variant: { select: { priceCents: true } } } },
      },
    }),
  ]);

  const lineasDe = (items: { quantity: number; variant: { priceCents: number } | null }[]) =>
    items.map((i) => ({ quantity: i.quantity, priceCents: i.variant?.priceCents ?? 0 }));

  const totalRecuperable = abandonadosTodos.reduce((acc, c) => acc + valorCarrito(lineasDe(c.items)), 0);
  const conContacto = abandonadosTodos.filter((c) => Boolean(c.email || c.phone)).length;
  const yaAvisados = abandonadosTodos.filter((c) => Boolean(c.reminderSentAt)).length;

  const vistaActual = VISTAS.find((v) => v.key === busqueda.vista) ?? VISTAS[0];

  return (
    <>
      <PageHeader
        title="Carritos abandonados"
        subtitle="Clientas que llenaron el carrito y no llegaron a pagar. Escríbeles tú por DM: aquí tienes el mensaje listo."
        actions={
          <Button href="/admin/pedidos?estado=pendiente" variant="ghost" size="sm">
            Ver pedidos por cobrar
          </Button>
        }
      />

      <div className="adm-grid">
        <StatCard
          label="Carritos abandonados"
          value={abandonadosTodos.length}
          hint={`Sin tocar desde hace ${etiquetaHoras(busqueda.horas)}`}
          tone={abandonadosTodos.length > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Dinero recuperable"
          value={formatCents(totalRecuperable)}
          tone="accent"
          hint="Suma de todo lo que quedó dentro"
        />
        <StatCard label="Con forma de contactar" value={conContacto} hint="Dejaron correo o teléfono" />
        <StatCard label="Ya les escribiste" value={yaAvisados} tone={yaAvisados > 0 ? "success" : "default"} />
      </div>

      <Card>
        <form method="get" className="adm-row" style={{ alignItems: "flex-end", gap: 12 }}>
          <label className="adm-field" style={{ flex: "0 1 220px" }}>
            <span className="adm-field-lbl">Qué ver</span>
            <select name="vista" defaultValue={busqueda.vista}>
              {VISTAS.map((v) => (
                <option key={v.key} value={v.key}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>

          <label className="adm-field" style={{ flex: "0 1 220px" }}>
            <span className="adm-field-lbl">Sin actividad desde hace</span>
            <select name="horas" defaultValue={String(busqueda.horas)}>
              {ANTIGUEDADES.map((h) => (
                <option key={h} value={h}>
                  {etiquetaHoras(h)}
                </option>
              ))}
            </select>
            <span className="adm-field-hint">Menos de una hora suele ser alguien que todavía está mirando.</span>
          </label>

          <div className="adm-row" style={{ paddingBottom: 2 }}>
            <button type="submit" className="adm-btn adm-btn-primary adm-btn-sm">
              Aplicar
            </button>
            {busqueda.vista !== "abandonados" || busqueda.horas !== HORAS_ABANDONO ? (
              <Link className="adm-btn adm-btn-ghost adm-btn-sm" href="/admin/carritos">
                Volver a lo normal
              </Link>
            ) : null}
          </div>
        </form>
      </Card>

      {carritos.length === 0 ? (
        <Card title={vistaActual.label}>
          <EmptyState
            icon={<IconCarrito />}
            title={
              busqueda.vista === "abandonados"
                ? "Ningún carrito abandonado ahora mismo"
                : `Nada en «${vistaActual.label}»`
            }
            text={
              busqueda.vista === "abandonados"
                ? "Aquí aparecerán los carritos que se queden a medias más de unas horas, con lo que llevaban dentro y el mensaje listo para escribirle a la clienta por DM."
                : "Cuando marques carritos en esta situación, los verás aquí."
            }
            action={
              busqueda.vista !== "abandonados" ? (
                <Button href="/admin/carritos" variant="ghost">
                  Ver los abandonados
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        carritos.map((carrito) => {
          const lineas = lineasDe(carrito.items);
          const valor = valorCarrito(lineas);
          const articulos = carrito.items.reduce((acc, i) => acc + i.quantity, 0);
          const descartado = carrito.note.startsWith(MARCA_DESCARTE);
          const recuperado = Boolean(carrito.recoveredOrderId);
          const pedidoId =
            carrito.recoveredOrderId && carrito.recoveredOrderId !== "manual" ? carrito.recoveredOrderId : null;
          // Piezas que ya no se pueden vender: el mensaje no las enlaza (ver
          // `enlaceDelCarrito`) y Madeline tiene que saberlo ANTES de escribir, o
          // le ofrecerá a la clienta algo que no le puede despachar.
          const fueraDeVenta = carrito.items.filter((i) => i.product.status !== "active");
          const slugsALaVenta = new Set(
            carrito.items.filter((i) => i.product.status === "active").map((i) => i.product.slug),
          );

          return (
            <Card
              key={carrito.id}
              title={
                <span className="rev-carrito-cab">
                  <span>
                    {carrito.name || carrito.email || "Visitante sin nombre"}
                    <span className="adm-muted adm-small">
                      {" · "}
                      {articulos} {articulos === 1 ? "artículo" : "artículos"} · última actividad{" "}
                      {fechaHora.format(carrito.updatedAt)}
                    </span>
                  </span>
                </span>
              }
              actions={
                <span className="adm-row">
                  {recuperado ? <Badge tone="success">Recuperado</Badge> : null}
                  {descartado ? <Badge tone="neutral">Descartado</Badge> : null}
                  {carrito.reminderSentAt && !recuperado && !descartado ? (
                    <Badge tone="info">Ya avisada</Badge>
                  ) : null}
                  <Money cents={valor} tone="strong" />
                </span>
              }
            >
              <ul className="rev-carrito-items">
                {carrito.items.map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.quantity} × {item.product.title}
                      {item.variant?.title ? <span className="adm-muted"> · {item.variant.title}</span> : null}
                      {item.product.status !== "active" ? (
                        <>
                          {" "}
                          <Badge tone="warning">No está a la venta</Badge>
                        </>
                      ) : null}
                    </span>
                    <Money cents={(item.variant?.priceCents ?? 0) * item.quantity} />
                  </li>
                ))}
              </ul>

              <div className="rev-carrito-contacto">
                {carrito.email ? <span>✉️ {carrito.email}</span> : null}
                {carrito.phone ? <span>📞 {carrito.phone}</span> : null}
                {!carrito.email && !carrito.phone ? (
                  <span className="adm-muted">
                    No dejó ningún contacto: a esta clienta no hay forma de escribirle. Sirve para saber qué se está
                    quedando en el carrito.
                  </span>
                ) : null}
                {pedidoId ? (
                  <Link className="adm-link" href={`/admin/pedidos/${pedidoId}`}>
                    Ver el pedido que salió de aquí
                  </Link>
                ) : null}
              </div>

              {fueraDeVenta.length > 0 ? (
                <div className="rev-carrito-contacto">
                  <span>
                    <Badge tone="warning">Ojo</Badge>{" "}
                    {fueraDeVenta.length === 1
                      ? `«${fueraDeVenta[0].product.title}» está ${etiquetaEstado(fueraDeVenta[0].product.status)}: esa pieza no se puede comprar ahora mismo.`
                      : `${fueraDeVenta.length} de estas piezas no están a la venta y no se pueden comprar ahora mismo.`}{" "}
                    {slugsALaVenta.size === 1
                      ? "El mensaje enlaza solo a la pieza que sigue disponible."
                      : "El mensaje enlaza a la tienda, no a la ficha."}{" "}
                    Vuelve a ponerla a la venta antes de escribirle, o quita esa línea del mensaje.
                  </span>
                  {fueraDeVenta.map((item) => (
                    <Link key={item.id} className="adm-link" href={`/admin/productos/${item.product.id}`}>
                      Revisar «{item.product.title}»
                    </Link>
                  ))}
                </div>
              ) : null}

              <MensajeRecuperacion
                carrito={{
                  id: carrito.id,
                  mensaje: construirMensaje({
                    plantilla: plantilla?.isActive ? plantilla.body : "",
                    nombre: carrito.name,
                    tienda: ajustes.storeName,
                    horario: ajustes.hours,
                    instagram: ajustes.instagram ? `@${ajustes.instagram.replace(/^@/, "")}` : "",
                    // No hay forma honesta de "restaurar" el carrito de otra
                    // persona: su token vive en la cookie de SU navegador. Así
                    // que el enlace lleva a la ficha si solo queda una pieza a
                    // la venta, y al catálogo si son varias (o ninguna).
                    enlace: enlaceDelCarrito(carrito.items),
                    articulos: carrito.items.map((i) => ({
                      cantidad: i.quantity,
                      titulo: i.product.title,
                      variante: i.variant?.title ?? "",
                    })),
                    totalCents: valor,
                  }),
                  telefono: carrito.phone,
                  instagramDm: ajustes.instagramDm,
                  descartado,
                  recuperado,
                }}
              />
            </Card>
          );
        })
      )}

      <Card title="Limpieza" footer={<span className="adm-muted adm-small">Esto no toca ningún pedido.</span>}>
        <LimpiezaCarritos vacios={vacios} />
      </Card>
    </>
  );
}

/* ───────────────────────── mensaje de recuperación ───────────────────────── */

/**
 * Adónde mandar a la clienta: a la ficha si queda una sola pieza a la venta, al
 * catálogo si son varias. La base se lee del entorno aquí mismo y no de `lib/seo`,
 * para no atar esta pantalla a un módulo que ahora mismo está en construcción.
 *
 * SOLO se enlaza a productos `active`. El escaparate no sirve borradores ni
 * archivados (`/producto/[slug]` responde 404 si no está activo), y este enlace no
 * se queda en el panel: se copia en un DM a una compradora. Si Madeline archiva o
 * despublica una pieza que quedó en un carrito, la clienta recibiría una página de
 * error firmada por la boutique. Un enlace a la tienda es peor que la ficha exacta,
 * pero infinitamente mejor que un 404.
 */
function enlaceDelCarrito(items: { product: { slug: string; status: string } }[]): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://bloom-by-madeline.vercel.app").replace(/\/+$/, "");
  const slugs = [...new Set(items.filter((i) => i.product.status === "active").map((i) => i.product.slug))];
  return `${base}${slugs.length === 1 ? `/producto/${slugs[0]}` : "/tienda"}`;
}

/** Cómo se dice en español que una pieza no está a la venta. */
function etiquetaEstado(status: string): string {
  if (status === "draft") return "en borrador";
  if (status === "archived") return "archivada";
  return status;
}

/**
 * Redacta el recordatorio en el tono de la boutique. Si existe una plantilla
 * `abandoned_cart` activa se usa esa, sustituyendo los marcadores; si no, el
 * texto por defecto de aquí abajo. Madeline puede editarlo antes de copiarlo:
 * esto es un punto de partida, no un guion cerrado.
 *
 * Los marcadores se escriben con llaves dobles — `{{nombre}}` — porque es el
 * convenio que usa la pantalla de plantillas (`/admin/plantillas`), que es donde
 * Madeline las edita. Se aceptan también las simples por si alguien las escribe
 * así. Y lo que quede sin reconocer se borra: es preferible una frase corta a
 * que la clienta reciba un DM que dice literalmente "Hola {{nombre}}".
 */
function construirMensaje(datos: {
  plantilla: string;
  nombre: string | null;
  tienda: string;
  horario: string;
  instagram: string;
  enlace: string;
  articulos: { cantidad: number; titulo: string; variante: string }[];
  totalCents: number;
}): string {
  const nombre = (datos.nombre || "").trim();
  const saludo = nombre ? `Hola ${nombre}` : "Hola";
  const lista = datos.articulos
    .map((a) => `· ${a.cantidad} × ${a.titulo}${a.variante ? ` (${a.variante})` : ""}`)
    .join("\n");
  const total = formatCents(datos.totalCents);

  if (datos.plantilla.trim()) {
    const valores: Record<string, string> = {
      saludo,
      // Sin nombre, "Hola {{nombre}}:" quedaría como "Hola :" — se dice "guapa",
      // que es como habla la boutique, en vez de dejar el hueco.
      nombre: nombre || "guapa",
      articulos: lista,
      total,
      tienda: datos.tienda,
      horario: datos.horario,
      instagram: datos.instagram,
      enlace: datos.enlace,
    };
    return datos.plantilla
      .replace(/\{\{\s*(\w+)\s*\}\}|\{\s*(\w+)\s*\}/g, (_todo, doble, simple) => valores[doble ?? simple] ?? "")
      .trim();
  }

  return [
    `${saludo} 💛`,
    "",
    `Soy Madeline, de ${datos.tienda}. Vi que te quedaste a medias con esto:`,
    lista,
    "",
    `Total: ${total}`,
    "",
    "Te lo sigo guardando. Si lo quieres, contéstame por aquí y te lo aparto.",
    `Si prefieres terminarlo tú: ${datos.enlace}`,
    `Y si te queda cerca, pásate por la boutique: ${datos.horario}.`,
  ].join("\n");
}

/* ─────────────────────────────── iconos ───────────────────────────── */

function IconCarrito() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4h2.2l2.2 10.4a1.5 1.5 0 0 0 1.5 1.2h7.6a1.5 1.5 0 0 0 1.45-1.1L20 7H6.2" />
      <circle cx="9.5" cy="19.5" r="1.2" />
      <circle cx="16.5" cy="19.5" r="1.2" />
    </svg>
  );
}
