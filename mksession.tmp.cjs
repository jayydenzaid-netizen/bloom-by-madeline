const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const db = new PrismaClient();
(async () => {
  const admin = await db.adminUser.findFirst();
  if (!admin) { fs.writeFileSync("./token.tmp.txt", "NO_ADMIN"); return; }
  const token = "qa-desc-" + Date.now();
  await db.session.create({ data: { token, userId: admin.id, expiresAt: new Date(Date.now() + 3600e3) } });
  fs.writeFileSync("./token.tmp.txt", token);
  await db.$disconnect();
})();
