// Diagnóstico de la conexión con Shopify.
//
// Es lo PRIMERO que hay que ejecutar y lo primero que hay que volver a ejecutar
// cuando algo falle. Comprueba, en este orden y parando en cuanto algo no dé:
//
//   1. que el .env tiene lo que hace falta y está bien escrito;
//   2. que Shopify acepta el token y contra qué tienda estamos hablando;
//   3. qué permisos tiene la app y cuáles le faltan para cada tarea;
//   4. qué sabe hacer esta versión del API (camino nuevo o de respaldo);
//   5. con --prueba: crea un producto de mentira, lo mira y lo borra.
//
// El paso 3 es el que ahorra las horas: el 90% de los fallos de una integración
// nueva son un permiso sin marcar, y Shopify lo cuenta con un 403 que no dice
// cuál. Aquí se listan uno a uno.
//
//   npx tsx shopify/verificar.ts
//   npx tsx shopify/verificar.ts --prueba

import { cargarEntorno, ErrorEntorno } from "./lib/entorno.js";
import { ClienteShopify, ErrorShopify, mensajeDe } from "./lib/admin.js";
import { detectarCapacidades } from "./lib/capacidades.js";
import { crearProducto, borrarProducto } from "./lib/productos.js";
import { aEntradaProductSet } from "./lib/mapear.js";
import type { NormalizedProduct } from "@/lib/importers/types";

import { bien, mal, ojo, nota, titulo, regla, negrita, verde, rojo, gris } from "./lib/consola.js";

/* ─────────────────────────── permisos ─────────────────────────── */

/**
 * Los permisos que pide esta integración y PARA QUÉ. La segunda columna importa
 * tanto como la primera: sin ella, un permiso que falta es un nombre técnico
 * sin consecuencia visible, y se acaba marcando todo "por si acaso" — que es
 * justo lo que no se debe hacer con la tienda de otra persona.
 */
const PERMISOS: { handle: string; para: string; imprescindible: boolean }[] = [
  { handle: "write_products", para: "crear e importar productos, variantes y fotos", imprescindible: true },
  { handle: "read_products", para: "buscar si una pieza ya se importó antes", imprescindible: true },
  { handle: "write_publications", para: "poner las piezas a la venta en la tienda online", imprescindible: false },
  { handle: "read_publications", para: "saber en qué canales está publicada cada pieza", imprescindible: false },
  { handle: "write_inventory", para: "marcar las piezas como «sin seguimiento de stock» (dropshipping)", imprescindible: false },
  { handle: "read_locations", para: "saber desde qué almacén se sirve", imprescindible: false },
  { handle: "write_content", para: "migrar las páginas (Devoluciones, Envíos, Sobre nosotros)", imprescindible: false },
  { handle: "write_discounts", para: "migrar los códigos de descuento", imprescindible: false },
  { handle: "read_orders", para: "leer pedidos para informes", imprescindible: false },
];

type PermisoTienda = { handle: string };

async function comprobarPermisos(cliente: ClienteShopify): Promise<boolean> {
  const consulta = `
    query Permisos {
      currentAppInstallation {
        accessScopes { handle }
      }
    }
  `;

  let concedidos: Set<string>;
  try {
    const datos = await cliente.pedir<{
      currentAppInstallation: { accessScopes: PermisoTienda[] } | null;
    }>(consulta, {}, "consulta de permisos");
    concedidos = new Set((datos.currentAppInstallation?.accessScopes || []).map((s) => s.handle));
  } catch (error) {
    ojo(`No pude leer la lista de permisos: ${mensajeDe(error)}`);
    nota("Sigo igualmente; los fallos de permiso saldrán al usar cada función.");
    return true;
  }

  let faltaAlgoImprescindible = false;

  for (const permiso of PERMISOS) {
    if (concedidos.has(permiso.handle)) {
      bien(`${permiso.handle} — ${permiso.para}`);
    } else if (permiso.imprescindible) {
      mal(`${permiso.handle} — ${permiso.para}`);
      faltaAlgoImprescindible = true;
    } else {
      ojo(`${permiso.handle} — ${permiso.para} (opcional)`);
    }
  }

  // Permisos que la app tiene y esta integración no necesita: no es un error,
  // pero conviene verlo. Dar de más en una tienda real es una superficie de
  // riesgo gratuita.
  const pedidos = new Set(PERMISOS.map((p) => p.handle));
  const deMas = [...concedidos].filter((c) => !pedidos.has(c));
  if (deMas.length) {
    console.log("");
    ojo(`La app tiene ${deMas.length} permisos que esta integración no usa:`);
    nota(deMas.join(", "));
    nota("No rompen nada, pero si la tienda es real conviene quitar los que no hagan falta.");
  }

  return !faltaAlgoImprescindible;
}

/* ─────────────────────────── prueba de escritura ─────────────────────────── */

/** Una ficha de mentira que ejercita todo: dos ejes de variante, foto y coste. */
function fichaDePrueba(): NormalizedProduct {
  return {
    provider: "manual",
    method: "migracion",
    sourceProductId: `prueba-${Date.now()}`,
    sourceUrl: null,
    title: "PRUEBA — bórrame si sigo aquí",
    description:
      "Producto de prueba creado por shopify/verificar.ts.\n\nSi lo estás leyendo en la tienda, el script no llegó a borrarlo: bórralo a mano.",
    attributes: { Material: "Ninguno", Origen: "Script de verificación" },
    images: [],
    optionNames: ["Talla", "Color"],
    variants: [
      { title: "S / Negro", optionValues: ["S", "Negro"], costCents: 500, priceCents: 1999, sku: "PRUEBA-S-NEGRO" },
      { title: "M / Negro", optionValues: ["M", "Negro"], costCents: 500, priceCents: 1999, sku: "PRUEBA-M-NEGRO" },
    ],
    costCentsMin: 500,
    costCentsMax: 500,
    currency: "USD",
    vendor: "Verificación",
    warnings: [],
  };
}

async function pruebaDeEscritura(cliente: ClienteShopify): Promise<boolean> {
  const capacidades = await detectarCapacidades(cliente);
  const { entrada } = aEntradaProductSet(fichaDePrueba(), capacidades, {
    handle: `prueba-verificacion-${Date.now().toString(36)}`,
    estado: "DRAFT",
    etiquetas: ["prueba-automatica"],
  });

  let creado: Awaited<ReturnType<typeof crearProducto>> | null = null;
  try {
    creado = await crearProducto(cliente, capacidades, entrada);
    bien(`Producto de prueba creado: ${creado.titulo}`);
    nota(`${creado.variantes} variantes · ${creado.fotos} fotos · handle ${creado.handle}`);
  } catch (error) {
    mal(`No se pudo crear el producto de prueba: ${mensajeDe(error)}`);
    if (error instanceof ErrorShopify) nota(error.pista);
    return false;
  }

  try {
    await borrarProducto(cliente, creado.id);
    bien("Producto de prueba borrado: la tienda queda como estaba.");
  } catch (error) {
    ojo(`El producto se creó pero NO se pudo borrar: ${mensajeDe(error)}`);
    nota(`Bórralo a mano aquí: ${creado.urlPanel}`);
    // La escritura funciona, que es lo que se estaba comprobando.
    return true;
  }

  return true;
}

/* ─────────────────────────── principal ─────────────────────────── */

async function principal(): Promise<void> {
  const conPrueba = process.argv.includes("--prueba");

  console.log(negrita("\nVerificación de la conexión con Shopify"));
  regla();

  /* 1 — el .env */
  titulo("1 · Configuración local");
  let entorno;
  try {
    entorno = await cargarEntorno();
    bien(`Tienda: ${entorno.tienda}`);
    bien(`Token: ${entorno.token.slice(0, 12)}… (${entorno.token.length} caracteres)`);
    if (entorno.version) ojo(`Versión del API fijada a mano: ${entorno.version}`);
  } catch (error) {
    if (error instanceof ErrorEntorno) {
      mal(error.message);
      nota(error.pista);
    } else {
      mal(mensajeDe(error));
    }
    console.log(rojo("\nNo se puede seguir sin esto.\n"));
    process.exitCode = 1;
    return;
  }

  /* 2 — la tienda */
  titulo("2 · Conexión y tienda");
  let cliente: ClienteShopify;
  try {
    cliente = await ClienteShopify.crear();
    bien(`Versión del Admin API: ${cliente.versionApi}`);
  } catch (error) {
    mal(mensajeDe(error));
    if (error instanceof ErrorShopify) nota(error.pista);
    console.log(rojo("\nNo se puede seguir sin conexión.\n"));
    process.exitCode = 1;
    return;
  }

  try {
    const datos = await cliente.pedir<{
      shop: {
        name: string;
        myshopifyDomain: string;
        currencyCode: string;
        ianaTimezone: string;
        primaryDomain: { url: string; host: string };
        plan: { displayName: string; partnerDevelopment: boolean; shopifyPlus: boolean };
      };
    }>(
      `query Tienda {
        shop {
          name
          myshopifyDomain
          currencyCode
          ianaTimezone
          primaryDomain { url host }
          plan { displayName partnerDevelopment shopifyPlus }
        }
      }`,
      {},
      "consulta de la tienda",
    );

    const shop = datos.shop;
    bien(`Nombre: ${shop.name}`);
    bien(`Dominio público: ${shop.primaryDomain.url}`);
    bien(`Moneda: ${shop.currencyCode} · Zona horaria: ${shop.ianaTimezone}`);
    bien(`Plan: ${shop.plan.displayName}`);

    if (shop.currencyCode !== "USD") {
      ojo(`La moneda de la tienda es ${shop.currencyCode}, pero los importadores calculan en USD.`);
      nota("Los precios importados saldrán con el número correcto pero en la moneda de la tienda.");
    }
    if (shop.plan.partnerDevelopment) {
      ojo("Es una tienda de desarrollo: no puede cobrar de verdad hasta pasarla a un plan de pago.");
    }
  } catch (error) {
    mal(mensajeDe(error));
    if (error instanceof ErrorShopify) nota(error.pista);
    process.exitCode = 1;
    return;
  }

  /* 3 — permisos */
  titulo("3 · Permisos de la app");
  const permisosOk = await comprobarPermisos(cliente);
  if (!permisosOk) {
    console.log("");
    mal("Faltan permisos imprescindibles: sin ellos no se puede importar nada.");
    nota("Panel → Configuración → Aplicaciones y canales de venta → Desarrollar aplicaciones");
    nota("→ tu app → Configuración de Admin API → marca los que faltan → Guardar → REINSTALAR");
    nota("Al reinstalar, el token CAMBIA: hay que copiarlo otra vez al .env.");
  }

  /* 4 — capacidades del API */
  titulo("4 · Qué sabe hacer esta versión del API");
  try {
    const capacidades = await detectarCapacidades(cliente, true);
    if (capacidades.productSet) {
      bien("productSet disponible: cada producto entra en UNA sola llamada (camino bueno).");
    } else {
      ojo("productSet NO disponible: se usará el camino de respaldo (tres llamadas).");
      nota("Funciona igual, pero no es atómico: un fallo a mitad deja el producto sin variantes.");
    }
    if (capacidades.camposProductSet.length) {
      nota(`ProductSetInput acepta ${capacidades.camposProductSet.length} campos.`);
      const clave = ["files", "metafields", "seo", "collections"].filter(
        (c) => !capacidades.camposProductSet.includes(c),
      );
      if (clave.length) ojo(`No acepta: ${clave.join(", ")} — se manejan aparte.`);
    }
  } catch (error) {
    ojo(`No se pudieron detectar las capacidades: ${mensajeDe(error)}`);
  }

  /* 5 — prueba real */
  if (conPrueba) {
    titulo("5 · Prueba de escritura (crea y borra un producto)");
    if (!permisosOk) {
      ojo("Saltada: faltan permisos imprescindibles.");
    } else {
      const ok = await pruebaDeEscritura(cliente);
      if (!ok) process.exitCode = 1;
    }
  } else {
    titulo("5 · Prueba de escritura");
    nota("Saltada. Añade --prueba para crear y borrar un producto de verdad.");
  }

  console.log("");
  regla();
  if (process.exitCode) {
    console.log(rojo("Hay cosas que arreglar antes de importar.\n"));
  } else {
    console.log(`${verde("Todo listo.")} Panel: ${cliente.panel}\n`);
  }
}

principal().catch((error) => {
  console.error(`${rojo("\nError inesperado:")} ${mensajeDe(error)}`);
  if (error instanceof ErrorShopify || error instanceof ErrorEntorno) {
    console.error(gris((error as { pista: string }).pista));
  }
  process.exitCode = 1;
});
