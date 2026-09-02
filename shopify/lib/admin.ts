// Cliente del Admin API de Shopify (GraphQL).
//
// Shopify no cobra las peticiones por número, sino por COSTE: cada consulta
// gasta puntos de un cubo que se rellena solo (50/s en las tiendas normales).
// Un script que importa 300 productos vacía el cubo en segundos, y a partir de
// ahí Shopify contesta THROTTLED. Reintentar a ciegas empeora las cosas.
//
// Por eso este cliente hace tres cosas que un `fetch` pelado no hace:
//
//   1. lee `extensions.cost.throttleStatus` de CADA respuesta y, cuando el saldo
//      baja del coste de la siguiente consulta, espera exactamente lo que tarda
//      en rellenarse — ni un ciego "sleep 1s" de más ni de menos;
//   2. distingue los tres fallos que Shopify mete en el mismo saco: error de
//      transporte (reintentable), error de GraphQL (la consulta está mal, NO se
//      reintenta) y `userErrors` dentro de la mutación (la operación se rechazó
//      por reglas de negocio: tampoco se reintenta, pero hay que leerlo);
//   3. autodetecta la versión del API, porque fijarla a mano garantiza que este
//      código deje de funcionar el día que Shopify jubile esa versión.

import { cargarEntorno, type Entorno } from "./entorno.js";

export type RespuestaGraphQL<T> = {
  data: T;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
};

export class ErrorShopify extends Error {
  readonly pista: string;
  readonly detalles: unknown;
  constructor(mensaje: string, pista: string, detalles?: unknown) {
    super(mensaje);
    this.name = "ErrorShopify";
    this.pista = pista;
    this.detalles = detalles;
  }
}

/** Un `userErrors` de cualquier mutación, ya aplanado. */
export type ErrorDeUsuario = { field?: string[] | null; message: string; code?: string | null };

const REINTENTOS_MAX = 5;
const ESPERA_BASE_MS = 800;
/** Nunca esperar más de esto de una sentada: si hace falta más, algo va mal. */
const ESPERA_TOPE_MS = 20_000;

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─────────────────────────── versión del API ───────────────────────────

/**
 * Shopify publica una versión nueva cada trimestre y mantiene cada una un año.
 * Escribir "2026-07" a fuego aquí es programar una avería para dentro de doce
 * meses, así que se pregunta.
 *
 * `unstable` es el único handle que existe SIEMPRE, así que sirve de puerta de
 * entrada para hacer la única consulta que hace falta: cuáles hay.
 */
let versionCache: string | null = null;

export async function versionDelApi(env: Entorno): Promise<string> {
  if (env.version) return env.version;
  if (versionCache) return versionCache;

  const consulta = "{ publicApiVersions { handle supported } }";

  let respuesta: Response;
  try {
    respuesta = await fetch(`https://${env.tienda}/admin/api/unstable/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": env.token,
      },
      body: JSON.stringify({ query: consulta }),
    });
  } catch (error) {
    throw new ErrorShopify(
      `No se pudo contactar con https://${env.tienda}: ${mensajeDe(error)}`,
      "Comprueba la conexión y que el dominio de SHOPIFY_STORE exista de verdad (pégalo en el navegador: debe llevarte a la tienda).",
    );
  }

  if (respuesta.status === 401 || respuesta.status === 403) {
    throw new ErrorShopify(
      "Shopify rechazó el token al preguntarle las versiones del API.",
      "El token no vale para esta tienda, o la app no está instalada. Vuelve a Configuración → Aplicaciones y canales de venta → Desarrollar aplicaciones, comprueba que la app esté INSTALADA y copia otra vez el token de Admin API.",
    );
  }
  if (respuesta.status === 404) {
    throw new ErrorShopify(
      `Shopify contestó 404 en https://${env.tienda}/admin/api/...`,
      "Ese dominio no es una tienda de Shopify. Tiene que ser el interno, el que acaba en .myshopify.com — no el dominio propio de la tienda.",
    );
  }
  if (!respuesta.ok) {
    throw new ErrorShopify(
      `Shopify contestó ${respuesta.status} al preguntarle las versiones del API.`,
      `Estoy llamando a https://${env.tienda}/admin/api/unstable/graphql.json. Si esa tienda no es la tuya, corrige SHOPIFY_STORE.`,
    );
  }

  const cuerpo = (await respuesta.json()) as {
    data?: { publicApiVersions?: { handle: string; supported: boolean }[] };
  };
  const versiones = (cuerpo.data?.publicApiVersions || [])
    .filter((v) => v.supported && /^\d{4}-\d{2}$/.test(v.handle))
    .map((v) => v.handle)
    .sort();

  if (!versiones.length) {
    throw new ErrorShopify(
      "Shopify no devolvió ninguna versión estable del API.",
      'Es rarísimo. Fija una a mano en el .env con SHOPIFY_API_VERSION="2025-10" y vuelve a probar.',
    );
  }

  // La más nueva soportada: la que más tiempo va a seguir viva.
  versionCache = versiones[versiones.length - 1];
  return versionCache;
}

// ─────────────────────────── el cliente ───────────────────────────

export class ClienteShopify {
  private env: Entorno;
  private version: string;
  /** Saldo del cubo tras la última respuesta. null = todavía no se sabe. */
  private saldo: number | null = null;
  private ritmo = 50;
  /** Coste real de la última consulta: la mejor estimación de lo que costará la próxima. */
  private ultimoCoste = 10;

  private constructor(env: Entorno, version: string) {
    this.env = env;
    this.version = version;
  }

  static async crear(): Promise<ClienteShopify> {
    const env = await cargarEntorno();
    const version = await versionDelApi(env);
    return new ClienteShopify(env, version);
  }

  get tienda(): string {
    return this.env.tienda;
  }

  get versionApi(): string {
    return this.version;
  }

  /** Enlace al panel de la tienda, para poder imprimir "míralo aquí". */
  get panel(): string {
    return `https://admin.shopify.com/store/${this.env.tienda.replace(".myshopify.com", "")}`;
  }

  private get endpoint(): string {
    return `https://${this.env.tienda}/admin/api/${this.version}/graphql.json`;
  }

  /**
   * Espera a que haya saldo suficiente ANTES de disparar.
   *
   * Es preventivo a propósito: dejar que Shopify conteste THROTTLED y reintentar
   * después funciona, pero gasta una petición y un viaje de red por cada tope, y
   * en una migración de 300 productos eso son minutos regalados.
   */
  private async esperarSaldo(): Promise<void> {
    if (this.saldo === null) return;

    const necesario = Math.max(this.ultimoCoste, 10);
    if (this.saldo >= necesario) return;

    const faltan = necesario - this.saldo;
    const ms = Math.min(ESPERA_TOPE_MS, Math.ceil((faltan / Math.max(1, this.ritmo)) * 1000) + 120);
    await dormir(ms);
    // Se da por rellenado lo esperado; la respuesta real corregirá el número.
    this.saldo = Math.min(this.saldo + (ms / 1000) * this.ritmo, necesario);
  }

  private anotarCoste(extensions: RespuestaGraphQL<unknown>["extensions"]): void {
    const cost = extensions?.cost;
    if (!cost) return;
    if (typeof cost.actualQueryCost === "number") this.ultimoCoste = cost.actualQueryCost;
    const estado = cost.throttleStatus;
    if (estado) {
      this.saldo = estado.currentlyAvailable;
      this.ritmo = estado.restoreRate || this.ritmo;
    }
  }

  /**
   * Lanza una consulta o mutación. Devuelve `data` ya desenvuelto.
   *
   * Lanza ErrorShopify cuando no hay nada que hacer; reintenta solo lo que tiene
   * sentido reintentar (red, 429, 5xx, THROTTLED).
   */
  async pedir<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
    etiqueta = "consulta",
  ): Promise<T> {
    let ultimoError: ErrorShopify | null = null;

    for (let intento = 1; intento <= REINTENTOS_MAX; intento++) {
      await this.esperarSaldo();

      let respuesta: Response;
      try {
        respuesta = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": this.env.token,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (error) {
        // Red caída o DNS: reintentable.
        ultimoError = new ErrorShopify(
          `No se pudo contactar con Shopify (${etiqueta}): ${mensajeDe(error)}`,
          "Revisa la conexión a internet. Si estás detrás de un proxy o VPN, prueba sin él.",
        );
        await dormir(Math.min(ESPERA_TOPE_MS, ESPERA_BASE_MS * 2 ** (intento - 1)));
        continue;
      }

      if (respuesta.status === 401 || respuesta.status === 403) {
        throw new ErrorShopify(
          `Shopify rechazó el token (${respuesta.status}) en ${etiqueta}.`,
          "Casi siempre es un permiso que falta en la app, no el token. Ejecuta `npm run shopify:verificar` para ver exactamente cuál.",
        );
      }

      if (respuesta.status === 429) {
        const espera = Number(respuesta.headers.get("Retry-After") || "2");
        await dormir(Math.min(ESPERA_TOPE_MS, espera * 1000));
        continue;
      }

      if (respuesta.status >= 500) {
        ultimoError = new ErrorShopify(
          `Shopify devolvió ${respuesta.status} en ${etiqueta}.`,
          "Es un fallo del lado de Shopify. El script reintenta solo; si insiste, mira status.shopify.com.",
        );
        await dormir(Math.min(ESPERA_TOPE_MS, ESPERA_BASE_MS * 2 ** (intento - 1)));
        continue;
      }

      const texto = await respuesta.text();
      let cuerpo: RespuestaGraphQL<T> & {
        errors?: { message: string; extensions?: { code?: string } }[];
      };
      try {
        cuerpo = JSON.parse(texto);
      } catch {
        throw new ErrorShopify(
          `Shopify contestó algo que no es JSON en ${etiqueta} (HTTP ${respuesta.status}).`,
          `Los primeros 300 caracteres: ${texto.slice(0, 300)}`,
        );
      }

      this.anotarCoste(cuerpo.extensions);

      if (cuerpo.errors?.length) {
        const throttled = cuerpo.errors.some((e) => e.extensions?.code === "THROTTLED");
        if (throttled) {
          // El cubo está vacío de verdad: esperar a que se rellene lo que pide.
          const necesario = Math.max(this.ultimoCoste, 50);
          await dormir(Math.min(ESPERA_TOPE_MS, Math.ceil((necesario / this.ritmo) * 1000) + 250));
          continue;
        }

        const detalle = cuerpo.errors.map((e) => e.message).join(" · ");
        throw new ErrorShopify(
          `Shopify rechazó la ${etiqueta}: ${detalle}`,
          codigoAccion(cuerpo.errors),
          cuerpo.errors,
        );
      }

      if (!cuerpo.data) {
        throw new ErrorShopify(
          `Shopify no devolvió datos en ${etiqueta}.`,
          "Respuesta vacía sin errores: es un caso raro, vuelve a intentarlo.",
        );
      }

      return cuerpo.data;
    }

    throw (
      ultimoError ??
      new ErrorShopify(
        `Se agotaron los ${REINTENTOS_MAX} intentos en ${etiqueta}.`,
        "Shopify no respondió de forma utilizable. Prueba de nuevo en unos minutos.",
      )
    );
  }
}

/**
 * Traduce los códigos de error de GraphQL a algo accionable.
 *
 * ACCESS_DENIED es, con diferencia, el más común al montar la integración: la
 * app existe y el token es válido, pero le falta un `scope`. Shopify dice cuál
 * en el propio mensaje, así que se le da paso tal cual.
 */
function codigoAccion(errores: { message: string; extensions?: { code?: string } }[]): string {
  const codigos = new Set(errores.map((e) => e.extensions?.code).filter(Boolean));

  if (codigos.has("ACCESS_DENIED")) {
    return "A la app le falta un permiso. En el panel: Configuración → Aplicaciones → Desarrollar aplicaciones → tu app → Configuración de Admin API → marca el permiso que pide el mensaje de arriba y guarda. Ojo: al cambiar permisos hay que REINSTALAR la app, y el token cambia.";
  }
  if (codigos.has("MAX_COST_EXCEEDED")) {
    return "La consulta pide demasiado de una vez. Baja el tamaño de página y vuelve a lanzar.";
  }
  if (codigos.has("SHOP_INACTIVE")) {
    return "La tienda está pausada o el plan caducó. Hay que reactivarla desde el panel antes de poder escribir nada.";
  }
  return "Si el mensaje habla de un campo desconocido, es que la versión del API cambió: borra SHOPIFY_API_VERSION del .env para que se autodetecte la más nueva.";
}

/** Convierte `userErrors` en una excepción legible, o no hace nada si está vacío. */
export function reventarSiHayErrores(
  errores: ErrorDeUsuario[] | undefined | null,
  queSeIntentaba: string,
): void {
  if (!errores || errores.length === 0) return;

  const detalle = errores
    .map((e) => {
      const campo = e.field?.length ? `${e.field.join(".")}: ` : "";
      return `${campo}${e.message}`;
    })
    .join(" · ");

  throw new ErrorShopify(
    `Shopify rechazó ${queSeIntentaba}: ${detalle}`,
    "Esto no es un fallo de red: la operación llegó y Shopify la rechazó por sus propias reglas. El mensaje de arriba dice el campo exacto.",
    errores,
  );
}
