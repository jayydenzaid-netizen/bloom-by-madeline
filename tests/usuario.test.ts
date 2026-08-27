// Pruebas del nombre de usuario del panel (lib/usuario.ts).
//
// Correr con:  npx tsx --test tests/usuario.test.ts   (o `npm test`)
//
// No tocan la base de datos. Se prueba lo que decide si Madeline entra o se
// queda fuera: que «Madeline21» y «madeline21» sean la misma puerta, que un
// espacio pegado al final no cuente, y que rellenar el usuario de las cuentas
// viejas no genere dos iguales — un choque ahí revienta el índice único y deja
// el panel sin acceso, que es el peor sitio posible para un fallo.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AYUDA_USUARIO,
  USUARIO_MAX,
  USUARIO_MIN,
  claveUsuario,
  normalizarUsuario,
  usuarioDesdeCorreo,
  usuarioLibre,
  validarUsuario,
} from "@/lib/usuario";

/* ───────────────────────────── normalizar ───────────────────────────── */

test("normalizar quita los espacios de los bordes y respeta las mayúsculas", () => {
  assert.equal(normalizarUsuario("  Madeline21  "), "Madeline21");
  assert.equal(normalizarUsuario("Madeline21"), "Madeline21");
});

test("normalizar aguanta lo que no es texto", () => {
  assert.equal(normalizarUsuario(null), "");
  assert.equal(normalizarUsuario(undefined), "");
  assert.equal(normalizarUsuario(42), "42");
});

test("la clave de comparación es en minúsculas", () => {
  assert.equal(claveUsuario("Madeline21"), "madeline21");
  assert.equal(claveUsuario(" MADELINE21 "), "madeline21");
  assert.equal(claveUsuario("Madeline21"), claveUsuario("madeline21"));
});

/* ────────────────────────────── validar ────────────────────────────── */

test("un usuario normal vale y se guarda tal cual se escribió", () => {
  const veredicto = validarUsuario("  Madeline21 ");
  assert.equal(veredicto.ok, true);
  assert.equal(veredicto.ok && veredicto.usuario, "Madeline21");
});

test("se admiten punto, guion y guion bajo", () => {
  for (const bueno of ["ana.lopez", "ana-lopez", "ana_lopez", "abc"]) {
    assert.equal(validarUsuario(bueno).ok, true, `deberia valer: ${bueno}`);
  }
});

test("se rechaza lo que dejaría a alguien fuera sin entender por qué", () => {
  const malos = [
    "", // vacío
    "  ", // solo espacios
    "ab", // corto
    "ana lopez", // con espacio
    "ana@tienda.com", // con arroba: eso es un correo
    "maría", // con tilde: imposible de escribir igual dos veces
    "a".repeat(USUARIO_MAX + 1), // demasiado largo
  ];
  for (const malo of malos) {
    const veredicto = validarUsuario(malo);
    assert.equal(veredicto.ok, false, `no deberia valer: «${malo}»`);
    assert.ok(!veredicto.ok && veredicto.error.length > 0, "el fallo tiene que venir explicado");
  }
});

test("los límites de la ayuda son los que aplica el validador", () => {
  assert.equal(validarUsuario("a".repeat(USUARIO_MIN)).ok, true);
  assert.equal(validarUsuario("a".repeat(USUARIO_MAX)).ok, true);
  assert.ok(AYUDA_USUARIO.includes(String(USUARIO_MIN)));
  assert.ok(AYUDA_USUARIO.includes(String(USUARIO_MAX)));
});

/* ───────────────── relleno de las cuentas antiguas ───────────────── */

test("del correo sale un usuario reconocible", () => {
  assert.equal(usuarioDesdeCorreo("madeline@bloombymadeline.com"), "madeline");
  assert.equal(usuarioDesdeCorreo("ana.lopez@gmail.com"), "ana.lopez");
});

test("la tilde pierde el acento pero no la letra", () => {
  assert.equal(usuarioDesdeCorreo("maría@tienda.com"), "maria");
});

test("un correo del que no sale nada usable cae en una base genérica", () => {
  const sacado = usuarioDesdeCorreo("é@tienda.com");
  assert.equal(validarUsuario(sacado).ok, true, "lo que salga tiene que ser válido");
});

test("lo que sale del correo siempre es un usuario válido", () => {
  for (const correo of ["a@b.com", "MAYUS@b.com", "con+etiqueta@b.com", "@b.com"]) {
    const sacado = usuarioDesdeCorreo(correo);
    assert.equal(validarUsuario(sacado).ok, true, `de ${correo} salio «${sacado}»`);
  }
});

test("si el usuario está cogido se numera, sin distinguir mayúsculas", () => {
  assert.equal(usuarioLibre("ana", []), "ana");
  assert.equal(usuarioLibre("ana", ["ana"]), "ana2");
  assert.equal(usuarioLibre("ana", ["ANA", "ana2"]), "ana3");
});

test("numerar no revienta el largo máximo", () => {
  const largo = "a".repeat(USUARIO_MAX);
  const libre = usuarioLibre(largo, [largo]);
  assert.ok(libre.length <= USUARIO_MAX, `${libre.length} > ${USUARIO_MAX}`);
  assert.equal(validarUsuario(libre).ok, true);
  assert.notEqual(claveUsuario(libre), claveUsuario(largo));
});
