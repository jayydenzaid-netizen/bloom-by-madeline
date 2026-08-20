const { PrismaClient } = require("@prisma/client");
const d = new PrismaClient();
(async () => {
  const vars = await d.productVariant.findMany({ where: { priceCents: { gt: 0 } }, take: 2, select: { id: true, productId: true, priceCents: true } });
  const usar = vars.length ? vars : await d.productVariant.findMany({ take: 2, select: { id: true, productId: true, priceCents: true } });
  const prod = usar[0].productId;

  const r1 = await d.review.create({ data: { productId: prod, authorName: "QA Pendiente", rating: 3, title: "QA", body: "Reseña de prueba del agente, se borra al terminar.", status: "pending", source: "instagram" } });
  const r2 = await d.review.create({ data: { productId: prod, authorName: "QA Aprobada", rating: 5, body: "Reseña de prueba aprobada del agente.", status: "approved", source: "instagram", isVerified: true } });
  const r3 = await d.review.create({ data: { authorName: "QA Rechazada", rating: 1, body: "Reseña de prueba rechazada del agente.", status: "rejected", source: "web" } });

  const cart = await d.cart.create({
    data: {
      token: "qa-token-" + Date.now(),
      name: "QA Clienta",
      email: "qa@example.com",
      phone: "(513) 555-0123",
      items: { create: usar.map((v) => ({ productId: v.productId, variantId: v.id, quantity: 2 })) },
    },
  });
  await d.$executeRawUnsafe("UPDATE Cart SET updatedAt = datetime('now','-3 days') WHERE id = ?", cart.id);

  console.log(JSON.stringify({ reviews: [r1.id, r2.id, r3.id], cart: cart.id, precios: usar.map(v=>v.priceCents) }));
  process.exit(0);
})();
