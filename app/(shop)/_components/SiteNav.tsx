import Link from "next/link";
import { getCartCount } from "@/lib/cart";
import { cargarMenu } from "@/lib/navegacion";
import { getSettings } from "@/lib/settings";
import { MobileMenu, NavActions } from "./CartDrawer";

/**
 * Barra superior del storefront. Es Server Component a propósito: el contador del
 * carrito llega ya pintado en el HTML, sin el parpadeo de "0 y luego 3" que sale
 * cuando el número se lee en el cliente.
 *
 * Solo la parte que necesita manos (abrir el cajón, la hamburguesa) es cliente.
 *
 * Los enlaces ya no están escritos aquí: los sirve `cargarMenu("main")`, que con
 * la tabla `MenuItem` vacía devuelve exactamente los mismos cuatro de siempre
 * (viven en `lib/navegacion.ts` como valor por defecto). Así lo que Madeline
 * ordena en `/admin/menus` se ve de verdad, y mientras no toque nada la web no
 * cambia ni un píxel.
 */
export default async function SiteNav({ cartCount }: { cartCount?: number }) {
  const [settings, enlaces] = await Promise.all([getSettings(), cargarMenu("main")]);
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
          {enlaces.map((link, i) =>
            // Un enlace de fuera (su Instagram, una guía de tallas alojada aparte)
            // sale con <a> y en pestaña nueva: <Link> no precarga nada de otro
            // dominio y además sacaría a la clienta de la tienda sin vuelta.
            // La clave lleva el índice porque nada impide guardar dos enlaces con
            // el mismo destino y distinto texto.
            link.externo ? (
              <a key={`${link.href}-${i}`} href={link.href} target="_blank" rel="noopener">
                {link.label}
              </a>
            ) : (
              <Link key={`${link.href}-${i}`} href={link.href}>
                {link.label}
              </Link>
            ),
          )}
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
        links={enlaces}
        dmUrl={settings.instagramDm}
        address={settings.address}
        hours={settings.hours}
      />
    </>
  );
}
