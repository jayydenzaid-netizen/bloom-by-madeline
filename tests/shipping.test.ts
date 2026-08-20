import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AjustesEnvio,
  type ZonaEnvio,
  elegirZona,
  especificidadZona,
  formatearTipo,
  IMPUESTOS_POR_DEFECTO,
  parsearRegiones,
  plantillaZonasIniciales,
  resolverEnvio,
  resolverImpuesto,
  tarifasQueEncajan,
  tipoAPuntosBasicos,
} from "../lib/shipping";

/* ───────────────────────────── utilidades ───────────────────────────── */

const AJUSTES: AjustesEnvio = {
  freeShippingOverCents: 7500,
  flatShippingCents: 695,
  localPickup: true,
  shippingNotice: "Los pedidos salen en 1–2 días hábiles.",
};

function zona(
  id: string,
  name: string,
  regions: string[],
  rates: Array<Partial<ZonaEnvio["rates"][number]> & { name: string; priceCents: number }>,
  position = 0,
): ZonaEnvio {
  return {
    id,
    name,
    regions,
    position,
    rates: rates.map((r, i) => ({
      id: `${id}-r${i}`,
      name: r.name,
      priceCents: r.priceCents,
      minSubtotalCents: r.minSubtotalCents ?? 0,
      maxSubtotalCents: r.maxSubtotalCents ?? 0,
      etaLabel: r.etaLabel ?? "",
      position: r.position ?? i,
    })),
  };
}

const OHIO = zona("z-oh", "Ohio", ["US-OH"], [{ name: "Ohio en 2 días", priceCents: 450 }], 0);
const USA = zona("z-us", "Estados Unidos", ["US"], [{ name: "Estándar", priceCents: 695 }], 1);
const RECOGIDA = zona("z-pk", "Recogida", ["PICKUP"], [{ name: "Recoger en la boutique", priceCents: 0 }], 2);

/* ───────────────────────── elección de zona ───────────────────────── */

test("la zona más concreta gana a la más amplia", () => {
  const elegida = elegirZona([USA, OHIO], { state: "OH", country: "US" });
  assert.equal(elegida?.id, "z-oh", "para una clienta de Ohio debe ganar la zona de Ohio");
});

test("fuera del estado cae en la zona del país", () => {
  const elegida = elegirZona([USA, OHIO], { state: "CA", country: "US" });
  assert.equal(elegida?.id, "z-us");
});

test("un destino que ninguna zona cubre no elige zona", () => {
  const soloOhio = elegirZona([OHIO], { state: "CA", country: "US" });
  assert.equal(soloOhio, null);
});

test("el nombre del estado vale igual que su código", () => {
  assert.equal(especificidadZona(OHIO, { state: "Ohio" }), 3);
  assert.equal(especificidadZona(OHIO, { state: "US-OH" }), 3);
  assert.equal(especificidadZona(OHIO, { state: "oh" }), 3);
});

/* ───────────────────────── tramos de subtotal ───────────────────────── */

test("cada tarifa solo aparece dentro de su tramo", () => {
  const escalonada = zona("z", "Con tramos", ["US"], [
    { name: "Pequeños", priceCents: 695, minSubtotalCents: 0, maxSubtotalCents: 4999 },
    { name: "Medianos", priceCents: 395, minSubtotalCents: 5000, maxSubtotalCents: 9999 },
    { name: "Grandes", priceCents: 0, minSubtotalCents: 10000 },
  ]);

  assert.deepEqual(tarifasQueEncajan(escalonada, 2500).map((t) => t.name), ["Pequeños"]);
  assert.deepEqual(tarifasQueEncajan(escalonada, 7000).map((t) => t.name), ["Medianos"]);
  assert.deepEqual(tarifasQueEncajan(escalonada, 15000).map((t) => t.name), ["Grandes"]);
});

test("los bordes del tramo se incluyen, no se escapan por un centavo", () => {
  const t = zona("z", "z", ["US"], [
    { name: "Tramo", priceCents: 500, minSubtotalCents: 5000, maxSubtotalCents: 9999 },
  ]);
  assert.equal(tarifasQueEncajan(t, 4999).length, 0);
  assert.equal(tarifasQueEncajan(t, 5000).length, 1);
  assert.equal(tarifasQueEncajan(t, 9999).length, 1);
  assert.equal(tarifasQueEncajan(t, 10000).length, 0);
});

/* ───────────────────────── envío gratis ───────────────────────── */

test("por encima del umbral el envío sale gratis", () => {
  const res = resolverEnvio(9000, { state: "OH" }, { zonas: [OHIO, RECOGIDA], ajustes: AJUSTES });
  const envio = res.opciones.find((o) => !o.esRecogida);
  assert.ok(envio, "debe haber una opción de envío");
  assert.equal(envio.priceCents, 0, "9000 supera el umbral de 7500");
});

test("por debajo del umbral se cobra la tarifa de la zona", () => {
  const res = resolverEnvio(3000, { state: "OH" }, { zonas: [OHIO, RECOGIDA], ajustes: AJUSTES });
  const envio = res.opciones.find((o) => !o.esRecogida);
  assert.equal(envio?.priceCents, 450, "la tarifa de Ohio son 450, no la general");
});

/* ───────────────────────── recogida ───────────────────────── */

test("la recogida siempre cuesta cero y se ofrece con el envío", () => {
  const res = resolverEnvio(3000, { state: "OH" }, { zonas: [OHIO, RECOGIDA], ajustes: AJUSTES });
  const recogida = res.opciones.find((o) => o.esRecogida);
  assert.ok(recogida, "la recogida debe seguir estando aunque gane la zona de Ohio");
  assert.equal(recogida.priceCents, 0);
  assert.ok(res.opciones.length >= 2, "la clienta tiene que poder elegir");
});

/* ─────────────── respaldo cuando no hay zonas configuradas ─────────────── */

test("sin zonas configuradas cae a los ajustes generales", () => {
  const res = resolverEnvio(3000, { state: "OH" }, { zonas: [], ajustes: AJUSTES });
  assert.equal(res.origen, "ajustes");
  assert.equal(res.zona, null);
  const envio = res.opciones.find((o) => !o.esRecogida);
  assert.equal(envio?.priceCents, AJUSTES.flatShippingCents);
});

test("el respaldo también respeta el envío gratis y la recogida", () => {
  const res = resolverEnvio(9000, { state: "OH" }, { zonas: [], ajustes: AJUSTES });
  assert.equal(res.opciones.find((o) => !o.esRecogida)?.priceCents, 0);
  assert.ok(res.opciones.some((o) => o.esRecogida), "localPickup está activo en los ajustes");
});

test("nunca se devuelve una lista de opciones vacía", () => {
  // Aunque no haya nada configurado y el pedido sea de cero: el checkout siempre
  // tiene que poder pintar algo, o la clienta se queda sin poder pagar.
  const sinNada = resolverEnvio(0, {}, {
    zonas: [],
    ajustes: { ...AJUSTES, localPickup: false, flatShippingCents: 0, freeShippingOverCents: 0 },
  });
  assert.ok(sinNada.opciones.length > 0);
});

/* ───────────────────────── impuestos ───────────────────────── */

test("apagado no cobra impuesto y explica por qué", () => {
  const r = resolverImpuesto(10000, { state: "OH" }, IMPUESTOS_POR_DEFECTO);
  assert.equal(r.taxCents, 0);
  assert.equal(r.aplicado, false);
  assert.match(r.nota, /desactivado/i);
});

test("activado sin tipo tampoco cobra: prefiere no cobrar a cobrar mal", () => {
  const r = resolverImpuesto(10000, { state: "OH" }, { ...IMPUESTOS_POR_DEFECTO, activo: true, rateBps: 0 });
  assert.equal(r.taxCents, 0);
  assert.equal(r.aplicado, false);
});

test("con tipo confirmado cobra el porcentaje sobre la base", () => {
  const cfg = { ...IMPUESTOS_POR_DEFECTO, activo: true, rateBps: 780, confirmadoPor: "Contable" };
  const r = resolverImpuesto(10000, { state: "OH" }, cfg);
  assert.equal(r.aplicado, true);
  assert.equal(r.taxCents, 780, "7,80 % de $100.00 son $7.80");
});

test("solo se cobra en los estados de la lista", () => {
  const cfg = { ...IMPUESTOS_POR_DEFECTO, activo: true, rateBps: 780, confirmadoPor: "Contable" };
  const fuera = resolverImpuesto(10000, { state: "CA" }, cfg);
  assert.equal(fuera.taxCents, 0);
  assert.equal(fuera.aplicado, false);
});

test("el impuesto se redondea al centavo entero", () => {
  const cfg = { ...IMPUESTOS_POR_DEFECTO, activo: true, rateBps: 725, confirmadoPor: "Contable" };
  const r = resolverImpuesto(3333, { state: "OH" }, cfg);
  assert.equal(r.taxCents, Math.round((3333 * 725) / 10000));
  assert.equal(Number.isInteger(r.taxCents), true, "nunca fracciones de centavo");
});

/* ───────────────────── conversión de tipos y regiones ───────────────────── */

test("el tipo se escribe como porcentaje y se guarda en puntos básicos", () => {
  assert.equal(tipoAPuntosBasicos("7.8"), 780);
  assert.equal(tipoAPuntosBasicos("7,8 %"), 780);
  assert.equal(tipoAPuntosBasicos("7.25%"), 725);
  assert.equal(tipoAPuntosBasicos(""), null);
  assert.equal(tipoAPuntosBasicos("abc"), null);
  assert.equal(formatearTipo(780), "7.80 %");
});

test("un regionsJson roto no tumba la tienda", () => {
  assert.deepEqual(parsearRegiones('["US-OH","US"]'), ["US-OH", "US"]);
  assert.deepEqual(parsearRegiones("no es json"), []);
  assert.deepEqual(parsearRegiones(null), []);
  assert.deepEqual(parsearRegiones('{"no":"array"}'), []);
});

/* ───────────────────── plantilla de configuración inicial ───────────────────── */

test("la configuración inicial no inventa precios: los saca de los ajustes", () => {
  const plantilla = plantillaZonasIniciales(AJUSTES);
  assert.ok(plantilla.length >= 2, "al menos Ohio y Estados Unidos");

  const todasLasTarifas = plantilla.flatMap((z) => z.rates);
  const dePago = todasLasTarifas.filter((t) => t.priceCents > 0);
  assert.ok(
    dePago.every((t) => t.priceCents === AJUSTES.flatShippingCents),
    "ninguna tarifa de pago puede tener un importe que no venga de los ajustes",
  );

  // Con umbral de envío gratis configurado, tiene que existir la tarifa gratis.
  assert.ok(
    todasLasTarifas.some((t) => t.priceCents === 0 && t.minSubtotalCents === AJUSTES.freeShippingOverCents),
    "falta la tarifa de envío gratis a partir del umbral",
  );
});

test("la plantilla incluye la recogida cuando está activada en los ajustes", () => {
  const con = plantillaZonasIniciales(AJUSTES);
  assert.ok(con.some((z) => z.regions.includes("PICKUP")));

  const sin = plantillaZonasIniciales({ ...AJUSTES, localPickup: false });
  assert.equal(sin.some((z) => z.regions.includes("PICKUP")), false);
});
