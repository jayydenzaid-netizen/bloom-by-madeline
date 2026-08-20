// Pruebas de la lógica de reseñas y carritos abandonados.
//
// Correr con:  npx tsx --test tests/reviews.test.ts
//
// Aquí solo se prueban las funciones puras de lib/reviews.ts: no hay base de
// datos ni red. Son justo las dos cosas que, si se rompen, mienten en la cara
// de la clienta (una nota media inflada) o hacen que Madeline escriba a alguien
// que sigue comprando ahora mismo.

import assert from "node:assert/strict";
import test from "node:test";

import {
  esCarritoAbandonado,
  fechaCorteAbandono,
  horasDesde,
  mediaPuntuaciones,
  resumirResenas,
  valorCarrito,
  HORAS_ABANDONO,
} from "@/lib/reviews";

/* ───────────────────────────── medias ───────────────────────────── */

test("la media sale con un decimal", () => {
  assert.equal(mediaPuntuaciones([5, 4]), 4.5);
  assert.equal(mediaPuntuaciones([5, 4, 4]), 4.3); // 4.333… -> 4.3
  assert.equal(mediaPuntuaciones([5]), 5);
});

test("sin reseñas la media es 0 y nunca NaN", () => {
  assert.equal(mediaPuntuaciones([]), 0);
  assert.ok(!Number.isNaN(mediaPuntuaciones([])));
});

test("los valores corruptos no envenenan la media", () => {
  assert.equal(mediaPuntuaciones([5, Number.NaN, 3]), 4);
});

test("resumir una lista sin reseñas deja media 0 y total 0", () => {
  const resumen = resumirResenas([]);
  assert.deepEqual(resumen, { media: 0, total: 0 });
});

test("las pendientes y las rechazadas NO cuentan en la media", () => {
  const resumen = resumirResenas([
    { rating: 5, status: "approved" },
    { rating: 4, status: "approved" },
    { rating: 1, status: "pending" }, // llegó por el formulario, sin moderar
    { rating: 1, status: "rejected" },
  ]);

  assert.equal(resumen.total, 2, "solo cuentan las aprobadas");
  assert.equal(resumen.media, 4.5, "el 1 pendiente no puede hundir la nota");
});

test("si todo está pendiente, el producto aparece como si no tuviera reseñas", () => {
  const resumen = resumirResenas([
    { rating: 5, status: "pending" },
    { rating: 5, status: "pending" },
  ]);
  assert.deepEqual(resumen, { media: 0, total: 0 });
});

/* ─────────────────────── carritos abandonados ─────────────────────── */

const AHORA = new Date("2026-08-19T18:00:00.000Z");

function hace(horas: number): Date {
  return new Date(AHORA.getTime() - horas * 3_600_000);
}

test("horasDesde mide en horas", () => {
  assert.equal(horasDesde(hace(3), AHORA), 3);
  assert.equal(horasDesde(hace(0.5), AHORA), 0.5);
});

test("un carrito con artículos y sin actividad reciente está abandonado", () => {
  assert.equal(
    esCarritoAbandonado({ updatedAt: hace(8), articulos: 2 }, { ahora: AHORA, horas: 6 }),
    true,
  );
});

test("un carrito tocado hace un rato todavía NO está abandonado", () => {
  assert.equal(
    esCarritoAbandonado({ updatedAt: hace(2), articulos: 2 }, { ahora: AHORA, horas: 6 }),
    false,
  );
});

test("el límite es inclusivo: justo a las horas ya cuenta", () => {
  assert.equal(
    esCarritoAbandonado({ updatedAt: hace(6), articulos: 1 }, { ahora: AHORA, horas: 6 }),
    true,
  );
});

test("un carrito vacío nunca es un carrito abandonado", () => {
  assert.equal(
    esCarritoAbandonado({ updatedAt: hace(72), articulos: 0 }, { ahora: AHORA, horas: 6 }),
    false,
  );
});

test("un carrito que acabó en pedido ya no se persigue", () => {
  assert.equal(
    esCarritoAbandonado(
      { updatedAt: hace(72), articulos: 3, recoveredOrderId: "ord_1" },
      { ahora: AHORA, horas: 6 },
    ),
    false,
  );
});

test("cambiar la antigüedad cambia el veredicto del mismo carrito", () => {
  const carrito = { updatedAt: hace(12), articulos: 1 };
  assert.equal(esCarritoAbandonado(carrito, { ahora: AHORA, horas: 6 }), true);
  assert.equal(esCarritoAbandonado(carrito, { ahora: AHORA, horas: 24 }), false);
});

test("sin opciones usa el umbral por defecto de la casa", () => {
  const justoDespues = new Date(Date.now() - (HORAS_ABANDONO + 1) * 3_600_000);
  const justoAntes = new Date(Date.now() - (HORAS_ABANDONO - 1) * 3_600_000);
  assert.equal(esCarritoAbandonado({ updatedAt: justoDespues, articulos: 1 }), true);
  assert.equal(esCarritoAbandonado({ updatedAt: justoAntes, articulos: 1 }), false);
});

test("la fecha de corte retrocede exactamente las horas pedidas", () => {
  assert.equal(fechaCorteAbandono(6, AHORA).toISOString(), "2026-08-19T12:00:00.000Z");
  assert.equal(fechaCorteAbandono(24, AHORA).toISOString(), "2026-08-18T18:00:00.000Z");
});

/* ─────────────────────── valor del carrito ─────────────────────── */

test("el valor del carrito es cantidad x precio, en centavos enteros", () => {
  assert.equal(
    valorCarrito([
      { quantity: 2, priceCents: 4599 },
      { quantity: 1, priceCents: 1250 },
    ]),
    10448,
  );
  assert.equal(valorCarrito([]), 0);
});

test("un precio o una cantidad negativa no resta del total", () => {
  assert.equal(valorCarrito([{ quantity: -3, priceCents: 4599 }]), 0);
  assert.equal(valorCarrito([{ quantity: 2, priceCents: -100 }]), 0);
});
