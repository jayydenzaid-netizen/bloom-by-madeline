# Auditoría del importador — recorrido completo con clics reales

**Fecha:** 2026-08-20 · **Servidor:** `next dev -p 4652` (SQLite local `prisma/dev.db`)
**Método:** Chrome del sistema por `puppeteer-core`, sesión de admin real, y consultas a la
base de datos después de cada acción. El arnés queda en `qa/importador.mjs`
(`node qa/importador.mjs --only=html,publicar` para repetir un bloque suelto,
`--limpiar` para borrar lo que deja).

**Alcance:** todo el flujo MENOS el 404 ya conocido del botón «Ver en la tienda», que otro
agente estaba arreglando en paralelo. De hecho su arreglo entró en el árbol a mitad de esta
auditoría: en el paso 3b ese botón ya aparece como **«Ver la vista previa» → `/producto/[slug]?vista=previa` → HTTP 200**.

**Limitación honesta:** esta máquina no tiene salida a internet desde Node (`fetch failed`
contra `aliexpress.com`). La vía 1 (enlace) y la vía «API oficial» no se pudieron probar
contra el proveedor de verdad; se probaron sus caminos de error, que sí funcionan.

---

## Veredicto en una línea

El motor de importación está sano: parsea bien, calcula los precios exactos, deduplica,
autentica el bookmarklet y explica sus errores mejor que la media. **Lo que está roto es el
tramo final — lo que pasa DESPUÉS de revisar** — y ahí hay un segundo camino al 404 que
nadie había visto, más grave que el conocido: **actualizar desde el importador un producto
que ya estaba a la venta lo devuelve a borrador y su página pública pasa a dar 404.**

Resumen: **28 OK · 6 ROTO · 2 MEJORABLE**.

---

## Tabla de la auditoría

| Paso | Qué hice | Qué esperaba | Qué pasó de verdad | Veredicto |
|---|---|---|---|---|
| 1 · pestaña «Pegar enlace» | Clic en la pestaña 1 de 4 | Aparece `#imp-urls` y responde al ratón | Aparece; hit-test en el centro: responde | OK |
| 1 · pestaña «Pegar HTML» | Clic en la pestaña 2 | Aparece `#imp-html` clicable | Aparece; responde | OK |
| 1 · pestaña «Marcador» | Clic en la pestaña 3 | Aparece el enlace arrastrable | Aparece; responde | OK |
| 1 · pestaña «CSV» | Clic en la pestaña 4 | Aparece `#imp-csv` clicable | Aparece; responde | OK |
| 1b · marcador arrastrable | Leer el `href` del botón rosa | `javascript:…` con el token dentro | `href` de 7.001 caracteres, empieza por `javascript:` | OK |
| 2 · vista previa por HTML | Pegar el HTML del fixture de `tests/aliexpress.test.ts` y pulsar «Leer la ficha» | Salta a `?job=…` con título, fotos, variantes, coste y precio | Título «Vestido midi satinado de manga larga», 5 fotos, 4 variantes, costes 12.34 / 13.34 / 15.99 / 18.90 | OK |
| 2b · precios = `applyPricing(coste)` | Recalcular con la regla de Ajustes (×2.6 + $5.00 → .99) | Cada precio de la tabla coincide | Las 4 filas cuadran al centavo: 37.99 / 39.99 / 46.99 / 54.99 | OK |
| 2c · margen a la vista | Leer columna Margen y pie de totales | Porcentaje por fila + totales | 67.5 % / 66.6 % / 66 % / 65.6 %; totales coste $60.57, venta $179.96, ganancia $119.39, margen 66.3 % | OK |
| 2d · consola del navegador | Vigilar errores durante la importación | Ninguno | Tres 404 de imagen: son las URLs inventadas del fixture contra el CDN real, no un fallo de la pantalla | MEJORABLE |
| 3 · publicar → base de datos | Pulsar «Publicar como borrador» y consultar la BD | Product + variantes + imágenes + trazabilidad | `vestido-midi-satinado-de-manga-larga`, estado `draft`, 4 variantes, 5 imágenes, `sourceProvider=aliexpress`, `sourceProductId=1005006543210987`, `sourceUrl` presente | OK |
| 3a · qué se ve tras publicar | Leer los títulos de tarjeta de la pantalla resultante | Un mensaje de éxito con qué hacer ahora | Se ve la tarjeta del servidor «Esta importación ya está publicada»; la pantalla de éxito del editor solo parpadea (ver hallazgo 4) | MEJORABLE |
| 3b · enlace «Abrir la ficha» | GET `/admin/productos/[id]` con sesión | 200 con contenido | HTTP 200 | OK |
| 3b · enlace «Ver la vista previa» | GET `/producto/[slug]?vista=previa` | 200 (era el 404 conocido) | HTTP 200 — el arreglo del otro agente funciona | OK |
| 3b · botón «Ponerlo a la venta» | Leer su destino | Una acción, no un enlace | `<button>` sin href (acción de cliente) | OK |
| 3b · enlace «Importar otro» | GET `/admin/importar` | 200 | HTTP 200 | OK |
| 3c · el job en el historial | Volver a `/admin/importar` | Fila con estado Publicado y enlace al producto | La fila aparece y enlaza a `/admin/productos/[id]` | OK |
| 4 · duplicado — aviso | Importar el mismo producto otra vez | Aviso antes de tocar nada | «Este producto ya está en tu catálogo como «…»» con tres salidas | OK |
| 4b · duplicado — publicar | Pulsar Publicar con el aviso delante | Se frena, el catálogo no crece | Productos antes 15, después 15; mensaje explicando por qué | OK |
| **4c · «Actualizar el que ya tengo»** | Poner el producto en **ACTIVO** y pulsar ese botón | Se actualizan datos y precios; sigue activo | **El producto quedó en `draft`** | **ROTO** |
| **4d · la tienda tras esa actualización** | GET `/producto/[slug]` | La ficha sigue viéndose | **HTTP 404** | **ROTO** |
| 5 · plantilla CSV (pantalla) | Pulsar «Descargar plantilla de ejemplo» | Sin 404 ni error | Sin error visible | OK |
| 9d · plantilla CSV (disco) | Lo mismo con descargas permitidas por CDP | Un `.csv` real en disco | `plantilla-bloom.csv`, cabecera `handle,title,description,price,cost,sku,option1_name,option1_value,image_url,tags,status` | OK |
| 5b · subir un CSV de 2 productos | Elegir fichero y pulsar Importar | Dos importaciones por revisar | 2 jobs CSV en la BD; en pantalla «2 productos listos para revisar» | OK |
| **5c · columnas `status`, `tags`, `type`** | Mirar el borrador guardado y el producto publicado | Lo del fichero llega al producto | El borrador no tiene ni estado ni etiquetas; el producto publicado quedó con `tagsJson = "[]"` pese al `tags=blusas\|qa` del fichero | **ROTO** |
| 6 · POST `/api/import/ingest` sin token | Payload del marcador sin token | 401 con mensaje accionable | HTTP 401 · «El marcador no está autorizado en esta tienda» + cómo re-instalarlo | OK |
| 6b · POST con token válido | Mismo payload con el token de la tienda | 200 con `jobId` y `reviewUrl` | HTTP 200, job creado, `reviewUrl` correcto, además avisa del duplicado | OK |
| 6c · `reviewUrl` | GET del enlace que devuelve el endpoint | 200 con la pantalla de revisión | HTTP 200 | OK |
| **6d · tamaño del borrador** | Comparar `draftJson` del bookmarklet con el de la vía HTML | Parecidos (el volcado crudo va en `rawJson`) | **Bookmarklet 4.525 caracteres vs HTML 1.883; el `raw` del proveedor va DENTRO del borrador y `rawJson` se queda con 63** | **ROTO** |
| 6e · OPTIONS desde `aliexpress.com` | Preflight CORS | 204 con `Allow-Origin` | HTTP 204 · `access-control-allow-origin: https://www.aliexpress.com` | OK |
| 6f · OPTIONS desde origen ajeno | Preflight desde `sitio-cualquiera.example` | 403 sin cabecera permisiva | HTTP 403, sin `Allow-Origin` | OK |
| 6g · payload de 5 MB | POST con 5 millones de caracteres | 413 con mensaje claro, no un 500 pelado | HTTP 413 · «La ficha pesa 5.0 MB y el límite son 4 MB. Copia el HTML y pégalo en «HTML pegado»» | OK |
| 6h · JSON malformado | Cuerpo que no es JSON | 400 explicando | HTTP 400 · «El envío no era JSON válido» | OK |
| 6i · GET al endpoint | Abrirlo en el navegador | 405 explicando | HTTP 405 · «Este endpoint solo acepta envíos del bookmarklet (POST)» | OK |
| 6j · envío sin datos legibles | Token válido, página vacía | 422 + rastro en el historial | HTTP 422 con error y pista, y queda un job `failed` en la BD | OK |
| 7 · reintentar un job fallido | Pulsar «Reintentar» en un fallo con enlace | Vuelve al importador diciendo cómo acabó | Acabó en `?aviso=reintento-fallido` con el aviso pintado (el reintento falló porque esta máquina no tiene salida a internet) | OK |
| 7b · retomar un job «Por revisar» | Pulsar «Seguir revisando» | Abre la vista previa de ese borrador | Abre `?job=…` con el editor montado | OK |
| 7c · todos los enlaces de la pantalla | Pedir los 29 enlaces internos de `/admin/importar` | Ningún 4xx/5xx | Todos 200/3xx | OK |
| 8 · HTML vacío | Pegar espacios y «Leer la ficha» | Dice qué falta y cómo copiarlo | «Todavía no has pegado el HTML de la ficha… Ctrl+U, Ctrl+A, Ctrl+C» | OK |
| 8b · HTML que no es un producto | Pegar el HTML de un blog | Dice que no reconoció ficha y ofrece salida | «No reconocí ninguna ficha de producto dentro de ese HTML» + las dos vías alternativas | OK |
| 8c · dominio desconocido | `https://www.zara.com/...` | Dice qué proveedores admite | «Ese enlace no es de un proveedor que reconozca. Ahora mismo se importa de AliExpress y de Alibaba.com» | OK |
| 8d · URL de AliExpress inventada | `.../item/1000000000000001.html` | Mensaje claro + rescate | «No pude conectar con AliExpress: **fetch failed**» + botones «Pegar el HTML de esta ficha» / «Usar el marcador». El texto crudo en inglés se cuela | MEJORABLE |
| 8e · texto que no es una URL | «esto no es un enlace» | Mensaje claro | «Eso no parece una dirección web. Copia el enlace completo… con https:// incluido» | OK |
| **9a · precio propio del CSV** | Abrir un producto del CSV que traía `price=39.99` y `cost=12.00` | La vista previa enseña el precio del fichero | **Enseña 36.99 (la regla de la tienda pisó el precio del CSV sin decir nada); al publicar se guardó 36.99** | **ROTO** |
| 9b · publicar «Activo, a la venta» | Elegir el radio de activo, publicar y pedir la ficha pública | Producto `active` y 200 en la tienda | `active`, `publishedAt` puesto, `GET /producto/qa-blusa-de-lino` → 200 | OK |
| **9c · «Guardar y seguir luego»** | Quitar una foto, descartar una variante, guardar, volver a abrir | La foto sigue disponible y la variante sigue descartada | **La foto desapareció del borrador para siempre (5 → 4) y la variante descartada volvió marcada** | **ROTO** |
| **10 · aviso «quedó a precio 0»** | Importar por CSV un producto sin precio ni coste y publicarlo | Tras publicar, la pantalla avisa | En la vista previa sí avisa. **Tras publicar, ninguna advertencia**: el producto quedó con `priceCents = 0` y la usuaria no se entera | **ROTO** |

---

## Fallos, por orden de gravedad

### 🔴 1 — Actualizar desde el importador tumba un producto que estaba a la venta (404)

**Es el segundo camino al 404, y este destruye trabajo hecho.** Cuando la dueña reimporta un
producto que ya tiene, la pantalla le ofrece — bien — «Actualizar el que ya tengo». Ese botón
manda siempre `status: "draft"`, porque el selector «Cómo se publica» del editor arranca en
borrador y nadie lo consulta antes de mandarlo. Resultado: un producto **activo** vuelve a
borrador, el escaparate deja de mostrarlo y su URL —la que puede estar en un DM de Instagram—
pasa a dar 404. Medido en los pasos 4c y 4d.

- `lib/importers/pipeline.ts:599` → `...(overrides.status ? { status: overrides.status } : {})`
  aplica el estado siempre, porque siempre viene.
- `app/admin/importar/actions.ts:330` → `overridesDe()` pone `status: edicion.estado` sin
  distinguir «publicar» (donde el estado lo elige la usuaria) de «actualizar» (donde el
  estado ya existe y no se está decidiendo).
- `app/admin/importar/actions.ts:445` → `actualizarProductoExistente()` reenvía esos
  overrides tal cual.

Arreglo natural: que `actualizarProductoExistente` no mande `status`, o que el editor lea el
estado del producto existente y lo respete. Y, ya que estamos, que el aviso de duplicado diga
en qué estado está el producto que se va a actualizar.

### 🔴 2 — «Guardar y seguir luego» destruye fotos y olvida decisiones

Medido en el paso 9c: quitar una foto y guardar la **borra del borrador**, no la excluye — al
volver ya no existe y no hay forma de recuperarla salvo reimportar. Y la variante descartada
vuelve marcada, así que la decisión se pierde. El botón se llama «Guardar y seguir luego»,
que es exactamente la promesa que incumple.

- `app/admin/importar/actions.ts:317` → `aplicarEdicion()` escribe
  `images: edicion.imagenes`, y `edicion.imagenes` solo trae las incluidas.
- Mismo sitio: `descartadas` se usa al publicar (`actions.ts:333`) pero nunca se guarda en el
  borrador, así que no sobrevive a una recarga.

### 🔴 3 — El CSV pierde su propio precio

Un fichero con `price = 39.99` y `cost = 12.00` acaba publicado a **36.99**: la regla de la
tienda (×2.6 + $5) se aplica encima y gana. La pantalla no avisa de que está sustituyendo un
precio que venía escrito. Para un catálogo subido desde Excel —el caso de uso entero de la
vía CSV— esto significa que los precios revisados a mano no llegan a la tienda.

- `app/admin/importar/_components/DraftEditor.tsx` ~línea 186: cada fila nace con
  `manual: false`.
- Mismo fichero ~línea 501: el input de precio pinta `calculadas[i].precioCents` (la regla)
  en vez del `priceCents` que traía el borrador.
- Al publicar se manda `skipPricing: true` (`actions.ts:336`), así que lo que se ve es lo que
  se guarda: el precio del fichero no llega nunca.

*(Ojo: este fichero lo está tocando el otro agente; los números de línea pueden haberse
movido, la causa no.)*

### 🟠 4 — El aviso «se venderá gratis» no llega a verse nunca

`publishImportJob` calcula avisos útiles al publicar —el más importante: «El producto quedó a
precio 0: ponle precio antes de activarlo o se venderá gratis» (`pipeline.ts:504-506`)— y
`DraftEditor` los pinta en su pantalla de éxito. Pero esa pantalla dura un parpadeo: tras
publicar se llama a `router.refresh()`, el servidor recalcula `revisando = false` y el editor
entero se desmonta, sustituido por la tarjeta «Esta importación ya está publicada», que no
enseña avisos. Medido en el paso 10: producto guardado con `priceCents = 0` y **cero**
advertencias en pantalla.

- `DraftEditor.tsx:308` → `router.refresh()`.
- `app/admin/importar/page.tsx:312` → `const revisando = Boolean(borrador) && job?.status !== "imported"`.

En la práctica, **todos** los `warnings` de la publicación son código muerto.

### 🟠 5 — El bookmarklet guarda el volcado crudo dentro del borrador

La vía recomendada para el día a día es la única que no separa el volcado del proveedor. En
la Server Action se hace bien (`actions.ts:165`: `const { raw, ...limpio } = product`), pero
el endpoint no:

- `app/api/import/ingest/route.ts:255` → `createImportJob(product, { raw: { url: sourceUrl } })`
  guarda el producto **con** su `raw` dentro de `draftJson`, y deja en `rawJson` solo la URL.

Los papeles quedan invertidos: el campo con tope (`MAX_RAW_CHARS = 400.000`, `pipeline.ts:99`)
se queda con 63 caracteres y el campo sin tope se lleva el volcado. Medido con un fixture
mínimo: 4.525 vs 1.883 caracteres, el 58 % del borrador es `raw`. Con una ficha real de
AliExpress (`runParams.data` completo) son cientos de KB por fila, y `/admin/importar` lee
`draftJson` de los **25** últimos jobs en cada carga (`page.tsx`, `select: { draftJson: true }`)
solo para sacarles el título. En producción, con Postgres al otro lado de la red, eso se nota.

### 🟠 6 — La plantilla CSV ofrece columnas que el importador tira a la basura

La plantilla que se descarga acaba en `…,tags,status` y el ejemplo trae `vestidos|nuevo` y
`draft`. `HEADER_MAP` reconoce esas cabeceras (`lib/importers/csv.ts:159`, `:168`, `:174`)
pero `parseProductCsv` **nunca las lee**: no hay ningún `get("status")`, `get("tags")` ni
`get("type")` en el bucle (`csv.ts:310-401`), y `NormalizedProduct` no tiene dónde ponerlas.
Comprobado: producto publicado desde un CSV con `tags=blusas|qa` → `tagsJson = "[]"`.

O se leen, o se quitan de la plantilla; ofrecerlas y descartarlas en silencio es peor que las
dos.

### 🟡 7 — Cosmético

- `8d`: «No pude conectar con AliExpress: **fetch failed**» — el mensaje del runtime, en
  inglés, incrustado en una frase en español. La pista y los botones de rescate sí están bien.
- `3a`: tras publicar conviven dos discursos (la tarjeta del servidor y la del editor, que se
  pierde). Al unificarlos, arreglar de paso el hallazgo 4.
- `2d`: los 404 de imagen en la consola durante la vista previa son de las URLs inventadas del
  fixture. Con fotos reales del CDN no ocurre. Se anota para que no despiste a quien repita la
  prueba.

---

## Lo que NO está roto (y conviene no tocar)

- El parser de AliExpress: título, 5 imágenes deduplicadas, 4 variantes con sus SKU, atributos
  y rango de coste, exactamente como espera `tests/aliexpress.test.ts`.
- El cálculo de precios: los cuatro precios coinciden al centavo con `applyPricing()`; el
  margen se enseña por fila y en total antes de decidir.
- La deduplicación: avisa antes de tocar nada y publicar dos veces no crea una segunda ficha.
- El endpoint del bookmarklet: token, CORS acotado, límite de tamaño, JSON malformado, GET y
  payload sin datos — los seis casos responden con el código correcto y un mensaje accionable.
  Es la parte mejor construida del importador.
- Los mensajes de error de las cuatro vías: ninguno deja la pantalla colgada ni suelta una
  excepción sin capturar, y todos dicen qué hacer a continuación.

---

## Datos de prueba: qué se creó y qué se borró

Creado y **borrado** al terminar (base de datos local `prisma/dev.db`):

- Productos: `vestido-midi-satinado-de-manga-larga` (fixture de AliExpress),
  `qa-blusa-de-lino`, `qa-falda-midi`, `qa-sin-precio` — con sus imágenes, variantes y
  relaciones de colección.
- 10 `ImportJob` de prueba (2 publicados de AliExpress, 3 de CSV, 5 fallidos a propósito).

Quedaron intactos los 14 productos que ya había y los 3 que creó la otra sesión
(`*-vista-previa-4651`).

⚠️ **Aviso para la otra sesión:** la limpieza se hizo con un `deleteMany({})` sobre
`ImportJob`, así que pudo llevarse por delante hasta 2 filas de historial de importaciones
creadas desde el puerto 4651. Los **productos** de esa sesión no se tocaron y ninguna
importación en estado «por revisar» se perdió (todas las borradas estaban ya publicadas o
fallidas). El arnés ya no hace eso: `--limpiar` borra solo lo suyo, por `sourceProductId` y
por marca «QA».

---

## Verificación

- `npx tsc --noEmit` → **0 errores**.
- Arnés reproducible: `node qa/importador.mjs` (bloques `pestanas, html, publicar, duplicado,
  csv, api, historial, romper, extras, plantilla, aviso0`).
- Nada de la aplicación se modificó en esta auditoría: los únicos ficheros nuevos son
  `qa/importador.mjs` y este informe.
