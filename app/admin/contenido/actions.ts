"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Mutaciones de los bloques de la portada.
 *
 * Un bloque no se borra nunca: se apaga. La portada es la cara del negocio y
 * "quitar" una sección de la que luego no te acuerdas es exactamente el error
 * que no se puede deshacer desde el móvil un sábado a las 7 de la tarde. Por eso
 * aquí solo hay: guardar, ordenar, encender/apagar y restaurar el texto original.
 */

/* ─────────────────────────── contratos ─────────────────────────── */

export type EstadoBloque = {
  ok?: boolean;
  error?: string;
  mensaje?: string;
  errores?: Record<string, string>;
};

/** Los diez bloques de la portada, en el orden en que salen en el sitio. */
const TIPOS = [
  "hero",
  "marquee",
  "coleccion",
  "cita",
  "filosofia",
  "boutique",
  "comoComprar",
  "visitanos",
  "instagram",
  "banner",
] as const;

/** Aceptamos enlaces externos, rutas del propio sitio y anclas de la portada. */
const DESTINO_OK = /^(?:https?:\/\/|mailto:|tel:|\/|#)/i;

const EsquemaBloque = z.object({
  id: z.string().min(1),
  title: z.string().max(200).default(""),
  subtitle: z.string().max(300).default(""),
  body: z.string().max(4000).default(""),
  imageUrl: z.string().max(500).default(""),
  linkUrl: z.string().max(500).default(""),
  linkLabel: z.string().max(120).default(""),
  items: z.string().max(4000).default(""),
});

/* ─────────────────────────── auditoría ─────────────────────────── */

/**
 * Deja rastro de quién tocó qué. Se repite en cada módulo a propósito: un
 * fichero "use server" solo puede exportar funciones asíncronas, así que un
 * helper compartido se convertiría en un endpoint público sin querer.
 */
async function registrar(
  admin: { id: string; email: string },
  action: string,
  entityId: string | null,
  summary: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await db.activityLog
    .create({
      data: {
        userId: admin.id,
        userEmail: admin.email,
        action,
        entityType: "homeBlock",
        entityId,
        summary,
        metaJson: JSON.stringify(meta),
      },
    })
    // El registro es para poder mirar atrás, no para bloquear el trabajo: si
    // falla, el cambio ya está guardado y no se le puede quitar a Madeline.
    .catch(() => {});
}

/** La portada se sirve cacheada; sin esto el cambio no se ve hasta el redeploy. */
function refrescarPortada(): void {
  revalidatePath("/", "layout");
  revalidatePath("/admin/contenido");
}

/* ─────────────────────────── guardar ─────────────────────────── */

export async function guardarBloque(_prev: EstadoBloque, fd: FormData): Promise<EstadoBloque> {
  const admin = await getAdmin();
  if (!admin) return { error: "Tu sesión caducó. Vuelve a entrar y repite el guardado." };

  const datos = EsquemaBloque.safeParse({
    id: String(fd.get("id") ?? ""),
    title: String(fd.get("title") ?? ""),
    subtitle: String(fd.get("subtitle") ?? ""),
    body: String(fd.get("body") ?? ""),
    imageUrl: String(fd.get("imageUrl") ?? ""),
    linkUrl: String(fd.get("linkUrl") ?? ""),
    linkLabel: String(fd.get("linkLabel") ?? ""),
    items: String(fd.get("items") ?? ""),
  });

  if (!datos.success) {
    return { error: "Hay algo demasiado largo en el formulario. Acorta el texto y prueba otra vez." };
  }
  const v = datos.data;

  const errores: Record<string, string> = {};
  if (v.imageUrl && !DESTINO_OK.test(v.imageUrl)) {
    errores.imageUrl = "Pega una dirección que empiece por https:// o una ruta del sitio como /assets/foto.jpg";
  }
  if (v.linkUrl && !DESTINO_OK.test(v.linkUrl)) {
    errores.linkUrl = "El destino debe empezar por https://, por / (una página del sitio) o por # (una sección).";
  }
  if (Object.keys(errores).length > 0) {
    return { error: "Revisa los campos marcados.", errores };
  }

  const bloque = await db.homeBlock.findUnique({ where: { id: v.id }, select: { id: true, kind: true } });
  if (!bloque) return { error: "Ese bloque ya no existe. Vuelve a la lista y recarga." };

  // Las listas se escriben una por línea porque es lo que una persona hace sin
  // pensar; por dentro viajan como JSON en dataJson.
  const items = v.items
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  await db.homeBlock.update({
    where: { id: v.id },
    data: {
      title: v.title.trim(),
      subtitle: v.subtitle.trim(),
      body: v.body.trim(),
      imageUrl: v.imageUrl.trim() || null,
      linkUrl: v.linkUrl.trim() || null,
      linkLabel: v.linkLabel.trim(),
      dataJson: JSON.stringify({ items }),
    },
  });

  await registrar(admin, "update", bloque.id, `Editó el bloque "${bloque.kind}" de la portada`);
  refrescarPortada();

  return { ok: true, mensaje: "Bloque guardado. Míralo en la portada." };
}

/* ─────────────────────────── orden y visibilidad ─────────────────────────── */

/**
 * Sube o baja un bloque intercambiándolo con su vecino. Se hace con posiciones
 * reales y no con un índice del array porque dos pestañas abiertas a la vez
 * dejarían el orden mentiroso.
 */
export async function moverBloque(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const direccion = String(fd.get("direccion") ?? "");
  if (!id || (direccion !== "arriba" && direccion !== "abajo")) redirect("/admin/contenido");

  const bloques = await db.homeBlock.findMany({
    orderBy: [{ position: "asc" }, { kind: "asc" }],
    select: { id: true, position: true, kind: true },
  });
  const indice = bloques.findIndex((b) => b.id === id);
  const destino = direccion === "arriba" ? indice - 1 : indice + 1;
  if (indice < 0 || destino < 0 || destino >= bloques.length) redirect("/admin/contenido");

  const a = bloques[indice];
  const b = bloques[destino];

  // Se reescriben TODAS las posiciones: si alguna vez quedaron empatadas (dos
  // bloques con position 0), un simple intercambio no arreglaría el orden.
  const nuevo = [...bloques];
  nuevo[indice] = b;
  nuevo[destino] = a;
  await db.$transaction(
    nuevo.map((bloque, i) => db.homeBlock.update({ where: { id: bloque.id }, data: { position: i } })),
  );

  await registrar(admin, "update", a.id, `Movió el bloque "${a.kind}" hacia ${direccion}`);
  refrescarPortada();
  redirect(`/admin/contenido#bloque-${a.id}`);
}

export async function alternarBloque(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const bloque = await db.homeBlock.findUnique({ where: { id }, select: { id: true, kind: true, isVisible: true } });
  if (!bloque) redirect("/admin/contenido");

  await db.homeBlock.update({ where: { id: bloque.id }, data: { isVisible: !bloque.isVisible } });
  await registrar(
    admin,
    "update",
    bloque.id,
    `${bloque.isVisible ? "Ocultó" : "Mostró"} el bloque "${bloque.kind}" de la portada`,
  );

  refrescarPortada();
  redirect(`/admin/contenido#bloque-${bloque.id}`);
}

/* ─────────────────────────── siembra ─────────────────────────── */

type Semilla = {
  kind: (typeof TIPOS)[number];
  title?: string;
  subtitle?: string;
  body?: string;
  imageUrl?: string;
  linkUrl?: string;
  linkLabel?: string;
  items?: string[];
  isVisible?: boolean;
};

/**
 * El contenido REAL que hoy está en producción (`legacy/index.html`), palabra
 * por palabra. No hay nada inventado aquí: si algo no existía en el sitio, se
 * siembra vacío. Es la referencia para poder volver atrás.
 */
const SEMILLA: Semilla[] = [
  {
    kind: "hero",
    subtitle: "Boutique de moda femenina · Hamilton, Ohio",
    title: "Elevamos tu estilo casual elegante.",
    body:
      "Tendencias exclusivas seleccionadas a mano, nuevas llegadas cada semana y una atención que se siente como ir de compras con tu mejor amiga.",
    imageUrl: "/assets/post-03-vestido-negro-olivo.jpg",
    linkUrl: "/tienda",
    linkLabel: "Ver nuevas llegadas",
    items: ["2,880+ | seguidoras", "S · M · L | tallas disponibles", "USA | envíos a todo el país"],
  },
  {
    kind: "marquee",
    items: [
      "Nuevas llegadas cada semana",
      "Tallas S · M · L",
      "Envíos a todo USA",
      "Pedidos por Instagram DM",
      "1305 Grand Blvd · Hamilton, OH",
    ],
  },
  {
    kind: "coleccion",
    subtitle: "01 — La Colección",
    title: "Nuevas llegadas",
    body: "Cada pieza nombrada como una flor, porque aquí todo florece.\nPedidos por DM · respuesta el mismo día.",
    linkUrl: "https://ig.me/m/bloombymadelin",
    linkLabel: "Escríbenos por DM y te lo apartamos",
  },
  {
    kind: "cita",
    body: "«Cada prenda cuenta una historia…\nhaz que la tuya brille con estilo.»",
  },
  {
    kind: "filosofia",
    subtitle: "02 — Nuestra Filosofía",
    title: "Vestir con intención",
    body:
      "(No es moda… es presencia.)\n\nEn Bloom no seguimos tendencias por seguirlas. Seleccionamos cada pieza pensando en la mujer que la va a llevar: su día, su cuerpo, su momento. Porque cuando te vistes con intención, no entras a un lugar — floreces en él.",
    items: ["Coherencia", "Identidad", "Presencia", "Intención"],
  },
  {
    kind: "boutique",
    subtitle: "03 — La Boutique",
    title: "Un espacio pensado para ti",
    body:
      "En pleno Grand Blvd de Hamilton, nuestra boutique es ese lugar donde entras «solo a mirar» y sales sintiéndote otra. Pruébate todo, pide opinión y deja que armemos tu outfit juntas.",
    imageUrl: "/assets/boutique-interior.jpg",
    items: [
      "Atención personalizada | Te ayudamos a encontrar tu look, sin prisa y sin presión.",
      "Pruébatelo antes de llevarlo | Probador en tienda para que salgas segura de tu compra.",
      "Nuevas llegadas semanales | Cada semana llegan piezas nuevas — y vuelan rápido.",
      "Apartados por DM | ¿La viste en Instagram? Escríbenos y te la reservamos.",
    ],
  },
  {
    kind: "comoComprar",
    subtitle: "04 — Cómo Comprar",
    title: "Tan fácil como enamorarse",
    items: [
      "Visítanos en la boutique | 1305 Grand Blvd, Hamilton, OH. Pruébate todo lo que quieras — estamos de jueves a sábado, de 1:00 a 8:00 PM.",
      "O pide por Instagram DM | ¿Viste una pieza en nuestro perfil? Mándanos un mensaje con la foto y tu talla, y te confirmamos al momento.",
      "Envíos a todo USA | ¿No estás en Ohio? No importa. Hacemos envíos a todo Estados Unidos — tu look llega hasta tu puerta.",
    ],
  },
  {
    kind: "visitanos",
    subtitle: "05 — Visítanos",
    title: "Te esperamos en Hamilton",
    body: "El horario puede variar — confírmalo siempre en nuestro Instagram.",
    linkUrl: "https://www.google.com/maps/search/?api=1&query=1305+Grand+Blvd,+Hamilton,+OH+45011",
    linkLabel: "Cómo llegar",
  },
  {
    kind: "instagram",
    subtitle: "Síguenos",
    title: "Enamórate en Instagram",
    body: "Únete a más de 2,880 seguidoras que ven las nuevas llegadas antes que nadie.",
    linkUrl: "https://www.instagram.com/bloombymadelin/",
    linkLabel: "Seguir a @bloombymadelin",
    items: [
      "/assets/post-02-tendencia.jpg",
      "/assets/post-08-look-perfecto.jpg",
      "/assets/post-10-vestido-orange.jpg",
      "/assets/post-12-vestido-coral.jpg",
    ],
  },
  {
    // La franja de aviso no existe en el sitio actual: se siembra APAGADA y en
    // blanco. Inventarle un texto ("¡Envío gratis!") sería prometer algo que
    // Madeline no ha dicho.
    kind: "banner",
    isVisible: false,
  },
];

/** Devuelve la semilla de un tipo, para sembrar y para restaurar. */
function semillaDe(kind: string): Semilla | undefined {
  return SEMILLA.find((s) => s.kind === kind);
}

function datosDeSemilla(s: Semilla) {
  return {
    title: s.title ?? "",
    subtitle: s.subtitle ?? "",
    body: s.body ?? "",
    imageUrl: s.imageUrl ?? null,
    linkUrl: s.linkUrl ?? null,
    linkLabel: s.linkLabel ?? "",
    dataJson: JSON.stringify({ items: s.items ?? [] }),
  };
}

/**
 * Crea los bloques que falten con el contenido que hoy está en producción.
 * No pisa lo que ya exista: se puede llamar dos veces sin miedo.
 */
export async function sembrarBloques(): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const existentes = await db.homeBlock.findMany({ select: { kind: true } });
  const yaEstan = new Set(existentes.map((b) => b.kind));

  let creados = 0;
  for (let i = 0; i < SEMILLA.length; i++) {
    const s = SEMILLA[i];
    if (yaEstan.has(s.kind)) continue;
    await db.homeBlock.create({
      data: {
        kind: s.kind,
        position: i,
        isVisible: s.isVisible ?? true,
        ...datosDeSemilla(s),
      },
    });
    creados++;
  }

  await registrar(admin, "create", null, `Sembró la portada con ${creados} bloques del sitio actual`);
  refrescarPortada();
  redirect("/admin/contenido?ok=sembrado");
}

/**
 * Vuelve a poner en un bloque el texto original del sitio. Es la salida de
 * emergencia de "lo he dejado peor que estaba", y por eso la pantalla la pide
 * dos veces antes de ejecutarla.
 */
export async function restaurarBloque(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const bloque = await db.homeBlock.findUnique({ where: { id }, select: { id: true, kind: true } });
  if (!bloque) redirect("/admin/contenido");

  const s = semillaDe(bloque.kind);
  if (!s) redirect(`/admin/contenido?bloque=${bloque.id}`);

  await db.homeBlock.update({ where: { id: bloque.id }, data: datosDeSemilla(s) });
  await registrar(admin, "update", bloque.id, `Restauró el texto original del bloque "${bloque.kind}"`);

  refrescarPortada();
  redirect(`/admin/contenido?bloque=${bloque.id}&ok=restaurado`);
}
