import { Fragment } from "react";
import Link from "next/link";
import { cargarMenu, paginasDelPie, type EnlaceMenu } from "@/lib/navegacion";
import { getSettings } from "@/lib/settings";

/**
 * Pie del storefront. Los datos de contacto salen de Ajustes, no del código:
 * cuando Madeline cambie el horario o la dirección no hay que redesplegar.
 *
 * Dos cosas más, ahora conectadas de verdad:
 *  · la columna "Tienda" pinta el menú `footer` de `/admin/menus`; con la tabla
 *    vacía devuelve los dos enlaces de siempre y el pie queda idéntico;
 *  · la columna "Información" lista las páginas publicadas marcadas "sale en el
 *    pie". Existían y no había ni un enlace hacia ellas en toda la web: la
 *    clienta buscaba la política de devoluciones y no la encontraba.
 */
export default async function SiteFooter() {
  const [settings, enlacesTienda, paginas] = await Promise.all([
    getSettings(),
    cargarMenu("footer"),
    paginasDelPie(),
  ]);

  const igUrl = `https://www.instagram.com/${settings.instagram}/`;
  const year = new Date().getFullYear();

  // Sin páginas publicadas no hay cuarta columna, y el pie se ve exactamente
  // como se veía antes de que esto existiera.
  const columnas = paginas.length > 0 ? 4 : 3;

  return (
    <footer className="footer">
      {/* React 19 iza este <style> al <head> y lo deduplica por `href`. Va aquí y
          no en globals.css porque globals.css es la identidad del sitio y no se
          toca; esto solo corrige la rejilla cuando aparece la cuarta columna. */}
      {columnas === 4 ? (
        <style href="footer-cuatro-columnas" precedence="default">{ESTILO_CUATRO}</style>
      ) : null}

      <div className="footer-brand">
        <svg className="footer-lotus" viewBox="0 0 120 104" aria-hidden="true">
          <use href="#lotus" />
        </svg>
        <p className="footer-bloom">B&thinsp;L&thinsp;O&thinsp;O&thinsp;M</p>
        <p className="footer-by">
          <em>by</em> MADELINE
        </p>
      </div>

      <div className={columnas === 4 ? "footer-cols footer-cols-4" : "footer-cols"}>
        <div>
          <h4>Visítanos</h4>
          <p>
            {settings.address}
            <br />
            {settings.hours}
          </p>
        </div>
        <div>
          <h4>Síguenos</h4>
          <p>
            <a href={igUrl} target="_blank" rel="noopener">
              Instagram — @{settings.instagram}
            </a>
            <br />
            <a href={settings.instagramDm} target="_blank" rel="noopener">
              Pedidos por DM
            </a>
          </p>
        </div>
        <div>
          <h4>Tienda</h4>
          <p>
            <ListaEnlaces enlaces={enlacesTienda} />
          </p>
        </div>
        {paginas.length > 0 ? (
          <div>
            <h4>Información</h4>
            <p>
              <ListaEnlaces enlaces={paginas} />
            </p>
          </div>
        ) : null}
      </div>

      <div className="footer-bottom">
        <p>
          © {year} {settings.storeName} · Hamilton, Ohio
        </p>
        <p className="footer-tag">{settings.tagline}</p>
      </div>
    </footer>
  );
}

/**
 * Los enlaces del pie van dentro de un solo `<p>` separados por `<br />` — así
 * estaba escrito el pie original y así lo espera `.footer-cols p` (interlineado
 * 1.9). Meterlos en una `<ul>` cambiaría el ritmo vertical de la columna.
 */
function ListaEnlaces({ enlaces }: { enlaces: EnlaceMenu[] }) {
  return (
    <>
      {enlaces.map((enlace, i) => (
        <Fragment key={`${enlace.href}-${i}`}>
          {i > 0 ? <br /> : null}
          {enlace.externo ? (
            <a href={enlace.href} target="_blank" rel="noopener">
              {enlace.label}
            </a>
          ) : (
            <Link href={enlace.href}>{enlace.label}</Link>
          )}
        </Fragment>
      ))}
    </>
  );
}

/**
 * `.footer-cols` es `repeat(3, 1fr)` fijo en globals.css: con cuatro columnas la
 * última caería sola en una segunda fila. La especificidad de `.footer-cols-4`
 * (dos clases) gana a `.footer-cols` esté donde esté la hoja, así que también
 * hay que repetir aquí los cortes de móvil.
 */
const ESTILO_CUATRO = `
.footer-cols.footer-cols-4 { grid-template-columns: repeat(4, 1fr); gap: 34px 26px; }
@media (max-width: 900px) { .footer-cols.footer-cols-4 { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 640px) { .footer-cols.footer-cols-4 { grid-template-columns: 1fr; } }
`;
