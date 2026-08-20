/**
 * Seed de Bloom by Madeline.
 *
 * Deja la tienda utilizable desde el primer arranque: admin, ajustes reales del
 * negocio, colecciones y el catálogo que ya existía en el sitio viejo.
 *
 * Dos principios que mandan sobre cualquier comodidad:
 *
 *  1. NO SE INVENTAN DATOS DE LA CLIENTA. Los productos que vienen del sitio viejo
 *     no tienen precio conocido, así que entran como `draft` con precio 0. Madeline
 *     les pone precio y los publica. Teléfono y email quedan vacíos por lo mismo.
 *  2. ES IDEMPOTENTE Y NO DESTRUCTIVO. Correrlo dos veces no duplica nada, y lo que
 *     ya tocó Madeline (precios, estado, ajustes) no se pisa: solo se rellena lo que
 *     falta. Un seed que borra el trabajo de la dueña es peor que no tener seed.
 *
 * Uso:
 *   npx tsx prisma/seed.ts            → solo datos reales (catálogo en borrador)
 *   npx tsx prisma/seed.ts --demo     → añade 6 productos DEMO activos y con precio
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { db } from "@/lib/db";
import { ensureSeedAdmin } from "@/lib/auth";
import { DEFAULT_SETTINGS, saveSettings, type StoreSettings } from "@/lib/settings";
import { slugify, uniqueCollectionSlug, uniqueProductSlug } from "@/lib/slug";
import { applyPricing, DEFAULT_PRICING, formatCents } from "@/lib/money";

// ───────────────────────────── datos del sitio viejo ─────────────────────────────

type SeedCollection = {
  title: string;
  description: string;
  /** Foto real de una de sus prendas; no hay arte de colección aparte. */
  imageUrl: string;
};

type SeedProduct = {
  title: string;
  description: string;
  /** Línea literal de `data-meta` en legacy/index.html. Se conserva como origen. */
  meta: string;
  image: string;
  alt: string;
  sizes: string[];
  productType: string;
  tags: string[];
  /** Títulos de las colecciones a las que pertenece. */
  collections: string[];
};

const COL_NUEVAS = "Nuevas llegadas";
const COL_VESTIDOS = "Vestidos";
const COL_CONJUNTOS = "Conjuntos";
const COL_BLUSAS = "Blusas y tops";

// Los nombres salen del propio sitio: la sección se titula "01 — La Colección ·
// Nuevas llegadas" y las prendas se agrupan solas por tipo.
const COLLECTIONS: SeedCollection[] = [
  {
    title: COL_NUEVAS,
    description:
      "Cada pieza nombrada como una flor, porque aquí todo florece. Lo último que llegó a la boutique.",
    imageUrl: "/assets/post-08-look-perfecto.jpg",
  },
  {
    title: COL_VESTIDOS,
    description: "Midis, minis y maxis para los días en que apetece brillar.",
    imageUrl: "/assets/post-12-vestido-coral.jpg",
  },
  {
    title: COL_CONJUNTOS,
    description: "Dos piezas pensadas para ir juntas y resolver el look de una vez.",
    imageUrl: "/assets/post-02-tendencia.jpg",
  },
  {
    title: COL_BLUSAS,
    description: "Blusas y tops que levantan cualquier jean.",
    imageUrl: "/assets/post-07-blusa-corazon.jpg",
  },
];

// Talla por defecto: el HTML viejo no trae `data-sizes`, pero todas las fichas
// dicen "Tallas S / M / L" en el meta y el marquee del sitio también.
const TALLAS_POR_DEFECTO = ["S", "M", "L"];

/**
 * Los 8 productos del grid `article.product` de legacy/index.html, copiados tal
 * cual: nombre de flor, `data-desc`, `data-meta`, imagen y el alt de la foto.
 * No hay más: el sitio viejo tiene 8 fichas, no 12 (las otras fotos de post-*
 * son publicaciones de Instagram, no prendas).
 */
const PRODUCTS: SeedProduct[] = [
  {
    title: "Set Margarita",
    description:
      "Top peplum de tiras y falda midi entallada en lunares. El conjunto que se lleva todas las miradas del escaparate.",
    meta: "Negro · Lunares — Tallas S / M / L",
    image: "/assets/post-02-tendencia.jpg",
    alt: "Set Margarita: top peplum y falda midi de lunares negro",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Conjunto",
    tags: ["Negro", "Lunares"],
    collections: [COL_CONJUNTOS, COL_NUEVAS],
  },
  {
    title: "Vestido Salvia",
    description:
      "Midi de punto acanalado a rayas, cuello halter y silueta que abraza. Disponible en dos colores: oliva y negro.",
    meta: "Oliva & Crema · también en Negro — Tallas S / M / L",
    image: "/assets/post-03-vestido-negro-olivo.jpg",
    alt: "Vestido Salvia: midi de rayas oliva y crema",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Vestido",
    tags: ["Oliva", "Crema", "Negro"],
    collections: [COL_VESTIDOS, COL_NUEVAS],
  },
  {
    title: "Vestido Jazmín",
    description:
      "Maxi blanco perla con detalles de cristal en el escote y la cintura. Elegancia pura para una noche especial.",
    meta: "Blanco Perla · Cristales — Tallas S / M / L",
    image: "/assets/post-04-set-falda-diamantes.jpg",
    alt: "Vestido Jazmín: maxi blanco con detalles de cristales",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Vestido",
    tags: ["Blanco Perla", "Cristales"],
    collections: [COL_VESTIDOS, COL_NUEVAS],
  },
  {
    title: "Vestido Mimosa",
    description:
      "Mini de punto acanalado con escote halter cruzado. Un color que no pide permiso.",
    meta: "Verde Lima — Tallas S / M / L",
    image: "/assets/post-05-vestido-blanco.jpg",
    alt: "Vestido Mimosa: mini halter verde lima",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Vestido",
    tags: ["Verde Lima"],
    collections: [COL_VESTIDOS, COL_NUEVAS],
  },
  {
    title: "Blusa Violeta",
    description:
      "Blusa blanca con mangas abullonadas a rayas lilas y corazón de cristales al centro. Súper fresca para el verano.",
    meta: "Blanco & Lila · Corazón de cristales — Tallas S / M / L",
    image: "/assets/post-07-blusa-corazon.jpg",
    alt: "Blusa Violeta: mangas abullonadas lilas y corazón de cristales",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Blusa",
    tags: ["Blanco", "Lila", "Cristales"],
    collections: [COL_BLUSAS, COL_NUEVAS],
  },
  {
    title: "Top Lavanda",
    description:
      "Top lila con plumas de avestruz en el bajo. La pieza statement de la temporada — new arrival.",
    meta: "Lila · Plumas — Tallas S / M / L",
    image: "/assets/post-08-look-perfecto.jpg",
    alt: "Top Lavanda: top lila con plumas de avestruz",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Top",
    tags: ["Lila", "Plumas"],
    collections: [COL_BLUSAS, COL_NUEVAS],
  },
  {
    title: "Vestido Amapola",
    description:
      "Mini naranja con mangas globo, cinturón a juego y falda con volumen. Para robar todas las miradas del verano.",
    meta: "Naranja — Tallas S / M / L",
    image: "/assets/post-10-vestido-orange.jpg",
    alt: "Vestido Amapola: mini naranja con mangas globo y cinturón",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Vestido",
    tags: ["Naranja"],
    collections: [COL_VESTIDOS, COL_NUEVAS],
  },
  {
    title: "Vestido Dalia",
    description:
      "Maxi durazno con cut-outs en la cintura, mangas transparentes abullonadas y argolla central. Romántico y atrevido a la vez.",
    meta: "Durazno — Tallas S / M / L",
    image: "/assets/post-12-vestido-coral.jpg",
    alt: "Vestido Dalia: maxi durazno con cut-outs y mangas transparentes",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Vestido",
    tags: ["Durazno"],
    collections: [COL_VESTIDOS, COL_NUEVAS],
  },
];

// ───────────────────────────── productos de demostración ─────────────────────────────

type DemoProduct = SeedProduct & {
  /** Coste ficticio; el precio sale de applyPricing, no se escribe a mano. */
  costCents: number;
  /** Con control de stock para poder probar el "agotado" en el checkout. */
  trackStock: boolean;
  stockPorTalla: number;
};

/**
 * Solo con `--demo`. Existen para poder enseñar la tienda funcionando de punta a
 * punta (carrito, checkout, pedido) sin ponerle precio inventado a la ropa real:
 * llevan la foto genérica del interior de la boutique, el prefijo "DEMO" en el
 * título y el tag `demo`, así que se borran de un tirón:
 *   db.product.deleteMany({ where: { tagsJson: { contains: '"demo"' } } })
 */
const DEMO_IMAGE = "/assets/boutique-interior.jpg";

const DEMO_PRODUCTS: DemoProduct[] = [
  {
    title: "DEMO · Vestido de muestra",
    description:
      "Producto de demostración para probar la tienda de punta a punta. No es una prenda real y su precio es inventado.",
    meta: "Producto de prueba — Tallas S / M / L",
    image: DEMO_IMAGE,
    alt: "Interior de la boutique Bloom by Madeline (foto de demostración)",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Vestido",
    tags: ["demo"],
    collections: [COL_VESTIDOS, COL_NUEVAS],
    costCents: 1200,
    trackStock: false,
    stockPorTalla: 0,
  },
  {
    title: "DEMO · Conjunto de muestra",
    description:
      "Producto de demostración para probar la tienda de punta a punta. No es una prenda real y su precio es inventado.",
    meta: "Producto de prueba — Tallas S / M / L",
    image: DEMO_IMAGE,
    alt: "Interior de la boutique Bloom by Madeline (foto de demostración)",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Conjunto",
    tags: ["demo"],
    collections: [COL_CONJUNTOS, COL_NUEVAS],
    costCents: 1800,
    trackStock: false,
    stockPorTalla: 0,
  },
  {
    title: "DEMO · Blusa de muestra",
    description:
      "Producto de demostración para probar la tienda de punta a punta. No es una prenda real y su precio es inventado.",
    meta: "Producto de prueba — Tallas S / M / L",
    image: DEMO_IMAGE,
    alt: "Interior de la boutique Bloom by Madeline (foto de demostración)",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Blusa",
    tags: ["demo"],
    collections: [COL_BLUSAS, COL_NUEVAS],
    costCents: 900,
    trackStock: false,
    stockPorTalla: 0,
  },
  {
    title: "DEMO · Top de muestra",
    description:
      "Producto de demostración para probar la tienda de punta a punta. No es una prenda real y su precio es inventado.",
    meta: "Producto de prueba — Tallas S / M / L",
    image: DEMO_IMAGE,
    alt: "Interior de la boutique Bloom by Madeline (foto de demostración)",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Top",
    tags: ["demo"],
    collections: [COL_BLUSAS, COL_NUEVAS],
    costCents: 750,
    trackStock: false,
    stockPorTalla: 0,
  },
  {
    // Con stock limitado: hace falta un caso así para probar el "quedan pocas".
    title: "DEMO · Vestido con stock limitado",
    description:
      "Producto de demostración con control de inventario, para probar el aviso de stock y el agotado. No es una prenda real.",
    meta: "Producto de prueba con stock — Tallas S / M / L",
    image: DEMO_IMAGE,
    alt: "Interior de la boutique Bloom by Madeline (foto de demostración)",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Vestido",
    tags: ["demo"],
    collections: [COL_VESTIDOS, COL_NUEVAS],
    costCents: 2400,
    trackStock: true,
    stockPorTalla: 3,
  },
  {
    // Agotado de fábrica: el checkout tiene que negarse a venderlo.
    title: "DEMO · Conjunto agotado",
    description:
      "Producto de demostración sin existencias, para comprobar que la tienda no deja comprar lo que no hay. No es una prenda real.",
    meta: "Producto de prueba agotado — Tallas S / M / L",
    image: DEMO_IMAGE,
    alt: "Interior de la boutique Bloom by Madeline (foto de demostración)",
    sizes: TALLAS_POR_DEFECTO,
    productType: "Conjunto",
    tags: ["demo"],
    collections: [COL_CONJUNTOS, COL_NUEVAS],
    costCents: 3100,
    trackStock: true,
    stockPorTalla: 0,
  },
];

// ───────────────────────────────── utilidades ─────────────────────────────────

const PUBLIC_DIR = path.join(process.cwd(), "public");

/** Aborta antes de escribir nada si una foto del seed no existe en /public. */
function verificarImagenes(rutas: string[]): void {
  const faltan = [...new Set(rutas)].filter(
    (ruta) => !existsSync(path.join(PUBLIC_DIR, ruta.replace(/^\//, ""))),
  );
  if (faltan.length > 0) {
    throw new Error(
      `Faltan imágenes en public/: ${faltan.join(", ")}. ` +
        "El seed no escribe nada para no dejar productos con la foto rota.",
    );
  }
}

/**
 * Slug estable entre ejecuciones: si el registro ya existe con el slug natural se
 * reutiliza. Llamar a uniqueXSlug a ciegas daría "vestidos-2" en la segunda pasada.
 */
async function slugDeColeccion(title: string): Promise<string> {
  const base = slugify(title);
  const existe = await db.collection.findUnique({ where: { slug: base }, select: { slug: true } });
  return existe ? existe.slug : await uniqueCollectionSlug(title);
}

async function slugDeProducto(title: string): Promise<string> {
  const base = slugify(title);
  const existe = await db.product.findUnique({ where: { slug: base }, select: { slug: true } });
  return existe ? existe.slug : await uniqueProductSlug(title);
}

const resumen = {
  adminCreado: false,
  ajustesEscritos: [] as string[],
  coleccionesCreadas: 0,
  coleccionesExistentes: 0,
  productosCreados: 0,
  productosExistentes: 0,
  variantesCreadas: 0,
  imagenesCreadas: 0,
  demoCreados: 0,
  demoExistentes: 0,
};

// ─────────────────────────────────── pasos ───────────────────────────────────

async function seedAdmin(): Promise<string> {
  const antes = await db.adminUser.count();
  await ensureSeedAdmin();
  resumen.adminCreado = antes === 0;
  const admin = await db.adminUser.findFirst({ select: { email: true } });
  return admin?.email ?? "(sin admin)";
}

async function seedAjustes(): Promise<void> {
  // El teléfono y el email van vacíos a propósito: no los tenemos y no se inventan.
  const ajustes: StoreSettings = { ...DEFAULT_SETTINGS, email: "", phone: "" };

  // Solo se siembran las claves que faltan; si Madeline ya cambió un ajuste desde
  // el panel, un segundo `npm run db:seed` no debe devolvérselo al valor de fábrica.
  const existentes = new Set((await db.setting.findMany({ select: { key: true } })).map((s) => s.key));
  const patch: Partial<StoreSettings> = {};
  for (const key of Object.keys(ajustes) as (keyof StoreSettings)[]) {
    if (existentes.has(key)) continue;
    (patch as Record<string, unknown>)[key] = ajustes[key];
    resumen.ajustesEscritos.push(key);
  }

  if (resumen.ajustesEscritos.length > 0) await saveSettings(patch);
}

async function seedColecciones(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const [index, spec] of COLLECTIONS.entries()) {
    const slug = await slugDeColeccion(spec.title);
    const existe = await db.collection.findUnique({ where: { slug }, select: { id: true } });

    const coleccion = await db.collection.upsert({
      where: { slug },
      update: { title: spec.title, description: spec.description, position: index },
      create: {
        slug,
        title: spec.title,
        description: spec.description,
        imageUrl: spec.imageUrl,
        position: index,
        isVisible: true,
      },
      select: { id: true },
    });

    if (existe) resumen.coleccionesExistentes++;
    else resumen.coleccionesCreadas++;
    ids.set(spec.title, coleccion.id);
  }

  return ids;
}

type OpcionesDeSiembra = {
  /** draft para la ropa real (sin precio conocido), active para las demos. */
  status: "draft" | "active";
  priceCents: number;
  costCents: number | null;
  trackStock: boolean;
  stockPorTalla: number;
};

/**
 * Crea o completa un producto con su imagen, sus variantes de talla y sus
 * colecciones. Al actualizar NO toca `status` ni los precios: esos son terreno de
 * Madeline en cuanto abra el panel.
 */
async function seedProducto(
  spec: SeedProduct,
  opciones: OpcionesDeSiembra,
  coleccionIds: Map<string, string>,
): Promise<"creado" | "existente"> {
  const slug = await slugDeProducto(spec.title);
  const previo = await db.product.findUnique({ where: { slug }, select: { id: true } });

  const comun = {
    title: spec.title,
    description: spec.description,
    vendor: "Bloom by Madeline",
    productType: spec.productType,
    tagsJson: JSON.stringify(spec.tags),
    optionNamesJson: JSON.stringify(["Talla"]),
    seoTitle: `${spec.title} · Bloom by Madeline`,
    seoDescription: spec.description.slice(0, 155),
    sourceProvider: "manual",
    // El meta original queda guardado aquí para no perder la copia literal del
    // sitio viejo aunque la descripción se reescriba desde el panel.
    sourceDataJson: JSON.stringify({ origen: "legacy/index.html", meta: spec.meta, imagen: spec.image }),
  };

  const producto = await db.product.upsert({
    where: { slug },
    update: comun,
    create: {
      slug,
      ...comun,
      status: opciones.status,
      priceCents: opciones.priceCents,
      costCents: opciones.costCents,
      publishedAt: opciones.status === "active" ? new Date() : null,
    },
    select: { id: true },
  });

  // Imagen: una sola foto por producto en el sitio viejo.
  const yaTieneFoto = await db.productImage.findFirst({
    where: { productId: producto.id, url: spec.image },
    select: { id: true },
  });
  if (!yaTieneFoto) {
    await db.productImage.create({
      data: { productId: producto.id, url: spec.image, alt: spec.alt, position: 0, localPath: spec.image },
    });
    resumen.imagenesCreadas++;
  }

  // Una variante por talla. Se crean solo las que falten, para no duplicar ni
  // pisar el precio que Madeline le haya puesto ya a una talla concreta.
  const variantes = await db.productVariant.findMany({
    where: { productId: producto.id },
    select: { option1: true },
  });
  const tallasExistentes = new Set(variantes.map((v) => v.option1));

  for (const [index, talla] of spec.sizes.entries()) {
    if (tallasExistentes.has(talla)) continue;
    await db.productVariant.create({
      data: {
        productId: producto.id,
        title: talla,
        sku: `${slug}-${talla}`.toLowerCase(),
        option1: talla,
        priceCents: opciones.priceCents,
        costCents: opciones.costCents,
        stock: opciones.stockPorTalla,
        trackStock: opciones.trackStock,
        imageUrl: spec.image,
        position: index,
      },
    });
    resumen.variantesCreadas++;
  }

  for (const [index, titulo] of spec.collections.entries()) {
    const collectionId = coleccionIds.get(titulo);
    if (!collectionId) continue;
    await db.collectionProduct.upsert({
      where: { collectionId_productId: { collectionId, productId: producto.id } },
      update: { position: index },
      create: { collectionId, productId: producto.id, position: index },
    });
  }

  return previo ? "existente" : "creado";
}

async function seedCatalogoReal(coleccionIds: Map<string, string>): Promise<void> {
  for (const spec of PRODUCTS) {
    const resultado = await seedProducto(
      spec,
      // priceCents 0 + draft: no conocemos el precio real y el contrato prohíbe
      // inventarlo. trackStock false porque la boutique no lleva inventario aquí.
      { status: "draft", priceCents: 0, costCents: null, trackStock: false, stockPorTalla: 0 },
      coleccionIds,
    );
    if (resultado === "creado") resumen.productosCreados++;
    else resumen.productosExistentes++;
  }
}

async function seedDemo(coleccionIds: Map<string, string>): Promise<void> {
  for (const spec of DEMO_PRODUCTS) {
    // El precio sale de la regla de pricing de la tienda, no de un número a mano.
    const priceCents = applyPricing(spec.costCents, DEFAULT_PRICING);
    const resultado = await seedProducto(
      spec,
      {
        status: "active",
        priceCents,
        costCents: spec.costCents,
        trackStock: spec.trackStock,
        stockPorTalla: spec.stockPorTalla,
      },
      coleccionIds,
    );
    if (resultado === "creado") resumen.demoCreados++;
    else resumen.demoExistentes++;
  }
}

// ──────────────────────────────────── main ────────────────────────────────────

async function main(): Promise<void> {
  const conDemo = process.argv.includes("--demo");

  verificarImagenes([
    ...PRODUCTS.map((p) => p.image),
    ...COLLECTIONS.map((c) => c.imageUrl),
    ...(conDemo ? DEMO_PRODUCTS.map((p) => p.image) : []),
  ]);

  const adminEmail = await seedAdmin();
  await seedAjustes();
  const coleccionIds = await seedColecciones();
  await seedCatalogoReal(coleccionIds);
  if (conDemo) await seedDemo(coleccionIds);

  const precioDemo = DEMO_PRODUCTS.map((p) => applyPricing(p.costCents, DEFAULT_PRICING));
  const totalProductos = await db.product.count();
  const activos = await db.product.count({ where: { status: "active" } });

  console.log("");
  console.log("🌸 Seed de Bloom by Madeline");
  console.log("──────────────────────────────────────────────");
  console.log(`Admin           ${adminEmail} ${resumen.adminCreado ? "(creado)" : "(ya existía)"}`);
  console.log(
    `Ajustes         ${resumen.ajustesEscritos.length} claves sembradas` +
      (resumen.ajustesEscritos.length ? ` (${resumen.ajustesEscritos.join(", ")})` : " (ya estaban)"),
  );
  console.log(
    `Colecciones     ${resumen.coleccionesCreadas} nuevas, ${resumen.coleccionesExistentes} ya existían`,
  );
  console.log(
    `Productos       ${resumen.productosCreados} nuevos, ${resumen.productosExistentes} ya existían  ← en BORRADOR, precio 0`,
  );
  console.log(`Variantes       ${resumen.variantesCreadas} nuevas`);
  console.log(`Imágenes        ${resumen.imagenesCreadas} nuevas`);
  if (conDemo) {
    console.log(
      `Demo            ${resumen.demoCreados} nuevos, ${resumen.demoExistentes} ya existían  ` +
        `(${formatCents(Math.min(...precioDemo))} – ${formatCents(Math.max(...precioDemo))}, tag "demo")`,
    );
  } else {
    console.log("Demo            omitido (pasa --demo para crear 6 productos de prueba)");
  }
  console.log("──────────────────────────────────────────────");
  console.log(`Total en la BD  ${totalProductos} productos, ${activos} activos`);
  console.log("");
  console.log("Siguiente paso para Madeline: entrar en /admin/productos, poner precio");
  console.log("a cada prenda y cambiarla de Borrador a Activa. Hasta entonces la tienda");
  console.log("no las muestra, que es justo lo que queremos: nadie ve un precio inventado.");
  if (conDemo) {
    console.log("");
    console.log('Para borrar las demos de un tirón, en /admin o en Prisma Studio: productos con tag "demo".');
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error("El seed falló:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
