# CONTRATO TÉCNICO — Bloom by Madeline v2 (plataforma e-commerce)

Documento de referencia obligatorio. Todo el que toque este repo lo lee primero.

## Qué estamos construyendo

El sitio era un one-page estático de captación (sigue en `legacy/`, y en producción
hasta que despleguemos). Lo convertimos en una **tienda tipo Shopify**: catálogo real
en base de datos, carrito, checkout, panel de administración y un **importador de
productos de AliExpress y Alibaba** (dropshipping).

Cliente real: Madeline, boutique de moda femenina en 1305 Grand Blvd, Hamilton, OH.
Vende hoy por DM de Instagram (@bloombymadelin). Jue–Sáb 1–8 PM.

## Stack

- **Next.js 15** App Router + **React 19** + **TypeScript strict**
- **Prisma 6** + SQLite en dev (`prisma/dev.db`). El esquema evita enums y arrays
  nativos a propósito para poder migrar a Postgres sin reescribirlo.
- **Sin Tailwind, sin librerías de UI.** CSS propio. La identidad visual del sitio
  está en `app/globals.css` (copia literal del CSS pulido durante meses) y **no se toca**.
- Puerto de desarrollo: **4590**. Arranque: `npm run dev`.

## Reglas irrenunciables

1. **El dinero va en centavos enteros (`Int`).** Nunca floats. Formatear solo con
   `formatCents()` de `lib/money.ts`. Parsear solo con `parseToCents()`.
2. **No inventar precios ni datos de la clienta.** Los 12 productos actuales no tienen
   precio conocido: se siembran como borrador con precio 0 y hay que marcarlo en el admin.
   Nada de teléfonos, reseñas ni testimonios inventados.
3. **No romper la identidad visual.** Paleta champán `--bone: #ECE1CD` (Gregory pidió
   CERO blanco), acento burgundy `--clay: #77303E`, tipos Cormorant Garamond + Jost +
   Allura, marcos "pétalo" (`--petal*`, esquinas opuestas redondeadas, alternando
   dirección con `:nth-child(even)`). Todos los tokens ya existen en `globals.css`.
4. **`[hidden] { display: none !important }` es sagrado.** Una regla de autor que anule
   `[hidden]` ya causó un P0 en producción: una capa invisible cubría el viewport y
   NADA era clickeable. Ver `legacy/styles.css`.
5. **Verificar con clicks reales, no con capturas.** `document.elementFromPoint` antes de
   cantar victoria. El bug anterior sobrevivió a decenas de screenshots.
6. Comentarios y textos de cara al usuario **en español**. Los comentarios explican el
   *porqué*, no repiten el código.
7. **No tocar `legacy/`** — es el punto de retorno.

## Ficheros ya construidos (NO reescribir, solo usar)

| Fichero | Qué expone |
|---|---|
| `prisma/schema.prisma` | Modelos: Product, ProductImage, ProductVariant, Collection, CollectionProduct, Cart, CartItem, Customer, Order, OrderItem, ImportJob, Setting, AdminUser, Session |
| `lib/db.ts` | `db` — cliente Prisma singleton |
| `lib/money.ts` | `formatCents`, `parseToCents`, `applyPricing`, `margin`, `DEFAULT_PRICING`, tipo `PricingRule` |
| `lib/slug.ts` | `slugify`, `uniqueProductSlug`, `uniqueCollectionSlug` |
| `lib/settings.ts` | `getSettings`, `saveSettings`, tipo `StoreSettings`, `DEFAULT_SETTINGS` |
| `lib/auth.ts` | `hashPassword`, `verifyPassword`, `createSession`, `destroySession`, `getAdmin`, `ensureSeedAdmin`, `SESSION_COOKIE` |
| `lib/cart.ts` | `getOrCreateCart`, `getCart`, `readCartToken`, `getCartCount`, tipos `CartView`/`CartLine`, `CART_COOKIE` |
| `lib/importers/types.ts` | `NormalizedProduct`, `NormalizedVariant`, `NormalizedImage`, `ProviderAdapter`, `ImportResult`, `ProviderId`, `ImportMethod`, `emptyProduct` |
| `app/layout.tsx` | Layout raíz con fuentes, metadata y OG |
| `app/globals.css` | Sistema visual completo del storefront |

Alias de imports: `@/lib/...`, `@/app/...` (configurado en `tsconfig.json`).

## Convenciones de datos

- `Product.status`: `draft` | `active` | `archived`. El storefront **solo** muestra `active`.
- `Product.tagsJson` y `Product.optionNamesJson` son **strings con JSON dentro**.
  Leer con `JSON.parse`, escribir con `JSON.stringify`. Nunca guardar el array directo.
- `Order.paymentStatus`: `pending` | `paid` | `refunded` | `cancelled`.
- `Order.fulfillStatus`: `unfulfilled` | `fulfilled` | `cancelled`.
- `Order.paymentMethod`: `stripe` | `dm` | `pickup` | `cash`.
- `Order.number`: formato `BLM-1001`, correlativo.
- `ProductVariant.trackStock = false` significa "vender sin control de stock" — es el
  caso normal en dropshipping, donde el inventario lo tiene el proveedor.
- `OrderItem` guarda copia congelada de título/precio/imagen: un pedido viejo debe seguir
  siendo legible aunque el producto cambie o se borre.

## Rutas

### Storefront
- `/` — portada (el diseño editorial actual, ahora alimentado por la BD)
- `/tienda` — catálogo con filtros (colección, talla, color, precio), orden y búsqueda
- `/producto/[slug]` — ficha con galería, selector de variantes, stock, añadir al carrito
- `/coleccion/[slug]` — productos de una colección
- `/carrito` — carrito completo
- `/checkout` — datos de envío y método de pago
- `/pedido/[number]` — confirmación y seguimiento

### Admin (todo bajo sesión)
- `/admin/login`
- `/admin` — dashboard
- `/admin/productos`, `/admin/productos/[id]`, `/admin/productos/nuevo`
- `/admin/colecciones`
- `/admin/pedidos`, `/admin/pedidos/[id]`
- `/admin/clientes`
- `/admin/importar` — el importador
- `/admin/ajustes`

## El importador — arquitectura de 4 vías

Ni AliExpress ni Alibaba tienen API pública sin aprobación, y ambos bloquean peticiones
desde IPs de datacenter (Vercel es exactamente eso). Por eso el importador **no depende de
una sola vía**, sino de cuatro en cascada, de más cómoda a más fiable:

1. **API oficial** (`method: "api"`) — si hay credenciales en el entorno
   (`ALIEXPRESS_APP_KEY` / `ALIEXPRESS_APP_SECRET`, `ALIBABA_APP_KEY` / `ALIBABA_APP_SECRET`).
   Firma HMAC-SHA256 estilo TOP. Es la vía limpia cuando existan las llaves.
2. **Fetch por URL** (`method: "url"`) — se baja el HTML con cabeceras de navegador real
   y se parsea el JSON embebido. Funciona a veces; hay que **detectar el bloqueo y decirlo
   con claridad**, no fallar en silencio.
3. **HTML pegado** (`method: "html"`) — la usuaria abre el producto en su navegador, copia
   el HTML y lo pega. Nunca falla por anti-bot. Es la red de seguridad universal.
4. **Bookmarklet** (`method: "bookmarklet"`) — un marcador que la usuaria arrastra a su
   barra. Estando en la ficha del proveedor, un clic extrae el JSON desde la propia página
   (su sesión, su IP, sin bloqueo) y lo manda a `/api/import/ingest`. Es lo que hacen DSers
   y AutoDS con su extensión de Chrome, sin necesitar publicar una extensión.

Todas las vías desembocan en el mismo `NormalizedProduct`, se guardan como `ImportJob`
con `status: "ready"`, y la usuaria revisa y edita antes de publicar. **Nunca se publica
nada automáticamente sin revisión.**

### Dónde vive cada dato en AliExpress

El HTML de una ficha lleva el estado en `window._d_c_.DCData` y/o `window.runParams`
(`data.` con `skuModule`, `priceModule`, `imageModule`, `titleModule`, `specsModule`).
El parser debe tolerar que falten: probar varias formas y acumular `warnings[]` en vez
de reventar. Si no se reconoce nada, devolver `{ ok: false, error, hint }` con una pista
accionable ("pega el HTML de la ficha" / "usa el bookmarklet").

### Precios

El coste del proveedor pasa por `applyPricing(costCents, settings.pricing)` para dar el
precio de venta. La regla por defecto es ×2.6 + $5.00 redondeado a `.99`, y es editable
en Ajustes. En la vista previa de importación hay que enseñar **coste, precio y margen**
lado a lado para que Madeline decida con datos.

## Verificación — cómo se comprueba que algo funciona

- `npx tsc --noEmit` sin errores.
- `npm run build` verde.
- Chrome real headless por CLI para lo visual, **no** el Browser pane (en esta máquina
  el pane congela el renderer y miente: dice que un elemento sigue oculto cuando ya se
  mostró). Perfil limpio, sin `--user-data-dir` persistente, o sirve CSS de caché.
- Hit-testing con `document.elementFromPoint(x, y)` para probar que se puede hacer clic.
- Comprobar el HTTP del servidor antes de capturar: una captura de la página de error de
  Chrome parece "fondo oscuro vacío" y se confunde con un fallo de diseño.
