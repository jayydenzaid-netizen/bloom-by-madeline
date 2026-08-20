/**
 * Búsqueda de texto que se comporta igual en SQLite y en Postgres.
 *
 * El motivo de que esto exista: `contains` de Prisma NO significa lo mismo en
 * los dos motores. En SQLite el LIKE de fondo ignora mayúsculas y minúsculas
 * (para ASCII), así que buscar "vestido" encuentra "Vestido Coral". En Postgres
 * es sensible a mayúsculas y esa misma búsqueda no encuentra nada — y no falla,
 * simplemente devuelve cero resultados, que es la peor forma de romperse.
 *
 * Postgres lo arregla con `mode: "insensitive"`, pero ese modificador no existe
 * en SQLite: Prisma rechaza la consulta entera si se lo pasas. De ahí el
 * interruptor: se mira la cadena de conexión y se construye el filtro que ese
 * motor entiende.
 *
 * Regla de uso: TODA búsqueda escrita por una persona en un buscador pasa por
 * aquí. Las comparaciones internas (buscar '"demo"' dentro de tagsJson, o una
 * URL exacta) no: ésas quieren coincidencia literal.
 */

function usaPostgres(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

// Se calcula una vez: la cadena de conexión no cambia con el proceso vivo.
const INSENSIBLE = usaPostgres();

export type FiltroTexto = { contains: string; mode?: "insensitive" };

/** Filtro para un campo de texto. `where: { title: buscar(q) }` */
export function buscar(termino: string): FiltroTexto {
  const q = (termino ?? "").trim();
  return INSENSIBLE ? { contains: q, mode: "insensitive" } : { contains: q };
}

/**
 * Filtro OR sobre varios campos del mismo modelo:
 *   where: { OR: buscarEn(["title", "slug", "vendor"], q) }
 */
export function buscarEn<T extends string>(campos: readonly T[], termino: string) {
  const filtro = buscar(termino);
  return campos.map((campo) => ({ [campo]: filtro }) as Record<T, FiltroTexto>);
}

/** Solo para diagnóstico: qué motor cree el código que hay debajo. */
export const MOTOR = INSENSIBLE ? "postgres" : "sqlite";
