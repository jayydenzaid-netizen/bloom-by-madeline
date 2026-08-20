import { PrismaClient } from "@prisma/client";

// En dev Next recarga los módulos en cada cambio; sin este singleton se abrirían
// decenas de conexiones a SQLite hasta que la BD se queja.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
