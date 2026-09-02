// Qué sabe hacer ESTA versión del Admin API.
//
// Shopify reorganizó el modelo de productos entre 2024 y 2025: `productCreate`
// dejó de aceptar variantes, nació `productSet` (crear/actualizar un producto
// entero —opciones, variantes y fotos— en una sola llamada) y `productOptions`
// pasó a ser obligatorio. Escribir la mutación "correcta" a fuego significa
// romperse en la primera tienda que esté en otra versión.
//
// La alternativa a adivinar es preguntar: GraphQL se describe a sí mismo. Se
// hace UNA introspección al arrancar, se guarda en disco y a partir de ahí cada
// script elige el camino que la tienda soporta de verdad.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { ClienteShopify } from "./admin.js";

export type Capacidades = {
  version: string;
  /** ¿Existe la mutación productSet? Es el camino bueno: una llamada por producto. */
  productSet: boolean;
  /** Campos que acepta ProductSetInput. Sirve para no mandar nada que no exista. */
  camposProductSet: string[];
  /** Campos que acepta cada variante. `sku` se mudó a `inventoryItem` según la versión. */
  camposVariante: string[];
  /** ¿ProductCreateInput acepta `productOptions`? (modelo nuevo) */
  productCreateConOpciones: boolean;
  /** ¿Existe productVariantsBulkCreate? Camino de respaldo. */
  variantesEnLote: boolean;
  /** Momento de la comprobación, para poder caducarla. */
  comprobadoEn: string;
};

const FICHERO = path.join(process.cwd(), "shopify", ".capacidades.json");
/** Una semana: lo justo para no introspeccionar en cada import y detectar cambios de versión. */
const CADUCA_MS = 7 * 24 * 60 * 60 * 1000;

const CONSULTA = `
  query Capacidades {
    mutacion: __type(name: "Mutation") { fields { name } }
    entradaSet: __type(name: "ProductSetInput") { inputFields { name } }
    entradaCrear: __type(name: "ProductCreateInput") { inputFields { name } }
    entradaVariante: __type(name: "ProductVariantSetInput") { inputFields { name } }
  }
`;

type RespuestaIntrospeccion = {
  mutacion: { fields: { name: string }[] } | null;
  entradaSet: { inputFields: { name: string }[] } | null;
  entradaCrear: { inputFields: { name: string }[] } | null;
  entradaVariante: { inputFields: { name: string }[] } | null;
};

async function leerCache(version: string): Promise<Capacidades | null> {
  try {
    const guardado = JSON.parse(await readFile(FICHERO, "utf8")) as Capacidades;
    if (guardado.version !== version) return null;
    if (Date.now() - Date.parse(guardado.comprobadoEn) > CADUCA_MS) return null;
    return guardado;
  } catch {
    return null;
  }
}

export async function detectarCapacidades(
  cliente: ClienteShopify,
  forzar = false,
): Promise<Capacidades> {
  if (!forzar) {
    const guardado = await leerCache(cliente.versionApi);
    if (guardado) return guardado;
  }

  const datos = await cliente.pedir<RespuestaIntrospeccion>(CONSULTA, {}, "introspección");

  const mutaciones = new Set((datos.mutacion?.fields || []).map((f) => f.name));
  const camposSet = (datos.entradaSet?.inputFields || []).map((f) => f.name);
  const camposCrear = (datos.entradaCrear?.inputFields || []).map((f) => f.name);

  const capacidades: Capacidades = {
    version: cliente.versionApi,
    productSet: mutaciones.has("productSet") && camposSet.length > 0,
    camposProductSet: camposSet,
    camposVariante: (datos.entradaVariante?.inputFields || []).map((f) => f.name),
    productCreateConOpciones: camposCrear.includes("productOptions"),
    variantesEnLote: mutaciones.has("productVariantsBulkCreate"),
    comprobadoEn: new Date().toISOString(),
  };

  try {
    await mkdir(path.dirname(FICHERO), { recursive: true });
    await writeFile(FICHERO, JSON.stringify(capacidades, null, 2), "utf8");
  } catch {
    // Sin caché se introspecciona cada vez: más lento, igual de correcto.
  }

  return capacidades;
}

/** ¿Puedo mandar este campo dentro de ProductSetInput sin que Shopify lo rechace? */
export function aceptaCampo(capacidades: Capacidades, campo: string): boolean {
  // Si la introspección no devolvió la lista, no se filtra nada: mejor intentarlo
  // y leer el error de Shopify que quedarse sin mandar la mitad de la ficha.
  if (!capacidades.camposProductSet.length) return true;
  return capacidades.camposProductSet.includes(campo);
}
