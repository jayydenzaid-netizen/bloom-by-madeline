// Importar una ficha de AliExpress o Alibaba directamente a Shopify.
//
// Reutiliza los adaptadores que ya existían en `lib/importers/`: son mil líneas
// por proveedor de leer un estado JSON que cambia de nombre cada temporada, y
// tirarlas para volver a escribirlas contra Shopify habría sido absurdo. Aquí
// solo se añade el último tramo: ficha normalizada → producto en la tienda.
//
//   npx tsx shopify/importar.ts "https://es.aliexpress.com/item/1005006....html"
//   npx tsx shopify/importar.ts "https://www.alibaba.com/product-detail/...html" --margen 3
//   npx tsx shopify/importar.ts --html ficha-guardada.html
//   npx tsx shopify/importar.ts "<url>" --coleccion nuevas-llegadas --publicar
//
// Por defecto TODO entra como borrador. `--publicar` existe, pero hay que
// escribirlo a conciencia: publicar sin mirar es publicar un título de máquina y
// fotos con marca de agua en la tienda de una clienta real.

import { readFile } from "node:fs/promises";

import { importFromUrl, importFromHtml } from "@/lib/importers";
import { DEFAULT_PRICING, formatCents, type PricingRule } from "@/lib/money";
import type { NormalizedProduct } from "@/lib/importers/types";

import { ClienteShopify, ErrorShopify, mensajeDe } from "./lib/admin.js";
import { detectarCapacidades } from "./lib/capacidades.js";
import { aEntradaProductSet, aHandle } from "./lib/mapear.js";
import {
  buscarImportadoAntes,
  crearProducto,
  crearColeccion,
  anadirAColeccion,
  handleDisponible,
} from "./lib/productos.js";
import { bien, mal, ojo, nota, titulo, regla, negrita, verde, rojo, gris, cian } from "./lib/consola.js";

/* ─────────────────────────── argumentos ─────────────────────────── */

type Argumentos = {
  url: string | null;
  ficheroHtml: string | null;
  publicar: boolean;
  forzar: boolean;
  coleccion: string | null;
  pricing: PricingRule;
};

function leerArgumentos(argv: string[]): Argumentos {
  const args: Argumentos = {
    url: null,
    ficheroHtml: null,
    publicar: false,
    forzar: false,
    coleccion: null,
    pricing: { ...DEFAULT_PRICING },
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--publicar") args.publicar = true;
    else if (a === "--forzar") args.forzar = true;
    else if (a === "--html") args.ficheroHtml = argv[++i] || null;
    else if (a === "--coleccion") args.coleccion = argv[++i] || null;
    else if (a === "--margen") {
      const valor = Number(argv[++i]);
      if (Number.isFinite(valor) && valor > 0) args.pricing.multiplier = valor;
    } else if (a === "--redondeo") {
      const valor = argv[++i];
      if (valor === "99" || valor === "95" || valor === "whole" || valor === "none") {
        args.pricing.rounding = valor;
      }
    } else if (!a.startsWith("--") && !args.url) {
      args.url = a;
    }
  }

  return args;
}

function ayuda(): void {
  console.log(`
${negrita("Importar de AliExpress / Alibaba a Shopify")}

  npx tsx shopify/importar.ts "<url de la ficha>"          importa esa pieza
  npx tsx shopify/importar.ts --html ficha.html            importa de un HTML guardado

${negrita("Opciones")}
  --margen 2.6        multiplicador sobre el coste del proveedor (por defecto ${DEFAULT_PRICING.multiplier})
  --redondeo 99       cómo termina el precio: 99 · 95 · whole · none
  --coleccion <slug>  además, mete la pieza en esa colección (la crea si no existe)
  --publicar          entra ACTIVA en vez de borrador. Úsalo sabiendo lo que haces.
  --forzar            impórtala aunque ya se hubiera importado antes

${gris("Sin --publicar la pieza entra como borrador: nadie la ve hasta que la revises.")}
`);
}

/* ─────────────────────────── obtener la ficha ─────────────────────────── */

async function conseguirFicha(args: Argumentos): Promise<NormalizedProduct> {
  if (args.ficheroHtml) {
    let html: string;
    try {
      html = await readFile(args.ficheroHtml, "utf8");
    } catch (error) {
      throw new Error(`No pude leer «${args.ficheroHtml}»: ${mensajeDe(error)}`);
    }
    const resultado = importFromHtml(html, args.url || undefined);
    if (!resultado.ok) {
      throw Object.assign(new Error(resultado.error), { pista: resultado.hint });
    }
    return resultado.product;
  }

  if (!args.url) throw new Error("Hace falta una URL o un fichero con --html.");

  const resultado = await importFromUrl(args.url);
  if (!resultado.ok) {
    throw Object.assign(new Error(resultado.error), { pista: resultado.hint });
  }
  return resultado.product;
}

/* ─────────────────────────── resumen de la ficha ─────────────────────────── */

function resumirFicha(producto: NormalizedProduct, pricing: PricingRule): void {
  titulo("Lo que trae el proveedor");
  bien(`Título: ${producto.title || "(sin título)"}`);
  bien(`Proveedor: ${producto.provider} · vía ${producto.method}`);
  bien(`Fotos: ${producto.images.length}`);

  if (producto.optionNames.length) {
    bien(`Variantes: ${producto.variants.length} sobre ${producto.optionNames.join(" × ")}`);
  } else {
    ojo("Sin variantes: entra como pieza única.");
  }

  const costes = producto.variants
    .map((v) => v.costCents)
    .filter((c): c is number => typeof c === "number" && c > 0);
  const costeMin = costes.length ? Math.min(...costes) : producto.costCentsMin;
  const costeMax = costes.length ? Math.max(...costes) : producto.costCentsMax;

  if (costeMin) {
    const rango =
      costeMax && costeMax !== costeMin
        ? `${formatCents(costeMin)} – ${formatCents(costeMax)}`
        : formatCents(costeMin);
    bien(`Coste en el proveedor: ${rango}`);
    nota(
      `Con margen ×${pricing.multiplier} + ${formatCents(pricing.addCents)}, terminado en ${pricing.rounding}`,
    );
  } else {
    ojo("El proveedor no dio ningún coste: los precios habrá que ponerlos a mano.");
  }

  const atributos = Object.keys(producto.attributes || {}).length;
  if (atributos) nota(`${atributos} campos de ficha técnica se pasan a la descripción.`);
}

/* ─────────────────────────── principal ─────────────────────────── */

async function principal(): Promise<void> {
  const args = leerArgumentos(process.argv.slice(2));

  if (!args.url && !args.ficheroHtml) {
    ayuda();
    process.exitCode = 1;
    return;
  }

  console.log(negrita("\nImportar a Shopify"));
  regla();

  /* 1 — leer la ficha del proveedor */
  let producto: NormalizedProduct;
  try {
    titulo("1 · Leyendo la ficha del proveedor");
    nota(args.ficheroHtml ? `desde ${args.ficheroHtml}` : args.url || "");
    producto = await conseguirFicha(args);
  } catch (error) {
    mal(mensajeDe(error));
    const pista = (error as { pista?: string }).pista;
    if (pista) nota(pista);
    process.exitCode = 1;
    return;
  }

  resumirFicha(producto, args.pricing);

  /* 2 — conectar */
  titulo("2 · Conectando con Shopify");
  let cliente: ClienteShopify;
  try {
    cliente = await ClienteShopify.crear();
    bien(`${cliente.tienda} · API ${cliente.versionApi}`);
  } catch (error) {
    mal(mensajeDe(error));
    if (error instanceof ErrorShopify) nota(error.pista);
    nota("Ejecuta primero: npx tsx shopify/verificar.ts");
    process.exitCode = 1;
    return;
  }

  const capacidades = await detectarCapacidades(cliente);

  /* 3 — ¿ya estaba? */
  titulo("3 · Comprobando si ya se importó");
  try {
    const previo = await buscarImportadoAntes(cliente, producto.provider, producto.sourceProductId);
    if (previo && !args.forzar) {
      ojo(`Esta pieza ya está en la tienda: «${previo.titulo}» (${previo.estado.toLowerCase()}).`);
      nota(`${cliente.panel}/products/${previo.id.split("/").pop()}`);
      nota("Si aun así quieres crearla otra vez, repite el comando con --forzar.");
      console.log("");
      return;
    }
    if (previo && args.forzar) {
      ojo(`Ya existía «${previo.titulo}», pero se pidió --forzar: se crea una segunda copia.`);
    } else {
      bien("Es nueva.");
    }
  } catch (error) {
    // No poder comprobarlo no es motivo para no importar; sí para avisar.
    ojo(`No pude comprobar si ya existía: ${mensajeDe(error)}`);
  }

  /* 4 — crear */
  titulo("4 · Creando el producto");

  const handleBase = aHandle(producto.title || "pieza");
  let handle = handleBase;
  try {
    handle = await handleDisponible(cliente, handleBase);
    if (handle !== handleBase) nota(`El handle «${handleBase}» estaba ocupado; se usa «${handle}».`);
  } catch {
    // Si la comprobación falla se sigue con el base: Shopify avisará si choca.
  }

  const { entrada, avisos } = aEntradaProductSet(producto, capacidades, {
    pricing: args.pricing,
    handle,
    estado: args.publicar ? "ACTIVE" : "DRAFT",
  });

  let creado;
  try {
    creado = await crearProducto(cliente, capacidades, entrada);
    bien(`Creado: ${creado.titulo}`);
    nota(`${creado.variantes} variantes · ${creado.fotos} fotos · /${creado.handle}`);
  } catch (error) {
    mal(`Shopify rechazó el producto: ${mensajeDe(error)}`);
    if (error instanceof ErrorShopify) nota(error.pista);
    process.exitCode = 1;
    return;
  }

  /* 5 — colección */
  if (args.coleccion) {
    titulo("5 · Metiéndolo en la colección");
    try {
      const titulosBonitos = args.coleccion
        .split("-")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ");
      const coleccionId = await crearColeccion(cliente, {
        handle: args.coleccion,
        titulo: titulosBonitos,
      });
      await anadirAColeccion(cliente, coleccionId, [creado.id]);
      bien(`En «${titulosBonitos}».`);
    } catch (error) {
      ojo(`No se pudo meter en la colección: ${mensajeDe(error)}`);
      nota("El producto SÍ se creó; solo falta asignarle la colección a mano.");
    }
  }

  /* 6 — avisos */
  if (avisos.length) {
    titulo("Cosas que revisar antes de publicar");
    for (const aviso of avisos) ojo(aviso);
  }

  console.log("");
  regla();
  if (args.publicar) {
    console.log(`${verde("Publicado.")} Ya se ve en la tienda.`);
  } else {
    console.log(`${verde("Importado como borrador.")} No lo ve nadie todavía.`);
  }
  console.log(`${gris("Revísalo aquí:")} ${cian(creado.urlPanel)}\n`);
}

principal().catch((error) => {
  console.error(`${rojo("\nError inesperado:")} ${mensajeDe(error)}`);
  const pista = (error as { pista?: string }).pista;
  if (pista) console.error(gris(pista));
  process.exitCode = 1;
});
