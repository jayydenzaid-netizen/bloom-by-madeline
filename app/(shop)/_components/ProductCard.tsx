import Link from "next/link";
import { formatCents } from "@/lib/money";

/**
 * Tarjeta de producto para las rejillas (.product-grid).
 *
 * Server Component: no tiene interacción propia, el clic es un enlace normal a la
 * ficha. El marco "pétalo" alterna de dirección con :nth-child(even), así que la
 * tarjeta debe ser hija DIRECTA de la rejilla para que el ritmo se mantenga.
 */

export type ProductCardItem = {
  slug: string;
  title: string;
  /** Precio en centavos. 0 = todavía sin precio (producto sembrado o borrador). */
  priceCents: number;
  compareAtCents?: number | null;
  imageUrl?: string | null;
  imageAlt?: string | null;
  /** Línea corta bajo el título: "Negro · Lunares — S / M / L". */
  meta?: string | null;
  soldOut?: boolean;
  /** Unidades que quedan en total. null = sin control de stock. */
  quedan?: number | null;
};

export default function ProductCard({ product }: { product: ProductCardItem }) {
  const { slug, title, priceCents, compareAtCents, imageUrl, imageAlt, meta, soldOut, quedan } = product;
  // Nunca inventamos un precio: si aún no lo tiene, se dice tal cual.
  const conPrecio = priceCents > 0;
  const rebajado = conPrecio && !!compareAtCents && compareAtCents > priceCents;
  // Cuánto se ahorra, en redondo: «−30 %» convence más que dos cifras que hay
  // que restar mentalmente.
  const descuento = rebajado ? Math.round((1 - priceCents / (compareAtCents as number)) * 100) : 0;
  // Escasez REAL: sale del inventario. Sin control de stock no se dice nada,
  // porque ahí las unidades las tiene el proveedor y sería inventado.
  const pocas = !soldOut && typeof quedan === "number" && quedan > 0 && quedan <= 3;

  return (
    <Link className="product" href={`/producto/${slug}`}>
      <figure>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- las fotos viven en el CDN del proveedor
          <img src={imageUrl} alt={imageAlt || title} loading="lazy" />
        ) : (
          <span className="pc-noimg" aria-hidden="true" />
        )}
        {soldOut ? <span className="pc-flag">Agotado</span> : null}
        {!soldOut && rebajado ? (
          <span className="pc-flag pc-flag-sale">−{descuento} %</span>
        ) : null}
        {pocas ? (
          <span className={quedan === 1 ? "pc-flag pc-flag-ultima" : "pc-flag pc-flag-pocas"}>
            {quedan === 1 ? "¡Última!" : `Quedan ${quedan}`}
          </span>
        ) : null}
        <figcaption>
          <span>Ver la pieza</span>
        </figcaption>
      </figure>

      <h3>{title}</h3>
      {meta ? <p className="product-meta">{meta}</p> : null}

      <p className="pc-price">
        {conPrecio ? (
          <>
            {rebajado ? <s>{formatCents(compareAtCents!)}</s> : null}
            <strong className={rebajado ? "pc-ahora" : undefined}>{formatCents(priceCents)}</strong>
          </>
        ) : (
          <em>Precio por confirmar</em>
        )}
      </p>
    </Link>
  );
}
