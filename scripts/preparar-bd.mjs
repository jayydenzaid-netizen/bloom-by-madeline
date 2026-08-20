// Deja la base de datos lista antes de compilar.
//
// Corre dentro del build de Vercel, donde DATABASE_URL ya está inyectada. Hace
// dos cosas, las dos seguras de repetir:
//
//   1. Crea o actualiza las tablas (prisma db push). Sin --accept-data-loss: si
//      un cambio fuese destructivo preferimos que el build falle a que la tienda
//      pierda pedidos en silencio. Un build fallido no toca lo que ya está
//      publicado; Vercel mantiene el despliegue anterior.
//   2. Siembra los datos iniciales SOLO si la tienda está vacía. Si ya hay
//      productos, no se toca nada: el seed no puede pisar el trabajo de Madeline.
//
// En local sin Postgres no hace nada: el desarrollo usa SQLite y sus propios
// comandos (npm run db:push / db:seed).

import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL ?? "";
const esPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");

if (!esPostgres) {
  console.log("Base de datos: no es Postgres, no se prepara nada (desarrollo local).");
  process.exit(0);
}

function correr(comando) {
  execSync(comando, { stdio: "inherit", env: process.env });
}

console.log("▸ Creando o actualizando las tablas en Postgres…");
correr("npx prisma db push --skip-generate");

// ¿Está vacía? Se pregunta con el cliente ya generado, en un proceso aparte para
// no arrastrar Prisma dentro del build de Next.
console.log("▸ Comprobando si la tienda ya tiene datos…");
let vacia = false;
try {
  const salida = execSync(
    `node -e "const{PrismaClient}=require('@prisma/client');const d=new PrismaClient();d.product.count().then(n=>{console.log('PRODUCTOS='+n);return d.$disconnect()}).catch(()=>{console.log('PRODUCTOS=-1');process.exit(0)})"`,
    { encoding: "utf8", env: process.env },
  );
  const n = Number(salida.match(/PRODUCTOS=(-?\d+)/)?.[1] ?? -1);
  vacia = n === 0;
  console.log(`  Productos en la base: ${n < 0 ? "no se pudo leer" : n}`);
} catch {
  console.log("  No se pudo comprobar; por prudencia NO se siembra.");
}

if (vacia) {
  console.log("▸ Tienda vacía: sembrando datos iniciales…");
  correr("npx tsx prisma/seed.ts");
} else {
  console.log("▸ La tienda ya tiene datos: no se siembra nada.");
}

console.log("✔ Base de datos lista.");
