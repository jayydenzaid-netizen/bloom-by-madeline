// Pruebas del inventario (lib/inventory.ts).
//
// Correr con:  npx tsx --test tests/inventory.test.ts
//
// Estas SÍ tocan la base de datos de desarrollo, a propósito: lo que hay que
// demostrar es que el cambio de stock y su StockMovement ocurren juntos y con
// el antes/después correctos, y eso solo se comprueba de verdad contra SQLite.
// Todo lo que se crea aquí lleva un slug "test-inventario-…" y se borra al
// final; las cifras se comparan siempre contra una foto tomada antes de tocar
// nada, así que no importa qué datos tuviera ya la tienda.

import assert from "node:assert/strict";
import test, { after } from "node:test";

// El cliente de Prisma lee el .env del proyecto al construirse, así que hay que
// lanzar esto desde la raíz del repo (que es lo que hace `npm test`).
import { db } from "@/lib/db";
import { adjustStock, bulkAdjust, lowStockVariants, setStock, stockValue } from "@/lib/inventory";

/* ─────────────────────────── andamiaje ─────────────────────────── */

const productosCreados: string[] = [];
const variantesCreadas: string[] = [];

type VarianteSemilla = {
  title: string;
  stock: number;
  trackStock: boolean;
  priceCents: number;
  costCents: number | null;
};

async function crearProducto(variantes: VarianteSemilla[]): Promise<string[]> {
  const marca = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const producto = await db.product.create({
    data: {
      slug: `test-inventario-${marca}`,
      title: `Producto de prueba ${marca}`,
      status: "draft",
      variants: {
        create: variantes.map((v, i) => ({
          title: v.title,
          sku: `TEST-${marca}-${i}`,
          stock: v.stock,
          trackStock: v.trackStock,
          priceCents: v.priceCents,
          costCents: v.costCents,
          position: i,
        })),
      },
    },
    select: { id: true, variants: { orderBy: { position: "asc" }, select: { id: true } } },
  });

  productosCreados.push(producto.id);
  const ids = producto.variants.map((v) => v.id);
  variantesCreadas.push(...ids);
  return ids;
}

after(async () => {
  // Los movimientos no cuelgan de la variante por relación de Prisma (el
  // esquema los deja sueltos a propósito), así que hay que borrarlos aparte o
  // quedarían huérfanos ensuciando el historial de Madeline.
  if (variantesCreadas.length > 0) {
    await db.stockMovement.deleteMany({ where: { variantId: { in: variantesCreadas } } });
  }
  if (productosCreados.length > 0) {
    await db.product.deleteMany({ where: { id: { in: productosCreados } } });
  }
  await db.$disconnect();
});

async function stockDe(variantId: string): Promise<number> {
  const v = await db.productVariant.findUnique({ where: { id: variantId }, select: { stock: true } });
  assert.ok(v, "la variante de prueba debería existir");
  return v.stock;
}

/* ─────────────────────────── pruebas ─────────────────────────── */

test("adjustStock escribe un movimiento con el antes y el después correctos", async () => {
  const [variantId] = await crearProducto([
    { title: "M", stock: 10, trackStock: true, priceCents: 4599, costCents: 1200 },
  ]);

  const resultado = await adjustStock(variantId, 4, { reason: "restock", reference: "CAJA-7", note: "Llegó el martes" });

  assert.equal(resultado.ok, true);
  if (!resultado.ok) return;
  assert.deepEqual(
    { before: resultado.change.before, after: resultado.change.after, delta: resultado.change.delta },
    { before: 10, after: 14, delta: 4 },
  );

  assert.equal(await stockDe(variantId), 14, "el stock de la variante tiene que quedar en 14");

  const movimientos = await db.stockMovement.findMany({ where: { variantId } });
  assert.equal(movimientos.length, 1, "un ajuste = un movimiento, ni cero ni dos");
  assert.equal(movimientos[0].before, 10);
  assert.equal(movimientos[0].after, 14);
  assert.equal(movimientos[0].delta, 4);
  assert.equal(movimientos[0].reason, "restock");
  assert.equal(movimientos[0].reference, "CAJA-7");
  assert.equal(movimientos[0].note, "Llegó el martes");
});

test("dos ajustes seguidos encadenan: el después de uno es el antes del siguiente", async () => {
  const [variantId] = await crearProducto([
    { title: "S", stock: 5, trackStock: true, priceCents: 3999, costCents: 1500 },
  ]);

  const primero = await adjustStock(variantId, 3, { reason: "restock" });
  const segundo = await adjustStock(variantId, -6, { reason: "sale", reference: "BLM-1042" });

  assert.equal(primero.ok, true);
  assert.equal(segundo.ok, true);
  if (!primero.ok || !segundo.ok) return;

  assert.equal(primero.change.before, 5);
  assert.equal(primero.change.after, 8);
  assert.equal(segundo.change.before, 8, "el segundo ajuste tiene que partir de donde dejó el primero");
  assert.equal(segundo.change.after, 2);
  assert.equal(await stockDe(variantId), 2);

  const movimientos = await db.stockMovement.findMany({ where: { variantId }, orderBy: { createdAt: "asc" } });
  assert.equal(movimientos.length, 2);
  assert.equal(movimientos[0].after, movimientos[1].before, "el historial tiene que ser una cadena sin huecos");
});

test("el stock nunca baja de cero y el movimiento guarda el delta que de verdad se aplicó", async () => {
  const [variantId] = await crearProducto([
    { title: "L", stock: 2, trackStock: true, priceCents: 2500, costCents: 900 },
  ]);

  const resultado = await adjustStock(variantId, -9, { reason: "sale" });
  assert.equal(resultado.ok, true);
  if (!resultado.ok) return;

  assert.equal(resultado.change.after, 0, "no existen las −7 unidades");
  assert.equal(resultado.change.delta, -2, "el delta guardado es el real, no el pedido");
  assert.equal(await stockDe(variantId), 0);
});

test("setStock calcula el delta a partir de lo que había", async () => {
  const [variantId] = await crearProducto([
    { title: "XL", stock: 7, trackStock: true, priceCents: 5999, costCents: 2000 },
  ]);

  const bajada = await setStock(variantId, 4, { note: "Conté el armario" });
  assert.equal(bajada.ok, true);
  if (!bajada.ok) return;
  assert.equal(bajada.change.before, 7);
  assert.equal(bajada.change.after, 4);
  assert.equal(bajada.change.delta, -3, "de 7 a 4 son −3, y eso es lo que tiene que decir el historial");

  const subida = await setStock(variantId, 11);
  assert.equal(subida.ok, true);
  if (!subida.ok) return;
  assert.equal(subida.change.delta, 7, "de 4 a 11 son +7");
  assert.equal(await stockDe(variantId), 11);

  const movimientos = await db.stockMovement.findMany({ where: { variantId }, orderBy: { createdAt: "asc" } });
  assert.equal(movimientos.length, 2);
  assert.equal(movimientos[0].reason, "count", "fijar el valor es un recuento mientras no se diga otra cosa");
  assert.equal(movimientos[0].delta, -3);
  assert.equal(movimientos[1].delta, 7);
});

test("un recuento que confirma el mismo número también deja rastro", async () => {
  const [variantId] = await crearProducto([
    { title: "Única", stock: 6, trackStock: true, priceCents: 1999, costCents: 800 },
  ]);

  const resultado = await setStock(variantId, 6, { note: "Todo cuadra" });
  assert.equal(resultado.ok, true);
  if (!resultado.ok) return;
  assert.equal(resultado.change.delta, 0);
  assert.ok(resultado.change.movementId, "el recuento se registra aunque no cambie nada");

  // Un ajuste manual de 0 unidades, en cambio, no ensucia el historial.
  const nulo = await adjustStock(variantId, 0, { reason: "manual" });
  assert.equal(nulo.ok, true);
  if (!nulo.ok) return;
  assert.equal(nulo.change.movementId, null);

  const movimientos = await db.stockMovement.findMany({ where: { variantId } });
  assert.equal(movimientos.length, 1);
});

test("bulkAdjust aplica todo o nada", async () => {
  const [uno, dos] = await crearProducto([
    { title: "A", stock: 5, trackStock: true, priceCents: 1000, costCents: 400 },
    { title: "B", stock: 8, trackStock: true, priceCents: 1000, costCents: 400 },
  ]);

  const bien = await bulkAdjust(
    [
      { variantId: uno, delta: 2 },
      { variantId: dos, setTo: 20 },
    ],
    { reason: "restock", note: "Pedido de temporada" },
  );
  assert.equal(bien.ok, true);
  assert.equal(await stockDe(uno), 7);
  assert.equal(await stockDe(dos), 20);

  // Con una variante inexistente en la lista no se aplica NINGUNO de los
  // cambios: un lote a medias es peor que un lote fallido.
  const mal = await bulkAdjust(
    [
      { variantId: uno, delta: 100 },
      { variantId: "variante-que-no-existe", delta: 1 },
    ],
    { reason: "manual" },
  );
  assert.equal(mal.ok, false);
  assert.equal(await stockDe(uno), 7, "la transacción tiene que haberse deshecho entera");
});

test("el valor del inventario ignora las variantes sin control de stock", async () => {
  const antes = await stockValue();

  const [conControl, sinControl] = await crearProducto([
    { title: "Con control", stock: 5, trackStock: true, priceCents: 2500, costCents: 1000 },
    // Esta es la típica de dropshipping: el stock lo tiene el proveedor y su
    // número no significa nada, así que no puede sumar en ninguna cifra.
    { title: "Del proveedor", stock: 999, trackStock: false, priceCents: 9900, costCents: 4000 },
  ]);

  const despues = await stockValue();

  assert.equal(despues.units - antes.units, 5, "solo cuentan las unidades de la variante con control");
  assert.equal(despues.costCents - antes.costCents, 5 * 1000);
  assert.equal(despues.retailCents - antes.retailCents, 5 * 2500);
  assert.equal(despues.trackedVariants - antes.trackedVariants, 1);
  assert.equal(despues.untrackedVariants - antes.untrackedVariants, 1);

  // Y tampoco aparece en el aviso de "bajo mínimo", por muy a cero que esté.
  await setStock(sinControl, 0, { reason: "count" });
  const bajas = await lowStockVariants(3);
  assert.equal(
    bajas.some((b) => b.variantId === sinControl),
    false,
    "una variante de proveedor nunca puede salir como bajo mínimo",
  );

  await setStock(conControl, 2, { reason: "count" });
  const bajas2 = await lowStockVariants(3);
  assert.equal(
    bajas2.some((b) => b.variantId === conControl),
    true,
    "con 2 unidades y umbral 3 sí tiene que salir",
  );
});
