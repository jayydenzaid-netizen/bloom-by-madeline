"use client";

/**
 * Aviso flotante del storefront.
 *
 * Es deliberadamente tonto: el estado (mensaje + temporizador) vive en
 * ShopUIProvider para que cualquier componente — AddToCart, el drawer, una
 * página — pueda avisar sin montar su propio toast y sin que se pisen dos.
 */
export default function Toast({ message, show }: { message: string; show: boolean }) {
  return (
    <div className={show ? "toast show" : "toast"} role="status" aria-live="polite">
      {message}
    </div>
  );
}
