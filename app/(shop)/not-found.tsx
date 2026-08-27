import Link from "next/link";

/**
 * 404 del escaparate.
 *
 * Next sirve por defecto una pantalla blanca con «This page could not be found»,
 * sin barra, sin pie y sin ninguna vuelta a la tienda. Una compradora que pincha
 * un enlace viejo de Instagram (una prenda que Madeline despublicó, una colección
 * que vació) se merece algo mejor que un callejón sin salida en inglés.
 *
 * Vive dentro de `(shop)`, así que hereda la nav y el pie del escaparate y el
 * mismo lenguaje visual que los carritos y checkouts vacíos: el loto, un título
 * editorial y un camino claro de vuelta. Cubre los `notFound()` de producto,
 * colección y página. (Las redirecciones de Herramientas se prueban ANTES de
 * llegar aquí, así que un enlace con slug cambiado ni pasa por este 404.)
 */
export default function NotFound() {
  return (
    <div className="shop-page section">
      <div className="cp-empty">
        <svg viewBox="0 0 120 104" aria-hidden="true">
          <use href="#lotus" />
        </svg>
        <h1 className="cp-title">
          Esto ya no <em className="serif-it">florece aquí</em>
        </h1>
        <p>
          La página que buscabas no existe o se movió. A lo mejor la pieza voló
          o la guardamos para otra temporada.
        </p>
        <Link className="btn btn-ink" href="/tienda">
          Ver la colección
        </Link>
      </div>
    </div>
  );
}
