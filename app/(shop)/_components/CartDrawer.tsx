"use client";

/**
 * Capa cliente del storefront.
 *
 * Todo lo que necesita estado en el navegador vive aquí para que solo haya UN
 * proveedor de contexto y un único sitio donde se decide qué está abierto:
 *   · ShopUIProvider — estado compartido (drawer, menú móvil, toast) + chrome fijo
 *   · CartDrawer     — el cajón del carrito
 *   · NavActions     — botón de carrito con contador y hamburguesa (van dentro del header)
 *   · MobileMenu     — menú a pantalla completa (va FUERA del header: dentro quedaría
 *                      atrapado en su contexto de apilado y taparía su propio botón de cerrar)
 *
 * El resto del storefront (nav, footer, páginas) son Server Components.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { CartView } from "@/lib/cart";
import { formatCents } from "@/lib/money";
import { removeCartLine, updateCartLine } from "../cart-actions";
import Toast from "./Toast";

export type NavLink = { href: string; label: string };

type ShopUI = {
  /** Carrito real, servido por el layout. Se refresca cuando una Server Action revalida. */
  cart: CartView;
  cartOpen: boolean;
  menuOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
  toggleMenu: () => void;
  closeMenu: () => void;
  toast: (message: string) => void;
};

const ShopUICtx = createContext<ShopUI | null>(null);

export function useShopUI(): ShopUI {
  const ctx = useContext(ShopUICtx);
  if (!ctx) {
    throw new Error("useShopUI() solo funciona dentro de ShopUIProvider (app/(shop)/layout.tsx)");
  }
  return ctx;
}

export function ShopUIProvider({
  cart,
  dmUrl,
  shippingNotice,
  children,
}: {
  cart: CartView;
  dmUrl: string;
  shippingNotice: string;
  children: ReactNode;
}) {
  const [cartOpen, setCartOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [toastOn, setToastOn] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathname = usePathname();

  const openCart = useCallback(() => {
    setMenuOpen(false);
    setCartOpen(true);
  }, []);
  const closeCart = useCallback(() => setCartOpen(false), []);
  const toggleMenu = useCallback(() => setMenuOpen((v) => !v), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const toast = useCallback((message: string) => {
    if (!message) return;
    setToastMsg(message);
    setToastOn(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastOn(false), 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  /* Modo estático (?static): sin animaciones y todo visible. Es lo que usa el QA con
     Chrome real; sin esto la captura sale medio vacía y se confunde con un fallo de diseño. */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("static")) {
      document.documentElement.classList.add("static");
    }
  }, []);

  /* Al navegar se cierra todo: si no, el cajón sobrevive al cambio de página. */
  useEffect(() => {
    setCartOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  /* Sin bloqueo de scroll el fondo se desplaza bajo el cajón en móvil. */
  useEffect(() => {
    document.body.style.overflow = cartOpen || menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [cartOpen, menuOpen]);

  useEffect(() => {
    if (!cartOpen && !menuOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      setCartOpen(false);
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cartOpen, menuOpen]);

  /* Reveal al hacer scroll. Va aquí y no en cada página porque .reveal arranca con
     opacity:0 en globals.css: si nadie le pone .in, el contenido queda INVISIBLE.
     El MutationObserver cubre lo que llega después (streaming, filtros, paginación). */
  useEffect(() => {
    const isStatic = document.documentElement.classList.contains("static");
    const reveal = (el: Element) => el.classList.add("in");

    if (isStatic) {
      document.querySelectorAll(".reveal:not(.in)").forEach(reveal);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          reveal(entry.target);
          io.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
    );

    const observeAll = () =>
      document.querySelectorAll(".reveal:not(.in)").forEach((el) => io.observe(el));
    observeAll();

    const mo = new MutationObserver(observeAll);
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      io.disconnect();
    };
  }, [pathname]);

  const value = useMemo<ShopUI>(
    () => ({ cart, cartOpen, menuOpen, openCart, closeCart, toggleMenu, closeMenu, toast }),
    [cart, cartOpen, menuOpen, openCart, closeCart, toggleMenu, closeMenu, toast],
  );

  return (
    <ShopUICtx.Provider value={value}>
      {children}
      <CartDrawer dmUrl={dmUrl} shippingNotice={shippingNotice} />
      <DmFab dmUrl={dmUrl} />
      <Toast message={toastMsg} show={toastOn} />
    </ShopUICtx.Provider>
  );
}

/* ═══════════ NAV: contador + hamburguesa ═══════════ */

export function NavActions({ count }: { count: number }) {
  const { openCart, menuOpen, toggleMenu } = useShopUI();
  const cartBtn = useRef<HTMLButtonElement>(null);

  /* La barra se vuelve sólida al bajar. Se busca el header desde el botón en vez de
     por id para no depender de que SiteNav conserve ese id. */
  useEffect(() => {
    const nav = cartBtn.current?.closest(".nav");
    if (!nav) return;
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 30);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <button
        className="cart-btn"
        type="button"
        ref={cartBtn}
        onClick={openCart}
        aria-label={count > 0 ? `Abrir carrito (${count})` : "Abrir carrito de compras"}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 8V6.5a4 4 0 0 1 8 0V8" />
          <path d="M4.8 8h14.4l-1.1 11.1a2 2 0 0 1-2 1.9H7.9a2 2 0 0 1-2-1.9L4.8 8z" />
        </svg>
        {count > 0 ? <span className="cart-count">{count}</span> : null}
      </button>

      <button
        className={menuOpen ? "nav-burger open" : "nav-burger"}
        type="button"
        onClick={toggleMenu}
        aria-label={menuOpen ? "Cerrar menú" : "Abrir menú"}
        aria-expanded={menuOpen}
      >
        <span />
        <span />
      </button>
    </>
  );
}

export function MobileMenu({
  links,
  dmUrl,
  address,
  hours,
}: {
  links: NavLink[];
  dmUrl: string;
  address: string;
  hours: string;
}) {
  const { menuOpen, closeMenu } = useShopUI();

  return (
    <div className={menuOpen ? "mobile-menu open" : "mobile-menu"} aria-hidden={!menuOpen}>
      <nav aria-label="Menú móvil">
        {links.map((link, i) => (
          <Link
            key={link.href}
            href={link.href}
            onClick={closeMenu}
            style={{ "--i": i } as CSSProperties}
            tabIndex={menuOpen ? undefined : -1}
          >
            {link.label}
          </Link>
        ))}
        <a
          className="mm-cta"
          href={dmUrl}
          target="_blank"
          rel="noopener"
          onClick={closeMenu}
          style={{ "--i": links.length } as CSSProperties}
          tabIndex={menuOpen ? undefined : -1}
        >
          Pedir por Instagram DM →
        </a>
      </nav>
      <p className="mm-foot">
        {address}
        <br />
        {hours}
      </p>
    </div>
  );
}

/* ═══════════ CAJÓN DEL CARRITO ═══════════ */

export default function CartDrawer({
  dmUrl,
  shippingNotice,
}: {
  dmUrl: string;
  shippingNotice: string;
}) {
  const { cart, cartOpen, closeCart, toast } = useShopUI();
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  /* El foco entra al cajón, pero no en el mismo frame: mientras la transición no
     arranca el aside sigue en visibility:hidden y el navegador rechaza el focus(). */
  useEffect(() => {
    if (!cartOpen) {
      setCopied(false);
      return;
    }
    const t = setTimeout(() => closeBtn.current?.focus(), 90);
    return () => clearTimeout(t);
  }, [cartOpen]);

  const setQty = (lineId: string, qty: number) => {
    startTransition(async () => {
      const res = qty <= 0 ? await removeCartLine(lineId) : await updateCartLine(lineId, qty);
      if (res.message) toast(res.message);
    });
  };

  /**
   * Pedir por DM: ig.me no admite texto prefijado en la URL, así que el resumen se
   * copia al portapapeles y ella lo pega en el chat. Es el comportamiento del sitio
   * actual y la clienta ya lo tiene aprendido.
   */
  const sendByDm = () => {
    if (cart.lines.length === 0) return;
    const resumen = [
      "✿ Pedido — Bloom by Madeline",
      ...cart.lines.map(
        (l) =>
          `${l.quantity}× ${l.title}${l.variantTitle ? ` · ${l.variantTitle}` : ""} — ${formatCents(l.lineTotalCents)}`,
      ),
      `Subtotal: ${formatCents(cart.subtotalCents)}`,
      `Envío: ${cart.shippingCents === 0 ? "gratis" : formatCents(cart.shippingCents)}`,
      `Total: ${formatCents(cart.totalCents)}`,
    ].join("\n");

    try {
      navigator.clipboard?.writeText(resumen).catch(() => undefined);
    } catch {
      /* sin portapapeles: se abre el DM igual y ella escribe el pedido a mano */
    }
    setCopied(true);
    window.open(dmUrl, "_blank", "noopener");
  };

  const faltan = cart.freeShippingMissingCents;
  const progreso =
    faltan > 0 ? Math.round((cart.subtotalCents / (cart.subtotalCents + faltan)) * 100) : 100;

  return (
    <>
      <div
        className={cartOpen ? "cart-backdrop open" : "cart-backdrop"}
        onClick={closeCart}
        aria-hidden="true"
      />

      <aside
        className={cartOpen ? "cart open" : "cart"}
        role="dialog"
        aria-modal="true"
        aria-label="Carrito de compras"
      >
        <header className="cart-head">
          <h3>
            Tu <em className="serif-it">carrito</em>
          </h3>
          <button
            className="cart-close"
            type="button"
            ref={closeBtn}
            onClick={closeCart}
            aria-label="Cerrar carrito"
            tabIndex={cartOpen ? undefined : -1}
          >
            ×
          </button>
        </header>

        <div className="cart-body">
          {cart.lines.length === 0 ? (
            <div className="cart-empty">
              <svg viewBox="0 0 120 104" aria-hidden="true">
                <use href="#lotus" />
              </svg>
              <p>
                Tu carrito aún está por <em>florecer</em>.
              </p>
              <Link className="btn btn-ink" href="/tienda" onClick={closeCart}>
                Ver la colección
              </Link>
            </div>
          ) : (
            cart.lines.map((line) => {
              const tope = line.available !== null && line.quantity >= line.available;
              return (
                <div className="cart-item" key={line.id}>
                  {line.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- las fotos viven en el CDN del proveedor
                    <img src={line.imageUrl} alt={line.title} />
                  ) : (
                    <span className="cd-noimg" aria-hidden="true" />
                  )}

                  <div className="ci-info">
                    <h4>
                      <Link href={`/producto/${line.slug}`} onClick={closeCart}>
                        {line.title}
                      </Link>
                    </h4>
                    {line.variantTitle ? <p className="ci-meta">{line.variantTitle}</p> : null}

                    <div className="ci-qty">
                      <button
                        type="button"
                        onClick={() => setQty(line.id, line.quantity - 1)}
                        disabled={pending}
                        aria-label={`Quitar una unidad de ${line.title}`}
                      >
                        −
                      </button>
                      <span>{line.quantity}</span>
                      <button
                        type="button"
                        onClick={() => setQty(line.id, line.quantity + 1)}
                        disabled={pending || tope}
                        aria-label={`Añadir una unidad de ${line.title}`}
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <span className="ci-precio">{formatCents(line.lineTotalCents)}</span>

                  <button
                    type="button"
                    className="ci-del"
                    onClick={() => setQty(line.id, 0)}
                    disabled={pending}
                    aria-label={`Eliminar ${line.title} del carrito`}
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </div>

        {cart.lines.length > 0 ? (
          <footer className="cart-foot">
            {faltan > 0 ? (
              <div className="cd-ship">
                <p>
                  Te faltan <strong>{formatCents(faltan)}</strong> para el envío gratis
                </p>
                <div className="cd-ship-bar">
                  <span style={{ width: `${progreso}%` }} />
                </div>
              </div>
            ) : null}

            <div className="cd-row">
              <span>Subtotal</span>
              <span>{formatCents(cart.subtotalCents)}</span>
            </div>
            <div className="cd-row">
              <span>Envío</span>
              <span>{cart.shippingCents === 0 ? "Gratis" : formatCents(cart.shippingCents)}</span>
            </div>
            <div className="cart-total">
              <span>Total</span>
              <strong>{formatCents(cart.totalCents)}</strong>
            </div>

            <Link
              className="btn btn-ink cart-send"
              href="/checkout"
              onClick={closeCart}
              tabIndex={cartOpen ? undefined : -1}
            >
              Finalizar compra
            </Link>
            <button
              className="btn btn-ghost cd-dm"
              type="button"
              onClick={sendByDm}
              tabIndex={cartOpen ? undefined : -1}
            >
              Pedir por DM
            </button>

            {copied ? (
              <p className="cart-hint">✓ Pedido copiado — pégalo en el chat de Instagram</p>
            ) : null}
            {shippingNotice ? <p className="cart-note">{shippingNotice}</p> : null}
          </footer>
        ) : null}
      </aside>
    </>
  );
}

/* Botón flotante de DM: aparece al bajar, igual que en el sitio actual. */
function DmFab({ dmUrl }: { dmUrl: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 640);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <a
      className={show ? "dm-fab show" : "dm-fab"}
      href={dmUrl}
      target="_blank"
      rel="noopener"
      aria-label="Pedir por Instagram DM"
      tabIndex={show ? undefined : -1}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="2" width="20" height="20" rx="5.5" />
        <circle cx="12" cy="12" r="4.2" />
        <circle cx="17.6" cy="6.4" r="1.1" fill="currentColor" stroke="none" />
      </svg>
      <span>Pedir por DM</span>
    </a>
  );
}
