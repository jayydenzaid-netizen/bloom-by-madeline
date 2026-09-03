// Pruebas de los enlaces del menú y de la escasez de la portada. Se ejecutan con:
//   npx tsx --test tests/navegacion.test.ts
//
// Todo lo de aquí es lógica pura: nada toca la base de datos.

import test from "node:test";
import assert from "node:assert/strict";

import { anclasDePortada, ANCLAS_PORTADA, type KindOrdenable } from "@/lib/home-content";
import { MENU_PRINCIPAL_POR_DEFECTO } from "@/lib/navegacion";
import { elegirEscasas, type CandidataEscasez } from "@/lib/escasez";

/* ───────────────────────── anclas de la portada ───────────────────────── */

/** El orden que devuelve `cargarPortada` con la portada tal y como está hoy. */
const HOY: KindOrdenable[] = ["coleccion", "cita", "exclusividad", "boutique", "comoComprar", "visitanos", "instagram"];

test("el ancla de una sección apagada no cuenta como viva", () => {
  // Filosofía no está en el orden: está apagada desde /admin/contenido.
  const estados = anclasDePortada(HOY, true);
  assert.equal(estados.get("filosofia"), "apagada");
  assert.equal(estados.get("boutique"), "viva");
});

test("la sección de escasez se cae sola cuando no queda nada por agotarse", () => {
  assert.equal(anclasDePortada(HOY, true).get("escasez"), "viva");
  assert.equal(anclasDePortada(HOY, false).get("escasez"), "vacia");
});

test("apagada gana a vacía: si el bloque está apagado, ese es el motivo", () => {
  const sinExclusividad = HOY.filter((k) => k !== "exclusividad");
  assert.equal(anclasDePortada(sinExclusividad, false).get("escasez"), "apagada");
});

test("el hero no depende de ningún bloque: su ancla vive siempre", () => {
  assert.equal(anclasDePortada([], false).get("inicio"), "viva");
});

test("toda ancla del menú por defecto existe en el registro de la portada", () => {
  // El fallo que motivó todo esto: el menú apuntaba a `#filosofia` cuando esa
  // sección ya no se pintaba. Si alguien añade un enlace a una sección que no
  // tiene `id`, salta aquí y no en la cara de una clienta.
  const conocidas = new Set(ANCLAS_PORTADA.map((a) => a.ancla));
  for (const enlace of MENU_PRINCIPAL_POR_DEFECTO) {
    if (!enlace.href.startsWith("/#")) continue;
    assert.ok(
      conocidas.has(enlace.href.slice(2)),
      `El menú enlaza a ${enlace.href} y ninguna sección de la portada pinta ese id`,
    );
  }
});

test("el menú por defecto sigue ofreciendo la tienda pase lo que pase", () => {
  assert.ok(MENU_PRINCIPAL_POR_DEFECTO.some((e) => e.href === "/tienda"));
});

/* ───────────────────────── piezas que vuelan ───────────────────────── */

function prenda(over: Partial<CandidataEscasez> = {}): CandidataEscasez {
  return {
    slug: "vestido-amapola",
    title: "Vestido Amapola",
    priceCents: 4599,
    compareAtCents: null,
    images: [{ url: "/uploads/amapola.jpg" }],
    variants: [
      { option1: "S", stock: 1, trackStock: true },
      { option1: "M", stock: 1, trackStock: true },
    ],
    ...over,
  };
}

test("suma las unidades de todas las tallas y solo lista las tallas con stock", () => {
  const [pieza] = elegirEscasas(
    [
      prenda({
        variants: [
          { option1: "S", stock: 2, trackStock: true },
          { option1: "M", stock: 0, trackStock: true },
          { option1: "L", stock: 1, trackStock: true },
        ],
      }),
    ],
    3,
  );
  assert.equal(pieza.quedan, 3);
  assert.equal(pieza.tallas, "S · L");
});

test("una prenda sin control de stock nunca sale: no sabemos cuántas quedan", () => {
  const sinControl = prenda({ variants: [{ option1: "S", stock: 0, trackStock: false }] });
  assert.deepEqual(elegirEscasas([sinControl], 3), []);
});

test("agotada no es escasa, y por encima del umbral tampoco", () => {
  const agotada = prenda({ variants: [{ option1: "S", stock: 0, trackStock: true }] });
  const desahogada = prenda({ variants: [{ option1: "S", stock: 9, trackStock: true }] });
  assert.deepEqual(elegirEscasas([agotada, desahogada], 3), []);
});

test("primero la que menos queda, y como mucho cuatro", () => {
  const con = (slug: string, stock: number) =>
    prenda({ slug, variants: [{ option1: "S", stock, trackStock: true }] });
  const salida = elegirEscasas([con("a", 3), con("b", 1), con("c", 2), con("d", 3), con("e", 1)], 3);
  assert.equal(salida.length, 4);
  assert.deepEqual(salida.map((p) => p.quedan), [1, 1, 2, 3]);
});

test("una prenda sin foto entra igual, con imageUrl a null", () => {
  const [pieza] = elegirEscasas([prenda({ images: [] })], 3);
  assert.equal(pieza.imageUrl, null);
});
