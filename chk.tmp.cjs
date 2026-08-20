const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const s = await db.session.findMany({ select: { token: true, expiresAt: true } });
  console.log("sesiones:", JSON.stringify(s));
  const d = await db.discount.findMany({ select: { id: true, code: true, isActive: true } });
  console.log("descuentos:", JSON.stringify(d));
  const a = await db.activityLog.findMany({ where: { entityType: "discount" }, select: { action: true, summary: true } });
  console.log("logs:", JSON.stringify(a));
  await db.$disconnect();
})();
