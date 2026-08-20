# AliExpress — anatomía real de una ficha y decisiones del adaptador

Notas de trabajo de `lib/importers/aliexpress.ts`. Todo lo que hay aquí es lo que condiciona
el parser: si AliExpress cambia algo, este documento es el primer sitio donde mirar.

---

## 1. Dónde vive el estado dentro del HTML

La ficha de producto se pinta en el cliente. El servidor manda el estado completo dentro de
un `<script>` y React lo hidrata. El nombre de esa variable ha cambiado varias veces, así que
el parser prueba **en cascada** y se queda con el primero que dé datos útiles:

| Orden | Dónde | Notas |
|---|---|---|
| 1 | `window.runParams = {…}` | La forma clásica y la más completa. Los módulos cuelgan de la clave `data`. |
| 1b | `window.runParams.data = {…}` | Variante antigua: aquí el objeto **ya es** `data`. |
| 2 | `window._d_c_.DCData = {…}` | Versión "detail component" de la ficha nueva. Mismos módulos. |
| 3 | `window.__INIT_DATA__` / `__STORE_DATA__` / `<script id="__NEXT_DATA__">` | Páginas migradas a Next. Los módulos suelen colgar de `props.pageProps`. |
| 4 | `<script type="application/ld+json">` con `@type: "Product"` | Solo título, imágenes, descripción y rango de precio. **Sin variantes.** |
| 5 | `<meta property="og:*">` | Último recurso: título, una foto y a veces `og:price:amount`. |

### Gotcha importante: hay VARIOS `window.runParams` en la misma página

Una ficha real trae tres o cuatro asignaciones a `window.runParams` (cabecera, recomendados,
reseñas, ficha). Quedarse con la primera devuelve basura. Por eso el parser **recoge todas**,
puntúa cada candidata por cuántos módulos reconocibles contiene (`skuPriceList` y
`productSKUPropertyList` valen doble) y usa la de mayor puntuación.

### Gotcha: el estado es JS, no JSON estricto

Se recorta contando llaves **respetando las comillas** (las descripciones traen `{` y `}` dentro)
y se intenta `JSON.parse`. Si falla, hay una segunda pasada de reparación (comas colgando,
`undefined`, claves sin comillas). Nunca se usa `eval` ni `new Function`: el HTML lo pega la
usuaria y podría venir de cualquier sitio.

---

## 2. Mapa de módulos (cuando existe `runParams.data`)

```jsonc
{
  "actionModule":      { "productId": 1005006543210987 },
  "titleModule":       { "subject": "Vestido midi satinado de manga larga" },
  "imageModule":       { "imagePathList": ["//ae01.alicdn.com/kf/S1a.jpg_640x640q90.jpg", "…"] },
  "priceModule": {
    "formatedPrice":         "US $15.99 - US $22.50",   // precio de lista
    "formatedActivityPrice": "US $12.34 - US $18.90",   // precio con promoción
    "minAmount":         { "value": 15.99, "currency": "USD", "formatedAmount": "US $15.99" },
    "maxAmount":         { "value": 22.50, "currency": "USD" },
    "minActivityAmount": { "value": 12.34, "currency": "USD" },
    "maxActivityAmount": { "value": 18.90, "currency": "USD" }
  },
  "skuModule":         { "productSKUPropertyList": [...], "skuPriceList": [...] },
  "specsModule":       { "props": [{ "attrName": "Material", "attrValue": "Poliéster" }] },
  "descriptionModule": { "descriptionUrl": "https://aeproductsourcesite.alicdn.com/…/desc.htm" },
  "storeModule":       { "storeName": "Chic Fashion Store" }
}
```

En la generación nueva los mismos módulos se llaman `productInfoComponent`, `priceComponent`,
`skuComponent`, `imageComponent`. El parser busca los dos juegos de nombres y, si tampoco están,
hace una **búsqueda en anchura por nombre de clave** (`skuPriceList`, `imagePathList`, `subject`…),
así da igual a qué profundidad los hayan movido.

---

## 3. Lo difícil: emparejar variantes con sus opciones

Son dos listas separadas y hay que cruzarlas.

**`productSKUPropertyList`** — las OPCIONES y sus valores posibles:

```jsonc
[
  { "skuPropertyId": 14, "skuPropertyName": "Color", "skuPropertyValues": [
      { "propertyValueId": 350852, "propertyValueName": "Red",
        "propertyValueDisplayName": "Rojo",                       // ← el traducido, se prefiere
        "skuPropertyImagePath": "//ae01.alicdn.com/kf/Sred.jpg_220x220.jpg" },
      { "propertyValueId": 350850, "propertyValueName": "Black", "propertyValueDisplayName": "Negro" } ] },
  { "skuPropertyId": 5, "skuPropertyName": "Size", "skuPropertyValues": [
      { "propertyValueId": 361386, "propertyValueName": "S" },
      { "propertyValueId": 361387, "propertyValueName": "M" } ] }
]
```

**`skuPriceList`** — las VARIANTES vendibles, que solo traen ids:

```jsonc
[
  { "skuId": "12000037181001",
    "skuAttr":    "14:350852#Red;5:361386",   // propiedadId:valorId#nombreVisible
    "skuPropIds": "350852,361386",            // ← la clave del emparejamiento
    "skuVal": {
      "skuAmount":         { "value": 15.99, "currency": "USD" },  // precio de lista
      "skuActivityAmount": { "value": 12.34, "currency": "USD" },  // ← lo que se paga
      "skuCalPrice": "12.34",
      "availQuantity": 120 } }
]
```

**Cómo lo cruza el parser:** construye un índice `propertyValueId → { índice de opción, etiqueta, imagen }`
recorriendo `productSKUPropertyList`, y después, para cada sku, parte `skuPropIds` por comas y
coloca cada etiqueta en la posición de su opción. De ahí sale `"Rojo / S"` con
`optionValues: ["Rojo", "S"]` alineado con `optionNames: ["Color", "Talla"]`.

- **Plan B:** si no hay `skuPropIds` (o ningún id casa), se parte `skuAttr` por `;` y se usa el
  `#nombreVisible` de cada segmento, asignando por orden de segmento. Se anota un warning porque
  ese orden puede no coincidir con el de las opciones.
- **Plan C:** si tampoco hay nada, se genera **una sola variante** con el precio mínimo de la
  ficha y un warning explicando que hay que revisar tallas y colores a mano. Nunca se descarta
  el producto por esto.

### Precio de la variante

Prioridad: `skuActivityAmount` → `skuAmount` → `actSkuCalPrice` → `skuCalPrice`. Se usa el
promocional porque es lo que se paga de verdad al proveedor, y de ahí sale el margen real.

`costCents` = precio del proveedor. **`priceCents` se deja en `null` a propósito**: el precio de
venta lo calcula después el pipeline con `applyPricing(costCents, settings.pricing)`. El adaptador
no decide precios. `compareAtCents` también queda en `null`: el "precio tachado" de AliExpress es
del proveedor y no tiene nada que ver con el que Madeline quiera enseñar tachado.

### Nombres de opción

Llegan en el idioma de la sesión, casi siempre inglés. Se traduce **solo el nombre** de la opción
(`Size` → `Talla`, `Ships From` → `Envía desde`…) con una tabla fija. Los **valores** se dejan
literales: traducirlos sería inventar datos del proveedor.

---

## 4. Imágenes de alicdn

- Llegan **sin protocolo**: `//ae01.alicdn.com/kf/S1a.jpg` → se normaliza a `https://`.
- Llevan un **sufijo de tamaño** que hay que quitar para traer la original:
  - `…/S1a.jpg_640x640q90.jpg` → `…/S1a.jpg`
  - `…/S1a.jpg_220x220.jpg_.webp` → `…/S1a.jpg`
  - `…/S1a_220x220.png` → `…/S1a.png`
- La misma foto aparece varias veces con sufijos distintos: se **deduplica después** de normalizar.
- Se descartan iconos/espaciadores (`placeholder`, `blank.gif`, `/icon/`, `1x1.gif`, `data:`).
- Las fotos de color de las variantes (`skuPropertyImagePath`) se **añaden al final de la galería**:
  suelen ser las únicas que enseñan la prenda en cada color.

---

## 5. Descripción larga: NO se descarga

`descriptionModule.descriptionUrl` apunta a **otro dominio**
(`aeproductsourcesite.alicdn.com/product/description/…htm`). Pedirla desde el servidor es
exactamente el patrón que dispara el anti-bot, así que el adaptador **solo guarda la URL** en
`attributes["Descripción larga (URL del proveedor)"]` y deja un warning. Que la abra la usuaria
en su navegador y copie lo que le sirva.

---

## 6. Por qué falla `fromUrl` (vía 2) y cómo se detecta

AliExpress bloquea IPs de datacenter — y Vercel es exactamente eso. El adaptador manda cabeceras
de Chrome real, `Accept-Language` en español, `Sec-Fetch-*` de navegación y la cookie de
preferencias `aep_usuc_f=site=glo&c_tp=USD&region=US` (esa cookie es la que hace que los precios
lleguen ya **en dólares** y no haya que convertir nada). Timeout de 15 s.

Se considera bloqueo y se devuelve `{ ok:false, error, hint }`:

| Señal | Qué significa |
|---|---|
| HTTP 403 | Reconoció que no es un navegador |
| HTTP 429 | Demasiadas peticiones |
| HTTP 503 | Escudo anti-bot |
| HTTP 404 | El producto ya no existe (pista distinta: revisar el enlace) |
| Cuerpo < 1500 bytes | Respuesta vacía típica de servidor |
| `_____tmd_____`, `x5secdata`, `punish?`, `nocaptcha`, `baxia` | Página de captcha |
| `login.aliexpress.com`, `passport.aliexpress` | Muro de login |

Los marcadores se buscan **solo en los primeros 20 KB** del documento: la palabra "captcha"
suelta aparece en fichas legítimas y daría falsos positivos.

La pista siempre dirige a la vía 3 (pegar el código fuente con Ctrl+U) o a la 4 (bookmarklet).
**Nunca se devuelve `ok:true` con la ficha vacía**: eso llenaría el catálogo de productos fantasma.

---

## 7. Contrato del bookmarklet (vía 4)

`fromPayload` espera esto (todo opcional menos que venga *algo* con datos):

```jsonc
{ "runParams": window.runParams,   // o el objeto entero, o solo su .data
  "dcData":    window._d_c_?.DCData,
  "html":      document.documentElement.outerHTML,  // alternativa si no hay estado
  "url":       location.href }
```

Se acepta también un string JSON, o el objeto de estado pelado. Si el HTML no da nada se
reintenta con el estado JSON antes de rendirse. Si no hay ningún módulo reconocible se
responde con la pista de "púlsalo estando en la ficha del producto, no en la búsqueda".

Referencia de lo que tiene que hacer el marcador (lo monta el módulo del admin, no este fichero):

```js
javascript:(function(){fetch('https://TIENDA/api/import/ingest',{method:'POST',
 headers:{'Content-Type':'application/json'},
 body:JSON.stringify({provider:'aliexpress',url:location.href,
   runParams:window.runParams,dcData:(window._d_c_||{}).DCData,
   html:document.documentElement.outerHTML})}).then(function(){alert('Enviado a Bloom');});})()
```

Funciona porque corre en **la sesión y la IP de la usuaria**: para AliExpress es tráfico humano
normal. Es lo mismo que hacen DSers o AutoDS con su extensión, sin tener que publicar extensión.

---

## 8. API oficial (vía 1) — `fromApi(productId)`

- **Endpoint:** `POST https://api-sg.aliexpress.com/sync`
- **Método:** `aliexpress.ds.product.get`
- **Parámetros de sistema:** `app_key`, `method`, `format=json`, `v=2.0`,
  `sign_method=hmac-sha256`, `timestamp` (**milisegundos** desde epoch en esta pasarela; la vieja
  `gw.api.taobao.com` usa `yyyy-MM-dd HH:mm:ss` en GMT+8 — si algún día devuelve error de
  timestamp, ese es el primer sitio donde mirar).
- **Parámetros de negocio:** `product_id`, `target_currency=USD`, `target_language=ES`,
  `ship_to_country=US`.
- **Firma (estilo TOP):** se ordenan **todas** las claves alfabéticamente (menos `sign`), se
  concatena `clave+valor` sin separadores, se hace `HMAC-SHA256` con el *app secret* y se manda
  el resultado en **hex mayúsculas** en el parámetro `sign`.

```
base = "app_key12345methodaliexpress.ds.product.getproduct_id1005…timestamp1700000000000"
sign = HMAC_SHA256(base, app_secret).hex().toUpperCase()
```

**Respuesta** (se navega con búsqueda por clave, no por ruta fija, porque cambia entre versiones):

```jsonc
{ "aliexpress_ds_product_get_response": { "rsp_result": { "result": {
  "ae_item_base_info_dto":  { "product_id": …, "subject": "…", "detail": "<html>…", "currency_code": "USD" },
  "ae_multimedia_info_dto": { "image_urls": "https://a.jpg;https://b.jpg" },
  "ae_item_properties":     { "ae_item_property": [ { "attr_name": "Material", "attr_value": "Polyester" } ] },
  "ae_item_sku_info_dtos":  { "ae_item_sku_info_d_t_o": [ {
      "sku_id": "12000037181001", "sku_price": "15.99", "offer_sale_price": "12.34",
      "sku_available_stock": "120",
      "ae_sku_property_dtos": { "ae_sku_property_d_t_o": [
        { "sku_property_name": "Color", "sku_property_value": "Red", "sku_image": "//…" } ] } } ] } } } } }
```

Los errores de la pasarela **no** vienen en el status HTTP sino en `error_response`
(`code`, `sub_code`, `sub_msg`). Si el mensaje habla de firma, la pista apunta al secreto y al
reloj del servidor, que es lo que falla el 90 % de las veces.

### Cómo conseguir las credenciales

1. Registrarse en **portals.aliexpress.com** (AliExpress Open Platform) con la cuenta de compra.
2. Entrar al programa **Dropshipping (DS)** o al de **Affiliate**; el permiso de
   `aliexpress.ds.product.get` depende de estar aprobado en uno de los dos. La aprobación es
   manual y tarda días.
3. Crear una App → salen `App Key` y `App Secret`.
4. Ponerlos en el entorno como `ALIEXPRESS_APP_KEY` y `ALIEXPRESS_APP_SECRET`.

Sin credenciales, `fromApi()` devuelve un error explícito diciendo que faltan y remitiendo a las
vías de HTML/bookmarklet, que dan los mismos datos. **La tienda funciona entera sin API.**

---

## 9. Decisiones y límites conocidos

- **Nada lanza excepciones hacia arriba.** Todo sale como `ImportResult`; lo que no se pudo leer
  se acumula en `warnings[]` y se enseña en el admin. Media ficha revisable vale más que un error.
- **Moneda:** si el proveedor no da USD se guarda la moneda tal cual y se avisa. **No se convierte
  a ciegas**: un tipo de cambio inventado falsearía el margen.
- **`raw`** guarda `{ source, data }` para poder re-parsear sin volver a pedir la página. En
  fichas grandes son varios MB; quien lo persista en `ImportJob.rawJson` que valore recortarlo.
- **Rendimiento:** página de 2,8 MB con 300 SKUs → ~21 ms. El recorte del objeto es un barrido de
  caracteres y las búsquedas por clave van en anchura con presupuesto de nodos.
- **Sin dependencias nuevas.** Solo `node:crypto` (firma de la API), que es de servidor: este
  módulo **no debe importarse desde un componente cliente**.
- **Lo que este adaptador NO hace:** descargar imágenes a `/public`, bajar la descripción larga,
  calcular precios de venta y escribir en la base de datos. Todo eso es del pipeline.
