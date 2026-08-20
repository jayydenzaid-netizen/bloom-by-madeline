// Pruebas de la lógica de descuentos. Se ejecutan con:
//   npx tsx --test tests/discounts.test.ts
//
// No tocan la base de datos a propósito: lo que se prueba aquí es el cálculo y
// las reglas, que es donde un fallo cuesta dinero de verdad (un total negativo,
// un código caducado que sigue colando, un 20 % aplicado a media tienda).

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeDiscountCents,
  evaluateDiscount,
  generateCode,
  normalizarCodigo,
  type DescuentoBase,
  type LineaDescuento,
} from "@/lib/discounts";

/* ─────────────────────────────── fixtures ─────────────────────────────── */

/** Descuento base sano; cada prueba sobrescribe lo que le interesa. */
function descuento(cambios: Partial<DescuentoBase> = {}): DescuentoBase {
  return {
    id: "d1",
    code: "BLOOM-4K2P",
    title: "Prueba",
    type: "percentage",
    value: 20,
    minSubtotalCents: 0,
    appliesTo: "all",
    appliesToIdsJson: "[]",
    oncePerCustomer: false,
    usageLimit: 0,
    usageCount: 0,
    startsAt: null,
    endsAt: null,
    isActive: true,
    ...cambios,
  };
}

const AHORA = new Date("2026-08-19T12:00:00Z");

/* ─────────────────────────────── porcentaje ────────────────────────────── */

test("porcentaje: 20 % de $50.00 descuenta $10.00", () => {
  const d = descuento({ type: "percentage", value: 20 });
  assert.equal(computeDiscountCents(d, 5000), 1000);

  const resultado = evaluateDiscount(d, { subtotalCents: 5000, now: AHORA });
  assert.equal(resultado.ok, true);
  if (resultado.ok) {
    assert.equal(resultado.discountCents, 1000);
    assert.equal(resultado.freeShipping, false);
  }
});

test("porcentaje: un 120 % mal tecleado no puede pasar del subtotal", () => {
  const d = descuento({ type: "percentage", value: 120 });
  assert.equal(computeDiscountCents(d, 5000), 5000);
});

/* ───────────────────── importe fijo mayor que el subtotal ──────────────── */

test("importe fijo mayor que el subtotal: el total se queda en cero, nunca negativo", () => {
  const d = descuento({ type: "fixed", value: 10000 }); // $100 de descuento
  const subtotal = 4000; // ...sobre una compra de $40

  const descontado = computeDiscountCents(d, subtotal);
  assert.equal(descontado, 4000);
  assert.equal(subtotal - descontado, 0);
  assert.ok(subtotal - descontado >= 0, "el total jamás puede quedar por debajo de cero");
});

test("importe fijo normal: $15.00 sobre $60.00", () => {
  const d = descuento({ type: "fixed", value: 1500 });
  assert.equal(computeDiscountCents(d, 6000), 1500);
});

/* ───────────────────────────── envío gratis ────────────────────────────── */

test("envío gratis: no toca el subtotal, pero marca el envío como gratuito", () => {
  const d = descuento({ type: "free_shipping", value: 0 });
  assert.equal(computeDiscountCents(d, 5000), 0);

  const resultado = evaluateDiscount(d, { subtotalCents: 5000, now: AHORA });
  assert.equal(resultado.ok, true);
  if (resultado.ok) {
    assert.equal(resultado.discountCents, 0);
    assert.equal(resultado.freeShipping, true);
  }
});

/* ────────────────────────────── caducidad ──────────────────────────────── */

test("código caducado: se rechaza y el motivo dice la fecha", () => {
  const d = descuento({ endsAt: new Date("2026-08-03T23:59:59Z") });
  const resultado = evaluateDiscount(d, { subtotalCents: 5000, now: AHORA });

  assert.equal(resultado.ok, false);
  if (!resultado.ok) {
    assert.match(resultado.reason, /caduc/i);
    assert.match(resultado.reason, /agosto/i);
  }
});

test("código programado para más adelante: todavía no vale", () => {
  const d = descuento({ startsAt: new Date("2026-09-01T00:00:00Z") });
  const resultado = evaluateDiscount(d, { subtotalCents: 5000, now: AHORA });

  assert.equal(resultado.ok, false);
  if (!resultado.ok) assert.match(resultado.reason, /todavía no empieza/i);
});

/* ──────────────────────────── límite de usos ───────────────────────────── */

test("límite de usos agotado: no se puede usar una vez más", () => {
  const d = descuento({ usageLimit: 50, usageCount: 50 });
  const resultado = evaluateDiscount(d, { subtotalCents: 5000, now: AHORA });

  assert.equal(resultado.ok, false);
  if (!resultado.ok) assert.match(resultado.reason, /agot/i);
});

test("límite de usos con hueco todavía: pasa", () => {
  const d = descuento({ usageLimit: 50, usageCount: 49 });
  assert.equal(evaluateDiscount(d, { subtotalCents: 5000, now: AHORA }).ok, true);
});

/* ─────────────────────────── compra mínima ─────────────────────────────── */

test("mínimo de compra no alcanzado: se rechaza y se dice cuánto falta", () => {
  const d = descuento({ minSubtotalCents: 5000 });
  const resultado = evaluateDiscount(d, { subtotalCents: 4000, now: AHORA });

  assert.equal(resultado.ok, false);
  if (!resultado.ok) {
    assert.match(resultado.reason, /\$50\.00/);
    assert.match(resultado.reason, /\$10\.00/); // lo que le falta para llegar
  }
});

test("mínimo de compra justo alcanzado: pasa", () => {
  const d = descuento({ minSubtotalCents: 5000 });
  assert.equal(evaluateDiscount(d, { subtotalCents: 5000, now: AHORA }).ok, true);
});

/* ───────────────────── restringido a una colección ─────────────────────── */

test("descuento de colección: solo muerde las líneas de esa colección", () => {
  const d = descuento({
    type: "percentage",
    value: 20,
    appliesTo: "collection",
    appliesToIdsJson: JSON.stringify(["col-vestidos"]),
  });

  const lineas: LineaDescuento[] = [
    // $40 en vestidos (2 × $20) — sí entra
    { productId: "p1", collectionIds: ["col-vestidos"], priceCents: 2000, quantity: 2 },
    // $60 en bolsos — no entra
    { productId: "p2", collectionIds: ["col-bolsos"], priceCents: 6000, quantity: 1 },
  ];
  const subtotal = 10000;

  // 20 % de los $40 elegibles = $8.00, no 20 % de los $100 del carrito.
  assert.equal(computeDiscountCents(d, subtotal, lineas), 800);

  const resultado = evaluateDiscount(d, { subtotalCents: subtotal, lineas, now: AHORA });
  assert.equal(resultado.ok, true);
  if (resultado.ok) assert.equal(resultado.discountCents, 800);
});

test("descuento de colección sin nada de esa colección en la bolsa: se rechaza", () => {
  const d = descuento({
    appliesTo: "collection",
    appliesToIdsJson: JSON.stringify(["col-vestidos"]),
  });
  const lineas: LineaDescuento[] = [
    { productId: "p2", collectionIds: ["col-bolsos"], priceCents: 6000, quantity: 1 },
  ];

  const resultado = evaluateDiscount(d, { subtotalCents: 6000, lineas, now: AHORA });
  assert.equal(resultado.ok, false);
  if (!resultado.ok) assert.match(resultado.reason, /solo vale para algunos productos/i);
});

test("descuento de producto: un importe fijo no puede exceder lo que cuesta ese producto", () => {
  const d = descuento({
    type: "fixed",
    value: 5000, // $50 de descuento
    appliesTo: "product",
    appliesToIdsJson: JSON.stringify(["p1"]),
  });
  const lineas: LineaDescuento[] = [
    { productId: "p1", collectionIds: [], priceCents: 3000, quantity: 1 }, // $30
    { productId: "p2", collectionIds: [], priceCents: 7000, quantity: 1 },
  ];

  assert.equal(computeDiscountCents(d, 10000, lineas), 3000);
});

/* ──────────────────────── una vez por clienta ──────────────────────────── */

test("una vez por clienta: si ya lo usó, se rechaza", () => {
  const d = descuento({ oncePerCustomer: true });
  const resultado = evaluateDiscount(
    d,
    { subtotalCents: 5000, email: "ana@ejemplo.com", now: AHORA },
    { yaUsadoPorEsteEmail: true },
  );

  assert.equal(resultado.ok, false);
  if (!resultado.ok) assert.match(resultado.reason, /pedido anterior/i);
});

/* ────────────────────────── código desactivado ─────────────────────────── */

test("código desactivado a mano: deja de valer al momento", () => {
  const resultado = evaluateDiscount(descuento({ isActive: false }), { subtotalCents: 5000, now: AHORA });
  assert.equal(resultado.ok, false);
});

/* ──────────────────────── generador de códigos ─────────────────────────── */

test("generateCode: formato PREFIJO-XXXX y sin caracteres que se confundan", () => {
  for (let i = 0; i < 200; i++) {
    const codigo = generateCode("BLOOM");
    assert.match(codigo, /^BLOOM-[2-9A-Z]{4}$/);
    // O/0 e I/1 se confunden al dictarlos; L y U también, así que no salen nunca.
    assert.ok(!/[O01ILU]/.test(codigo.split("-")[1]), `código con carácter ambiguo: ${codigo}`);
  }
});

test("generateCode: el prefijo se limpia y se pone en mayúsculas", () => {
  assert.match(generateCode("verano 2026"), /^VERANO2026-[2-9A-Z]{4}$/);
  assert.match(generateCode(""), /^BLOOM-[2-9A-Z]{4}$/);
});

test("normalizarCodigo: los códigos se comparan siempre en mayúsculas", () => {
  assert.equal(normalizarCodigo("  bloom-4k2p "), "BLOOM-4K2P");
});
