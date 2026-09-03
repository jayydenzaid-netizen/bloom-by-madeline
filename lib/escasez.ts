import { cache } from "react";
import { db } from "@/lib/db";

/**
 * Las piezas que están a punto de agotarse.
 *
 * Por qué vive aquí y no dentro de la portada
 * ───────────────────────────────────────────
 * La sección «Cuando vuela, no vuelve» **no siempre se pinta**: si no queda
 * ninguna pieza por debajo del umbral, `Exclusividad` devuelve `null` y el
 * ancla `#escasez` deja de existir en el HTML. El menú necesita saber eso antes
 * de ofrecer un enlace hacia ella, así que el cálculo no puede seguir siendo una
 * variable local de `page.tsx`.
 *
 * `cache` de React memoiza por petición: en la portada la consulta se hace una
 * sola vez aunque la pidan la página y la barra de navegación.
 */

/** Una pieza a punto de agotarse, con las unidades que quedan DE VERDAD. */
export type PiezaEscasa = {
  slug: string;
  title: string;
  imageUrl: string | null;
  priceCents: number;
  compareAtCents: number | null;
  /** Unidades que quedan sumando todas las tallas. */
  quedan: number;
  /** Tallas que aún tienen alguna unidad: "S · M". */
  tallas: string;
};

/** Lo mínimo que hace falta saber de una prenda para decidir si «vuela». */
export type CandidataEscasez = {
  slug: string;
  title: string;
  priceCents: number;
  compareAtCents: number | null;
  images: { url: string }[];
  variants: { option1: string | null; stock: number; trackStock: boolean }[];
};

/** Cuántas piezas caben en la fila de escasez de la portada. */
export const MAX_ESCASAS = 4;

/**
 * Separado de la consulta para poder probarlo sin base de datos.
 *
 * Se cuentan solo variantes que llevan control de stock (en dropshipping el
 * stock lo tiene el proveedor y decir «queda 1» sería mentir) y se ordenan de la
 * que menos queda a la que más. Si nadie está por debajo del umbral la lista
 * sale vacía y el bloque no se pinta: mejor no enseñar nada que fabricar una
 * urgencia que no existe.
 */
export function elegirEscasas(candidatas: CandidataEscasez[], umbral: number): PiezaEscasa[] {
  return candidatas
    .map((p): PiezaEscasa | null => {
      const conControl = p.variants.filter((v) => v.trackStock);
      if (conControl.length === 0) return null;
      const quedan = conControl.reduce((s, v) => s + Math.max(0, v.stock), 0);
      if (quedan <= 0 || quedan > umbral) return null;
      return {
        slug: p.slug,
        title: p.title,
        imageUrl: p.images[0]?.url ?? null,
        priceCents: p.priceCents,
        compareAtCents: p.compareAtCents,
        quedan,
        tallas: conControl
          .filter((v) => v.stock > 0)
          .map((v) => v.option1)
          .filter((t): t is string => !!t)
          .join(" · "),
      };
    })
    .filter((x): x is PiezaEscasa => x !== null)
    .sort((a, b) => a.quedan - b.quedan)
    .slice(0, MAX_ESCASAS);
}

/**
 * Las piezas escasas de todo el catálogo, no solo de las ocho de la portada: lo
 * que está a punto de agotarse puede ser cualquier prenda de la tienda.
 *
 * Si la consulta falla se devuelve una lista vacía. El precio de equivocarse
 * hacia ese lado es no enseñar la sección; hacia el otro, un 500 en la cara de
 * una clienta.
 */
export const piezasEscasas = cache(async (umbral: number): Promise<PiezaEscasa[]> => {
  try {
    const candidatas = await db.product.findMany({
      where: { status: "active", priceCents: { gt: 0 } },
      select: {
        slug: true,
        title: true,
        priceCents: true,
        compareAtCents: true,
        images: { select: { url: true }, orderBy: { position: "asc" }, take: 1 },
        variants: {
          select: { option1: true, stock: true, trackStock: true },
          orderBy: { position: "asc" },
        },
      },
    });
    return elegirEscasas(candidatas, umbral);
  } catch {
    return [];
  }
});
