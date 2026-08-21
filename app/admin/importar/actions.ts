"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { detectByUrl, importFromHtml, importFromUrl } from "@/lib/importers";
import { parseProductCsv } from "@/lib/importers/csv";
import {
  createFailedImportJob,
  createImportJob,
  findProductBySource,
  getImportJob,
  publishImportJob,
  readDraft,
  readRevision,
  saveDraft,
  updateFromImport,
  type DraftGuardado,
  type ProductStatus,
  type PublishOverrides,
  type RevisionBorrador,
  type VariantOverride,
} from "@/lib/importers/pipeline";
import type { NormalizedProduct, ProviderId } from "@/lib/importers/types";

/**
 * Mutaciones de la pantalla de importación.
 *
 * Aquí NO se parsea nada: todo el trabajo sucio (bajar, reconocer, normalizar)
 * vive en lib/importers. Este fichero es la frontera entre el navegador y ese
 * motor, y por eso hace tres cosas y solo tres:
 *
 *   1. comprobar que quien llama tiene sesión — una Server Action es un endpoint
 *      público con otro nombre: sin este control, cualquiera con la URL del panel
 *      podría meter productos en la tienda;
 *   2. validar lo que llega del cliente (zod), porque el formulario se puede
 *      falsificar entero desde la consola del navegador;
 *   3. traducir los resultados del motor a algo que la UI pueda pintar sin saber
 *      de adaptadores.
 *
 * Regla del contrato que se respeta a rajatabla: nada se publica solo. Importar
 * crea un ImportJob en 'ready' y ahí se para hasta que una persona pulsa Publicar.
 */

/* ─────────────────────────────── contratos ─────────────────────────────── */

export type ResultadoImportacion =
  | {
      ok: true;
      jobId: string;
      titulo: string;
      proveedor: string;
      imagenes: number;
      variantes: number;
      avisos: string[];
      /** Si ese producto de proveedor ya está en el catálogo. */
      duplicado: { productId: string; slug: string; title: string } | null;
    }
  | {
      ok: false;
      error: string;
      pista: string | null;
      /**
       * El fallo huele a anti-bot y no a error de la usuaria. La UI lo usa para
       * ofrecer las vías que sí funcionan en vez de un "reintentar" inútil.
       */
      bloqueado: boolean;
    };

export type ResultadoCsv = {
  ok: boolean;
  creados: { jobId: string; titulo: string }[];
  errores: string[];
  avisos: string[];
};

export type ResultadoPublicacion =
  | {
      ok: true;
      accion: "creado" | "actualizado";
      productId: string;
      slug: string;
      titulo: string;
      avisos: string[];
    }
  | {
      ok: false;
      error: string;
      pista: string | null;
      /** `status` es el estado del producto que YA existe: la pantalla dice «ya lo
       *  tienes y está a la venta» o «ya lo tienes, en borrador» según eso. */
      duplicado: { productId: string; slug: string; title: string; status: string } | null;
    };

/** Lo que la usuaria dejó tocado en la vista previa antes de publicar. */
export type EdicionBorrador = z.infer<typeof EsquemaEdicion>;

const EsquemaImagen = z.object({
  url: z.string().min(1).max(2000),
  alt: z.string().max(200).default(""),
  /** Excluir NO es borrar: la foto se queda en el borrador, marcada como fuera,
   *  para poder recuperarla mañana sin volver a importar el producto. */
  incluida: z.boolean().default(true),
});

const EsquemaPrecio = z.object({
  indice: z.number().int().min(0).max(999),
  /** null = variante sin precio: se publica a 0 y se avisa, nunca se inventa. */
  priceCents: z.number().int().min(0).max(100_000_00).nullable(),
  costCents: z.number().int().min(0).max(100_000_00).nullable(),
  /** El precio manda sobre la regla (vino del origen o lo escribió ella). */
  manual: z.boolean().default(false),
  /** De los manuales, los que venían escritos en el fichero de origen. */
  origen: z.boolean().default(false),
});

const EsquemaEdicion = z.object({
  titulo: z.string().max(300).default(""),
  descripcion: z.string().max(20_000).default(""),
  /** TODAS las del borrador, en el orden final y con su marca de incluida; la
   *  primera incluida es la portada. */
  imagenes: z.array(EsquemaImagen).max(60).default([]),
  precios: z.array(EsquemaPrecio).max(999).default([]),
  descartadas: z.array(z.number().int().min(0).max(999)).max(999).default([]),
  etiquetas: z.array(z.string().max(60)).max(30).default([]),
  colecciones: z.array(z.string().min(1).max(60)).max(30).default([]),
  // Por defecto BORRADOR: activar un producto es una decisión, no un descuido.
  estado: z.enum(["draft", "active"]).default("draft"),
});

/* ─────────────────────────────── utilidades ─────────────────────────────── */

/**
 * Cada acción la llama. No se puede confiar en el middleware ni en el layout:
 * una Server Action se invoca por POST directo a la ruta, sin pasar por el
 * render de ninguna página.
 */
async function exigirSesion(): Promise<void> {
  const admin = await getAdmin();
  if (!admin) throw new Error("Sesión caducada. Vuelve a entrar en el panel.");
}

/**
 * ¿El fallo es el proveedor cerrándonos la puerta, o un error nuestro?
 *
 * Importa mucho para la UI: ante un bloqueo, "reintentar" no sirve de nada y lo
 * honesto es mandar a la usuaria al HTML pegado o al bookmarklet. Los mensajes
 * del motor (fetcher.ts, aliexpress.ts) son en español y estables, así que se
 * reconocen por vocabulario en vez de inventar un código de error nuevo que
 * habría que mantener sincronizado en dos sitios.
 */
function pareceBloqueo(error: string, pista: string | null): boolean {
  const texto = `${error} ${pista ?? ""}`.toLowerCase();
  return /bloque|captcha|robot|sospechos|verificaci|403|429|sale de un servidor|no devolvió la ficha|slider/.test(
    texto,
  );
}

function proveedorDe(url: string): ProviderId {
  const adapter = detectByUrl(url);
  return (adapter?.id ?? "manual") as ProviderId;
}

function etiquetaProveedor(id: string): string {
  if (id === "aliexpress") return "AliExpress";
  if (id === "alibaba") return "Alibaba";
  if (id === "csv") return "CSV";
  return "Manual";
}

/** Empaqueta un producto normalizado como job listo para revisar. */
async function guardarComoJob(product: NormalizedProduct): Promise<ResultadoImportacion> {
  // El volcado crudo se guarda aparte (`rawJson`), no dentro del borrador: si no,
  // cada fila del historial arrastraría cientos de kilobytes de JSON del proveedor
  // que nadie va a leer, y la lista de importaciones se volvería lenta de golpe.
  const { raw, ...limpio } = product;
  const job = await createImportJob(limpio as NormalizedProduct, { raw });
  const duplicado = await findProductBySource(product.provider, product.sourceProductId).catch(() => null);

  revalidatePath("/admin/importar");

  return {
    ok: true,
    jobId: job.id,
    titulo: product.title || "Producto sin título",
    proveedor: etiquetaProveedor(product.provider),
    imagenes: product.images.length,
    variantes: product.variants.length,
    avisos: product.warnings,
    duplicado: duplicado ? { productId: duplicado.id, slug: duplicado.slug, title: duplicado.title } : null,
  };
}

function fallo(error: string, pista?: string | null): ResultadoImportacion {
  const limpia = pista ?? null;
  return { ok: false, error, pista: limpia, bloqueado: pareceBloqueo(error, limpia) };
}

/* ─────────────────────── paso 1 · traer el producto ─────────────────────── */

/**
 * Vía cómoda: bajar la ficha desde el servidor.
 *
 * Se importa de una en una, aunque la usuaria pegue veinte enlaces: el cliente
 * llama a esta acción en serie y así puede pintar el progreso real de cada línea
 * y seguir aunque una falle. Hacerlo en lote dentro de una sola acción daría una
 * espera muda de minuto y medio y un "algo falló" al final.
 */
export async function importarDesdeUrl(url: string): Promise<ResultadoImportacion> {
  await exigirSesion();

  const limpia = (url ?? "").trim();
  if (!limpia) return fallo("No has pegado ningún enlace.");
  if (limpia.length > 2000) {
    return fallo("Ese enlace es larguísimo y no parece una ficha de producto.", "Copia la dirección desde la barra del navegador.");
  }

  const resultado = await importFromUrl(limpia);

  if (!resultado.ok) {
    // Se deja rastro del intento: un fallo que no aparece en el historial es un
    // fallo que la usuaria cuenta como "no hice nada" y repite tres veces.
    await createFailedImportJob({
      provider: proveedorDe(limpia),
      method: "url",
      error: `${resultado.error}${resultado.hint ? ` — ${resultado.hint}` : ""}`,
      sourceUrl: limpia,
    }).catch(() => {});
    revalidatePath("/admin/importar");
    return fallo(resultado.error, resultado.hint ?? null);
  }

  const product = resultado.product;
  if (!product.sourceUrl) product.sourceUrl = limpia;
  return guardarComoJob(product);
}

/**
 * Vía que nunca falla por anti-bot: el HTML que la usuaria copió de su navegador.
 *
 * `url` es opcional pero ayuda: con ella el motor enruta al adaptador correcto en
 * vez de olfatear el HTML, y el producto queda con su enlace de origen (que es lo
 * que luego permite reimportarlo o comprarlo en el proveedor).
 */
export async function importarDesdeHtml(html: string, url?: string): Promise<ResultadoImportacion> {
  await exigirSesion();

  const cuerpo = html ?? "";
  if (cuerpo.trim().length < 200) {
    return fallo(
      "El HTML pegado está vacío o es demasiado corto para ser una ficha.",
      "En la página del producto pulsa Ctrl+U, luego Ctrl+A y Ctrl+C, y pega aquí todo.",
    );
  }

  const enlace = (url ?? "").trim() || undefined;
  const resultado = importFromHtml(cuerpo, enlace);

  if (!resultado.ok) {
    await createFailedImportJob({
      provider: enlace ? proveedorDe(enlace) : "manual",
      method: "html",
      error: `${resultado.error}${resultado.hint ? ` — ${resultado.hint}` : ""}`,
      sourceUrl: enlace ?? null,
    }).catch(() => {});
    revalidatePath("/admin/importar");
    return fallo(resultado.error, resultado.hint ?? null);
  }

  const product = resultado.product;
  if (!product.sourceUrl && enlace) product.sourceUrl = enlace;
  return guardarComoJob(product);
}

/**
 * Vía CSV: un fichero con muchos productos de golpe.
 *
 * Cada fila acaba siendo su propio ImportJob en 'ready', no un producto: así el
 * CSV pasa por exactamente la misma revisión que AliExpress y no hay una puerta
 * trasera por la que entren productos sin que nadie los mire.
 */
export async function importarDesdeCsv(texto: string, nombre = "catálogo"): Promise<ResultadoCsv> {
  await exigirSesion();

  const contenido = texto ?? "";
  if (!contenido.trim()) {
    return { ok: false, creados: [], errores: ["El fichero está vacío."], avisos: [] };
  }

  const leido = parseProductCsv(contenido);
  const creados: { jobId: string; titulo: string }[] = [];
  const errores = [...leido.errors];

  for (const product of leido.products) {
    try {
      const job = await createImportJob(product);
      creados.push({ jobId: job.id, titulo: product.title || "Producto sin título" });
    } catch (error) {
      errores.push(`No se pudo guardar «${product.title || "sin título"}»: ${mensaje(error)}`);
    }
  }

  if (creados.length === 0 && errores.length === 0) {
    errores.push(`No se reconoció ningún producto dentro de «${nombre}».`);
  }

  revalidatePath("/admin/importar");
  return { ok: creados.length > 0, creados, errores, avisos: leido.warnings };
}

/* ──────────────────── paso 2 · revisar · paso 3 · publicar ──────────────────── */

/**
 * Vuelca las ediciones de la usuaria sobre el borrador guardado.
 *
 * Se parte SIEMPRE del borrador que hay en la base de datos y no del que manda el
 * navegador: así se conservan los campos que la pantalla no toca (`raw`, atributos
 * de la ficha, id de proveedor) y una petición manipulada no puede reescribir el
 * origen del producto.
 */
function aplicarEdicion(base: DraftGuardado, edicion: EdicionBorrador): DraftGuardado {
  const porIndice = new Map(edicion.precios.map((fila) => [fila.indice, fila]));

  // El borrador conserva TODAS las fotos que trajo el proveedor. Antes se
  // guardaban solo las incluidas y «quitar una foto y guardar» la borraba para
  // siempre: al reabrir ya no existía y solo volvía reimportando el producto.
  // Ahora lo que se guarda aparte es la DECISIÓN (`revision.imagenesExcluidas`).
  // Si por lo que sea llegara una lista vacía, se respeta la del borrador: es
  // preferible publicar una foto de más que perder el material del proveedor.
  const imagenes = edicion.imagenes.length > 0 ? edicion.imagenes : null;

  const revision: RevisionBorrador = {
    ...(base.revision ?? {}),
    imagenesExcluidas: imagenes
      ? imagenes.map((imagen, indice) => (imagen.incluida ? -1 : indice)).filter((indice) => indice >= 0)
      : (base.revision?.imagenesExcluidas ?? []),
    // Las variantes descartadas también son una decisión y también tienen que
    // sobrevivir a la recarga: antes solo se usaban al publicar y al volver
    // aparecían marcadas otra vez, como si nadie hubiera decidido nada.
    variantesDescartadas: edicion.descartadas,
    preciosDecididos: edicion.precios.filter((fila) => fila.manual).map((fila) => fila.indice),
    preciosDelOrigen: edicion.precios.filter((fila) => fila.origen).map((fila) => fila.indice),
  };

  return {
    ...base,
    title: edicion.titulo.trim() || base.title,
    description: edicion.descripcion,
    images: imagenes
      ? imagenes.map((imagen) => ({ url: imagen.url, alt: imagen.alt }))
      : base.images,
    variants: base.variants.map((variante, indice) => {
      const fila = porIndice.get(indice);
      if (!fila) return variante;
      // En el borrador solo se guarda el precio DECIDIDO (el del fichero o el que
      // escribió ella). El que sale de la regla se deja en null a propósito: si se
      // guardara, al reabrir no habría forma de distinguir «precio del fichero» de
      // «precio calculado» y la regla no podría volver a recalcularlo.
      return { ...variante, priceCents: fila.manual ? fila.priceCents : null, costCents: fila.costCents };
    }),
    revision,
  };
}

/**
 * Traduce la edición a overrides de publicación.
 *
 * `incluirEstado` distingue los dos caminos, y no es un detalle: al PUBLICAR, el
 * estado lo elige la usuaria en el selector «Cómo se publica»; al ACTUALIZAR un
 * producto que ya existe, el estado ya está decidido desde hace tiempo y no se
 * está preguntando por él. Mandarlo igualmente devolvía a borrador productos que
 * estaban a la venta (y su URL pública, a 404).
 */
function overridesDe(
  edicion: EdicionBorrador,
  { permitirDuplicado = false, incluirEstado = true } = {},
): PublishOverrides {
  // Los precios de la pantalla se mandan variante a variante. El borrador solo
  // guarda los decididos a mano, así que sin esto las filas calculadas por la
  // regla se publicarían a 0.
  const variantOverrides: Record<number, VariantOverride> = {};
  for (const fila of edicion.precios) {
    variantOverrides[fila.indice] = { priceCents: fila.priceCents ?? 0, costCents: fila.costCents };
  }

  return {
    title: edicion.titulo.trim() || undefined,
    description: edicion.descripcion,
    ...(incluirEstado ? { status: edicion.estado as ProductStatus } : {}),
    tags: edicion.etiquetas,
    collectionIds: edicion.colecciones,
    dropVariantIndexes: edicion.descartadas,
    // El borrador guarda todas las fotos; las que se publican son las incluidas.
    // Sin lista (payload vacío) se publican todas, que es lo que hace `aplicarEdicion`.
    keepImageIndexes:
      edicion.imagenes.length > 0
        ? edicion.imagenes.map((imagen, indice) => (imagen.incluida ? indice : -1)).filter((indice) => indice >= 0)
        : undefined,
    variantOverrides,
    // Los precios ya vienen decididos por la usuaria (regla aplicada en vivo o
    // escritos a mano). Recalcularlos aquí pisaría justo lo que vino a decidir.
    skipPricing: true,
    allowDuplicate: permitirDuplicado,
  };
}

/**
 * Las decisiones guardadas de un borrador, para que el editor las recupere al
 * abrirse: qué fotos quedaron fuera, qué variantes descartadas y qué precios
 * mandan sobre la regla.
 *
 * Es una acción aparte y no un dato más de la pantalla porque `BorradorVista` la
 * arma la página (que es de otro agente) y solo lleva la ficha del proveedor.
 */
export async function revisionDelBorrador(jobId: string): Promise<RevisionBorrador | null> {
  await exigirSesion();
  const job = await getImportJob(jobId);
  if (!job) return null;
  return readRevision(job.draftJson);
}

/** Guarda sin publicar: para dejar un producto a medio revisar y volver mañana. */
export async function guardarBorrador(jobId: string, edicion: EdicionBorrador): Promise<{ ok: boolean; error?: string }> {
  await exigirSesion();

  const datos = EsquemaEdicion.safeParse(edicion);
  if (!datos.success) return { ok: false, error: "Hay algún campo con un valor imposible; revisa precios e imágenes." };

  const job = await getImportJob(jobId);
  if (!job) return { ok: false, error: "Esa importación ya no existe." };

  const base = readDraft(job.draftJson);
  if (!base) return { ok: false, error: "El borrador de esta importación está vacío o corrupto." };

  await saveDraft(jobId, aplicarEdicion(base, datos.data));
  revalidatePath("/admin/importar");
  return { ok: true };
}

/** Paso 3: crear el producto de verdad. */
export async function publicarBorrador(
  jobId: string,
  edicion: EdicionBorrador,
  permitirDuplicado = false,
): Promise<ResultadoPublicacion> {
  await exigirSesion();

  const datos = EsquemaEdicion.safeParse(edicion);
  if (!datos.success) {
    return { ok: false, error: "Hay algún campo con un valor imposible; revisa precios e imágenes.", pista: null, duplicado: null };
  }

  const job = await getImportJob(jobId);
  if (!job) return { ok: false, error: "Esa importación ya no existe.", pista: null, duplicado: null };

  const base = readDraft(job.draftJson);
  if (!base) {
    return {
      ok: false,
      error: "El borrador de esta importación está vacío o corrupto.",
      pista: "Vuelve a importar el producto desde el enlace o con el bookmarklet.",
      duplicado: null,
    };
  }

  // El borrador editado se guarda ANTES de publicar: publishImportJob lee de la
  // base de datos, así que sin este paso se publicarían los datos del proveedor
  // sin las correcciones (y el orden original de las fotos).
  await saveDraft(jobId, aplicarEdicion(base, datos.data));

  const resultado = await publishImportJob(jobId, overridesDe(datos.data, { permitirDuplicado }));

  revalidatePath("/admin/importar");
  revalidatePath("/admin/productos");

  if (resultado.ok) {
    return {
      ok: true,
      accion: resultado.status === "updated" ? "actualizado" : "creado",
      productId: resultado.productId,
      slug: resultado.slug,
      titulo: resultado.title,
      avisos: resultado.warnings,
    };
  }

  if (resultado.status === "duplicate") {
    return {
      ok: false,
      error: resultado.error,
      pista: resultado.hint,
      duplicado: {
        productId: resultado.productId,
        slug: resultado.slug,
        title: resultado.title,
        status: resultado.existingStatus,
      },
    };
  }

  return { ok: false, error: resultado.error, pista: resultado.hint ?? null, duplicado: null };
}

/**
 * La salida honesta del duplicado: en vez de crear una segunda ficha, se traen
 * los datos nuevos al producto que ya existe.
 */
export async function actualizarProductoExistente(
  jobId: string,
  productId: string,
  edicion: EdicionBorrador,
  reemplazarImagenes = false,
): Promise<ResultadoPublicacion> {
  await exigirSesion();

  const datos = EsquemaEdicion.safeParse(edicion);
  if (!datos.success) {
    return { ok: false, error: "Hay algún campo con un valor imposible; revisa precios e imágenes.", pista: null, duplicado: null };
  }

  const job = await getImportJob(jobId);
  if (!job) return { ok: false, error: "Esa importación ya no existe.", pista: null, duplicado: null };

  const base = readDraft(job.draftJson);
  if (!base) {
    return { ok: false, error: "El borrador de esta importación está vacío o corrupto.", pista: null, duplicado: null };
  }

  await saveDraft(jobId, aplicarEdicion(base, datos.data));

  // Sin `status`: actualizar refresca datos y precios, nunca decide si el producto
  // se ve o no en la tienda. Ese estado ya lo eligió ella en su día.
  const resultado = await updateFromImport(jobId, productId, {
    ...overridesDe(datos.data, { permitirDuplicado: true, incluirEstado: false }),
    replaceImages: reemplazarImagenes,
  });

  revalidatePath("/admin/importar");
  revalidatePath("/admin/productos");

  if (resultado.ok) {
    return {
      ok: true,
      accion: "actualizado",
      productId: resultado.productId,
      slug: resultado.slug,
      titulo: resultado.title,
      avisos: resultado.warnings,
    };
  }

  return {
    ok: false,
    error: resultado.status === "duplicate" ? resultado.error : resultado.error,
    pista: resultado.status === "duplicate" ? resultado.hint : (resultado.hint ?? null),
    duplicado: null,
  };
}

/* ─────────────────────────────── historial ─────────────────────────────── */

/**
 * Reintenta un job fallido volviendo a pedir su URL.
 *
 * Va por `<form action>` y no por onClick para que el historial funcione sin
 * JavaScript y sin convertir toda la lista en un componente cliente.
 *
 * Crea un job NUEVO en vez de revivir el viejo: el fallido es el registro de que
 * aquella vez no se pudo, y borrar esa huella es justo lo que impide entender por
 * qué AliExpress bloquea unos días sí y otros no.
 */
export async function reintentarJob(formData: FormData): Promise<void> {
  await exigirSesion();

  const jobId = String(formData.get("jobId") ?? "");
  const job = jobId ? await getImportJob(jobId) : null;

  if (!job?.sourceUrl) {
    // Sin enlace no hay nada que reintentar: ese job entró por HTML pegado o por
    // CSV, y repetir la operación exige el material original.
    redirect("/admin/importar?aviso=sin-enlace");
  }

  const resultado = await importarDesdeUrl(job.sourceUrl);
  revalidatePath("/admin/importar");

  if (resultado.ok) redirect(`/admin/importar?job=${encodeURIComponent(resultado.jobId)}`);
  redirect("/admin/importar?aviso=reintento-fallido");
}

/* ──────────────────────────── plantilla de CSV ──────────────────────────── */

/**
 * Ejemplo mínimo que sí importa. Se sirve desde el servidor para que las
 * cabeceras sean exactamente las que entiende `parseProductCsv` y no una lista
 * escrita de memoria en el cliente que se desincronice el día que cambien.
 */
export async function plantillaCsv(): Promise<string> {
  await exigirSesion();
  return [
    "handle,title,description,price,cost,sku,option1_name,option1_value,image_url,tags,status",
    'vestido-midi-satinado,Vestido midi satinado,"Tejido satinado con caída, manga larga.",49.99,14.50,BLM-001,Talla,S,https://ejemplo.com/foto-1.jpg,vestidos|nuevo,draft',
    'vestido-midi-satinado,Vestido midi satinado,,49.99,14.50,BLM-002,Talla,M,https://ejemplo.com/foto-2.jpg,,draft',
  ].join("\n");
}

/* ─────────────────────────────── auxiliares ─────────────────────────────── */

/** Colecciones para el selector de la vista previa. */
export async function coleccionesDisponibles(): Promise<{ id: string; title: string }[]> {
  await exigirSesion();
  return db.collection.findMany({ select: { id: true, title: true }, orderBy: { position: "asc" } });
}

function mensaje(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
