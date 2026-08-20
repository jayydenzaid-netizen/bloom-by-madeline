// Pruebas del adaptador de AliExpress.
//
// Correr con:  npx tsx --test tests/aliexpress.test.ts
//
// Los fixtures imitan la estructura real de una ficha (ver
// lib/importers/__fixtures__/aliexpress-notes.md). No hay red: todo lo que se prueba
// aquí es parseo puro, que es justo la parte que se rompe cuando AliExpress cambia algo.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  aliexpressAdapter,
  fromApi,
  normalizeImageUrl,
  signTopParams,
} from "@/lib/importers/aliexpress";
import type { NormalizedProduct } from "@/lib/importers/types";

// ────────────────────────────── fixtures ──────────────────────────────

/** Estado tal y como lo deja AliExpress en `window.runParams`, con los 6 módulos útiles. */
const RUN_PARAMS_STATE = {
  data: {
    actionModule: { productId: 1005006543210987, itemStatus: 0 },
    titleModule: { subject: "Vestido midi satinado de manga larga", formatTradeCount: "1,203 vendidos" },
    imageModule: {
      imagePathList: [
        "//ae01.alicdn.com/kf/S1a.jpg_640x640q90.jpg",
        "//ae01.alicdn.com/kf/S1a.jpg_220x220.jpg",
        "https://ae01.alicdn.com/kf/S2b.png_220x220.png",
        "//ae01.alicdn.com/kf/S3c.jpg",
        "//ae01.alicdn.com/images/placeholder.gif",
      ],
    },
    priceModule: {
      formatedPrice: "US $15.99 - US $22.50",
      formatedActivityPrice: "US $12.34 - US $18.90",
      minAmount: { value: 15.99, currency: "USD", formatedAmount: "US $15.99" },
      maxAmount: { value: 22.5, currency: "USD", formatedAmount: "US $22.50" },
      minActivityAmount: { value: 12.34, currency: "USD", formatedAmount: "US $12.34" },
      maxActivityAmount: { value: 18.9, currency: "USD", formatedAmount: "US $18.90" },
    },
    skuModule: {
      productSKUPropertyList: [
        {
          skuPropertyId: 14,
          skuPropertyName: "Color",
          skuPropertyValues: [
            {
              propertyValueId: 350852,
              propertyValueName: "Red",
              propertyValueDisplayName: "Rojo",
              skuPropertyImagePath: "//ae01.alicdn.com/kf/Sred.jpg_220x220.jpg",
            },
            {
              propertyValueId: 350850,
              propertyValueName: "Black",
              propertyValueDisplayName: "Negro",
              skuPropertyImagePath: "//ae01.alicdn.com/kf/Sblack.jpg_220x220.jpg",
            },
          ],
        },
        {
          skuPropertyId: 5,
          skuPropertyName: "Size",
          skuPropertyValues: [
            { propertyValueId: 361386, propertyValueName: "S", propertyValueDisplayName: "S" },
            { propertyValueId: 361387, propertyValueName: "M", propertyValueDisplayName: "M" },
          ],
        },
      ],
      skuPriceList: [
        {
          skuId: "12000037181001",
          skuAttr: "14:350852#Red;5:361386",
          skuPropIds: "350852,361386",
          skuVal: {
            skuAmount: { value: 15.99, currency: "USD", formatedAmount: "US $15.99" },
            skuActivityAmount: { value: 12.34, currency: "USD", formatedAmount: "US $12.34" },
            availQuantity: 120,
          },
        },
        {
          skuId: "12000037181002",
          skuAttr: "14:350852#Red;5:361387",
          skuPropIds: "350852,361387",
          skuVal: {
            skuAmount: { value: 16.99, currency: "USD" },
            skuActivityAmount: { value: 13.34, currency: "USD" },
            availQuantity: 8,
          },
        },
        {
          skuId: "12000037181003",
          skuAttr: "14:350850#Black;5:361386",
          skuPropIds: "350850,361386",
          skuVal: { skuAmount: { value: 15.99, currency: "USD" }, availQuantity: 0 },
        },
        {
          skuId: "12000037181004",
          skuAttr: "14:350850#Black;5:361387",
          skuPropIds: "350850,361387",
          skuVal: { skuCalPrice: "18.90", availQuantity: 55 },
        },
      ],
    },
    specsModule: {
      props: [
        { attrName: "Material", attrValue: "Poliéster" },
        { attrName: "Largo del vestido", attrValue: "Midi" },
      ],
    },
    descriptionModule: {
      descriptionUrl: "https://aeproductsourcesite.alicdn.com/product/description/pc/v2/es_ES/desc.htm",
    },
    storeModule: { storeName: "Chic Fashion Store" },
  },
  csrfToken: "abc123",
};

/** Una ficha real trae varios `window.runParams`; el bueno se elige por puntuación. */
function fullHtml(state: unknown = RUN_PARAMS_STATE): string {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta property="og:title" content="Vestido midi satinado &amp; elegante | AliExpress">
<meta property="og:image" content="//ae01.alicdn.com/kf/Sog.jpg_480x480.jpg">
<title>Vestido midi</title>
</head><body>
<div id="root"></div>
<script>window.runParams = {"data":{"titleModule":{"subject":"BLOQUE DECOY QUE NO ES LA FICHA"}}};</script>
<script type="text/javascript">
  window.runParams = ${JSON.stringify(state)};
</script>
<script>window.adminSeo = {"a":"}"};</script>
</body></html>`;
}

const LD_JSON_HTML = `<!doctype html>
<html><head>
<meta property="og:title" content="Blusa de gasa floral">
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"Product","name":"Blusa de gasa floral",
 "description":"Blusa ligera de gasa con estampado floral.",
 "image":["//ae01.alicdn.com/kf/Sblusa.jpg_640x640q90.jpg","//ae01.alicdn.com/kf/Sblusa2.jpg_220x220.jpg"],
 "sku":"1005007111222333",
 "offers":{"@type":"AggregateOffer","priceCurrency":"USD","lowPrice":"9.87","highPrice":"14.20"}}
</script>
</head><body><div id="root">Cargando…</div>
<p>Relleno para que el documento no se considere demasiado corto y el parser lo trate como una página real de producto.</p>
</body></html>`;

const META_ONLY_HTML = `<!doctype html>
<html><head>
<meta property="og:title" content="Falda plisada midi">
<meta property="og:image" content="https://ae01.alicdn.com/kf/Sfalda.jpg_220x220.jpg">
<meta property="og:description" content="Falda plisada de tiro alto.">
<meta property="og:price:amount" content="11.50">
<meta property="og:price:currency" content="USD">
</head><body><div id="root"></div>
<p>Relleno suficiente para superar el umbral mínimo de longitud del parser de HTML pegado por la usuaria.</p>
</body></html>`;

const GARBAGE_HTML = `<!doctype html><html><head><title>Nada</title></head><body>
<p>${"Esto no es una ficha de producto, solo texto suelto. ".repeat(8)}</p>
</body></html>`;

const CAPTCHA_HTML = `<!doctype html><html><head><title>Verification</title></head><body>
<script>window._____tmd_____ = {"tk":"x5secdata"};</script>
<p>${"Please slide to verify. ".repeat(12)}</p>
</body></html>`;

function unwrap(result: ReturnType<typeof aliexpressAdapter.fromHtml>): NormalizedProduct {
  assert.equal(result.ok, true, result.ok ? "" : `esperaba éxito: ${result.error}`);
  if (!result.ok) throw new Error("inalcanzable");
  return result.product;
}

// ────────────────────────────── extractId / matches ──────────────────────────────

test("extractId reconoce todas las formas de URL de AliExpress", () => {
  const cases: Array<[string, string | null]> = [
    ["https://www.aliexpress.com/item/1005006543210987.html", "1005006543210987"],
    [
      "https://es.aliexpress.com/item/1005006543210987.html?spm=a2g0o.productlist.main.1&gatewayAdapt=glo2esp&aem_p4p_detail=2024&pdp_npi=4%40dis%21USD%2112.34%2110.00%21%21%21%21%21%40%2112000037181001%21btf",
      "1005006543210987",
    ],
    ["https://m.aliexpress.com/item/1005006543210987.html", "1005006543210987"],
    ["https://www.aliexpress.us/item/3256806543210987.html", "3256806543210987"],
    ["https://m.aliexpress.com/i/1005006543210987.html", "1005006543210987"],
    ["https://www.aliexpress.com/gsp/detail?productId=1005006543210987&aff=abc", "1005006543210987"],
    ["https://www.aliexpress.com/store/product/algo/2251832.html?product_id=1005006543210987", "1005006543210987"],
    ["aliexpress.com/item/1005006543210987.html", "1005006543210987"],
    ["https://www.aliexpress.com/item/es/1005006543210987.html", "1005006543210987"],
    ["https://a.aliexpress.com/_mNxKwPq", null],
    ["https://www.aliexpress.com/w/wholesale-vestidos.html", null],
  ];
  for (const [url, expected] of cases) {
    assert.equal(aliexpressAdapter.extractId(url), expected, url);
  }
});

test("matches acepta los dominios y acortadores del proveedor y rechaza el resto", () => {
  const yes = [
    "https://www.aliexpress.com/item/1.html",
    "https://es.aliexpress.com/item/1.html",
    "https://m.aliexpress.com/item/1.html",
    "https://www.aliexpress.us/item/1.html",
    "https://a.aliexpress.com/_mNxKwPq",
    "https://s.click.aliexpress.com/e/_DmKQ1AB",
    "aliexpress.com/item/1.html",
  ];
  const no = [
    "https://www.alibaba.com/product-detail/x_1600123.html",
    "https://aliexpress.com.evil.example/item/1.html",
    "https://www.amazon.com/dp/B000",
    "no es una url",
  ];
  for (const url of yes) assert.equal(aliexpressAdapter.matches(url), true, url);
  for (const url of no) assert.equal(aliexpressAdapter.matches(url), false, url);
});

// ────────────────────────────── normalización de imágenes ──────────────────────────────

test("normalizeImageUrl deja la imagen grande en https y descarta la basura", () => {
  assert.equal(normalizeImageUrl("//ae01.alicdn.com/kf/S1a.jpg_220x220.jpg"), "https://ae01.alicdn.com/kf/S1a.jpg");
  assert.equal(
    normalizeImageUrl("https://ae01.alicdn.com/kf/S1a.jpg_640x640q90.jpg_.webp"),
    "https://ae01.alicdn.com/kf/S1a.jpg",
  );
  assert.equal(normalizeImageUrl("http://ae01.alicdn.com/kf/S1a_220x220.png"), "https://ae01.alicdn.com/kf/S1a.png");
  assert.equal(normalizeImageUrl("//ae01.alicdn.com/kf/S1a.jpg?spm=track&x=1"), "https://ae01.alicdn.com/kf/S1a.jpg");
  assert.equal(normalizeImageUrl("//ae01.alicdn.com/images/placeholder.gif"), null);
  assert.equal(normalizeImageUrl("data:image/gif;base64,R0lGOD"), null);
  assert.equal(normalizeImageUrl("/local/foto.jpg"), null);
  assert.equal(normalizeImageUrl(""), null);
  assert.equal(normalizeImageUrl(undefined), null);
});

// ────────────────────────────── fromHtml con runParams ──────────────────────────────

test("fromHtml lee la ficha completa desde window.runParams", () => {
  const product = unwrap(
    aliexpressAdapter.fromHtml(fullHtml(), "https://es.aliexpress.com/item/1005006543210987.html?spm=a2g0o"),
  );

  assert.equal(product.provider, "aliexpress");
  assert.equal(product.method, "html");
  assert.equal(product.title, "Vestido midi satinado de manga larga");
  assert.equal(product.sourceProductId, "1005006543210987");
  assert.equal(product.vendor, "Chic Fashion Store");
  assert.equal(product.currency, "USD");

  // "Size" se muestra en español; los valores se dejan como los da el proveedor.
  assert.deepEqual(product.optionNames, ["Color", "Talla"]);

  assert.equal(product.variants.length, 4);
  assert.deepEqual(
    product.variants.map((variant) => variant.title),
    ["Rojo / S", "Rojo / M", "Negro / S", "Negro / M"],
  );
  assert.deepEqual(product.variants[0]?.optionValues, ["Rojo", "S"]);

  // Precio promocional por encima del de lista, y todo en centavos enteros.
  assert.deepEqual(
    product.variants.map((variant) => variant.costCents),
    [1234, 1334, 1599, 1890],
  );
  assert.deepEqual(
    product.variants.map((variant) => variant.stock),
    [120, 8, 0, 55],
  );
  assert.equal(product.variants[0]?.sku, "12000037181001");
  assert.equal(product.variants[0]?.imageUrl, "https://ae01.alicdn.com/kf/Sred.jpg");

  // El precio de venta lo pone después applyPricing(): aquí NUNCA se calcula.
  for (const variant of product.variants) assert.equal(variant.priceCents, null);

  assert.equal(product.costCentsMin, 1234);
  assert.equal(product.costCentsMax, 1890);

  // 3 de galería (una duplicada por el sufijo de tamaño, un placeholder fuera) + 2 de color.
  assert.deepEqual(
    product.images.map((image) => image.url),
    [
      "https://ae01.alicdn.com/kf/S1a.jpg",
      "https://ae01.alicdn.com/kf/S2b.png",
      "https://ae01.alicdn.com/kf/S3c.jpg",
      "https://ae01.alicdn.com/kf/Sred.jpg",
      "https://ae01.alicdn.com/kf/Sblack.jpg",
    ],
  );

  assert.equal(product.attributes["Material"], "Poliéster");
  assert.equal(product.attributes["Largo del vestido"], "Midi");
  assert.equal(
    product.attributes["Descripción larga (URL del proveedor)"],
    "https://aeproductsourcesite.alicdn.com/product/description/pc/v2/es_ES/desc.htm",
  );
  // La descripción larga vive en otra URL y NO se descarga: hay que avisarlo.
  assert.ok(product.warnings.some((warning) => /descripción larga/i.test(warning)));

  assert.ok(product.raw, "el volcado crudo se guarda para poder re-parsear");
});

test("fromHtml avisa cuando el proveedor no da precios en dólares", () => {
  const state = JSON.parse(JSON.stringify(RUN_PARAMS_STATE)) as typeof RUN_PARAMS_STATE;
  state.data.priceModule.minActivityAmount.currency = "EUR";
  state.data.priceModule.maxActivityAmount.currency = "EUR";

  const product = unwrap(aliexpressAdapter.fromHtml(fullHtml(state)));
  assert.equal(product.currency, "EUR");
  assert.ok(product.warnings.some((warning) => /EUR/.test(warning) && /sin convertir/i.test(warning)));
});

test("fromHtml sobrevive a un skuModule sin emparejar y deja una sola variante", () => {
  const state = JSON.parse(JSON.stringify(RUN_PARAMS_STATE)) as Record<string, any>;
  state.data.skuModule.productSKUPropertyList = [];
  state.data.skuModule.skuPriceList = [];

  const product = unwrap(aliexpressAdapter.fromHtml(fullHtml(state)));
  assert.equal(product.variants.length, 1);
  assert.equal(product.variants[0]?.title, "Único");
  assert.equal(product.variants[0]?.costCents, 1234); // el mínimo del rango de la ficha
  assert.deepEqual(product.optionNames, []);
});

// ────────────────────────────── fallbacks ──────────────────────────────

test("fromHtml cae a ld+json cuando no hay estado embebido", () => {
  const product = unwrap(aliexpressAdapter.fromHtml(LD_JSON_HTML, "https://www.aliexpress.com/item/1005007111222333.html"));

  assert.equal(product.title, "Blusa de gasa floral");
  assert.equal(product.description, "Blusa ligera de gasa con estampado floral.");
  assert.equal(product.sourceProductId, "1005007111222333");
  assert.deepEqual(
    product.images.map((image) => image.url),
    ["https://ae01.alicdn.com/kf/Sblusa.jpg", "https://ae01.alicdn.com/kf/Sblusa2.jpg"],
  );
  assert.equal(product.costCentsMin, 987);
  assert.equal(product.costCentsMax, 1420);
  assert.equal(product.variants.length, 1);
  assert.equal(product.variants[0]?.costCents, 987);
  assert.equal(product.variants[0]?.priceCents, null);
  assert.ok(product.warnings.some((warning) => /bookmarklet/i.test(warning)));
});

test("fromHtml se agarra a las meta og: como último recurso", () => {
  const product = unwrap(aliexpressAdapter.fromHtml(META_ONLY_HTML));
  assert.equal(product.title, "Falda plisada midi");
  assert.equal(product.description, "Falda plisada de tiro alto.");
  assert.equal(product.images[0]?.url, "https://ae01.alicdn.com/kf/Sfalda.jpg");
  assert.equal(product.costCentsMin, 1150);
  assert.ok(product.warnings.length > 0);
});

test("fromHtml decodifica entidades del og:title cuando el estado no trae título", () => {
  const state = JSON.parse(JSON.stringify(RUN_PARAMS_STATE)) as Record<string, any>;
  delete state.data.titleModule;
  const product = unwrap(aliexpressAdapter.fromHtml(fullHtml(state)));
  assert.equal(product.title, "Vestido midi satinado & elegante | AliExpress");
});

// ────────────────────────────── fallos con pista ──────────────────────────────

test("fromHtml con basura falla con una pista accionable, no con datos vacíos", () => {
  const result = aliexpressAdapter.fromHtml(GARBAGE_HTML);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.hint ?? "", /bookmarklet|c[oó]digo fuente/i);
});

test("fromHtml con HTML vacío o cortísimo no finge éxito", () => {
  for (const html of ["", "   ", "<html></html>"]) {
    const result = aliexpressAdapter.fromHtml(html);
    assert.equal(result.ok, false, JSON.stringify(html));
    if (!result.ok) assert.ok(result.hint);
  }
});

test("fromHtml reconoce la página de captcha de AliExpress", () => {
  const result = aliexpressAdapter.fromHtml(CAPTCHA_HTML);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /verificaci[oó]n|captcha/i);
});

test("fromUrl rechaza enlaces que no son del proveedor sin salir a la red", async () => {
  const result = await aliexpressAdapter.fromUrl("https://www.alibaba.com/product-detail/x_1600123.html");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /no es de AliExpress/i);
});

// ────────────────────────────── bookmarklet ──────────────────────────────

test("fromPayload acepta el runParams que manda el bookmarklet", () => {
  const result = aliexpressAdapter.fromPayload?.({
    runParams: RUN_PARAMS_STATE,
    url: "https://www.aliexpress.com/item/1005006543210987.html",
  });
  assert.ok(result);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.product.method, "bookmarklet");
  assert.equal(result.product.title, "Vestido midi satinado de manga larga");
  assert.equal(result.product.variants.length, 4);
  assert.equal(result.product.sourceProductId, "1005006543210987");
});

test("fromPayload acepta también el HTML capturado en la página", () => {
  const result = aliexpressAdapter.fromPayload?.({ html: fullHtml(), url: "https://www.aliexpress.com/item/1005006543210987.html" });
  assert.ok(result);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.product.method, "bookmarklet");
  assert.equal(result.product.variants.length, 4);
});

test("fromPayload se queja con pista si el bookmarklet se pulsó fuera de una ficha", () => {
  const result = aliexpressAdapter.fromPayload?.({ url: "https://www.aliexpress.com/w/wholesale-vestidos.html", runParams: { data: { searchModule: {} } } });
  assert.ok(result);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.hint ?? "", /p[aá]gina del producto/i);
});

// ────────────────────────────── API oficial ──────────────────────────────

test("signTopParams firma como espera la pasarela TOP: claves ordenadas, hex en mayúsculas", () => {
  const params = { method: "aliexpress.ds.product.get", app_key: "12345", timestamp: "1700000000000", product_id: "1005006543210987" };
  const signature = signTopParams(params, "secreto");

  const expected = createHmac("sha256", "secreto")
    .update("app_key12345methodaliexpress.ds.product.getproduct_id1005006543210987timestamp1700000000000", "utf8")
    .digest("hex")
    .toUpperCase();

  assert.equal(signature, expected);
  assert.match(signature, /^[0-9A-F]{64}$/);
  // El propio `sign` nunca entra en la base de la firma.
  assert.equal(signTopParams({ ...params, sign: "loquesea" }, "secreto"), expected);
});

test("fromApi dice claramente que faltan las credenciales en vez de fallar por dentro", async () => {
  delete process.env.ALIEXPRESS_APP_KEY;
  delete process.env.ALIEXPRESS_APP_SECRET;

  const result = await fromApi("1005006543210987");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /credenciales/i);
  assert.match(result.hint ?? "", /ALIEXPRESS_APP_KEY/);
});

test("fromApi exige un id de producto aunque haya credenciales", async () => {
  const result = await fromApi("", { appKey: "k", appSecret: "s" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /id del producto/i);
});
