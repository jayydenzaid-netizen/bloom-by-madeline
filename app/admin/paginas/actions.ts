"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { slugify } from "@/lib/slug";

/**
 * Mutaciones de las páginas de contenido (envíos, devoluciones, sobre nosotros,
 * términos...).
 *
 * Una página nace SIEMPRE en borrador. Publicar es un gesto aparte y consciente:
 * una política de devoluciones a medio escribir en una web es peor que no tener
 * página, porque la clienta la lee y reclama en base a ella.
 */

/* ─────────────────────────── contratos ─────────────────────────── */

export type EstadoPagina = {
  ok?: boolean;
  error?: string;
  mensaje?: string;
  errores?: Record<string, string>;
};

const ESTADOS = ["draft", "published"] as const;

const EsquemaPagina = z.object({
  id: z.string().default(""),
  title: z.string().trim().min(2, "Ponle un título de al menos dos letras.").max(120, "El título es demasiado largo."),
  slug: z.string().trim().max(80).default(""),
  content: z.string().max(40000, "El texto es larguísimo. Pártelo en dos páginas.").default(""),
  status: z.enum(ESTADOS).default("draft"),
  seoTitle: z.string().trim().max(160).default(""),
  seoDescription: z.string().trim().max(320).default(""),
  showInFooter: z.boolean().default(true),
});

/* ─────────────────────────── auditoría ─────────────────────────── */

/** Ver la nota de app/admin/contenido/actions.ts: no se comparte a propósito. */
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
        entityType: "page",
        entityId,
        summary,
        metaJson: JSON.stringify(meta),
      },
    })
    .catch(() => {});
}

/** El pie de la web lista las páginas publicadas: cambia en todas las rutas. */
function refrescar(slug: string, slugAnterior?: string | null): void {
  revalidatePath("/", "layout");
  revalidatePath(`/pagina/${slug}`);
  if (slugAnterior && slugAnterior !== slug) revalidatePath(`/pagina/${slugAnterior}`);
  revalidatePath("/admin/paginas");
}

/** Direcciones que ya usa la tienda: una página no puede robárselas. */
const RESERVADOS = new Set([
  "tienda",
  "carrito",
  "checkout",
  "admin",
  "producto",
  "coleccion",
  "pedido",
  "pagina",
  "api",
]);

/** Devuelve un slug libre en la tabla de páginas. */
async function slugLibre(propuesto: string, ignoreId?: string): Promise<string> {
  const base = slugify(propuesto);
  let candidato = RESERVADOS.has(base) ? `${base}-pagina` : base;
  for (let i = 2; i < 200; i++) {
    const encontrada = await db.page.findUnique({ where: { slug: candidato }, select: { id: true } });
    if (!encontrada || encontrada.id === ignoreId) return candidato;
    candidato = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/* ─────────────────────────── guardar ─────────────────────────── */

export async function guardarPagina(_prev: EstadoPagina, fd: FormData): Promise<EstadoPagina> {
  const admin = await getAdmin();
  if (!admin) return { error: "Tu sesión caducó. Vuelve a entrar y repite el guardado." };

  const datos = EsquemaPagina.safeParse({
    id: String(fd.get("id") ?? ""),
    title: String(fd.get("title") ?? ""),
    slug: String(fd.get("slug") ?? ""),
    content: String(fd.get("content") ?? ""),
    status: String(fd.get("status") ?? "draft"),
    seoTitle: String(fd.get("seoTitle") ?? ""),
    seoDescription: String(fd.get("seoDescription") ?? ""),
    showInFooter: String(fd.get("showInFooter") ?? "1") === "1",
  });

  if (!datos.success) {
    const errores: Record<string, string> = {};
    for (const problema of datos.error.issues) {
      const campo = String(problema.path[0] ?? "");
      if (campo && !errores[campo]) errores[campo] = problema.message;
    }
    return { error: "Revisa los campos marcados.", errores };
  }

  const v = datos.data;
  const existente = v.id ? await db.page.findUnique({ where: { id: v.id } }) : null;
  if (v.id && !existente) return { error: "Esa página ya no existe. Vuelve a la lista y recarga." };

  const slug = await slugLibre(v.slug || v.title, existente?.id);

  let creada = false;
  let id = existente?.id ?? "";

  if (existente) {
    await db.page.update({
      where: { id: existente.id },
      data: {
        title: v.title,
        slug,
        content: v.content,
        status: v.status,
        seoTitle: v.seoTitle || null,
        seoDescription: v.seoDescription || null,
        showInFooter: v.showInFooter,
      },
    });
  } else {
    // La nueva se pone la última del pie: reordenar es un gesto, adivinar no.
    const ultima = await db.page.aggregate({ _max: { position: true } });
    const creado = await db.page.create({
      data: {
        title: v.title,
        slug,
        content: v.content,
        status: v.status,
        seoTitle: v.seoTitle || null,
        seoDescription: v.seoDescription || null,
        showInFooter: v.showInFooter,
        position: (ultima._max.position ?? 0) + 1,
      },
    });
    id = creado.id;
    creada = true;
  }

  await registrar(
    admin,
    creada ? "create" : "update",
    id,
    `${creada ? "Creó" : "Editó"} la página "${v.title}"`,
    { slug, status: v.status },
  );

  refrescar(slug, existente?.slug ?? null);

  // redirect() lanza una excepción de control de Next: va fuera de cualquier
  // try/catch, y solo al crear (al editar se sigue en la misma pantalla).
  if (creada) redirect(`/admin/paginas/${id}?ok=creada`);

  return {
    ok: true,
    mensaje:
      v.status === "published"
        ? `Guardada y publicada. Ya se puede ver en /pagina/${slug}.`
        : "Guardada como borrador. Nadie la ve todavía.",
  };
}

/* ─────────────────────────── estado y orden ─────────────────────────── */

export async function cambiarEstadoPagina(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const pagina = await db.page.findUnique({ where: { id }, select: { id: true, slug: true, title: true, status: true } });
  if (!pagina) redirect("/admin/paginas");

  const nuevo = pagina.status === "published" ? "draft" : "published";
  await db.page.update({ where: { id: pagina.id }, data: { status: nuevo } });
  await registrar(admin, nuevo === "published" ? "publish" : "update", pagina.id, `${nuevo === "published" ? "Publicó" : "Despublicó"} la página "${pagina.title}"`);

  refrescar(pagina.slug);
  redirect(`/admin/paginas?ok=${nuevo === "published" ? "publicada" : "retirada"}`);
}

/** Sube o baja una página en el orden del pie. */
export async function moverPagina(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const direccion = String(fd.get("direccion") ?? "");
  if (!id || (direccion !== "arriba" && direccion !== "abajo")) redirect("/admin/paginas");

  const paginas = await db.page.findMany({
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: { id: true, title: true },
  });
  const indice = paginas.findIndex((p) => p.id === id);
  const destino = direccion === "arriba" ? indice - 1 : indice + 1;
  if (indice < 0 || destino < 0 || destino >= paginas.length) redirect("/admin/paginas");

  const nuevo = [...paginas];
  nuevo[indice] = paginas[destino];
  nuevo[destino] = paginas[indice];
  await db.$transaction(nuevo.map((p, i) => db.page.update({ where: { id: p.id }, data: { position: i } })));

  await registrar(admin, "update", id, `Cambió el orden de la página "${paginas[indice].title}"`);
  revalidatePath("/", "layout");
  redirect("/admin/paginas");
}

/* ─────────────────────────── borrar ─────────────────────────── */

/**
 * Borrado real. La pantalla lo pide en dos pasos (enlace → tarjeta de aviso →
 * botón rojo), porque un "Eliminar" a un dedo de distancia en el móvil es una
 * página perdida sin manera de recuperarla.
 */
export async function eliminarPagina(fd: FormData): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const id = String(fd.get("id") ?? "");
  const pagina = await db.page.findUnique({ where: { id }, select: { id: true, slug: true, title: true } });
  if (!pagina) redirect("/admin/paginas");

  await db.page.delete({ where: { id: pagina.id } });
  await registrar(admin, "delete", pagina.id, `Borró la página "${pagina.title}"`, { slug: pagina.slug });

  refrescar(pagina.slug);
  redirect("/admin/paginas?ok=borrada");
}

/* ─────────────────────── las cuatro páginas básicas ─────────────────────── */

/**
 * Borradores de las cuatro páginas que toda tienda necesita y que hoy no
 * existen. Son BORRADORES: cada dato que solo Madeline conoce va marcado con
 * «[POR CONFIRMAR]» para que no se publique una promesa que no ha hecho.
 *
 * En cambios y devoluciones se respeta lo que ella ya dice en Instagram —que no
 * acepta devoluciones—: el texto no la contradice, solo lo deja escrito para que
 * ella lo confirme o lo suavice.
 */
const BASICAS: { slug: string; title: string; seoDescription: string; content: string }[] = [
  {
    slug: "envios-y-entregas",
    title: "Envíos y entregas",
    seoDescription: "Cómo te llega tu pedido de Bloom by Madeline: envíos a todo Estados Unidos y recogida en la boutique de Hamilton, Ohio.",
    content: `## Cómo te llega tu pedido

Puedes recoger tu compra en la boutique o pedir que te la enviemos a casa.

### Recogida en la boutique

1305 Grand Blvd, Hamilton, OH 45011
Jueves, viernes y sábado, de 1:00 a 8:00 PM.

Te guardamos la prenda hasta que puedas pasar. Escríbenos por Instagram para avisarnos.

### Envío a domicilio

Enviamos a todo Estados Unidos.

- **Coste del envío:** [POR CONFIRMAR — Madeline: ¿cuánto cobras por el envío? ¿Hay envío gratis a partir de cierto importe?]
- **Cuándo sale tu pedido:** [POR CONFIRMAR — ¿en cuántos días preparas el paquete?]
- **Cuánto tarda en llegar:** [POR CONFIRMAR — plazo aproximado del transportista]
- **Transportista:** [POR CONFIRMAR — USPS, UPS…]

### Seguimiento

Cuando tu paquete salga te mandamos el número de seguimiento por el mismo sitio por el que hiciste el pedido.

### ¿Dudas con tu envío?

Escríbenos por Instagram a [@bloombymadelin](https://www.instagram.com/bloombymadelin/) y te contestamos el mismo día.`,
  },
  {
    slug: "cambios-y-devoluciones",
    title: "Cambios y devoluciones",
    seoDescription: "Política de cambios y devoluciones de Bloom by Madeline.",
    content: `## Cambios y devoluciones

[POR CONFIRMAR — Madeline: este texto es un borrador basado en lo que dices hoy en tu Instagram (todas las ventas son finales). Léelo entero y cámbialo a tu gusto ANTES de publicarlo.]

### Todas las ventas son finales

Cada pieza se elige a mano y en cantidades muy pequeñas, así que **no se admiten devoluciones ni reembolsos**.

Antes de comprar, escríbenos: te decimos medidas, cómo queda la talla y te mandamos más fotos o un vídeo de la prenda. Preferimos aclarar todas las dudas antes que dejarte con algo que no te sirve.

### ¿Y si me queda mal la talla?

[POR CONFIRMAR — ¿aceptas cambio por otra talla si la prenda está sin usar y con etiqueta? ¿En cuántos días? Si no lo aceptas, borra este apartado.]

### Si tu pedido llega dañado o equivocado

Eso sí lo arreglamos siempre. Escríbenos **dentro de las 48 horas siguientes a recibirlo**, con una foto de la prenda y del paquete, y lo solucionamos.

### Compras en la boutique

Te puedes probar todo en el probador antes de llevártelo, sin prisa.

### ¿Alguna duda?

Escríbenos por Instagram a [@bloombymadelin](https://www.instagram.com/bloombymadelin/).`,
  },
  {
    slug: "sobre-nosotros",
    title: "Sobre nosotros",
    seoDescription: "Bloom by Madeline es una boutique de moda femenina en Hamilton, Ohio. Tendencias exclusivas seleccionadas a mano.",
    content: `## Bloom by Madeline

Somos una boutique de moda femenina en Hamilton, Ohio. Seleccionamos a mano cada pieza, en cantidades pequeñas, para que no te cruces con tu mismo vestido en cada esquina.

### Vestir con intención

En Bloom no seguimos tendencias por seguirlas. Elegimos cada prenda pensando en la mujer que la va a llevar: su día, su cuerpo, su momento. Porque cuando te vistes con intención, no entras a un lugar — floreces en él.

### Un espacio pensado para ti

En pleno Grand Blvd, nuestra boutique es ese sitio donde entras «solo a mirar» y sales sintiéndote otra. Pruébate todo, pide opinión y deja que armemos tu outfit juntas.

- **Atención personalizada.** Te ayudamos a encontrar tu look, sin prisa y sin presión.
- **Pruébatelo antes de llevarlo.** Probador en tienda para que salgas segura de tu compra.
- **Nuevas llegadas semanales.** Cada semana llegan piezas nuevas — y vuelan rápido.
- **Apartados por DM.** ¿La viste en Instagram? Escríbenos y te la reservamos.

### Visítanos

1305 Grand Blvd, Hamilton, OH 45011
Jueves, viernes y sábado, de 1:00 a 8:00 PM.

[POR CONFIRMAR — Madeline: si quieres contar aquí tu historia (cuándo abriste, por qué «Bloom», qué te llevó a montar la boutique), escríbelo tú. No lo inventamos nosotros.]`,
  },
  {
    slug: "terminos-y-privacidad",
    title: "Términos y privacidad",
    seoDescription: "Condiciones de uso y tratamiento de datos de la tienda online de Bloom by Madeline.",
    content: `## Términos y privacidad

[POR CONFIRMAR — Madeline: este texto es un borrador de partida. Si vendes con tarjeta, conviene que lo revise alguien que entienda de esto antes de publicarlo.]

### Quiénes somos

Esta tienda la lleva Bloom by Madeline, boutique de moda femenina en 1305 Grand Blvd, Hamilton, OH 45011.

### Precios y disponibilidad

Los precios están en dólares estadounidenses (USD). Trabajamos con cantidades muy pequeñas de cada prenda: puede que algo se agote entre que lo ves y lo pides. Si pasa, te avisamos y te devolvemos el importe.

### Pedidos

Un pedido queda confirmado cuando recibes nuestra confirmación. Podemos cancelar un pedido si la prenda ya no está disponible o si hay un error evidente en el precio; en ese caso te devolvemos lo pagado.

### Pagos

[POR CONFIRMAR — formas de pago que aceptas: tarjeta, efectivo en tienda, pago por DM…]

### Qué datos guardamos

Guardamos solo lo necesario para prepararte el pedido: tu nombre, tu correo, tu teléfono y tu dirección de envío. **No vendemos ni cedemos tus datos a nadie.**

Si pagas con tarjeta, los datos de la tarjeta los procesa la pasarela de pago; nosotros no los vemos ni los guardamos.

### Cookies

Usamos lo mínimo para que funcione el carrito: una cookie que recuerda lo que has añadido. No hay publicidad ni seguimiento de terceros.

### Tus datos son tuyos

Puedes pedirnos ver, corregir o borrar tus datos cuando quieras, escribiendo a [@bloombymadelin](https://www.instagram.com/bloombymadelin/).

### Fotos y contenido

Las fotos y los textos de esta web son nuestros. Por favor, no los uses sin permiso.

### Cambios

Si cambiamos estas condiciones, la fecha de la última actualización aparecerá aquí.`,
  },
];

/**
 * Crea de golpe las cuatro páginas básicas que falten, siempre en borrador.
 * Se puede pulsar dos veces sin duplicar nada.
 */
export async function crearPaginasBasicas(): Promise<void> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");

  const existentes = await db.page.findMany({ select: { slug: true } });
  const yaEstan = new Set(existentes.map((p) => p.slug));
  const ultima = await db.page.aggregate({ _max: { position: true } });
  let posicion = (ultima._max.position ?? 0) + 1;

  let creadas = 0;
  for (const base of BASICAS) {
    if (yaEstan.has(base.slug)) continue;
    await db.page.create({
      data: {
        slug: base.slug,
        title: base.title,
        content: base.content,
        seoDescription: base.seoDescription,
        // En borrador a propósito: llevan huecos [POR CONFIRMAR] que solo
        // Madeline puede rellenar. Publicarlas automáticamente sería publicar
        // una política de envíos inventada.
        status: "draft",
        showInFooter: true,
        position: posicion++,
      },
    });
    creadas++;
  }

  const plural = creadas === 1 ? "página básica" : "páginas básicas";
  await registrar(admin, "create", null, `Creó ${creadas} ${plural} en borrador`);
  revalidatePath("/", "layout");
  revalidatePath("/admin/paginas");
  redirect("/admin/paginas?ok=basicas");
}
