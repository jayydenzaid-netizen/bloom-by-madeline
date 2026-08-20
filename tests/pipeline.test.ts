// Pruebas del motor de importación. Se ejecutan con:
//   npx tsx --test tests/pipeline.test.ts
//
// Lo que se prueba aquí es lo que, si se rompe, se rompe en silencio: precios mal
// calculados, un producto duplicado que nadie nota hasta que hay dos fichas, un
// CSV mal partido por una coma dentro de una descripción, o un nombre de fichero
// del proveedor escribiendo fuera de public/uploads.
//
// Solo la prueba de deduplicación toca la base de datos; si no hay una disponible
// se salta en vez de fallar, para que otro agente reconstruyendo dev.db no rompa
// la batería entera.

import test from "node:test";
import assert from "node:assert/strict";

import { applyPricing, DEFAULT_PRICING, type PricingRule } from "@/lib/money";
import { applyPricingToDraft, decideDuplicate, safeImageFileName, prepareVariants } from "@/lib/importers/pipeline";
import { parseCsv, parseProductCsv, csvEscape, productsToShopifyCsv, SHOPIFY_COLUMNS } from "@/lib/importers/csv";
import { emptyProduct, type NormalizedProduct } from "@/lib/importers/types";

// ─────────────────────────────── fixtures ───────────────────────────────

function draftConVariantes(): NormalizedProduct {
  const product = emptyProduct("aliexpress", "bookmarklet");
  product.title = "Vestido midi de gasa";
  product.sourceProductId = "1005006123456789";
  product.sourceUrl = "https://www.aliexpress.com/item/1005006123456789.html";
  product.optionNames = ["Talla", "Color"];
  product.costCentsMin = 890;
  product.costCentsMax = 1240;
  product.variants = [
    { title: "S / Negro", optionValues: ["S", "Negro"], costCents: 890, priceCents: null },
    { title: "M / Negro", optionValues: ["M", "Negro"], costCents: 1240, priceCents: null },
    // Sin coste propio: tiene que heredar el costCentsMin del producto.
    { title: "L / Negro", optionValues: ["L", "Negro"], costCents: null, priceCents: null },
  ];
  return product;
}

// ──────────────────────── 1. precios sobre el borrador ────────────────────────

test("applyPricingToDraft calcula el precio de cada variante desde su coste", () => {
  const draft = draftConVariantes();
  const conPrecio = applyPricingToDraft(draft, DEFAULT_PRICING);

  assert.equal(conPrecio.variants[0].priceCents, applyPricing(890, DEFAULT_PRICING));
  assert.equal(conPrecio.variants[1].priceCents, applyPricing(1240, DEFAULT_PRICING));

  // Regla por defecto: x2.6 + $5.00 redondeado a .99 → 890 -> 2314+500 = 2814 -> 2899.
  assert.equal(conPrecio.variants[0].priceCents, 2899);
  // Y el redondeo psicológico deja todos los precios acabados en 99.
  for (const variant of conPrecio.variants) {
    assert.equal((variant.priceCents ?? 0) % 100, 99, `precio no acabado en .99: ${variant.priceCents}`);
  }
});

test("una variante sin coste hereda el costCentsMin del producto", () => {
  const draft = draftConVariantes();
  const conPrecio = applyPricingToDraft(draft, DEFAULT_PRICING);

  assert.equal(conPrecio.variants[2].costCents, 890);
  assert.equal(conPrecio.variants[2].priceCents, applyPricing(890, DEFAULT_PRICING));
});

test("sin ningún coste el precio se queda a null y se avisa, no se inventa", () => {
  const draft = emptyProduct("alibaba", "html");
  draft.title = "Bolso sin precio";
  draft.variants = [{ title: "Único", optionValues: [], costCents: null, priceCents: null }];

  const conPrecio = applyPricingToDraft(draft, DEFAULT_PRICING);
  assert.equal(conPrecio.variants[0].priceCents, null);
  assert.ok(conPrecio.warnings.some((warning) => warning.includes("coste")));
});

test("applyPricingToDraft devuelve una copia y no toca el borrador original", () => {
  const draft = draftConVariantes();
  const antes = JSON.stringify(draft);

  const regla: PricingRule = { multiplier: 3, addCents: 0, rounding: "none" };
  const primera = applyPricingToDraft(draft, regla);
  // Recalcular sobre el MISMO borrador tiene que dar lo mismo: si mutara, la
  // segunda pasada multiplicaría el precio ya inflado.
  const segunda = applyPricingToDraft(draft, regla);

  assert.equal(JSON.stringify(draft), antes, "el borrador original fue mutado");
  assert.deepEqual(primera.variants.map((v) => v.priceCents), segunda.variants.map((v) => v.priceCents));
  assert.notEqual(primera.variants, draft.variants);
});

test("prepareVariants respeta los descartes y los precios editados a mano", () => {
  const draft = applyPricingToDraft(draftConVariantes(), DEFAULT_PRICING);
  const rows = prepareVariants(draft, {
    dropVariantIndexes: [1],
    variantOverrides: { 0: { priceCents: 3500 } },
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].priceCents, 3500);
  assert.equal(rows[0].option1, "S");
  assert.equal(rows[0].option2, "Negro");
  // Dropshipping: sin control de stock salvo que se pida.
  assert.equal(rows[0].trackStock, false);
  assert.deepEqual(rows.map((row) => row.position), [0, 1]);
});

test("un producto sin variantes recibe una variante única para poder venderse", () => {
  const draft = emptyProduct("csv", "csv");
  draft.title = "Pañuelo";
  const rows = prepareVariants(draft);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Único");
});

// ─────────────────────────── 2. deduplicación ───────────────────────────

test("decideDuplicate frena cuando el producto ya está en el catálogo", () => {
  const existente = { id: "prod_1", slug: "vestido-midi", title: "Vestido midi", status: "active" };

  const frenado = decideDuplicate(existente);
  assert.equal(frenado.duplicate, true);
  assert.ok(frenado.error.includes("Vestido midi"));
  assert.ok(frenado.hint.length > 0, "un duplicado sin salida deja a la usuaria atascada");

  assert.equal(decideDuplicate(existente, true).duplicate, false, "allowDuplicate tiene que dejar pasar");
  assert.equal(decideDuplicate(null).duplicate, false);
});

test("findProductBySource encuentra el producto por sourceProvider + sourceProductId", async (t) => {
  const { db } = await import("@/lib/db");
  const { findProductBySource } = await import("@/lib/importers/pipeline");

  const marca = `test-dedupe-${Date.now()}`;
  let creado: { id: string } | null = null;

  try {
    creado = await db.product.create({
      data: {
        slug: marca,
        title: "Producto de prueba de deduplicación",
        sourceProvider: "aliexpress",
        sourceProductId: marca,
      },
      select: { id: true },
    });
  } catch {
    t.skip("no hay base de datos disponible en este entorno");
    return;
  }

  try {
    const encontrado = await findProductBySource("aliexpress", marca);
    assert.ok(encontrado, "no encontró el producto recién creado");
    assert.equal(encontrado?.id, creado.id);

    // El mismo id pero de otro proveedor NO es el mismo producto.
    assert.equal(await findProductBySource("alibaba", marca), null);
    assert.equal(await findProductBySource("aliexpress", null), null);
  } finally {
    await db.product.delete({ where: { id: creado.id } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});

// ────────────────────────────── 3. CSV ──────────────────────────────

test("parseCsv respeta comas, comillas y saltos de línea dentro de un campo", () => {
  const csv = [
    'handle,title,description,price',
    'vestido-coral,"Vestido coral, midi","Tela ligera, con forro y ""acabado premium""",45.99',
    'blusa-lino,Blusa de lino,"Cuello alto',
    'manga larga",29.50',
  ].join("\n");

  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);

  assert.deepEqual(rows[1], [
    "vestido-coral",
    "Vestido coral, midi",
    'Tela ligera, con forro y "acabado premium"',
    "45.99",
  ]);

  // El salto de línea dentro de las comillas NO parte la fila.
  assert.equal(rows[2].length, 4);
  assert.equal(rows[2][2], "Cuello alto\nmanga larga");
  assert.equal(rows[2][3], "29.50");
});

test("parseCsv aguanta el BOM de Excel y los finales de línea de Windows", () => {
  const rows = parseCsv('﻿handle,title\r\nfalda-lino,Falda de lino\r\n');
  assert.equal(rows[0][0], "handle");
  assert.deepEqual(rows[1], ["falda-lino", "Falda de lino"]);
});

test("parseProductCsv agrupa variantes y fotos bajo el mismo producto", () => {
  const csv = [
    "handle,title,description,option1_name,option1_value,option2_name,option2_value,price,cost,sku,image_url",
    'vestido-coral,"Vestido coral","Ligero, con forro",Talla,S,Color,Coral,45.99,12.00,VC-S,https://cdn.test/1.jpg',
    "vestido-coral,,,,M,,Coral,45.99,12.00,VC-M,https://cdn.test/2.jpg",
    "vestido-coral,,,,,,,,,,https://cdn.test/3.jpg",
  ].join("\n");

  const { products, errors } = parseProductCsv(csv);
  assert.deepEqual(errors, []);
  assert.equal(products.length, 1);

  const product = products[0];
  assert.equal(product.title, "Vestido coral");
  assert.equal(product.description, "Ligero, con forro");
  assert.deepEqual(product.optionNames, ["Talla", "Color"]);
  assert.equal(product.variants.length, 2, "la fila que solo trae foto no es una variante");
  assert.equal(product.variants[0].priceCents, 4599);
  assert.equal(product.variants[0].costCents, 1200);
  assert.equal(product.variants[1].optionValues[0], "M");
  assert.equal(product.images.length, 3);
  assert.equal(product.costCentsMin, 1200);
});

test("parseProductCsv entiende las cabeceras de la plantilla de Shopify", () => {
  const csv = [
    "Handle,Title,Body (HTML),Vendor,Option1 Name,Option1 Value,Variant SKU,Variant Price,Cost per item,Image Src",
    'blusa-seda,Blusa de seda,"Suave, fluida",Bloom,Talla,S,BS-S,38.00,9.50,https://cdn.test/b1.jpg',
  ].join("\n");

  const { products, errors } = parseProductCsv(csv);
  assert.deepEqual(errors, []);
  assert.equal(products[0].title, "Blusa de seda");
  assert.equal(products[0].variants[0].priceCents, 3800);
  assert.equal(products[0].variants[0].costCents, 950);
});

test("csvEscape entrecomilla lo que rompería la siguiente lectura", () => {
  assert.equal(csvEscape("simple"), "simple");
  assert.equal(csvEscape("con, coma"), '"con, coma"');
  assert.equal(csvEscape('con "comillas"'), '"con ""comillas"""');
  assert.equal(csvEscape("con\nsalto"), '"con\nsalto"');
  assert.equal(csvEscape(null), "");
});

test("la exportación a Shopify vuelve a leerse sin perder nada", () => {
  const csv = productsToShopifyCsv([
    {
      slug: "vestido-coral",
      title: "Vestido coral, midi",
      description: 'Tela ligera con "acabado premium"',
      status: "active",
      vendor: "Bloom by Madeline",
      productType: "Vestidos",
      tagsJson: JSON.stringify(["verano", "coral"]),
      optionNamesJson: JSON.stringify(["Talla"]),
      seoTitle: null,
      seoDescription: null,
      images: [{ url: "https://cdn.test/1.jpg", alt: "Vestido coral", position: 0, localPath: null }],
      variants: [
        {
          title: "S",
          sku: "VC-S",
          option1: "S",
          option2: null,
          option3: null,
          priceCents: 4599,
          compareAtCents: null,
          costCents: 1200,
          stock: 0,
          trackStock: false,
          weightGrams: 250,
          imageUrl: null,
          position: 0,
        },
      ],
    },
  ]);

  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], [...SHOPIFY_COLUMNS]);
  // El título con coma y la descripción con comillas sobreviven al viaje.
  assert.equal(rows[1][1], "Vestido coral, midi");
  assert.equal(rows[1][2], 'Tela ligera con "acabado premium"');
  // Shopify escribe dólares, no centavos.
  assert.equal(rows[1][SHOPIFY_COLUMNS.indexOf("Variant Price")], "45.99");
  assert.equal(rows[1][SHOPIFY_COLUMNS.indexOf("Cost per item")], "12.00");
  // Sin control de stock se vende igual: "continue".
  assert.equal(rows[1][SHOPIFY_COLUMNS.indexOf("Variant Inventory Policy")], "continue");
});

// ───────────────── 4. nombres de fichero de imagen ─────────────────

test("safeImageFileName nunca deja escapar la ruta del proveedor", () => {
  const nombre = safeImageFileName(
    "https://ae01.alicdn.com/../../../etc/passwd.jpg?x=1",
    "../../evil",
    0,
    "image/jpeg",
  );

  assert.ok(!nombre.includes("/"), `hay una barra en el nombre: ${nombre}`);
  assert.ok(!nombre.includes("\\"), `hay una contrabarra en el nombre: ${nombre}`);
  assert.ok(!nombre.includes(".."), `hay un salto de directorio en el nombre: ${nombre}`);
  assert.ok(!nombre.includes("passwd"), "el nombre no debe copiar texto del proveedor");
  assert.ok(nombre.endsWith(".jpg"));
  assert.match(nombre, /^[a-z0-9-]+\.[a-z0-9]{2,5}$/);
});

test("safeImageFileName saca la extensión del content-type y si no, de la URL", () => {
  assert.ok(safeImageFileName("https://cdn.test/a", "prod1", 0, "image/webp").endsWith(".webp"));
  assert.ok(safeImageFileName("https://cdn.test/a.png?v=2", "prod1", 0, null).endsWith(".png"));
  // Extensión desconocida o peligrosa: se cae a jpg, nunca se copia tal cual.
  assert.ok(safeImageFileName("https://cdn.test/a.php", "prod1", 0, null).endsWith(".jpg"));
  assert.ok(safeImageFileName("https://cdn.test/a.svg", "prod1", 0, "text/html").endsWith(".jpg"));
});

test("safeImageFileName es estable para la misma URL y distinto para otra", () => {
  const a = safeImageFileName("https://cdn.test/foto.jpg", "prod1", 0, "image/jpeg");
  const b = safeImageFileName("https://cdn.test/foto.jpg", "prod1", 0, "image/jpeg");
  const c = safeImageFileName("https://cdn.test/otra.jpg", "prod1", 0, "image/jpeg");

  assert.equal(a, b, "re-descargar la misma foto no debe duplicar ficheros");
  assert.notEqual(a, c);
  // La posición va en el nombre para que el orden se conserve en el disco.
  assert.ok(a.includes("-01-"));
  assert.ok(safeImageFileName("https://cdn.test/foto.jpg", "prod1", 9, "image/jpeg").includes("-10-"));
});
