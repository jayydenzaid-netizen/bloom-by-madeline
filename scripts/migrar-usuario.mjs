// Prepara la columna `username` de AdminUser ANTES de que corra `prisma db push`.
//
// POR QUÉ EXISTE ESTE FICHERO
//
// El panel dejó de entrar por correo y pasó a entrar por usuario, así que
// AdminUser tiene una columna nueva con índice único. `prisma db push` se niega
// a añadir un índice único sobre una columna que ya existe en filas anteriores
// —avisa de "possible data loss" y sale con error— y el build de producción
// llama a push a propósito SIN --accept-data-loss, para que un cambio destructivo
// tumbe el despliegue en vez de llevarse por delante los pedidos de la tienda.
//
// La salida no es relajar el push, es hacer el trabajo antes: se crea la columna
// (vacía, que se puede) y el índice único (que admite tantos NULL como quiera),
// de modo que cuando push mire la base ya no vea ninguna diferencia que aplicar.
//
// Los valores los rellena ensureUsernames() en lib/auth.ts la primera vez que
// alguien intenta entrar. Aquí solo se toca la forma de la tabla, nunca el
// contenido: este script no escribe ni una fila.
//
// Es seguro repetirlo, y seguro también sobre una base recién creada donde la
// tabla todavía no existe: en ese caso no hay nada que migrar y push la creará
// entera y bien.

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * En Vercel la URL viene inyectada en el entorno; en el portátil vive en el
 * `.env`, que node no lee solo (el CLI de Prisma sí, por eso `db execute`
 * funciona igual). Solo hace falta para saber a qué motor le estamos hablando.
 */
function urlDeLaBase() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const fichero = path.join(raiz, ".env");
  if (!existsSync(fichero)) return "";

  const linea = readFileSync(fichero, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trimStart().startsWith("DATABASE_URL="));

  return linea ? linea.slice(linea.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : "";
}

const url = urlDeLaBase();
const esPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");

if (!url) {
  console.log("Migración de usuario: no hay DATABASE_URL, no se toca nada.");
  process.exit(0);
}

const carpeta = mkdtempSync(path.join(tmpdir(), "bloom-sql-"));

/**
 * Lanza una sentencia con `prisma db execute`.
 *
 * Devuelve true si pasó y false si falló. Falla a propósito en silencio cuando
 * el motivo es inofensivo (la columna ya está, la tabla aún no existe): es la
 * forma de que el script sea idempotente sin tener que interrogar antes al
 * catálogo de cada motor, que se escribe distinto en SQLite y en Postgres.
 */
function ejecutar(nombre, sql) {
  const fichero = path.join(carpeta, `${nombre}.sql`);
  writeFileSync(fichero, sql, "utf8");

  try {
    // execSync y no execFileSync: en Windows, node se niega desde la 20 a lanzar
    // un .cmd (y npx lo es) sin pasar por el shell, y falla con un EINVAL que no
    // trae ni salida ni pista.
    execSync(`npx prisma db execute --file "${fichero}" --schema prisma/schema.prisma`, {
      stdio: "pipe",
      env: process.env,
    });
    return true;
  } catch (e) {
    // El mensaje entra en la mezcla: si el fallo es del propio lanzamiento no
    // hay stdout ni stderr, y sin él el aviso saldría vacío.
    const salida = `${e.stdout ?? ""}${e.stderr ?? ""} ${e.message ?? ""}`.toLowerCase();
    const inofensivo =
      salida.includes("duplicate column") || // SQLite: la columna ya estaba
      salida.includes("already exists") || // el índice ya estaba
      salida.includes("no such table") || // base nueva: push creará la tabla
      salida.includes("does not exist"); // idem en Postgres

    if (!inofensivo) {
      console.error(`✖ La migración de usuario falló en «${nombre}»:`);
      console.error(salida.trim().slice(0, 800));
      process.exit(1);
    }
    return false;
  }
}

console.log(`▸ Preparando AdminUser.username (${esPostgres ? "Postgres" : "SQLite"})…`);

// SQLite no entiende ADD COLUMN IF NOT EXISTS; se lanza a pelo y se tolera el
// error de columna repetida, que es exactamente la señal de "ya estaba hecho".
const columna = esPostgres
  ? 'ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "username" TEXT;'
  : 'ALTER TABLE "AdminUser" ADD COLUMN "username" TEXT;';

const creada = ejecutar("columna", columna);
console.log(creada ? "  Columna creada." : "  La columna ya estaba (o la tabla aún no existe).");

// El nombre del índice no es decorativo: tiene que ser el que Prisma genera para
// un @unique (Modelo_campo_key) o push vería un índice de más y otro de menos.
const indice = ejecutar(
  "indice",
  'CREATE UNIQUE INDEX IF NOT EXISTS "AdminUser_username_key" ON "AdminUser"("username");',
);
console.log(indice ? "  Índice único creado." : "  El índice ya estaba (o la tabla aún no existe).");
