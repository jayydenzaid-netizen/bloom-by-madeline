// Credenciales y configuración de la tienda de Shopify.
//
// Por qué existe este fichero y no un `process.env.X` suelto en cada script: las
// tres formas de fallar aquí (no hay .env, el dominio está mal escrito, el token
// es de otro tipo) producen errores de Shopify que no se parecen en nada a su
// causa —un 404 en el endpoint de GraphQL cuando el dominio lleva "https://"
// delante, un 401 seco cuando el token es de la Storefront API—. Se validan
// todos aquí, una vez, y el mensaje dice qué tocar.

import { readFile } from "node:fs/promises";
import path from "node:path";

export type Entorno = {
  /** Dominio interno: "bloom-by-madeline.myshopify.com". SIEMPRE sin protocolo. */
  tienda: string;
  /** Token de app privada: empieza por shpat_. */
  token: string;
  /** Versión del Admin API. Se autodetecta si no se fija a mano. */
  version: string | null;
  /** Dominio público, solo para imprimir enlaces útiles. */
  dominioPublico: string | null;
};

const RAIZ = process.cwd();

/**
 * Lee un .env sin dependencias.
 *
 * Node 20 trae `--env-file`, pero exige lanzarlo en la línea de comandos y estos
 * scripts se invocan desde npm; además hay que leer DOS ficheros con prioridad
 * (.env.local pisa .env). Cuarenta líneas propias evitan una dependencia y un
 * modo de fallo silencioso.
 */
async function leerEnv(fichero: string): Promise<Record<string, string>> {
  let texto: string;
  try {
    texto = await readFile(path.join(RAIZ, fichero), "utf8");
  } catch {
    return {};
  }

  const salida: Record<string, string> = {};
  for (const lineaCruda of texto.split(/\r?\n/)) {
    const linea = lineaCruda.trim();
    if (!linea || linea.startsWith("#")) continue;

    const corte = linea.indexOf("=");
    if (corte <= 0) continue;

    const clave = linea.slice(0, corte).trim();
    let valor = linea.slice(corte + 1).trim();

    // Comillas opcionales alrededor del valor: se quitan solo si abren y cierran.
    if (
      (valor.startsWith('"') && valor.endsWith('"') && valor.length >= 2) ||
      (valor.startsWith("'") && valor.endsWith("'") && valor.length >= 2)
    ) {
      valor = valor.slice(1, -1);
    }
    salida[clave] = valor;
  }
  return salida;
}

/**
 * Normaliza lo que la gente pega de verdad en el .env:
 *   https://admin.shopify.com/store/bloom-by-madeline   → bloom-by-madeline.myshopify.com
 *   https://bloom-by-madeline.myshopify.com/admin       → bloom-by-madeline.myshopify.com
 *   bloom-by-madeline                                   → bloom-by-madeline.myshopify.com
 *
 * Cualquiera de esas tres es lo que se ve en la barra del navegador al estar
 * dentro del panel; ninguna es lo que quiere la API. Corregirlo aquí ahorra el
 * 404 más común de toda la integración.
 */
export function normalizarTienda(valor: string): string | null {
  let v = String(valor || "").trim();
  if (!v) return null;

  // La URL del panel nuevo: admin.shopify.com/store/<handle>
  const panel = /admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/i.exec(v);
  if (panel) return `${panel[1].toLowerCase()}.myshopify.com`;

  v = v.replace(/^https?:\/\//i, "");
  v = v.split("/")[0];
  v = v.replace(/:\d+$/, "");
  v = v.toLowerCase();

  if (v.endsWith(".myshopify.com")) {
    const handle = v.slice(0, -".myshopify.com".length);
    return /^[a-z0-9][a-z0-9-]*$/.test(handle) ? v : null;
  }

  // Un handle pelado. Un dominio propio (bloombymadeline.com) NO vale para la
  // API aunque sea el que ve la clienta: Shopify solo enruta el Admin API por
  // el dominio .myshopify.com.
  if (/^[a-z0-9][a-z0-9-]*$/.test(v)) return `${v}.myshopify.com`;

  return null;
}

export class ErrorEntorno extends Error {
  readonly pista: string;
  constructor(mensaje: string, pista: string) {
    super(mensaje);
    this.name = "ErrorEntorno";
    this.pista = pista;
  }
}

let cache: Entorno | null = null;

export async function cargarEntorno(): Promise<Entorno> {
  if (cache) return cache;

  const base = await leerEnv(".env");
  const local = await leerEnv(".env.local");
  // process.env manda sobre los ficheros: así se puede hacer
  // `SHOPIFY_STORE=otra npm run shopify:verificar` sin editar nada.
  const env = { ...base, ...local, ...process.env } as Record<string, string | undefined>;

  const tiendaCruda = env.SHOPIFY_STORE;
  if (!tiendaCruda) {
    throw new ErrorEntorno(
      "Falta SHOPIFY_STORE: no sé contra qué tienda hablar.",
      "Abre .env y añade SHOPIFY_STORE=\"tu-tienda.myshopify.com\". El valor está en el panel de Shopify, en la barra de direcciones (admin.shopify.com/store/TU-TIENDA).",
    );
  }

  const tienda = normalizarTienda(tiendaCruda);
  if (!tienda) {
    throw new ErrorEntorno(
      `SHOPIFY_STORE no parece un dominio de Shopify: "${tiendaCruda}".`,
      "Tiene que ser el dominio interno, el que acaba en .myshopify.com. Un dominio propio (bloombymadeline.com) no sirve para la API aunque sea el que ve la clienta.",
    );
  }

  const token = (env.SHOPIFY_ADMIN_TOKEN || "").trim();
  if (!token) {
    throw new ErrorEntorno(
      "Falta SHOPIFY_ADMIN_TOKEN: sin token no se puede tocar nada de la tienda.",
      "En el panel: Configuración → Aplicaciones y canales de venta → Desarrollar aplicaciones → crea una, dale permisos y copia el token de acceso de Admin API. Empieza por shpat_.",
    );
  }

  // Los tokens de la Storefront API empiezan igual de opacos pero NO valen aquí,
  // y Shopify responde con un 401 pelado que no explica nada. Se avisa antes.
  if (!token.startsWith("shpat_") && !token.startsWith("shpca_") && !token.startsWith("shppa_")) {
    throw new ErrorEntorno(
      "SHOPIFY_ADMIN_TOKEN no tiene pinta de token de Admin API.",
      "El de Admin API empieza por shpat_. Si copiaste el «token de la API de Storefront» (el público), ese es otro y solo sirve para leer el escaparate.",
    );
  }

  cache = {
    tienda,
    token,
    version: (env.SHOPIFY_API_VERSION || "").trim() || null,
    dominioPublico: (env.SHOPIFY_DOMINIO_PUBLICO || "").trim() || null,
  };
  return cache;
}

/** Para los tests: olvida lo leído y vuelve a mirar los ficheros. */
export function olvidarEntorno(): void {
  cache = null;
}
