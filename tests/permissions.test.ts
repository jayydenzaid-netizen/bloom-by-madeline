// Pruebas de los permisos del panel (lib/permissions.ts).
//
// Correr con:  npx tsx --test tests/permissions.test.ts   (o `npm test`)
//
// No tocan la base de datos: lo que se prueba aquí es la matriz de permisos y
// la regla del último owner, que son lógica pura. Y son justo las dos cosas
// donde un fallo se paga caro: o alguien toca lo que no debe, o la tienda se
// queda sin nadie que pueda entrar en Ajustes y hay que ir a la base de datos
// a mano para arreglarlo.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCIONES,
  ROLES,
  accionesDe,
  can,
  esRol,
  normalizarRol,
  ownersActivosTras,
  permiteCambioDeCuenta,
  type Accion,
  type CuentaBasica,
} from "@/lib/permissions";

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const owner = { role: "owner", isActive: true };
const staff = { role: "staff", isActive: true };

/** Lo que un ayudante SÍ puede hacer: el trabajo del día a día. */
const PERMITIDAS_A_STAFF: Accion[] = [
  "pedidos.ver",
  "pedidos.gestionar",
  "productos.ver",
  "productos.gestionar",
  "inventario.ver",
  "inventario.ajustar",
  "clientes.ver",
  "importar.usar",
  "carritos.gestionar",
  "resenas.moderar",
  "cuenta.propia",
];

/** Lo que es solo de la dueña. Si algo de esto se cuela a staff, es un fallo. */
const PROHIBIDAS_A_STAFF: Accion[] = [
  "descuentos.gestionar",
  "informes.ver",
  "ajustes.gestionar",
  "contenido.gestionar",
  "equipo.gestionar",
  "actividad.ver",
  "borrar.definitivo",
];

function cuenta(id: string, role: string, isActive = true): CuentaBasica {
  return { id, role, isActive };
}

/* ─────────────────────────── matriz de permisos ─────────────────────────── */

test("la lista de acciones está cubierta por las dos listas de la prueba", () => {
  // Si alguien añade una acción nueva a ACCIONES y no decide aquí de qué lado
  // cae, esta prueba lo caza: no vale dejar una acción sin criterio.
  const cubiertas = [...PERMITIDAS_A_STAFF, ...PROHIBIDAS_A_STAFF].sort();
  assert.deepEqual(cubiertas, [...ACCIONES].sort());
});

test("la dueña puede absolutamente todo", () => {
  for (const accion of ACCIONES) {
    assert.equal(can(owner, accion), true, `owner debería poder ${accion}`);
  }
  assert.equal(accionesDe("owner").length, ACCIONES.length);
});

test("el ayudante gestiona pedidos, productos e inventario", () => {
  for (const accion of PERMITIDAS_A_STAFF) {
    assert.equal(can(staff, accion), true, `staff debería poder ${accion}`);
  }
});

test("el ayudante no toca ajustes, equipo, descuentos, informes ni borra nada", () => {
  for (const accion of PROHIBIDAS_A_STAFF) {
    assert.equal(can(staff, accion), false, `staff NO debería poder ${accion}`);
  }
  const permitidas = accionesDe("staff");
  for (const accion of PROHIBIDAS_A_STAFF) {
    assert.equal(permitidas.includes(accion), false);
  }
});

test("una cuenta desactivada no puede nada, aunque sea dueña", () => {
  for (const accion of ACCIONES) {
    assert.equal(can({ role: "owner", isActive: false }, accion), false);
    assert.equal(can({ role: "staff", isActive: false }, accion), false);
  }
});

test("sin usuario no se puede nada", () => {
  for (const accion of ACCIONES) {
    assert.equal(can(null, accion), false);
    assert.equal(can(undefined, accion), false);
  }
});

test("un rol desconocido se trata como ayudante, nunca como dueña", () => {
  assert.equal(normalizarRol("superadmin"), "staff");
  assert.equal(normalizarRol(""), "staff");
  assert.equal(normalizarRol(null), "staff");
  assert.equal(normalizarRol(undefined), "staff");
  assert.equal(normalizarRol("owner"), "owner");

  assert.equal(can({ role: "superadmin", isActive: true }, "ajustes.gestionar"), false);
  assert.equal(can({ role: "superadmin", isActive: true }, "pedidos.gestionar"), true);
});

test("esRol solo acepta los dos roles de verdad", () => {
  assert.equal(esRol("owner"), true);
  assert.equal(esRol("staff"), true);
  assert.equal(esRol("OWNER"), false);
  assert.equal(esRol(7), false);
  assert.deepEqual([...ROLES], ["owner", "staff"]);
});

/* ─────────────────── la tienda nunca se queda sin dueña ─────────────────── */

test("ownersActivosTras cuenta bien con y sin cambio", () => {
  const cuentas = [cuenta("a", "owner"), cuenta("b", "staff"), cuenta("c", "owner", false)];

  assert.equal(ownersActivosTras(cuentas), 1, "solo 'a' es dueña activa");
  assert.equal(ownersActivosTras(cuentas, { id: "a", isActive: false }), 0);
  assert.equal(ownersActivosTras(cuentas, { id: "a", role: "staff" }), 0);
  assert.equal(ownersActivosTras(cuentas, { id: "b", role: "owner" }), 2);
  assert.equal(ownersActivosTras(cuentas, { id: "c", isActive: true }), 2);
});

test("no se puede desactivar a la última dueña activa", () => {
  const cuentas = [cuenta("madeline", "owner"), cuenta("ayuda", "staff")];
  const veredicto = permiteCambioDeCuenta(cuentas, { id: "madeline", isActive: false });

  assert.equal(veredicto.ok, false);
  if (!veredicto.ok) {
    // El mensaje se le enseña tal cual a Madeline: tiene que explicar el porqué.
    assert.match(veredicto.error, /última cuenta de dueña/i);
  }
});

test("no se puede degradar a la última dueña activa", () => {
  const cuentas = [cuenta("madeline", "owner"), cuenta("ayuda", "staff")];
  assert.equal(permiteCambioDeCuenta(cuentas, { id: "madeline", role: "staff" }).ok, false);
});

test("con dos dueñas activas sí se puede tocar una", () => {
  const cuentas = [cuenta("madeline", "owner"), cuenta("hermana", "owner"), cuenta("ayuda", "staff")];

  assert.equal(permiteCambioDeCuenta(cuentas, { id: "hermana", isActive: false }).ok, true);
  assert.equal(permiteCambioDeCuenta(cuentas, { id: "hermana", role: "staff" }).ok, true);
});

test("apagar o degradar a un ayudante nunca está bloqueado", () => {
  const cuentas = [cuenta("madeline", "owner"), cuenta("ayuda", "staff")];
  assert.equal(permiteCambioDeCuenta(cuentas, { id: "ayuda", isActive: false }).ok, true);
  assert.equal(permiteCambioDeCuenta(cuentas, { id: "ayuda", role: "owner" }).ok, true);
});

test("una dueña desactivada no cuenta como la última dueña activa", () => {
  // Dos owners pero uno apagado: el que queda encendido sigue siendo intocable.
  const cuentas = [cuenta("madeline", "owner"), cuenta("antigua", "owner", false)];
  assert.equal(permiteCambioDeCuenta(cuentas, { id: "madeline", isActive: false }).ok, false);
  // Reactivar a la antigua sí se puede, y entonces ya se puede apagar a la otra.
  const tras = [cuenta("madeline", "owner"), cuenta("antigua", "owner", true)];
  assert.equal(permiteCambioDeCuenta(tras, { id: "madeline", isActive: false }).ok, true);
});

test("un cambio sobre una cuenta que no existe se rechaza sin tocar nada", () => {
  const cuentas = [cuenta("madeline", "owner")];
  const veredicto = permiteCambioDeCuenta(cuentas, { id: "fantasma", isActive: false });
  assert.equal(veredicto.ok, false);
  if (!veredicto.ok) assert.match(veredicto.error, /ya no existe/i);
});

test("secuencia real: crear una segunda dueña permite jubilar a la primera", () => {
  let cuentas = [cuenta("madeline", "owner"), cuenta("ayuda", "staff")];

  // Con una sola dueña, no hay salida.
  assert.equal(permiteCambioDeCuenta(cuentas, { id: "madeline", isActive: false }).ok, false);

  // Se asciende a la ayudante...
  assert.equal(permiteCambioDeCuenta(cuentas, { id: "ayuda", role: "owner" }).ok, true);
  cuentas = [cuenta("madeline", "owner"), cuenta("ayuda", "owner")];

  // ...y ahora sí.
  assert.equal(permiteCambioDeCuenta(cuentas, { id: "madeline", isActive: false }).ok, true);
  cuentas = [cuenta("madeline", "owner", false), cuenta("ayuda", "owner")];

  // Y el candado se ha movido con ella: la nueva dueña ya no se puede apagar.
  assert.equal(permiteCambioDeCuenta(cuentas, { id: "ayuda", isActive: false }).ok, false);
  assert.equal(ownersActivosTras(cuentas), 1);
});
