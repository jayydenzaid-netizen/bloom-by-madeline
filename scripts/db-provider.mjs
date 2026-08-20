// Ajusta el motor del esquema de Prisma al que indique DATABASE_URL.
//
// Prisma exige que el `provider` sea un literal en el fichero: no admite una
// variable. Y este proyecto usa SQLite en el portátil (cero fricción para
// desarrollar) y Postgres en producción (SQLite no sirve en Vercel, donde el
// disco es efímero y hay varias instancias a la vez).
//
// En vez de mantener dos esquemas que se desincronizan, se reescribe la línea
// del provider antes de generar el cliente. El esquema está escrito a propósito
// sin enums ni arrays nativos, así que el resto del fichero vale para los dos.
//
// Se ejecuta solo en el build y en los scripts de base de datos.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const esquema = path.join(raiz, "prisma", "schema.prisma");

const url = process.env.DATABASE_URL ?? "";
const destino =
  url.startsWith("postgres://") || url.startsWith("postgresql://") ? "postgresql" : "sqlite";

const contenido = readFileSync(esquema, "utf8");
const actual = contenido.match(/datasource\s+db\s*\{[^}]*provider\s*=\s*"([^"]+)"/)?.[1];

if (!actual) {
  console.error("No se encontró el provider en prisma/schema.prisma. No se toca nada.");
  process.exit(1);
}

if (actual === destino) {
  console.log(`Prisma: el esquema ya está en "${destino}".`);
  process.exit(0);
}

const nuevo = contenido.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*")[^"]+(")/,
  `$1${destino}$2`,
);

writeFileSync(esquema, nuevo);
console.log(`Prisma: esquema cambiado de "${actual}" a "${destino}".`);
