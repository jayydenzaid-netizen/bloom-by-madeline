const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const d = await db.discount.create({ data: { code: "QA-DBG", title: "debug", type: "percentage", value: 10 } });
  console.log("id", d.id);
  await db.$disconnect();
})();
