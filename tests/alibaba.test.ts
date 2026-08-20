// Pruebas del adaptador de Alibaba. Se ejecutan con:
//   npx tsx --test tests/alibaba.test.ts
//
// Los HTML de aquí son reconstrucciones mínimas de las formas reales que devuelve
// Alibaba (ver lib/importers/__fixtures__/alibaba-notes.md). No se descarga nada:
// las pruebas tienen que pasar sin red y sin credenciales.

import test from "node:test";
import assert from "node:assert/strict";

import { adapter, extractPriceLadder, formatLadder, normalizeAlibabaImageUrl } from "@/lib/importers/alibaba";
import { applyPricing, DEFAULT_PRICING } from "@/lib/money";

// ───────────────────────────── fixtures ─────────────────────────────

/** Ficha B2B típica: escalera de 3 tramos, MOQ 100, dos ejes de variante. */
function htmlConEscalera(): string {
  const detail = {
    globalData: {
      product: {
        productId: 1600891234567,
        subject: "Vestido midi floral de gasa para mujer, manga larga",
        companyName: "Guangzhou Lianhe Garment Co., Ltd.",
        productUnit: "piezas",
        minOrderQuantity: 100,
        currency: "USD",
        images: [
          "//sc04.alicdn.com/kf/Hab1c2d3e4.jpg_720x720q50.jpg",
          "https://sc04.alicdn.com/kf/Hff9e8d7c6_640x640.jpg",
        ],
        productLadderPrices: [
          { min: 100, max: 499, price: "12.50" },
          { min: 500, max: 999, price: "10.80" },
          { min: 1000, price: "9.20" },
        ],
        productAttributes: [
          { attrName: "Material", attrValue: "100% poliéster" },
          { attrName: "Estilo", attrValue: "Casual elegante" },
        ],
        skuProps: [
          { name: "Color", values: ["Rojo", "Azul"] },
          { name: "Talla", values: ["S", "M", "L"] },
        ],
      },
    },
  };
  return `<!doctype html><html><head><title>Vestido</title></head><body>
    <div id="app"></div>
    <script>window.detailData = ${JSON.stringify(detail)};</script>
  </body></html>`;
}

/** Misma ficha pero comprable de a poco: MOQ 2, un solo tramo. */
function htmlMoqBajo(): string {
  const detail = {
    product: {
      subject: "Bolso de mano de piel sintética",
      productUnit: "piezas",
      minOrderQuantity: 2,
      ladderPrices: [{ min: 2, price: "8.40" }],
      images: ["https://sc04.alicdn.com/kf/H1234567890.jpg"],
    },
  };
  return `<html><body><script>window.__INIT_DATA__ = ${JSON.stringify(detail)};</script></body></html>`;
}

// ───────────────────────────── extractId / matches ─────────────────────────────

test("extractId reconoce las formas de URL de Alibaba", () => {
  const casos: [string, string | null][] = [
    ["https://www.alibaba.com/product-detail/Womens-Summer-Floral-Dress_1600891234567.html", "1600891234567"],
    ["https://spanish.alibaba.com/product-detail/vestido-midi_1600891234567.html?spm=a2700.details", "1600891234567"],
    ["https://www.alibaba.com/p-detail/Dress-1600891234567.html", "1600891234567"],
    ["https://m.alibaba.com/product/1600891234567.html", "1600891234567"],
    ["https://www.alibaba.com/product-detail/algo.html?productId=1600891234567", "1600891234567"],
    ["www.alibaba.com/product-detail/Dress_1600891234567.html", "1600891234567"],
    ["https://www.aliexpress.com/item/1005006123456789.html", null],
    ["esto no es una url", null],
  ];
  for (const [url, esperado] of casos) {
    assert.equal(adapter.extractId(url), esperado, url);
  }
});

test("matches solo acepta dominios de Alibaba", () => {
  assert.equal(adapter.matches("https://www.alibaba.com/product-detail/x_1600891234567.html"), true);
  assert.equal(adapter.matches("https://spanish.alibaba.com/product-detail/x_1600891234567.html"), true);
  assert.equal(adapter.matches("https://notalibaba.com/product-detail/x.html"), false);
  assert.equal(adapter.matches("https://www.aliexpress.com/item/1.html"), false);
  assert.equal(adapter.matches(""), false);
});

// ───────────────────────────── escalera de precios ─────────────────────────────

test("la escalera de varios tramos se lee entera y el coste es el del primer tramo", () => {
  const result = adapter.fromHtml(
    htmlConEscalera(),
    "https://www.alibaba.com/product-detail/Vestido_1600891234567.html",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const product = result.product;

  assert.equal(product.provider, "alibaba");
  assert.equal(product.sourceProductId, "1600891234567");
  assert.match(product.title, /Vestido midi floral/);

  // El coste comprable es el del primer tramo, no el del último (más barato).
  assert.equal(product.costCentsMin, 1250);
  assert.equal(product.costCentsMax, 1250);
  assert.equal(product.variants[0].costCents, 1250);
  assert.equal(product.variants[0].priceCents, applyPricing(1250, DEFAULT_PRICING));

  // La escalera completa queda visible en la ficha técnica.
  assert.equal(
    product.attributes["Precio por cantidad"],
    "100–499 piezas: $12.50 · 500–999 piezas: $10.80 · 1000+ piezas: $9.20",
  );
  assert.equal(product.attributes["Pedido mínimo"], "100 piezas");
  assert.equal(product.attributes["Material"], "100% poliéster");

  // Y se avisa de que el precio es por tramos.
  assert.ok(product.warnings.some((warning) => /tramos/i.test(warning)), product.warnings.join(" | "));

  // Variantes: producto cartesiano de los dos ejes.
  assert.deepEqual(product.optionNames, ["Color", "Talla"]);
  assert.equal(product.variants.length, 6);
  assert.equal(product.variants[0].title, "Rojo / S");

  // Imágenes en https y sin sufijo de miniatura.
  assert.deepEqual(
    product.images.map((image) => image.url),
    ["https://sc04.alicdn.com/kf/Hab1c2d3e4.jpg", "https://sc04.alicdn.com/kf/Hff9e8d7c6.jpg"],
  );
});

test("extractPriceLadder entiende la escalera como mapa de rangos", () => {
  const tiers = extractPriceLadder({ skuPriceLadder: { "1-49": "12.50", "50-99": "US $11.20", "100+": 9.9 } });
  assert.deepEqual(tiers, [
    { minQuantity: 1, maxQuantity: 49, priceCents: 1250 },
    { minQuantity: 50, maxQuantity: 99, priceCents: 1120 },
    { minQuantity: 100, maxQuantity: null, priceCents: 990 },
  ]);
  assert.equal(formatLadder(tiers), "1–49 uds: $12.50 · 50–99 uds: $11.20 · 100+ uds: $9.90");
});

test("extractPriceLadder devuelve vacío cuando no hay nada que parezca una escalera", () => {
  assert.deepEqual(extractPriceLadder({ titulo: "hola", relacionados: [{ nombre: "otro" }] }), []);
  assert.deepEqual(extractPriceLadder(null), []);
});

// ───────────────────────────── MOQ ─────────────────────────────

test("un MOQ alto genera aviso; uno bajo no", () => {
  const alto = adapter.fromHtml(htmlConEscalera());
  assert.equal(alto.ok, true);
  if (!alto.ok) return;
  const avisoAlto = alto.product.warnings.find((warning) => warning.includes("Pedido mínimo alto"));
  assert.ok(avisoAlto, alto.product.warnings.join(" | "));
  assert.match(avisoAlto ?? "", /100 piezas/);

  const bajo = adapter.fromHtml(htmlMoqBajo());
  assert.equal(bajo.ok, true);
  if (!bajo.ok) return;
  assert.equal(bajo.product.attributes["Pedido mínimo"], "2 piezas");
  assert.equal(
    bajo.product.warnings.some((warning) => warning.includes("Pedido mínimo alto")),
    false,
  );
  assert.equal(bajo.product.costCentsMin, 840);
});

test("el MOQ se rescata del texto visible cuando no está en el JSON", () => {
  const html = `<html><head>
      <meta property="og:title" content="Blusa de seda para mujer" />
      <meta property="og:image" content="//sc04.alicdn.com/kf/Hzzz111.jpg_350x350.jpg" />
    </head><body><div class="moq">Min. Order: 1,000 Pieces</div></body></html>`;
  const result = adapter.fromHtml(html, "https://www.alibaba.com/product-detail/Blusa_1600000000123.html");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.product.attributes["Pedido mínimo"], "1000 uds");
  assert.ok(result.product.warnings.some((warning) => warning.includes("Pedido mínimo alto")));
  assert.equal(result.product.images[0].url, "https://sc04.alicdn.com/kf/Hzzz111.jpg");
});

// ───────────────────────────── fallos honestos ─────────────────────────────

test("un HTML sin datos reconocibles falla con una pista accionable", () => {
  const result = adapter.fromHtml("<!doctype html><html><body><h1>Página cualquiera</h1></body></html>");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /No se reconoció/);
  assert.ok(result.hint && result.hint.length > 0);
  assert.match(result.hint ?? "", /bookmarklet/i);
});

test("el HTML vacío no revienta", () => {
  const result = adapter.fromHtml("");
  assert.equal(result.ok, false);
});

test("se detecta la página de verificación de Alibaba en vez de fingir un producto", () => {
  const html = `<html><body><div id="_____tmd_____"><p>Please slide to verify</p></div></body></html>`;
  const result = adapter.fromHtml(html);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /verificaci[óo]n/i);
});

test("fromApi sin credenciales lo dice claro en vez de fallar en silencio", async () => {
  const key = process.env.ALIBABA_APP_KEY;
  const secret = process.env.ALIBABA_APP_SECRET;
  delete process.env.ALIBABA_APP_KEY;
  delete process.env.ALIBABA_APP_SECRET;
  try {
    const result = await adapter.fromApi("1600891234567");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /credenciales/i);
    assert.match(result.hint ?? "", /ALIBABA_APP_KEY/);
  } finally {
    if (key !== undefined) process.env.ALIBABA_APP_KEY = key;
    if (secret !== undefined) process.env.ALIBABA_APP_SECRET = secret;
  }
});

// ───────────────────────────── vías alternativas ─────────────────────────────

test("el JSON-LD sirve de red de seguridad y avisa de lo que le falta", () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Conjunto de dos piezas de lino",
    image: ["https://sc04.alicdn.com/kf/Hlino123.jpg_720x720q50.jpg"],
    description: "<p>Conjunto de lino para verano</p>",
    brand: { "@type": "Brand", name: "OEM" },
    offers: { "@type": "AggregateOffer", lowPrice: "7.90", highPrice: "11.30", priceCurrency: "USD" },
  })}</script></head><body></body></html>`;

  const result = adapter.fromHtml(html, "https://www.alibaba.com/product-detail/Conjunto_1600555444333.html");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.product.title, "Conjunto de dos piezas de lino");
  assert.equal(result.product.sourceProductId, "1600555444333");
  assert.equal(result.product.costCentsMin, 790);
  assert.equal(result.product.description, "Conjunto de lino para verano");
  assert.equal(result.product.images[0].url, "https://sc04.alicdn.com/kf/Hlino123.jpg");
  assert.ok(result.product.warnings.some((warning) => /JSON-LD/.test(warning)));
});

test("fromPayload acepta lo que manda el bookmarklet", () => {
  const payload = {
    url: "https://www.alibaba.com/product-detail/Falda_1600777888999.html",
    data: {
      product: {
        subject: "Falda plisada midi de mujer",
        productUnit: "piezas",
        minOrderQuantity: 5,
        ladderPrices: [{ min: 5, max: 99, price: "6.30" }],
        images: ["https://sc04.alicdn.com/kf/Hfalda99.jpg"],
      },
    },
  };
  const result = adapter.fromPayload ? adapter.fromPayload(payload) : { ok: false as const, error: "sin fromPayload" };
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.product.method, "bookmarklet");
  assert.equal(result.product.sourceProductId, "1600777888999");
  assert.equal(result.product.costCentsMin, 630);
  assert.equal(result.product.variants.length, 1);
  assert.equal(result.product.variants[0].title, "Único");
});

test("fromPayload no revienta con basura", () => {
  assert.equal(adapter.fromPayload?.(null).ok, false);
  assert.equal(adapter.fromPayload?.(42).ok, false);
  assert.equal(adapter.fromPayload?.({ nada: true }).ok, false);
});

// ───────────────────────────── imágenes ─────────────────────────────

test("las imágenes de alicdn quedan en https y a tamaño completo", () => {
  assert.equal(
    normalizeAlibabaImageUrl("//sc04.alicdn.com/kf/Habc.jpg_720x720q50.jpg"),
    "https://sc04.alicdn.com/kf/Habc.jpg",
  );
  assert.equal(normalizeAlibabaImageUrl("http://sc04.alicdn.com/kf/Habc.jpg_.webp"), "https://sc04.alicdn.com/kf/Habc.jpg");
  assert.equal(normalizeAlibabaImageUrl("https://sc04.alicdn.com/kf/Habc_640x640.jpg"), "https://sc04.alicdn.com/kf/Habc.jpg");
  assert.equal(normalizeAlibabaImageUrl("https://sc04.alicdn.com/kf/Habc.jpg?x=1"), "https://sc04.alicdn.com/kf/Habc.jpg");
  // Fuera de alicdn el sufijo puede ser parte del nombre real: no se toca.
  assert.equal(normalizeAlibabaImageUrl("https://otro.cdn.com/foto_640x640.jpg"), "https://otro.cdn.com/foto_640x640.jpg");
  assert.equal(normalizeAlibabaImageUrl("javascript:alert(1)"), null);
  assert.equal(normalizeAlibabaImageUrl(""), null);
  assert.equal(normalizeAlibabaImageUrl(null), null);
});
