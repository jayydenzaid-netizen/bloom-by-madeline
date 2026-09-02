# Bloom by Madeline en Shopify

Todo lo necesario para que la tienda viva en Shopify con el diseño de siempre, y
para importar productos de AliExpress y Alibaba directamente al catálogo.

Está montado sobre lo que ya existía: los parsers de proveedor de `lib/importers/`
y el CSS de la web actual se **reutilizan**, no se reescriben.

---

## Lo que hay aquí

```
shopify/
  verificar.ts          diagnóstico: credenciales, permisos, prueba real de escritura
  importar.ts           una URL de AliExpress/Alibaba → producto en Shopify
  puente.ts             servidor local + marcador para importar de un clic
  migrar-catalogo.ts    el catálogo actual → Shopify, con las 301 para no perder SEO
  construir-tema.mjs    ensambla el tema (CSS portado + fotos) y lo empaqueta en .zip
  validar-tema.mjs      comprueba el tema antes de subirlo
  vista-previa.mjs      prueba visual de la hoja de estilo con Chrome real
  tema/                 el tema de Shopify con el diseño de Bloom
  lib/                  cliente del Admin API, mapeo y detección de capacidades
```

Comandos (`npm run …`):

| Comando | Qué hace |
|---|---|
| `shopify:verificar` | Comprueba que todo está bien conectado. **Ejecútalo primero.** |
| `shopify:prueba` | Igual, pero además crea y borra un producto de verdad. |
| `tema:construir` | Genera `tema/assets/bloom.css` y copia las fotos. |
| `tema:validar` | Busca referencias rotas, JSON inválido y etiquetas sin cerrar. |
| `tema:zip` | Deja `shopify/tema-bloom.zip` listo para subir. |
| `tema:vista` | Captura el muestrario visual con Chrome. |
| `shopify:migrar` | **Simula** la mudanza del catálogo. No escribe nada. |
| `shopify:migrar:real` | La hace de verdad. |
| `shopify:puente` | Levanta el puente del marcador para importar. |
| `shopify:importar` | Importa una pieza desde una URL. |

---

## Paso 0 · Lo único que tienes que hacer tú en Shopify

Yo no puedo entrar en tu panel ni crear la aplicación: hace falta tu sesión. Son
cinco minutos y solo se hace una vez.

1. Entra en tu panel de Shopify.
2. **Configuración** (abajo a la izquierda) → **Aplicaciones y canales de venta**.
3. Arriba a la derecha: **Desarrollar aplicaciones** → **Permitir el desarrollo de aplicaciones** (solo la primera vez) → **Crear una aplicación**.
4. Nómbrala `Puente Bloom` y créala.
5. Pestaña **Configuración de Admin API** → **Configurar** y marca:

   | Permiso | Para qué |
   |---|---|
   | `write_products`, `read_products` | crear e importar piezas — **imprescindibles** |
   | `write_publications`, `read_publications` | ponerlas a la venta en la tienda online |
   | `write_inventory`, `read_locations` | marcarlas «sin seguimiento de stock» (dropshipping) |
   | `write_content` | traer las páginas (Devoluciones, Envíos…) |
   | `write_discounts` | traer los códigos de descuento |
   | `read_orders` | informes |

6. **Guardar** → pestaña **Credenciales de API** → **Instalar aplicación**.
7. Copia el **token de acceso de Admin API**. Empieza por `shpat_` y **solo se
   enseña una vez**.

Luego abre el fichero `.env` del proyecto y añade estas dos líneas:

```
SHOPIFY_STORE="tu-tienda.myshopify.com"
SHOPIFY_ADMIN_TOKEN="shpat_lo-que-copiaste"
```

> `SHOPIFY_STORE` es el dominio **interno**, el que acaba en `.myshopify.com`.
> Sale en la barra del navegador cuando estás dentro del panel
> (`admin.shopify.com/store/**tu-tienda**`). Un dominio propio no sirve para la API.

Y comprueba que todo está bien:

```bash
npm run shopify:verificar
```

Si algo falla, el propio comando dice qué tocar. Cuando salga limpio:

```bash
npm run shopify:prueba
```

Eso crea un producto de mentira, comprueba que se puede escribir, y lo borra.

> ⚠️ Si más adelante cambias los permisos de la aplicación, hay que **reinstalarla**
> y el **token cambia**. Habrá que volver a pegarlo en el `.env`.

---

## Paso 1 · Subir el tema

El tema reproduce el diseño de la web actual: las mismas tipografías (Cormorant
Garamond, Jost, Allura), la misma paleta champán/tinta/burdeos, los marcos
«pétalo», el loto de la marca y las ocho secciones de la portada.

```bash
npm run tema:construir
npm run tema:validar
npm run tema:zip
```

Y en el panel: **Tienda online → Temas → Añadir tema → Subir archivo ZIP** →
`shopify/tema-bloom.zip`.

Súbelo pero **no lo publiques todavía**: dale a **Vista previa** y míralo primero.
Cuando te convenza, **Publicar**.

Lo que Madeline puede cambiar sin tocar código, desde **Personalizar**:

- los textos y fotos de las ocho secciones de la portada;
- el orden de las secciones, y apagar las que no quiera;
- la dirección, el horario, el usuario de Instagram y el enlace al DM
  (**Configuración del tema → El negocio**) — se escriben una vez y cambian en el
  pie, el menú del móvil y la sección «Visítanos» a la vez;
- el umbral de envío gratis, que mueve la barra del carrito.

En los titulares, lo que se escriba entre `*asteriscos*` sale en la cursiva
elegante de la marca, y cada salto de línea es un renglón.

### Después de publicar el tema

1. **Tienda online → Navegación**: crea el menú principal (Tienda, Colecciones,
   La boutique, Visítanos) y el del pie.
2. **Personalizar → Cabecera**: pega el enlace del DM de Instagram.
3. **Personalizar → Colección destacada**: elige qué colección sale en la portada.

---

## Paso 2 · Traer el catálogo de la web actual

**Primero en seco, que no escribe nada:**

```bash
npm run shopify:migrar
```

Lee el resumen. Cuando cuadre:

```bash
npm run shopify:migrar:real
```

Trae, por este orden: colecciones → productos (con variantes, fotos y coste) →
páginas → descuentos → **redirecciones 301** → reseñas (a un CSV).

### Las 301 no son opcional

La web actual lleva meses en producción y sus enlaces están compartidos en
Instagram e indexados en Google. La migración crea una redirección por cada
dirección vieja:

```
/producto/vestido-amapola   →  /products/vestido-amapola
/coleccion/nuevas-llegadas  →  /collections/nuevas-llegadas
/pagina/devoluciones        →  /pages/devoluciones
/tienda                     →  /collections/all
```

Sin ellas, el día que se apague el sitio viejo cada enlace compartido se convierte
en un 404: se pierde el posicionamiento y, peor, la clienta que pincha se queda
sin nada.

### Dos cosas a tener en cuenta

- **Las fotos.** Las que viven en `/public` se le sirven a Shopify desde
  `https://bloom-by-madeline.vercel.app` para que las descargue. **No apagues el
  sitio actual hasta comprobar que las fotos están ya en Shopify.**
- **La base de datos.** La migración lee de `DATABASE_URL`. El script imprime de
  cuál está leyendo antes de empezar — mira que sea la que quieres (la de
  producción tiene el catálogo real).

Opciones útiles:

```bash
npm run shopify:migrar -- --con-borradores          # también los borradores
npm run shopify:migrar -- --solo productos,redirecciones
```

---

## Paso 3 · Importar de AliExpress y Alibaba

### El marcador (la vía fiable)

AliExpress y Alibaba bloquean a los scripts: detectan que quien pide la página no
es un navegador con sesión y devuelven un captcha o una ficha vacía. El marcador
lo esquiva porque **no descarga nada**: se ejecuta dentro de la pestaña que ya
tienes abierta, donde la ficha ya está cargada.

```bash
npm run shopify:puente
```

Abre <http://localhost:4595> y **arrastra** el botón «✿ Traer a Bloom» a tu barra
de marcadores. A partir de ahí:

1. abre la ficha del producto en AliExpress o Alibaba;
2. espera a que cargue del todo (que se vean fotos y precio);
3. pulsa el marcador;
4. se abre una pestaña con el resultado y el enlace al panel de Shopify.

### Por URL

Cuando el proveedor no bloquee:

```bash
npm run shopify:importar -- "https://es.aliexpress.com/item/1005006XXXXXXX.html"
npm run shopify:importar -- "https://www.alibaba.com/product-detail/..." --margen 3
npm run shopify:importar -- "<url>" --coleccion nuevas-llegadas
```

Opciones: `--margen 2.6` · `--redondeo 99|95|whole|none` · `--coleccion <slug>` ·
`--publicar` · `--forzar`.

### Lo que hace por ti

- **Todo entra como borrador.** Una pieza recién traída de AliExpress tiene el
  título en inglés de máquina, fotos con marca de agua y un precio sin margen.
  Nadie la ve hasta que la revisas.
- **Precio calculado**: ×2,6 sobre el coste + $5, terminado en `.99` (se cambia
  con `--margen`). El coste real se guarda en el campo nativo de Shopify, así que
  el margen sale en sus informes sin cuentas aparte.
- **Sin seguimiento de inventario**: en dropshipping el stock lo tiene el
  proveedor. Si Shopify lo siguiera, todo nacería en 0 y la tienda diría
  «Agotado» en cada pieza.
- **No se duplica**: si esa ficha ya se importó, avisa en vez de crear una segunda.
- **Alibaba es B2B**: tiene escalera de precios por cantidad y pedido mínimo. Se
  usa el coste del primer tramo (el único que una boutique pequeña puede comprar
  de verdad) y la escalera entera queda en la descripción, con el MOQ como aviso.

---

## Paso 4 · La app para pedir al proveedor

El importador de aquí trae la ficha, pero **no puede hacerle el pedido al
proveedor** cuando una clienta compra. Eso, en dropshipping, es la mitad del
trabajo: por cada venta hay que ir a AliExpress, pedir la pieza con la dirección
de la clienta y pegar el número de seguimiento en Shopify.

Para eso sí hace falta una app del ecosistema. En **Aplicaciones → Shopify App
Store**:

- **DSers** — es el socio oficial de dropshipping de AliExpress. Pide en lote y
  sincroniza el seguimiento solo. Tiene plan gratuito.
- **Zendrop** o **CJdropshipping** — alternativas con almacén en EE. UU., que es
  lo que baja los plazos de entrega de semanas a días.
- **Alibaba.com for Shopify** — la app oficial de Alibaba, para el lado B2B.

Los planes y precios cambian; míralos en la ficha de cada app antes de instalar.
Instálala tú desde el panel: instalar una app es aceptar sus permisos sobre la
tienda y esa decisión es tuya.

> Las dos vías conviven sin pisarse: importa con el marcador cuando quieras
> control fino sobre la ficha, y deja que la app se encargue de los pedidos.

---

## Antes de abrir la tienda

Nada de esto lo puede hacer un script — todo pide tu cuenta:

- [ ] **Pagos**: Configuración → Pagos → activar Shopify Payments (o PayPal).
      Sin esto no se cobra nada.
- [ ] **Envíos**: Configuración → Envíos y entregas. El umbral de envío gratis
      que pongas aquí tiene que coincidir con el del tema, o la barra del carrito
      promete algo que el checkout no cumple.
- [ ] **Impuestos**: Configuración → Impuestos y aranceles (Ohio).
- [ ] **Políticas**: Configuración → Políticas. Shopify las enlaza solo en el
      checkout, y sin ellas Shopify Payments puede no aprobarse.
- [ ] **Dominio**: Configuración → Dominios.
- [ ] **Correos**: Configuración → Notificaciones, con el logo de Bloom.
- [ ] **Quitar la contraseña de la tienda**: Tienda online → Preferencias.

### ⚠️ El plazo de entrega

El tema trae puesto «los pedidos salen de la boutique en 1–2 días hábiles», que
es verdad para lo que hay en la tienda física. Para una pieza traída de
AliExpress **no lo es**: son de dos a cuatro semanas.

Prometer dos días y tardar tres semanas es la primera causa de devoluciones y de
reclamaciones al banco. Antes de vender la primera pieza importada, cambia el
aviso en **Personalizar → Configuración del tema → Envíos**, o separa las piezas
importadas en su propia colección con su propio plazo.

---

## Qué está comprobado y qué no

**Comprobado:**

- Los scripts compilan sin errores de tipos (`npm run typecheck`).
- El tema pasa el validador: 35 ficheros Liquid, sin referencias rotas, sin JSON
  inválido, sin etiquetas sin cerrar, sin traducciones que falten.
- La hoja de estilo del tema está entera y las tres tipografías cargan
  (`npm run tema:vista` — hay capturas en `shopify/vista-previa/`).

**Sin comprobar, porque hace falta la tienda de verdad:**

- Que el Liquid produzca el HTML esperado. Eso solo lo dice Shopify renderizando
  el tema, y para eso hay que subirlo.
- Que el token, los permisos y las mutaciones funcionen contra tu tienda. Eso lo
  dice `npm run shopify:prueba` en cuanto pegues las credenciales.

El cliente del API detecta sola la versión del Admin API y se adapta a lo que esa
versión soporte, así que no depende de que Shopify no cambie nada.
