import Link from "next/link";
import "../vista-previa.css";

/**
 * Banda de VISTA PREVIA sobre la ficha pública.
 *
 * Existe porque el importador dejaba a Madeline delante de un 404: publicaba en
 * borrador (que es lo correcto) y acto seguido ofrecía «Ver en la tienda», donde
 * el escaparate solo enseña `active`. La respuesta no es enseñar borradores a
 * todo el mundo, sino dejar que quien tiene sesión de admin vea la ficha tal y
 * como quedará — y que se le diga, sin ambigüedad, que nadie más la ve.
 *
 * Este componente NO decide quién puede ver qué: eso lo resuelve la página, que
 * es la que tiene la sesión. Aquí solo se pinta el aviso. Si algún día se pinta
 * sin que la página haya comprobado la sesión, la fuga sería de la página.
 */

type Info = {
  /** Cómo se llama el estado en la boca de Madeline, no en la base de datos. */
  nombre: string;
  detalle: string;
};

const ESTADOS: Record<string, Info> = {
  draft: {
    nombre: "en borrador",
    detalle:
      "No sale en la tienda, ni en las búsquedas, ni en Google. Cuando lo actives aparecerá tal cual lo estás viendo.",
  },
  archived: {
    nombre: "archivado",
    detalle:
      "Se retiró del escaparate: las clientas ya no lo encuentran ni pueden comprarlo. Vuelve a activarlo para que se vea.",
  },
};

export default function AvisoVistaPrevia({
  estado,
  productId,
}: {
  /** `Product.status`: aquí llega `draft` o `archived`; `active` no lleva banda. */
  estado: string;
  productId: string;
}) {
  const info: Info = ESTADOS[estado] ?? {
    nombre: "sin publicar",
    detalle: "Todavía no está a la venta, así que las clientas no pueden verlo.",
  };

  return (
    <aside className="vp-banda" role="status" aria-label="Vista previa de un producto sin publicar">
      <span className="vp-etq">Vista previa</span>

      <div className="vp-texto">
        <p className="vp-titulo">
          Solo lo ves <em>tú</em>: esta pieza está {info.nombre}.
        </p>
        <p className="vp-sub">{info.detalle}</p>
        {/* Se avisa antes de que lo descubra pulsando: el carrito rechaza a
            propósito cualquier variante que no sea de un producto activo. */}
        <p className="vp-sub">El botón de añadir al carrito no funcionará mientras siga así.</p>
      </div>

      <Link className="vp-volver" href={`/admin/productos/${productId}`}>
        Volver a su ficha
      </Link>
    </aside>
  );
}
