import Link from "next/link";
import { getCartCount } from "@/lib/cart";
import { getSettings } from "@/lib/settings";
import { MobileMenu, NavActions, type NavLink } from "./CartDrawer";

/**
 * Barra superior del storefront. Es Server Component a propósito: el contador del
 * carrito llega ya pintado en el HTML, sin el parpadeo de "0 y luego 3" que sale
 * cuando el número se lee en el cliente.
 *
 * Solo la parte que necesita manos (abrir el cajón, la hamburguesa) es cliente.
 */

const NAV_LINKS: NavLink[] = [
  { href: "/tienda", label: "Nuevas Llegadas" },
  { href: "/#filosofia", label: "Filosofía" },
  { href: "/#boutique", label: "La Boutique" },
  { href: "/#visitanos", label: "Visítanos" },
];

export default async function SiteNav({ cartCount }: { cartCount?: number }) {
  const settings = await getSettings();
  // El layout ya trae el carrito entero; si alguien monta el nav suelto, lo cuenta él.
  const count = cartCount ?? (await getCartCount());

  return (
    <>
      <header className="nav" id="nav">
        <Link className="nav-brand" href="/" aria-label="Bloom by Madeline — inicio">
          <svg className="brand-lotus" viewBox="0 0 120 104" aria-hidden="true">
            <use href="#lotus" />
          </svg>
          <span className="brand-text">
            <span className="brand-bloom">BLOOM</span>
            <span className="brand-by">
              <em>by</em> MADELINE
            </span>
          </span>
        </Link>

        <nav className="nav-links" aria-label="Navegación principal">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="nav-actions">
          <a
            className="btn btn-ink btn-sm"
            href={settings.instagramDm}
            target="_blank"
            rel="noopener"
          >
            Pedir por DM
          </a>
          <NavActions count={count} />
        </div>
      </header>

      {/* Fuera del header: dentro heredaría su contexto de apilado y taparía la hamburguesa. */}
      <MobileMenu
        links={NAV_LINKS}
        dmUrl={settings.instagramDm}
        address={settings.address}
        hours={settings.hours}
      />
    </>
  );
}
