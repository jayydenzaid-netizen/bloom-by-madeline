# Bloom by Madeline

Tienda online de **Bloom by Madeline**, boutique de moda femenina en 1305 Grand Blvd,
Hamilton, Ohio. Instagram [@bloombymadelin](https://www.instagram.com/bloombymadelin/).
Abre de jueves a sábado, de 1 a 8 de la tarde.

Empezó siendo una página de captación estática y ahora es una plataforma de comercio
completa: catálogo, carrito, checkout, panel de administración e importador de productos
de proveedores.

## Poner en marcha

```bash
npm install
npx prisma db push
npm run db:seed
npm run dev
```

Tienda en http://localhost:4590 · Panel en http://localhost:4590/admin

Las credenciales iniciales del panel salen de `ADMIN_EMAIL` y `ADMIN_PASSWORD` del `.env`
y solo se usan para crear la cuenta la primera vez. Copia `.env.example` a `.env` para
empezar.

## Cómo está montado

| Carpeta | Qué hay |
|---|---|
| `app/(shop)/` | La tienda: portada, catálogo, ficha de producto, carrito, checkout, pedidos |
| `app/admin/` | El panel de administración |
| `lib/` | Lógica de negocio: dinero, carrito, pedidos, inventario, descuentos, envíos |
| `lib/importers/` | Importador de proveedores (AliExpress, Alibaba, CSV) |
| `prisma/` | Modelo de datos y semilla |
| `qa/` | Auditoría automática con Chrome real |
| `legacy/` | La página original estática, intacta, como punto de retorno |

Next.js 15 con App Router, React 19, Prisma sobre SQLite en desarrollo. Sin Tailwind y sin
librerías de interfaz: el CSS es propio y viene del diseño editorial original, que se
conserva entero en `app/globals.css`.

**El dinero se guarda siempre en centavos enteros.** Formatear solo con `formatCents()`.

## El importador de proveedores

Ni AliExpress ni Alibaba tienen una API abierta que se pueda llamar sin aprobación previa,
y las dos bloquean las peticiones que vienen de servidores. Por eso el importador no
depende de una sola vía sino de cuatro, y la interfaz dice cuál es cuál en vez de fallar
en silencio:

1. **API oficial** — la más cómoda, si algún día hay credenciales aprobadas.
2. **Por URL** — se pega el enlace del producto. Funciona a menudo, pero el proveedor
   puede bloquearla.
3. **HTML pegado** — se copia el código de la ficha desde el navegador. No falla nunca.
4. **Bookmarklet** — un marcador en la barra del navegador que captura el producto desde
   la propia página del proveedor. Es lo que hacen las herramientas profesionales de
   dropshipping con su extensión de Chrome, y es la vía fiable.

Todas terminan en la misma vista previa, donde se ven **coste, precio de venta y margen**
antes de publicar nada. Ningún producto se publica sin revisión.

## Verificar que funciona

```bash
npm run typecheck
npm test
node qa/audit.mjs --shots
```

`qa/audit.mjs` recorre la tienda y el panel con el Chrome del sistema y comprueba, además
del HTTP y el contenido, que **se puede hacer clic de verdad** en cada página.

Esto último no es una manía: en producción hubo un fallo en el que una capa invisible
tapaba toda la pantalla y ningún botón funcionaba. Sobrevivió a decenas de capturas de
pantalla, porque una captura no sabe si algo responde al ratón.

## Qué falta y depende de Madeline

- Los 12 productos actuales están **en borrador y sin precio**: no los conocemos y no se
  inventan. Ella les pone precio y los activa.
- Teléfono y email de contacto verificados.
- Reseñas reales (las tiene en un destacado de Instagram) para pasarlas al panel.
- Cuenta de Stripe si quiere cobrar con tarjeta. Mientras no exista, el checkout ofrece
  pedido por mensaje directo y recogida en la boutique, y no simula ningún cobro.
- El tipo de impuesto sobre ventas aplicable, confirmado con su contable.
- Dominio propio.
