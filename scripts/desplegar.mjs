// Despliegue completo de la tienda a producción, en un comando.
//
//   npm run desplegar
//
// Hace, en este orden: comprueba que hay base de datos, crea el esquema en ella,
// la siembra si está vacía, compila y publica en Vercel. Cada paso se para si el
// anterior falla, para no dejar la tienda a medio desplegar.
//
// Requiere DATABASE_URL de Postgres. Se puede pasar por el entorno:
//   DATABASE_URL="postgresql://..." npm run desplegar
// o dejarla en .env.production.local (que está en .gitignore).

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function leerEnvLocal() {
  const fichero = path.join(raiz, ".env.production.local");
  if (!existsSync(fichero)) return;
  for (const linea of readFileSync(fichero, "utf8").split("\n")) {
    const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const valor = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = valor;
  }
}

function paso(titulo, comando, opciones = {}) {
  console.log(`\n▸ ${titulo}`);
  try {
    execSync(comando, { cwd: raiz, stdio: "inherit", env: process.env, ...opciones });
  } catch {
    console.error(`\n✖ Falló: ${titulo}`);
    console.error("  Se detiene aquí a propósito: seguir dejaría la tienda a medias.");
    process.exit(1);
  }
}

leerEnvLocal();

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
  console.error(`
✖ Falta la base de datos de producción.

  Esta tienda usa SQLite para desarrollar, pero en Vercel eso no vale: el disco
  se borra en cada despliegue y hay varias instancias a la vez. Hace falta un
  Postgres, y la forma más corta de tenerlo es desde el propio Vercel:

    1. Abre https://vercel.com/jayydenzaid-2655s-projects/bloom-by-madeline
    2. Pestaña Storage → Create Database → Neon (Postgres) → plan gratuito
    3. Vercel enchufa DATABASE_URL al proyecto él solo

  Después, copia esa cadena aquí para poder crear el esquema desde el portátil:

    echo 'DATABASE_URL="postgresql://..."' > .env.production.local

  Y vuelve a lanzar: npm run desplegar
`);
  process.exit(1);
}

console.log("Base de datos de producción detectada.\n");

paso("Comprobando tipos", "npx tsc --noEmit");
paso("Pasando las pruebas", "npx tsx --test tests/*.test.ts");
paso("Creando el esquema en Postgres", "node scripts/db-provider.mjs && npx prisma db push");
paso("Sembrando los datos de la tienda", "npx tsx prisma/seed.ts");
paso("Publicando en Vercel", "npx vercel deploy --prod --yes");

console.log(`
✔ Desplegado.

  Comprueba la tienda y entra al panel en /admin con el correo y la contraseña
  que están en las variables de entorno del proyecto en Vercel.

  Lo primero que hay que hacer dentro: ponerle precio a los 8 productos y
  activarlos. Hasta entonces no se ven en la tienda, y es a propósito.
`);
