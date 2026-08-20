import Link from "next/link";
import { getSettings } from "@/lib/settings";

/**
 * Pie del storefront. Los datos de contacto salen de Ajustes, no del código:
 * cuando Madeline cambie el horario o la dirección no hay que redesplegar.
 */
export default async function SiteFooter() {
  const settings = await getSettings();
  const igUrl = `https://www.instagram.com/${settings.instagram}/`;
  const year = new Date().getFullYear();

  return (
    <footer className="footer">
      <div className="footer-brand">
        <svg className="footer-lotus" viewBox="0 0 120 104" aria-hidden="true">
          <use href="#lotus" />
        </svg>
        <p className="footer-bloom">B&thinsp;L&thinsp;O&thinsp;O&thinsp;M</p>
        <p className="footer-by">
          <em>by</em> MADELINE
        </p>
      </div>

      <div className="footer-cols">
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
            <Link href="/tienda">Ver todas las piezas</Link>
            <br />
            <Link href="/carrito">Tu carrito</Link>
          </p>
        </div>
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
