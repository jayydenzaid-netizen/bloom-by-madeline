import type { ReactNode } from "react";
import { getCart, readCartToken } from "@/lib/cart";
import { getSettings } from "@/lib/settings";
import { ShopUIProvider } from "./_components/CartDrawer";
import SiteNav from "./_components/SiteNav";
import SiteFooter from "./_components/SiteFooter";
import "./shop.css";

/**
 * Layout del storefront.
 *
 * El carrito se lee UNA vez aquí y baja por contexto: el badge del nav y el cajón
 * enseñan siempre el mismo número. Cuando una Server Action llama a revalidatePath
 * este layout se vuelve a ejecutar y los dos se actualizan solos.
 */
export default async function ShopLayout({ children }: { children: ReactNode }) {
  const token = await readCartToken();
  const [cart, settings] = await Promise.all([getCart(token), getSettings()]);

  return (
    <ShopUIProvider
      cart={cart}
      dmUrl={settings.instagramDm}
      shippingNotice={settings.shippingNotice}
    >
      <LotusDefs />
      <SiteNav cartCount={cart.count} />
      <main id="inicio">{children}</main>
      <SiteFooter />
    </ShopUIProvider>
  );
}

/**
 * El loto es la marca y aparece en el nav, el pie y el carrito vacío. Se define
 * una sola vez y el resto lo referencia con <use href="#lotus">.
 */
function LotusDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <g id="lotus" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none">
          <path d="M60 88 C51 62 51.5 34 60 12 C68.5 34 69 62 60 88 Z" />
          <path d="M60 88 C40 70 33 44 42 20 C56 36 61 62 60 88 Z" />
          <path d="M60 88 C80 70 87 44 78 20 C64 36 59 62 60 88 Z" />
          <path d="M60 88 C34 82 15 62 13 34 C36 42 54 62 60 88 Z" />
          <path d="M60 88 C86 82 105 62 107 34 C84 42 66 62 60 88 Z" />
          <path d="M60 88 C48 66 45 46 50 28" strokeWidth="1.4" opacity=".55" />
          <path d="M60 88 C72 66 75 46 70 28" strokeWidth="1.4" opacity=".55" />
          <path d="M18 95 C44 103 80 101 104 90" strokeWidth="1.6" opacity=".8" />
        </g>
      </defs>
    </svg>
  );
}
