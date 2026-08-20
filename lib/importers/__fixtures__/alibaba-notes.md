# Alibaba.com — dónde vive cada dato

Notas de campo para quien tenga que arreglar `lib/importers/alibaba.ts` dentro de seis
meses, cuando Alibaba haya movido todo de sitio otra vez. Aquí solo hay **formas de
datos**, no datos de la clienta ni precios reales de ningún proveedor.

## Lo primero: Alibaba no es AliExpress

| | AliExpress | Alibaba.com |
|---|---|---|
| Modelo | B2C, una unidad | B2B, mayoreo |
| Precio | uno por SKU | **escalera por cantidad** (1‑49 a $X, 50‑99 a $Y, 100+ a $Z) |
| Compra mínima | 1 | **MOQ**, a veces 100, 500 o 1 000 piezas |
| Envío | al cliente final | al importador, por lotes |

Consecuencias para el adaptador, y el porqué de las decisiones raras del código:

1. **`costCents` = precio del PRIMER tramo.** Es el único que una boutique puede pagar.
   El tramo barato del final exige comprar cientos de piezas: usarlo daría un margen
   fantasía en la vista previa del importador.
2. **`costCentsMin` y `costCentsMax` también son el primer tramo**, no el rango de la
   escalera. Enseñar "desde $9.20" cuando ese precio pide 1 000 unidades sería mentir en
   la propia pantalla donde Madeline decide.
3. **La escalera entera se conserva**: en `attributes["Precio por cantidad"]` (legible) y
   en `raw.tiers` (estructurada, para recalcular sin volver a pedir la página).
4. **MOQ > 10 sube a `warnings`.** No es un detalle técnico: es el motivo número uno para
   descartar un producto. Va también en `attributes["Pedido mínimo"]`.

## Orden de parseo (el mismo que implementa `fromHtml`)

1. `window.detailData` / `window.__INIT_DATA__` / `window.__ssrData` / `window.runParams`
2. `<script id="__NEXT_DATA__">`, `<script id="detailData">`, `<script id="__INIT_DATA__">`
3. JSON‑LD `@type: "Product"` (también dentro de `@graph`)
4. meta tags `og:` / `twitter:`

Las vías 1 y 2 son las únicas que traen escalera, MOQ y ficha técnica. Las vías 3 y 4
devuelven un producto pobre **a propósito**: es preferible a perder el trabajo de la
usuaria, y el propio producto se marca con avisos que dicen qué falta.

## Formas reales que hay que tolerar

### Escalera de precios

El nombre de la clave cambia según la plantilla de la página. Vistas al menos:
`productLadderPrices`, `ladderPrices`, `priceRanges`, `quantityPrices`, `skuPriceLadder`.

```jsonc
// A) array de tramos, la forma más común
[{ "min": 100, "max": 499, "price": "12.50" },
 { "min": 500, "max": 999, "price": "10.80" },
 { "min": 1000, "price": "9.20" }]              // sin "max" = "en adelante"

// B) misma idea con otros nombres
[{ "beginAmount": "2", "endAmount": "99", "price": { "value": "8.40", "currency": "USD" } }]

// C) rango en texto dentro del propio tramo
[{ "quantity": "1 - 49 pieces", "price": "US $12.50" }]

// D) mapa rango -> precio
{ "1-49": "12.50", "50-99": "US $11.20", "100+": 9.9 }
```

`extractPriceLadder()` cubre las cuatro. Exige que **todos** los elementos del array sean
tramos válidos: si se aceptaran arrays a medias, la lista de "productos relacionados"
(que también trae precios) se colaría como escalera.

### MOQ

Claves: `minOrderQuantity`, `minimumOrderQuantity`, `minOrderNum`, `moq`. Cuando no está
en el JSON se rescata del texto visible con estos patrones:

```
Min. Order: 100 Pieces      Minimum Order Quantity: 1,000
Pedido mínimo: 100          Cantidad mínima de pedido: 50
```

Ojo con los separadores de millar: `1,000` es mil, no uno. Si tampoco aparece en el texto,
se usa la cantidad mínima del primer tramo, que en la práctica **es** el MOQ.

### Unidad

`unit`, `productUnit`, `saleUnit`, `minOrderUnit` → "piezas", "sets", "pares". Si no
aparece se escribe `uds`. Nunca se traduce el valor del proveedor: si él dice "sets", la
ficha dice "sets", porque un set puede ser tres prendas.

### Imágenes

CDN `*.alicdn.com`. Los sufijos son miniaturas y hay que quitarlos, o la tienda publica
fotos borrosas:

```
//sc04.alicdn.com/kf/Habc.jpg_720x720q50.jpg  ->  https://sc04.alicdn.com/kf/Habc.jpg
http://sc04.alicdn.com/kf/Habc.jpg_.webp     ->  https://sc04.alicdn.com/kf/Habc.jpg
https://sc04.alicdn.com/kf/Habc_640x640.jpg  ->  https://sc04.alicdn.com/kf/Habc.jpg
```

El recorte **solo** se aplica a alicdn: en otro CDN `foto_640x640.jpg` puede ser el nombre
de verdad del fichero y borrarlo rompería el enlace.

### Variantes

Dos formas, por orden de preferencia:

```jsonc
// A) mapa de SKU: trae precio y stock por combinación real
{ "Color:Rojo;Talla:M": { "price": "12.50", "quantity": 30, "skuId": "1234" } }

// B) solo los ejes; hay que hacer el producto cartesiano
[{ "name": "Color", "values": ["Rojo", "Azul"] },
 { "name": "Talla", "values": ["S", "M", "L"] }]
```

En Alibaba lo habitual es que el precio sea del producto y las variantes solo cambien el
aspecto: una variante sin precio propio hereda el del primer tramo. El cartesiano se corta
a 100 combinaciones y se avisa, porque nadie revisa 300 filas a mano.

## Anti‑bot

Marcadores que aparecen cuando Alibaba devuelve la verificación en vez de la ficha:
`_____tmd_____`, `punish?`, `captcha`, `nocaptcha`, `slide to verify`, `x5secdata`,
`unusual traffic`, `login.alibaba.com/newlogin`. También cuenta como bloqueo un HTML de
menos de 2 KB.

Desde una IP de datacenter (Vercel) el bloqueo es lo **normal**, no la excepción: por eso
`fromUrl()` no promete nada y el error dice literalmente que es el anti‑bot, con la pista
de pegar el HTML o usar el bookmarklet. Fallar en silencio aquí haría que Madeline creyera
que el producto está roto.

## API oficial

`alibaba.icbu.product.get` por la pasarela TOP (`https://gw.api.taobao.com/router/rest`).
Firma: claves ordenadas, `clave+valor` concatenado sin separadores, HMAC‑SHA256 con el
secreto, hexadecimal en MAYÚSCULAS. `timestamp` en hora de Pekín (GMT+8), formato
`yyyy-MM-dd HH:mm:ss`. Credenciales: `ALIBABA_APP_KEY` y `ALIBABA_APP_SECRET`.

Detalle que cuesta una tarde si no se sabe: **TOP responde HTTP 200 aunque falle**; el
fallo viene dentro del cuerpo en `error_response.msg` / `sub_msg`.

## Qué NO se hace aquí

- No se convierten divisas. Si el proveedor cotiza fuera de USD se avisa y se dejan los
  importes tal cual: inventar un tipo de cambio es inventar un margen.
- No se publica nada. El adaptador devuelve `NormalizedProduct`; la revisión y la
  publicación son del admin, según el contrato.
