const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const db = new PrismaClient();
(async () => {
  const d = await db.discount.deleteMany({ where: { code: { startsWith: "QA-" } } });
  const l = await db.activityLog.deleteMany({ where: { entityType: "discount" } });
  console.log("borrados descuentos:", d.count, "logs:", l.count);
  const admin = await db.adminUser.findFirst();
  const token = "qa-desc-" + Date.now();
  await db.session.create({ data: { token, userId: admin.id, expiresAt: new Date(Date.now() + 6 * 3600e3) } });
  fs.writeFileSync("./token.tmp.txt", token);
  console.log("token:", token);
  await db.$disconnect();
})();
