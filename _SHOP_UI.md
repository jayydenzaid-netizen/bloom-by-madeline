# _SHOP_UI — componentes compartidos del storefront

Lo que hay montado en `app/(shop)/` para que las páginas públicas (`/`, `/tienda`,
`/producto/[slug]`, `/coleccion/[slug]`, `/carrito`, `/checkout`, `/pedido/[number]`)
solo tengan que traer datos y componer. **Nada de esto se reescribe: se usa.**

Todo se apoya en las clases que ya existen en `app/globals.css` (`.nav`, `.cart`,
`.product`, `.btn`, `.toast`…). Lo que el one-page no tenía —precios, stock, selector
de variantes, resumen del carrito— vive en `app/(shop)/shop.css`.

---

## 1. Lo que ya te da el layout — no lo repitas

`app/(shop)/layout.tsx` es Server Component y monta, para **todas** las rutas del grupo:

- los `<defs>` del loto (`<use href="#lotus">` funciona en cualquier página del grupo),
- `SiteNav` (con el contador del carrito ya pintado desde el servidor),
- `<main id="inicio">{children}</main>`,
- `SiteFooter`,
- el cajón del carrito, el botón flotante de DM y el toast,
- el `reveal` al hacer scroll y el modo `?static`.

**Tu página empieza dentro de `<main>`.** No pongas `<header>`, `<footer>`, `<main>`
ni el carrito otra vez.

### Sitio bajo el nav fijo

El nav es `position: fixed` (78 px). La portada ya lo compensa dentro de `.hero`.
Cualquier otra página envuelve su contenido:

```tsx
<div className="shop-page section">…</div>
```

`.shop-page` (en `shop.css`) reserva el alto del nav. `.section` es de `globals.css` y
da el ancho máximo y el padding lateral del sitio.

### `reveal`

Puedes poner `className="reveal"` en lo que quieras que aparezca al hacer scroll:
el observador vive en el proveedor y también capta lo que se monta después
(filtros, paginación, streaming). Ojo: `.reveal` arranca en `opacity: 0`; **si algún
día se quita el proveedor, ese contenido queda invisible.**

---

## 2. Server Actions del carrito — `app/(shop)/cart-actions.ts`

```ts
import { addToCart, updateCartLine, removeCartLine, clearCart } from "@/app/(shop)/cart-actions";
```

| Acción | Firma | Qué hace |
|---|---|---|
| `addToCart` | `(variantId: string, quantity = 1)` | Crea el carrito si hace falta y suma la variante |
| `updateCartLine` | `(lineId: string, quantity: number)` | `0` elimina la línea |
| `removeCartLine` | `(lineId: string)` | Quita la línea |
| `clearCart` | `()` | Vacía el carrito (útil al confirmar un pedido) |

Todas devuelven `{ ok: boolean; message?: string }` — **nunca lanzan**. El `message`
ya está en español y listo para pasárselo al toast tal cual.

Reglas que aplican solas, no las repitas en tu página:

- solo se vende `Product.status === "active"`;
- si `variant.trackStock` es `true` la cantidad se recorta al stock y el `message`
  avisa (`"Solo quedan 2 disponibles de esa talla."`); si es `false` no hay límite
  de stock (dropshipping) más allá del tope de 20 por línea;
- una línea solo se toca si pertenece al carrito de la cookie de quien pide;
- al final llaman `revalidatePath("/", "layout")`, así que el badge del nav y el
  cajón se refrescan solos en toda la web.

---

## 3. Componentes

### `SiteNav` — Server Component

```tsx
<SiteNav />            // cuenta el carrito por su cuenta
<SiteNav cartCount={n} /> // el layout ya se lo pasa; no lo llames tú
```

Ya lo monta el layout. Los enlaces del nav están en `NAV_LINKS` dentro del propio
fichero: si necesitas otra sección, se cambia ahí (afecta también al menú móvil).

### `SiteFooter` — Server Component

Ya lo monta el layout. Dirección, horario, Instagram y tagline salen de
`getSettings()`, no del código.

### `ProductCard` — Server Component

```tsx
import ProductCard, { type ProductCardItem } from "@/app/(shop)/_components/ProductCard";

<div className="product-grid">
  {productos.map((p) => <ProductCard key={p.slug} product={p} />)}
</div>
```

```ts
type ProductCardItem = {
  slug: string;
  title: string;
  priceCents: number;          // 0 => pinta "Precio por confirmar", no "$0.00"
  compareAtCents?: number | null;  // si es mayor, sale tachado + etiqueta "Rebaja"
  imageUrl?: string | null;    // sin imagen => marco vacío en tono hueso
  imageAlt?: string | null;
  meta?: string | null;        // "Negro · Lunares — S / M / L"
  soldOut?: boolean;           // pinta la etiqueta "Agotado"
};
```

**Tiene que ser hijo directo de `.product-grid`**: el marco pétalo alterna de
dirección con `:nth-child(even)` y un `<div>` intermedio rompe el ritmo.
La tarjeta entera es un `<Link>` a `/producto/[slug]`.

### `AddToCart` — Client Component

```tsx
import AddToCart, { type AddToCartVariant } from "@/app/(shop)/_components/AddToCart";

const optionNames: string[] = JSON.parse(product.optionNamesJson); // ["Talla","Color"]
const variants: AddToCartVariant[] = product.variants.map((v) => ({
  id: v.id,
  title: v.title,
  optionValues: [v.option1, v.option2, v.option3], // MISMO orden que optionNames
  priceCents: v.priceCents,
  available: v.trackStock ? v.stock : null,        // null = sin control de stock
}));

<AddToCart optionNames={optionNames} variants={variants} />
```

Se encarga solo de: obligar a elegir cada opción (avisa con toast y sacude los
chips), deshabilitar combinaciones inexistentes o agotadas, el selector de cantidad,
el estado "Añadiendo…", el toast de confirmación y abrir el cajón al terminar.
Si todo está agotado el botón queda deshabilitado con el mensaje de "escríbenos por DM".

El precio grande de la ficha lo pinta **tu página**; `AddToCart` solo muestra precio
cuando las variantes valen distinto (ahí sí cambia según lo elegido).

### `CartDrawer` / `ShopUIProvider` / `Toast`

`app/(shop)/_components/CartDrawer.tsx` es **la capa cliente del storefront** y
exporta más de una cosa a propósito (un único contexto, un único sitio donde se
decide qué está abierto):

| Export | Qué es |
|---|---|
| `ShopUIProvider` | proveedor de contexto + chrome fijo (cajón, FAB de DM, toast). Lo monta el layout |
| `useShopUI()` | hook para las páginas cliente |
| `CartDrawer` (default) | el cajón. Ya lo monta el proveedor |
| `NavActions` | botón de carrito + hamburguesa (van dentro del `<header>`) |
| `MobileMenu` | menú a pantalla completa (va **fuera** del `<header>`) |

Desde cualquier Client Component dentro de `(shop)`:

```tsx
"use client";
import { useShopUI } from "@/app/(shop)/_components/CartDrawer";

const { cart, openCart, closeCart, toast } = useShopUI();
```

- `cart` es el `CartView` de `@/lib/cart` que sirvió el layout: líneas, `count`,
  `subtotalCents`, `shippingCents`, `totalCents`, `freeShippingMissingCents`.
  Es de solo lectura: para cambiarlo, Server Action.
- `toast("mensaje")` — un solo toast a la vez, se va solo a los 2,6 s.
- El cajón se cierra con Escape, con el telón y al navegar.

La página `/carrito` puede pintar el carrito completo leyendo `getCart()` en el
servidor (es otra vista de los mismos datos) y reutilizando `updateCartLine` /
`removeCartLine`. No hace falta tocar el cajón.

---

## 4. Reglas de la casa (te ahorran el P0)

1. **Dinero siempre en centavos enteros** y formateado con `formatCents()`. En estos
   componentes no hay ni un `toFixed`.
2. **Ningún overlay nuevo con `position: fixed` que capture clicks cuando está cerrado.**
   El cajón, el telón, el menú y el toast se apagan con `visibility: hidden` (+
   `pointer-events: none` en el telón), nunca con un `display` que pelee contra
   `[hidden] { display: none !important }`. Comprobado con `document.elementFromPoint`,
   no con capturas.
3. **No se inventan datos de la clienta.** Un producto sin precio dice "Precio por
   confirmar"; el aviso de envío sale de Ajustes.
4. Textos de cara a la usuaria en español con acentos.

## 5. Verificado

- `npx tsc --noEmit` limpio.
- Chrome real headless contra el servidor de desarrollo:
  - con el carrito cerrado, `elementFromPoint` en el centro y en las esquinas
    devuelve el contenido de la página (ningún overlay tapa nada);
  - abrir con el botón del nav, cerrar con Escape y con el telón, `body.overflow`
    se restaura;
  - menú móvil a 390 px: abre, tapa, cierra con Escape y no deja capa muerta;
  - flujo completo con producto real: añadir sin talla avisa y no añade → elegir
    talla y añadir (badge 1, línea, subtotal, envío, "te faltan X para envío
    gratis") → `+` (badge 2) → `−` → eliminar (carrito vacío). Cero errores de
    consola.
  - el marco pétalo alterna: `border-radius` 76,8 px en la impar y 12 px en la par.
