import type { Metadata } from "next";
import { getSettings } from "@/lib/settings";
import {
  Catalogo,
  cargarCatalogo,
  leerParams,
  type BusquedaEntrante,
} from "@/app/(shop)/_components/Filtros";
import "../catalogo.css";

/**
 * Catálogo completo.
 *
 * Todo el estado (búsqueda, filtros, orden y página) viaja en la URL, así que
 * esta página se recalcula en cada petición: `searchParams` ya la marca como
 * dinámica, pero el catálogo cambia desde el admin y no queremos servir una
 * versión cacheada de ayer.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Tienda",
  description:
    "Todo el catálogo de Bloom by Madeline: vestidos, conjuntos, blusas y tops seleccionados a mano. Filtra por talla, color y precio.",
  alternates: { canonical: "/tienda" },
};

export default async function TiendaPage({
  searchParams,
}: {
  // En Next 15 searchParams es una promesa.
  searchParams: Promise<BusquedaEntrante>;
}) {
  const sp = await searchParams;
  const params = leerParams(sp);
  const [datos, settings] = await Promise.all([cargarCatalogo(params), getSettings()]);

  return (
    <div className="shop-page section">
      <header className="section-head">
        <div>
          <p className="overline">La colección</p>
          <h2>
            Toda la <span className="serif-it">tienda</span>
          </h2>
        </div>
        {/* El aviso sale de Ajustes: los plazos los escribe Madeline, no el código. */}
        {settings.shippingNotice ? (
          <p className="section-note">{settings.shippingNotice}</p>
        ) : null}
      </header>

      <Catalogo base="/tienda" params={params} datos={datos} />
    </div>
  );
}
