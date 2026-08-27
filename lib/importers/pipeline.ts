// El puente entre "datos del proveedor" y "producto de la tienda".
//
// Recorrido completo:
//   NormalizedProduct  →  applyPricingToDraft()  →  ImportJob(status:'ready')
//                      →  [Madeline revisa y edita en /admin/importar]
//                      →  publishImportJob()  →  Product + imágenes + variantes
//
// Dos decisiones estructurales que conviene entender antes de tocar nada:
//
// 1. NUNCA se publica sin revisión (regla del contrato). Por eso el job nace en
//    'ready' y no en 'imported': entre importar y publicar hay una persona.
//
// 2. La deduplicación por sourceProvider+sourceProductId es un freno de mano, no
//    un adorno. Importar dos veces el mismo producto es EL error clásico del
//    dropshipping: acabas con dos fichas, dos precios distintos y clientas que
//    compran la barata. Aquí publicar un duplicado no falla en silencio ni crea
//    la copia: devuelve el producto que ya existe para que la usuaria decida entre
//    «actualizar el que tengo» (updateFromImport) o «crear otro a propósito».

import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@/lib/db";
import { leerExtrasDeProducto } from "@/lib/importers/csv";
import { applyPricing, type PricingRule } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { uniqueProductSlug } from "@/lib/slug";
import type {
  ImportMethod,
  NormalizedProduct,
  NormalizedVariant,
  ProviderId,
} from "@/lib/importers/types";

// ─────────────────────────────────── tipos ───────────────────────────────────

export type ProductStatus = "draft" | "active" | "archived";

export type VariantOverride = {
  priceCents?: number;
  compareAtCents?: number | null;
  costCents?: number | null;
  sku?: string;
  stock?: number;
  trackStock?: boolean;
};

/**
 * Lo que la usuaria cambió en la vista previa antes de publicar.
 * Las imágenes y variantes se referencian por su ÍNDICE en el borrador: es lo
 * único estable, porque el borrador no tiene ids propios hasta que se publica.
 */
export type PublishOverrides = {
  title?: string;
  description?: string;
  /** Solo lo mira `publishImportJob` (crear). `updateFromImport` lo IGNORA a
   *  propósito: actualizar nunca decide si un producto se ve en la tienda. */
  status?: ProductStatus;
  vendor?: string;
  productType?: string;
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;

  /** Índices de `draft.images` que se conservan. Si no se indica, van todas. */
  keepImageIndexes?: number[];
  /** Índices de `draft.variants` que NO se crean. */
  dropVariantIndexes?: number[];
  /** Ajustes finos por variante; la clave es el índice en `draft.variants`. */
  variantOverrides?: Record<number, VariantOverride>;

  /** Colecciones a las que entra el producto. */
  collectionIds?: string[];

  /** Regla de precio a aplicar antes de publicar. Por defecto, la de Ajustes. */
  pricing?: PricingRule;
  /** Si el borrador ya trae precios editados a mano, no se recalculan. */
  skipPricing?: boolean;

  /** Publicar aunque ya exista el mismo producto de proveedor. */
  allowDuplicate?: boolean;
};

export type PublishOutcome =
  | { ok: true; status: "created" | "updated"; productId: string; slug: string; title: string; warnings: string[] }
  | {
      ok: false;
      status: "duplicate";
      productId: string;
      slug: string;
      title: string;
      /** Estado del producto que YA existe (`draft` | `active` | `archived`). La
       *  pantalla lo necesita para decir «ya lo tienes y está a la venta» en vez
       *  de un aviso genérico: no es lo mismo actualizar un borrador que tocar
       *  una ficha que las clientas están viendo. */
      existingStatus: string;
      error: string;
      hint: string;
    }
  | { ok: false; status: "error"; error: string; hint?: string };

/**
 * Las DECISIONES de la revisión, que no son datos del proveedor: qué fotos se
 * dejan fuera, qué variantes se descartan, qué precios mandan sobre la regla y
 * qué avisos dejó la publicación.
 *
 * Viven DENTRO de `ImportJob.draftJson`, como una clave `revision` al lado del
 * NormalizedProduct, y no en `rawJson`. El porqué: `rawJson` es el volcado del
 * proveedor, se trunca a MAX_RAW_CHARS y el endpoint del bookmarklet lo
 * sobrescribe con lo suyo, así que una decisión guardada ahí se perdería sin
 * avisar. `draftJson` es además lo único que se lee para reabrir un borrador,
 * que es justo el momento en que estas decisiones tienen que estar.
 */
export type RevisionBorrador = {
  /** Índices de `images` que la usuaria dejó fuera. Excluir NO es borrar: la foto
   *  sigue en el borrador y se puede volver a incluir sin reimportar. */
  imagenesExcluidas?: number[];
  /** Índices de `variants` que no se publican. */
  variantesDescartadas?: number[];
  /** Índices cuyo `priceCents` del borrador manda sobre la regla automática:
   *  o vino escrito en el origen, o lo escribió ella a mano. */
  preciosDecididos?: number[];
  /** De los anteriores, los que vinieron escritos en el fichero de origen. Solo
   *  sirve para poder decirlo en pantalla («precio del fichero»). */
  preciosDelOrigen?: number[];
  /** Avisos que dejó la publicación. Se guardan porque la pantalla que los
   *  calcula (el editor) se desmonta justo después de publicar; sin esto, el
   *  aviso «quedó a precio 0» no lo llega a leer nadie. */
  avisosPublicacion?: string[];
};

/** Lo que hay de verdad dentro de `draftJson`: la ficha del proveedor + las decisiones. */
export type DraftGuardado = NormalizedProduct & { revision?: RevisionBorrador };

// ────────────────────────────────── el job ──────────────────────────────────

/** Cuánto volcado crudo se guarda. El HTML entero de AliExpress ronda los 2 MB y
 *  no cabe (ni hace falta) dentro de una fila de SQLite que se lee en cada listado. */
const MAX_RAW_CHARS = 400_000;

function safeStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value);
    if (!text) return null;
    return text.length > MAX_RAW_CHARS ? text.slice(0, MAX_RAW_CHARS) : text;
  } catch {
    return null;
  }
}

/**
 * Guarda la ficha normalizada como job listo para revisar.
 * Devuelve el id del job para que la UI pueda llevar a la usuaria a revisarlo.
 */
export async function createImportJob(
  normalized: NormalizedProduct,
  options: { raw?: unknown } = {},
): Promise<{ id: string; provider: string; method: string; status: string }> {
  const draft: DraftGuardado = { ...normalized, revision: revisionInicial(normalized) };
  const job = await db.importJob.create({
    data: {
      provider: normalized.provider,
      method: normalized.method,
      status: "ready",
      sourceUrl: normalized.sourceUrl,
      draftJson: JSON.stringify(draft),
      rawJson: safeStringify(options.raw ?? normalized.raw),
    },
    select: { id: true, provider: true, method: true, status: true },
  });
  return job;
}

/**
 * Orígenes que traen un PRECIO DE VENTA de verdad, decidido fuera de la tienda.
 *
 * Hoy solo el CSV: es el catálogo que la usuaria ya revisó en Excel, con sus
 * precios puestos a mano, y pisárselo con la regla automática es tirar ese
 * trabajo. Ojo con confundirlo con Alibaba: su adaptador también rellena
 * `priceCents`, pero ahí no es un precio del proveedor sino el resultado de
 * aplicarle la regla POR DEFECTO al coste — si se tratara como precio propio, la
 * regla de la tienda no volvería a tocarlo nunca. Si algún día otra vía trae
 * precio de venta escrito (una API oficial, por ejemplo), se añade aquí.
 */
const ORIGENES_CON_PRECIO_PROPIO: ImportMethod[] = ["csv", "migracion"];

function revisionInicial(normalized: NormalizedProduct): RevisionBorrador {
  // Orígenes SIN precio propio (Alibaba, AliExpress, HTML, marcador): su
  // `priceCents` es la regla POR DEFECTO aplicada al coste, NO un precio del
  // proveedor. Se devuelven listas VACÍAS (no `{}`): el editor las lee como «ningún
  // precio es del origen» y pone cada fila como recalculable, para que la regla de
  // la tienda de Ajustes la mueva. Con `{}` (undefined) el editor no corregía la
  // heurística inicial y las filas de Alibaba se quedaban «manual» → la regla no
  // las tocaba nunca y Madeline perdía margen sin enterarse.
  if (!ORIGENES_CON_PRECIO_PROPIO.includes(normalized.method)) {
    return { preciosDecididos: [], preciosDelOrigen: [] };
  }
  const conPrecio = normalized.variants
    .map((variant, index) => (typeof variant.priceCents === "number" && variant.priceCents > 0 ? index : -1))
    .filter((index) => index >= 0);
  if (conPrecio.length === 0) return { preciosDecididos: [], preciosDelOrigen: [] };
  // Un precio escrito en el origen manda sobre la regla: nace "decidido".
  return { preciosDecididos: conPrecio, preciosDelOrigen: conPrecio };
}

/**
 * Deja constancia de un intento fallido. Existe porque un importador que falla en
 * silencio le hace creer a la usuaria que "no pasó nada"; con el job en 'failed'
 * ve el intento, el motivo y el enlace que probó.
 */
export async function createFailedImportJob(input: {
  provider: ProviderId;
  method: ImportMethod;
  error: string;
  sourceUrl?: string | null;
}): Promise<{ id: string }> {
  return db.importJob.create({
    data: {
      provider: input.provider,
      method: input.method,
      status: "failed",
      sourceUrl: input.sourceUrl ?? null,
      error: input.error.slice(0, 2_000),
    },
    select: { id: true },
  });
}

export async function getImportJob(jobId: string) {
  return db.importJob.findUnique({ where: { id: jobId } });
}

/** Lee el borrador guardado en un job. Devuelve null si el JSON se corrompió. */
export function readDraft(draftJson: string | null): DraftGuardado | null {
  if (!draftJson) return null;
  try {
    const parsed = JSON.parse(draftJson) as DraftGuardado;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.variants)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Las decisiones de la revisión, sin el resto del borrador.
 *
 * Cualquier pantalla puede llamarla para pintar lo que quedó guardado — en
 * particular `avisosPublicacion`, que es donde vive el «quedó a precio 0».
 */
export function readRevision(draftJson: string | null): RevisionBorrador | null {
  const draft = readDraft(draftJson);
  if (!draft) return null;
  const revision = draft.revision;
  return revision && typeof revision === "object" ? revision : null;
}

export async function saveDraft(jobId: string, draft: DraftGuardado): Promise<void> {
  await db.importJob.update({
    where: { id: jobId },
    data: { draftJson: JSON.stringify(draft), status: "ready", error: null },
  });
}

/**
 * Escribe unas cuantas decisiones sobre el borrador guardado, sin tocar nada más.
 *
 * A diferencia de `saveDraft`, NO devuelve el job a 'ready': se usa después de
 * publicar, cuando el job ya está en 'imported' y devolverlo a 'ready' haría
 * reaparecer el editor sobre un producto que ya existe.
 */
export async function saveRevision(jobId: string, patch: RevisionBorrador): Promise<void> {
  const job = await db.importJob.findUnique({ where: { id: jobId }, select: { draftJson: true } });
  const draft = readDraft(job?.draftJson ?? null);
  if (!draft) return;
  const actualizado: DraftGuardado = { ...draft, revision: { ...(draft.revision ?? {}), ...patch } };
  await db.importJob.update({ where: { id: jobId }, data: { draftJson: JSON.stringify(actualizado) } });
}

// ─────────────────────────────────── precios ───────────────────────────────────

/**
 * Calcula el precio de venta de cada variante a partir de su coste.
 *
 * Devuelve una COPIA: el borrador original se guarda tal como llegó del proveedor
 * para poder recalcular cuando Madeline cambie la regla en Ajustes. Si se mutara,
 * el segundo cálculo partiría del precio ya inflado y multiplicaría dos veces.
 *
 * Una variante sin coste propio hereda `costCentsMin` del producto: en AliExpress
 * es habitual que solo el producto traiga rango de precio y las variantes vengan
 * pelas. Si tampoco hay eso, se deja sin precio y se avisa — inventar un número
 * aquí sería inventar un precio de la clienta, que es justo lo prohibido.
 */
export function applyPricingToDraft(product: NormalizedProduct, rule: PricingRule): NormalizedProduct {
  const fallbackCost = typeof product.costCentsMin === "number" ? product.costCentsMin : null;
  let sinCoste = 0;

  const variants: NormalizedVariant[] = product.variants.map((variant) => {
    const cost = typeof variant.costCents === "number" ? variant.costCents : fallbackCost;
    if (cost === null) {
      sinCoste += 1;
      return { ...variant, optionValues: [...variant.optionValues] };
    }
    return {
      ...variant,
      optionValues: [...variant.optionValues],
      costCents: variant.costCents ?? cost,
      priceCents: applyPricing(cost, rule),
    };
  });

  const warnings = [...product.warnings];
  if (sinCoste > 0) {
    warnings.push(
      `${sinCoste} ${sinCoste === 1 ? "variante no traía" : "variantes no traían"} coste del proveedor: hay que ponerle precio a mano antes de activarlo.`,
    );
  }

  return {
    ...product,
    images: product.images.map((image) => ({ ...image })),
    optionNames: [...product.optionNames],
    attributes: { ...product.attributes },
    variants,
    warnings,
  };
}

// ────────────────────────────── deduplicación ──────────────────────────────

export type ExistingProduct = { id: string; slug: string; title: string; status: string };

/** ¿Ya está este producto de proveedor en el catálogo? */
export async function findProductBySource(
  provider: string | null | undefined,
  sourceProductId: string | null | undefined,
): Promise<ExistingProduct | null> {
  if (!provider || !sourceProductId) return null;
  return db.product.findFirst({
    where: { sourceProvider: provider, sourceProductId },
    select: { id: true, slug: true, title: true, status: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * La decisión, separada de la consulta, para poder probarla sin base de datos y
 * para que el mensaje que ve la usuaria viva en un solo sitio.
 */
export function decideDuplicate(
  existing: ExistingProduct | null,
  allowDuplicate = false,
): { duplicate: boolean; error: string; hint: string } {
  if (!existing || allowDuplicate) return { duplicate: false, error: "", hint: "" };
  return {
    duplicate: true,
    error: `Ese producto ya está en el catálogo como «${existing.title}».`,
    hint: "Puedes actualizar el que ya tienes con los datos nuevos, o crear una segunda ficha a propósito si es una variante distinta del mismo proveedor.",
  };
}

// ─────────────────────────────── publicación ───────────────────────────────

function variantTitleFrom(variant: NormalizedVariant, index: number): string {
  const fromOptions = variant.optionValues.filter(Boolean).join(" / ");
  return variant.title?.trim() || fromOptions || (index === 0 ? "Único" : `Opción ${index + 1}`);
}

type PreparedVariant = {
  title: string;
  sku: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  priceCents: number;
  compareAtCents: number | null;
  costCents: number | null;
  stock: number;
  trackStock: boolean;
  imageUrl: string | null;
  position: number;
};

/**
 * Convierte las variantes del borrador en filas listas para la BD, aplicando los
 * retoques de la usuaria. Pura a propósito: es lo que más se equivoca y lo que
 * más barato sale probar.
 */
export function prepareVariants(draft: NormalizedProduct, overrides: PublishOverrides = {}): PreparedVariant[] {
  const dropped = new Set(overrides.dropVariantIndexes ?? []);
  const perVariant = overrides.variantOverrides ?? {};

  const rows: PreparedVariant[] = [];
  draft.variants.forEach((variant, index) => {
    if (dropped.has(index)) return;
    const extra = perVariant[index] ?? {};

    const priceCents = Math.max(0, Math.round(extra.priceCents ?? variant.priceCents ?? 0));
    const costCents =
      extra.costCents !== undefined ? extra.costCents : typeof variant.costCents === "number" ? variant.costCents : null;

    rows.push({
      title: variantTitleFrom(variant, index),
      sku: (extra.sku ?? variant.sku ?? "").slice(0, 80),
      option1: variant.optionValues[0] ?? null,
      option2: variant.optionValues[1] ?? null,
      option3: variant.optionValues[2] ?? null,
      priceCents,
      compareAtCents:
        extra.compareAtCents !== undefined
          ? extra.compareAtCents
          : typeof variant.compareAtCents === "number"
            ? variant.compareAtCents
            : null,
      costCents,
      stock: Math.max(0, Math.round(extra.stock ?? variant.stock ?? 0)),
      // En dropshipping el inventario lo tiene el proveedor: por defecto se vende
      // sin contar unidades, salvo que la usuaria diga lo contrario.
      trackStock: extra.trackStock ?? false,
      imageUrl: variant.imageUrl ?? null,
      position: rows.length,
    });
  });

  // Un producto sin variantes no se puede meter en el carrito: CartItem exige
  // variantId. Se crea una variante única con el precio de referencia.
  if (rows.length === 0) {
    const cost = typeof draft.costCentsMin === "number" ? draft.costCentsMin : null;
    rows.push({
      title: "Único",
      sku: "",
      option1: null,
      option2: null,
      option3: null,
      priceCents: 0,
      compareAtCents: null,
      costCents: cost,
      stock: 0,
      trackStock: false,
      imageUrl: draft.images[0]?.url ?? null,
      position: 0,
    });
  }

  return rows;
}

export function prepareImages(draft: NormalizedProduct, overrides: PublishOverrides = {}) {
  const keep = overrides.keepImageIndexes;
  const chosen = keep ? draft.images.filter((_, index) => keep.includes(index)) : draft.images;
  const seen = new Set<string>();
  const rows: { url: string; alt: string; position: number }[] = [];
  for (const image of chosen) {
    const url = (image.url ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push({ url, alt: (image.alt ?? "").slice(0, 200), position: rows.length });
  }
  return rows;
}

/**
 * Publica un job: crea el Product de verdad.
 *
 * Todo va dentro de una transacción porque un producto a medias (con imágenes pero
 * sin variantes, por ejemplo) rompe el carrito y la ficha, y detectarlo después es
 * mucho más caro que no crearlo.
 */
export async function publishImportJob(jobId: string, overrides: PublishOverrides = {}): Promise<PublishOutcome> {
  const job = await db.importJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, status: "error", error: "Esa importación ya no existe." };

  if (job.status === "imported" && job.productId) {
    const existing = await db.product.findUnique({
      where: { id: job.productId },
      select: { id: true, slug: true, title: true, status: true },
    });
    if (existing) {
      return {
        ok: false,
        status: "duplicate",
        productId: existing.id,
        slug: existing.slug,
        title: existing.title,
        existingStatus: existing.status,
        error: "Esta importación ya se publicó.",
        hint: "Ve al producto para editarlo, o vuelve a importar el enlace si quieres traer datos nuevos.",
      };
    }
  }

  const stored = readDraft(job.draftJson);
  if (!stored) {
    return {
      ok: false,
      status: "error",
      error: "El borrador de esta importación está vacío o corrupto.",
      hint: "Vuelve a importar el producto desde el enlace o con el bookmarklet.",
    };
  }

  // Precios: si la usuaria ya los tocó a mano, no se pisan.
  let draft = stored;
  if (!overrides.skipPricing) {
    const rule = overrides.pricing ?? (await getSettings()).pricing;
    draft = applyPricingToDraft(stored, rule);
  }

  const existing = await findProductBySource(draft.provider, draft.sourceProductId);
  const dup = decideDuplicate(existing, overrides.allowDuplicate);
  if (dup.duplicate && existing) {
    return {
      ok: false,
      status: "duplicate",
      productId: existing.id,
      slug: existing.slug,
      title: existing.title,
      existingStatus: existing.status,
      error: dup.error,
      hint: dup.hint,
    };
  }

  const title = (overrides.title ?? draft.title ?? "").trim() || "Producto sin título";
  const variants = prepareVariants(draft, overrides);
  const images = prepareImages(draft, overrides);
  const status: ProductStatus = overrides.status ?? "draft";

  // El slug se resuelve FUERA de la transacción: uniqueProductSlug() usa el cliente
  // global y en SQLite una lectura desde fuera mientras la transacción tiene el
  // bloqueo de escritura se queda esperando. La colisión (muy improbable en la
  // ventana entre ambas) se cubre con el reintento de abajo.
  const baseSlug = await uniqueProductSlug(title);

  const cheapest = variants.reduce((min, row) => (row.priceCents < min ? row.priceCents : min), Number.MAX_SAFE_INTEGER);
  const costs = variants.map((row) => row.costCents).filter((value): value is number => typeof value === "number");
  // Campos de producto que trae el borrador (hoy solo el CSV los rellena).
  const extras = leerExtrasDeProducto(draft);

  const productData = {
    title,
    description: overrides.description ?? draft.description ?? "",
    status,
    vendor: overrides.vendor ?? draft.vendor ?? "Bloom by Madeline",
    // Etiquetas y tipo del propio borrador cuando la pantalla no los trae. Un CSV
    // con `tags=blusas|qa` acababa publicado con `tagsJson = "[]"` porque el
    // editor arranca ese campo vacío y su array vacío pisaba lo del fichero: aquí
    // «vacío» se lee como «no se tocó», no como «bórralas todas».
    productType: overrides.productType || extras.productType,
    tagsJson: JSON.stringify(overrides.tags?.length ? overrides.tags : extras.tags),
    optionNamesJson: JSON.stringify(draft.optionNames ?? []),
    priceCents: cheapest === Number.MAX_SAFE_INTEGER ? 0 : cheapest,
    costCents: costs.length ? Math.min(...costs) : null,
    sourceProvider: draft.provider,
    sourceUrl: draft.sourceUrl,
    sourceProductId: draft.sourceProductId,
    sourceDataJson: JSON.stringify({ attributes: draft.attributes, warnings: draft.warnings }),
    seoTitle: overrides.seoTitle ?? null,
    seoDescription: overrides.seoDescription ?? null,
    publishedAt: status === "active" ? new Date() : null,
  };

  const write = async (slug: string) =>
    db.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          ...productData,
          slug,
          images: { create: images },
          variants: { create: variants },
        },
        select: { id: true, slug: true, title: true },
      });

      const collectionIds = overrides.collectionIds ?? [];
      if (collectionIds.length > 0) {
        await tx.collectionProduct.createMany({
          data: collectionIds.map((collectionId, position) => ({
            collectionId,
            productId: product.id,
            position,
          })),
        });
      }

      await tx.importJob.update({
        where: { id: jobId },
        data: { status: "imported", productId: product.id, error: null },
      });

      return product;
    });

  let created: { id: string; slug: string; title: string };
  try {
    created = await write(baseSlug);
  } catch (error) {
    if (isUniqueSlugError(error)) {
      // Otro agente/otra pestaña se llevó el slug entre la consulta y el INSERT.
      created = await write(`${baseSlug}-${Date.now().toString(36)}`);
    } else {
      return {
        ok: false,
        status: "error",
        error: `No se pudo guardar el producto: ${message(error)}`,
        hint: "Si se repite, revisa que las colecciones seleccionadas sigan existiendo.",
      };
    }
  }

  const warnings = [...draft.warnings];
  if (variants.every((row) => row.priceCents === 0)) {
    warnings.push("El producto quedó a precio 0: ponle precio antes de activarlo o se venderá gratis.");
  }

  // Los avisos se guardan en el job (draftJson → revision.avisosPublicacion).
  // Devolverlos y ya no basta: quien los pinta es el editor, y el editor se
  // desmonta en cuanto la pantalla se entera de que este job ya está publicado.
  // Guardados aquí, los puede leer con readRevision() la pantalla que quede.
  await saveRevision(jobId, { avisosPublicacion: warnings }).catch(() => {});

  return { ok: true, status: "created", productId: created.id, slug: created.slug, title: created.title, warnings };
}

/**
 * Trae los datos nuevos a un producto que YA existe (la salida honesta del
 * duplicado). No borra variantes existentes aunque desaparezcan del proveedor:
 * pueden estar en el carrito de alguien o en un pedido antiguo, y borrarlas
 * dejaría pedidos ilegibles. Se actualizan las que coinciden y se añaden las
 * nuevas; lo que sobra se reporta para que la usuaria decida a mano.
 */
export async function updateFromImport(
  jobId: string,
  productId: string,
  overrides: PublishOverrides & { replaceImages?: boolean } = {},
): Promise<PublishOutcome> {
  const job = await db.importJob.findUnique({ where: { id: jobId } });
  if (!job) return { ok: false, status: "error", error: "Esa importación ya no existe." };

  const stored = readDraft(job.draftJson);
  if (!stored) {
    return { ok: false, status: "error", error: "El borrador de esta importación está vacío o corrupto." };
  }

  const product = await db.product.findUnique({
    where: { id: productId },
    select: { id: true, slug: true, title: true, variants: { select: { id: true, title: true, sku: true } } },
  });
  if (!product) return { ok: false, status: "error", error: "El producto que querías actualizar ya no existe." };

  let draft = stored;
  if (!overrides.skipPricing) {
    const rule = overrides.pricing ?? (await getSettings()).pricing;
    draft = applyPricingToDraft(stored, rule);
  }

  const variants = prepareVariants(draft, overrides);
  const images = prepareImages(draft, overrides);
  const warnings = [...draft.warnings];

  // Emparejado: primero por SKU (es lo que el proveedor promete estable) y si no,
  // por el título de la variante ("S / Negro").
  const bySku = new Map(product.variants.filter((v) => v.sku).map((v) => [v.sku, v.id]));
  const byTitle = new Map(product.variants.map((v) => [v.title, v.id]));
  const touched = new Set<string>();

  try {
    await db.$transaction(async (tx) => {
      for (const row of variants) {
        const matchId = (row.sku && bySku.get(row.sku)) || byTitle.get(row.title) || null;
        if (matchId) {
          touched.add(matchId);
          await tx.productVariant.update({
            where: { id: matchId },
            data: {
              priceCents: row.priceCents,
              compareAtCents: row.compareAtCents,
              costCents: row.costCents,
              sku: row.sku,
              imageUrl: row.imageUrl,
            },
          });
        } else {
          await tx.productVariant.create({ data: { ...row, productId } });
        }
      }

      if (overrides.replaceImages) {
        await tx.productImage.deleteMany({ where: { productId } });
        if (images.length > 0) {
          await tx.productImage.createMany({ data: images.map((image) => ({ ...image, productId })) });
        }
      } else {
        const already = await tx.productImage.findMany({ where: { productId }, select: { url: true } });
        const known = new Set(already.map((image) => image.url));
        const nuevas = images.filter((image) => !known.has(image.url));
        if (nuevas.length > 0) {
          await tx.productImage.createMany({
            data: nuevas.map((image, index) => ({ ...image, productId, position: already.length + index })),
          });
        }
      }

      const cheapest = variants.reduce((min, row) => (row.priceCents < min ? row.priceCents : min), Number.MAX_SAFE_INTEGER);
      await tx.product.update({
        where: { id: productId },
        data: {
          title: overrides.title ?? product.title,
          description: overrides.description ?? draft.description ?? undefined,
          priceCents: cheapest === Number.MAX_SAFE_INTEGER ? undefined : cheapest,
          sourceUrl: draft.sourceUrl ?? undefined,
          sourceDataJson: JSON.stringify({ attributes: draft.attributes, warnings: draft.warnings }),
          // ACTUALIZAR NO TOCA EL ESTADO DE PUBLICACIÓN. Nunca. Reimportar es
          // refrescar datos y precios de un producto que ya existe; decidir si se
          // ve en la tienda es otra cosa y se hace en su ficha. Cuando esto
          // mandaba el estado del selector del editor (que arranca en borrador),
          // actualizar un producto ACTIVO lo devolvía a borrador: el escaparate
          // dejaba de enseñarlo y su URL —la que la dueña manda por Instagram—
          // pasaba a dar 404.
        },
      });

      await tx.importJob.update({
        where: { id: jobId },
        data: { status: "imported", productId, error: null },
      });
    });
  } catch (error) {
    return { ok: false, status: "error", error: `No se pudo actualizar el producto: ${message(error)}` };
  }

  const huerfanas = product.variants.filter((v) => !touched.has(v.id));
  if (huerfanas.length > 0) {
    warnings.push(
      `${huerfanas.length} ${huerfanas.length === 1 ? "variante ya no viene" : "variantes ya no vienen"} del proveedor (${huerfanas
        .map((v) => v.title)
        .join(", ")}). Se han dejado como estaban: revísalas por si conviene archivarlas.`,
    );
  }

  // Mismo motivo que al publicar: que el aviso sobreviva a la pantalla.
  await saveRevision(jobId, { avisosPublicacion: warnings }).catch(() => {});

  return { ok: true, status: "updated", productId, slug: product.slug, title: product.title, warnings };
}

// ────────────────────────── descarga de imágenes ──────────────────────────

/** Extensiones que se aceptan. Cualquier otra cosa no es una foto de producto. */
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif"]);

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

/** Deja solo caracteres que no significan nada en una ruta. */
function sanitizeToken(input: string, max = 40): string {
  return (input || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .toLowerCase();
}

/**
 * Nombre de fichero seguro para una imagen bajada del proveedor.
 *
 * El nombre NUNCA sale del proveedor. Si se usara su ruta tal cual, una URL como
 * `https://cdn/../../../.env.jpg` escribiría fuera de public/uploads: eso es un
 * escape de directorio de manual. Aquí el nombre se construye desde cero
 * (producto + posición + hash de la URL) y la extensión sale de una lista blanca.
 * El hash además hace el nombre estable: re-descargar no duplica ficheros.
 */
export function safeImageFileName(
  sourceUrl: string,
  productId: string,
  index: number,
  contentType?: string | null,
): string {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  let ext = CONTENT_TYPE_EXTENSION[type] ?? "";

  if (!ext) {
    // Sin content-type fiable se mira la URL, pero solo para *elegir de la lista*,
    // nunca para copiar texto del proveedor al nombre.
    const match = /\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/.exec(sourceUrl ?? "");
    const candidate = (match?.[1] ?? "").toLowerCase();
    if (IMAGE_EXTENSIONS.has(candidate)) ext = candidate === "jpeg" ? "jpg" : candidate;
  }
  if (!ext) ext = "jpg";

  const stem = sanitizeToken(productId, 32) || "producto";
  const position = String(Math.max(0, Math.floor(index)) + 1).padStart(2, "0");
  const fingerprint = createHash("sha1").update(String(sourceUrl ?? "")).digest("hex").slice(0, 8);

  return `${stem}-${position}-${fingerprint}.${ext}`;
}

export type DownloadImagesOptions = {
  /** Cuántas fotos como mucho. Una ficha de AliExpress puede traer 40. */
  maxImages?: number;
  /** Tope por fichero. Los CDN sirven originales de varios MB. */
  maxBytesPerImage?: number;
  /** Tope total de la operación. */
  maxTotalBytes?: number;
  timeoutMs?: number;
};

export type DownloadImagesResult = {
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
  errors: string[];
};

const DOWNLOAD_DEFAULTS = {
  maxImages: 12,
  maxBytesPerImage: 3_000_000,
  maxTotalBytes: 24_000_000,
  timeoutMs: 20_000,
};

/**
 * Baja las fotos del CDN del proveedor a public/uploads y apunta la ruta local.
 *
 * Es opcional y explícita a propósito. Las URLs de alicdn caducan y un día la
 * tienda amanece sin fotos, así que hay que poder independizarse; pero bajar 200 MB
 * sin avisar tampoco vale. De ahí los topes y el que sea la usuaria quien lo pida.
 * `url` no se toca: si la descarga falla, la ficha sigue mostrando la del CDN.
 */
/**
 * ¿La URL apunta a la propia máquina o a la red interna? Mismo criterio que
 * `anfitrionProhibido` de lib/media.ts, replicado aquí a propósito: un guardia de
 * seguridad duplicado es más seguro que un módulo acoplado al otro. Ante una URL
 * ilegible, se trata como interna (rechazar por defecto).
 */
function esHostInterno(url: string): boolean {
  let h: string;
  try {
    h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return true;
  }
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

export async function downloadImages(
  productId: string,
  options: DownloadImagesOptions = {},
): Promise<DownloadImagesResult> {
  const config = { ...DOWNLOAD_DEFAULTS, ...options };
  const result: DownloadImagesResult = { downloaded: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };

  const images = await db.productImage.findMany({
    where: { productId },
    orderBy: { position: "asc" },
    select: { id: true, url: true, localPath: true, position: true },
  });

  if (images.length === 0) return result;

  const uploads = path.join(process.cwd(), "public", "uploads");
  await mkdir(uploads, { recursive: true });

  let procesadas = 0;
  for (const image of images) {
    if (procesadas >= config.maxImages) {
      result.skipped += 1;
      continue;
    }
    if (image.localPath) {
      result.skipped += 1;
      continue;
    }
    if (result.bytes >= config.maxTotalBytes) {
      result.skipped += 1;
      continue;
    }

    procesadas += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      // SSRF: una imagen de un import manipulado (bookmarklet o HTML pegado)
      // podría apuntar a la red interna (169.254.169.254, 10.x, localhost). Se
      // rechaza ANTES de pedirla, igual que hace lib/media.ts en importFromUrl.
      if (esHostInterno(image.url)) throw new Error("host interno bloqueado");
      const response = await fetch(image.url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      });
      if (!response.ok) throw new Error(`respondió ${response.status}`);

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("image/")) {
        throw new Error(`no es una imagen (${contentType || "sin tipo"})`);
      }

      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > config.maxBytesPerImage) {
        throw new Error(`pesa ${(declared / 1_000_000).toFixed(1)} MB, más del tope`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength === 0) throw new Error("llegó vacía");
      // El content-length se puede mentir: se comprueba también lo realmente recibido.
      if (buffer.byteLength > config.maxBytesPerImage) {
        throw new Error(`pesa ${(buffer.byteLength / 1_000_000).toFixed(1)} MB, más del tope`);
      }

      // El número del nombre sale de la posición de la foto en la ficha, no del
      // orden de descarga: así re-intentar una descarga fallida no le cambia el
      // nombre a nadie y el orden se sigue leyendo en el listado del disco.
      const fileName = safeImageFileName(image.url, productId, image.position, contentType);
      await writeFile(path.join(uploads, fileName), buffer);

      await db.productImage.update({ where: { id: image.id }, data: { localPath: `/uploads/${fileName}` } });
      result.downloaded += 1;
      result.bytes += buffer.byteLength;
    } catch (error) {
      result.failed += 1;
      result.errors.push(`No se pudo bajar una foto: ${message(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return result;
}

// ──────────────────────── token del bookmarklet ────────────────────────

export const IMPORT_TOKEN_KEY = "importToken";

/**
 * Token que autoriza a /api/import/ingest. Vive en Setting porque tiene que
 * sobrevivir a los despliegues: el bookmarklet queda guardado en la barra de
 * marcadores de Madeline y si el token cambiara con cada arranque, dejaría de
 * funcionar sin aviso.
 *
 * Sin token cualquiera que descubriera la URL podría inyectar productos en la
 * tienda: el endpoint es público por necesidad (el bookmarklet corre en el
 * dominio del proveedor y no lleva la cookie de sesión del panel).
 */
export async function getOrCreateImportToken(): Promise<string> {
  const existing = await db.setting.findUnique({ where: { key: IMPORT_TOKEN_KEY } });
  const current = normalizeToken(existing?.value);
  if (current) return current;

  const token = randomBytes(24).toString("base64url");
  await db.setting.upsert({
    where: { key: IMPORT_TOKEN_KEY },
    create: { key: IMPORT_TOKEN_KEY, value: token },
    update: { value: token },
  });
  return token;
}

/** Genera uno nuevo e invalida el anterior (si el token se filtró). */
export async function rotateImportToken(): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db.setting.upsert({
    where: { key: IMPORT_TOKEN_KEY },
    create: { key: IMPORT_TOKEN_KEY, value: token },
    update: { value: token },
  });
  return token;
}

/**
 * saveSettings() guarda los valores como JSON, así que un token escrito desde
 * Ajustes llegaría entrecomillado. Se acepta tal cual y entrecomillado.
 */
function normalizeToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

// ──────────────────────────────── utilidades ────────────────────────────────

function isUniqueSlugError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "P2002";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
