# Sistema de UI del panel (`/admin`)

Documento para quien construya pantallas dentro del panel. El esqueleto
(layout, sesión, navegación, CSS y primitivas) ya está montado: **no hay que
volver a inventarlo, y no hay que tocarlo**.

Ficheros del esqueleto (no editar sin avisar):

| Fichero | Qué es |
|---|---|
| `middleware.ts` | Portero de `/admin/*`: corta las peticiones sin cookie e inyecta `x-pathname` |
| `app/admin/layout.tsx` | Sesión, redirección al login, shell (sidebar + contenido) |
| `app/admin/admin.css` | Todo el sistema visual del panel |
| `app/admin/_components/Sidebar.tsx` | Navegación (escritorio: columna · móvil: barra inferior) |
| `app/admin/_components/ui.tsx` | Primitivas reutilizables |
| `app/admin/login/*`, `app/admin/logout/route.ts` | Entrada y salida |

---

## 1. Regla de oro: cada página comprueba la sesión

```tsx
import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth";

export default async function Page() {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login");
  // ...
}
```

**No es paranoia, está medido.** En Next 15 una página se renderiza aunque su
layout decida no pintar `children`, y el resultado viaja igualmente dentro del
payload RSC de la respuesta. Antes de blindar esto, un `curl` sin sesión a
`/admin` devolvía el HTML del login **con el dashboard entero incrustado**
(ventas, pedidos, correos). Lo único que corta de verdad es `redirect()`, que
aborta el render.

El layout y el middleware ya protegen, pero una pantalla que consulte datos
sensibles añade su propia comprobación. Cuesta una consulta.

Añade también `export const dynamic = "force-dynamic";` en páginas que lean la
base de datos: si no, Next puede cachear la respuesta y enseñar datos viejos.

---

## 2. Estructura de una pantalla

El layout ya pone `<main class="adm-content">`, así que la página devuelve
directamente su contenido, sin envoltorios de página ni `<div className="container">`:

```tsx
import { Button, Card, DataTable, PageHeader } from "../_components/ui";

return (
  <>
    <PageHeader
      title="Productos"
      subtitle="12 productos · 8 en borrador"
      actions={<Button href="/admin/productos/nuevo">Nuevo producto</Button>}
    />

    <Card title="Catálogo" flush>
      <DataTable columns={columnas} rows={productos} />
    </Card>
  </>
);
```

---

## 3. Primitivas (`app/admin/_components/ui.tsx`)

Todas están tipadas y son Server Components válidos (el módulo no lleva
`"use client"`, así que también sirve dentro de un componente cliente).

### `PageHeader({ title, subtitle?, actions? })`
Cabecera de la pantalla. Una por página, siempre la primera.
`actions` es donde van los botones principales.

### `Card({ title?, children, footer?, actions?, flush?, className? })`
Contenedor estándar. `actions` se pinta a la derecha del título (un "ver todo",
un filtro). `flush` quita el padding del cuerpo: úsalo cuando dentro va una
`DataTable`, para que la tabla llegue al borde.

### `Button({ variant?, size?, href?, block?, ...props })`
- `variant`: `primary` (acción principal, burgundy) · `ghost` (secundaria) · `danger` (destructiva)
- `size`: `md` (por defecto) · `sm` (dentro de tablas y cabeceras de tarjeta)
- Con `href` se pinta un `<Link>` con el mismo aspecto; sin él, un `<button>`
  (acepta `type="submit"`, `disabled`, `formAction`, y `onClick` si estás en cliente).
- `block` lo estira al 100 %.

Una sola acción `primary` por pantalla; el resto `ghost`.

### `Badge({ tone?, children })`
`tone`: `neutral` · `success` · `warning` · `danger` · `info`.
Convenios ya usados en el dashboard, mantenlos:

| Dato | Valor | Etiqueta | Tono |
|---|---|---|---|
| `paymentStatus` | `pending` | Por cobrar | `warning` |
| | `paid` | Pagado | `success` |
| | `refunded` | Reembolsado | `info` |
| | `cancelled` | Cancelado | `danger` |
| `fulfillStatus` | `unfulfilled` | Por enviar | `neutral` |
| | `fulfilled` | Enviado | `success` |
| | `cancelled` | Cancelado | `danger` |
| `Product.status` | `draft` | Borrador | `neutral` |
| | `active` | Activo | `success` |
| | `archived` | Archivado | `neutral` |

### `DataTable({ columns, rows, empty?, rowKey?, caption? })`
Tabla que **en móvil colapsa a tarjetas** (una tarjeta por fila, cada celda
como etiqueta/valor). No dupliques DOM ni escribas tu propia tabla.

```tsx
import type { Column } from "../_components/ui";

const columnas: Column<Producto>[] = [
  { key: "titulo", header: "Producto", primary: true, render: (p) => <Link href={`/admin/productos/${p.id}`}>{p.title}</Link> },
  { key: "estado", header: "Estado", render: (p) => <Badge tone="neutral">Borrador</Badge> },
  { key: "creado", header: "Creado", hideOnMobile: true, render: (p) => fecha.format(p.createdAt) },
  { key: "precio", header: "Precio", align: "right", render: (p) => <Money cents={p.priceCents} /> },
];

<DataTable columns={columnas} rows={productos} rowKey={(p) => p.id} empty={<EmptyState title="Sin productos" />} />
```

Campos de `Column<T>`:
- `key` — identificador único de la columna.
- `header` — cabecera. Si no es texto plano, pon `label` para la vista móvil.
- `render(row, index)` — contenido de la celda.
- `primary` — **marca solo una**: es el título de la tarjeta en móvil.
- `align` — `left` (por defecto) · `center` · `right` (el dinero siempre a la derecha).
- `hideOnMobile` — datos secundarios que estorban en una pantalla de teléfono.
- `width` — ancho CSS opcional en escritorio.

`empty` acepta texto o un `<EmptyState/>` entero.

### `EmptyState({ icon?, title, text?, action? })`
Para cuando no hay nada. **Siempre di qué hacer a continuación**, con un
`action` que lleve ahí. `icon` es un `<svg>` de 24×24 con `stroke="currentColor"`.

### `Field({ label, children, hint?, error?, htmlFor?, required? })`
Envoltorio de campo de formulario. El `<input>`/`<select>`/`<textarea>` va como
`children` y hereda los estilos del panel automáticamente; no le pongas clase.

```tsx
<Field label="Título" htmlFor="titulo" required error={errores.titulo}>
  <input id="titulo" name="titulo" defaultValue={producto.title} />
</Field>
```

### `Money({ cents, tone? })`
**La única forma de pintar dinero.** Usa `formatCents()` por dentro. `tone`:
`muted` o `strong`. Nunca dividas entre 100 a mano ni concatenes `"$"`.

### `StatCard({ label, value, hint?, tone? })`
Métrica grande. `tone`: `default` · `accent` · `success` · `warning` · `danger`.
Van dentro de `<div className="adm-grid">`.

---

## 4. Clases CSS disponibles

Si necesitas algo que no existe, **crea tu propio `.css` junto a tu página y
impórtalo desde tu componente**. No edites `admin.css` (lo comparten cuatro
pantallas) ni `app/globals.css` (es el escaparate).

| Clase | Para qué |
|---|---|
| `adm-grid` | Rejilla auto-ajustable para `StatCard` |
| `adm-cols-2` | Dos columnas que se apilan en móvil (formulario + panel lateral) |
| `adm-row` | Fila flexible con `gap`, se envuelve sola |
| `adm-alerts` / `adm-alert` / `adm-alert-text` / `adm-alert-cta` | Lista de avisos accionables |
| `adm-link` | Enlace en burgundy con subrayado suave |
| `adm-muted`, `adm-small` | Texto secundario / pequeño |
| `adm-thumb` | Miniatura cuadrada de 40 px para tablas |
| `adm-field`, `adm-field-lbl`, `adm-field-hint`, `adm-field-err` | Formularios (los pone `Field`) |
| `adm-btn adm-btn-primary\|ghost\|danger adm-btn-sm\|md` | Aspecto de botón para un `<button>` suelto |

Tokens (definidos en `:root` dentro de `admin.css`): `--adm-ink*` (sidebar),
`--adm-canvas`, `--adm-surface`, `--adm-line`, `--adm-text`, `--adm-muted`,
`--adm-accent` (#77303E), `--adm-success|warning|danger|info`, `--adm-r`,
`--adm-r-sm`, `--adm-r-lg`. Usa estos, no colores a pelo.

Reglas visuales del panel:
- Radios de 8–14 px. **Nada de `--petal*`**: los marcos asimétricos del
  escaparate se comen el contenido de una tabla densa.
- Tipografía Jost (`var(--sans)`) para todo; el serif solo en títulos de
  `EmptyState`.
- El burgundy es color de **acción**, no de decoración.
- Blanco puro prohibido, también aquí: la superficie es `--adm-surface` (#FCF8F0).

---

## 5. Móvil

Madeline despacha pedidos desde el teléfono, así que **cada pantalla se prueba a
375 px de ancho**:
- Por debajo de 900 px el sidebar baja a barra inferior (Panel · Pedidos ·
  Productos · Importar, más una hoja "Más"). El contenido ya reserva el hueco.
- Por debajo de 760 px las `DataTable` se convierten en tarjetas.
- Botones a un dedo: los tamaños de `Button` ya cumplen; no bajes de `sm`.

---

## 6. Enlaces y filtros que el dashboard ya usa

El panel enlaza a estas URLs desde los avisos. Quien construya esas pantallas
debería reconocer estos parámetros (y si decide otros, avisar para cambiarlos):

| URL | Qué debe mostrar |
|---|---|
| `/admin/productos?aviso=sin-precio` | Productos no archivados con `priceCents <= 0` |
| `/admin/productos?aviso=sin-stock` | Productos con variantes `trackStock=true` y `stock <= 0` |
| `/admin/productos?estado=draft` | Filtro por `Product.status` (`draft` \| `active` \| `archived`) |
| `/admin/pedidos?estado=pendiente` | `paymentStatus = "pending"` |
| `/admin/pedidos?estado=por-enviar` | `paymentStatus = "paid"` y `fulfillStatus = "unfulfilled"` |
| `/admin/pedidos/[id]` | Ficha del pedido (el dashboard enlaza por **id**, no por número) |
| `/admin/productos/nuevo`, `/admin/importar` | Acciones de la cabecera del dashboard |

Recuerda: en Next 15 `searchParams` es una **promesa**, hay que `await`.

---

## 7. Sesión, login y logout

- El login vive en `/admin/login` y usa el Server Action `loginAction` de
  `app/admin/login/actions.ts`. Se entra con **usuario**, no con correo (el
  correo se queda como contacto y para la bitácora). Mensaje de error único
  ("Usuario o contraseña incorrectos") para no revelar cuál de los dos falló, y
  freno tras 8 intentos.
- El usuario se compara sin distinguir mayúsculas y se guarda tal cual se
  escribió (`lib/usuario.ts`, probado en `tests/usuario.test.ts`).
- La cuenta se crea sola en el primer arranque con `ensureSeedAdmin()`
  (`ADMIN_USERNAME` / `ADMIN_PASSWORD` del `.env`), y `ensureUsernames()` le
  pone usuario a las cuentas que venían de la época del correo.
- Salir es `POST /admin/logout` (nunca GET: una precarga del navegador cerraría
  la sesión sola). Ya está en el sidebar; no hace falta repetirlo.
- `middleware.ts` inyecta `x-pathname` porque un layout de Next 15 no sabe en
  qué ruta está. Si algún día hace falta otro middleware, **amplía el existente**
  en vez de crear otro: solo puede haber uno por proyecto.
