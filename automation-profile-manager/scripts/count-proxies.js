const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
Promise.all([
  p.proxy.groupBy({ by: ["status"], _count: true }),
  p.proxy.count({
    where: { note: { startsWith: "homeproxy:" }, status: "ACTIVE" },
  }),
  p.proxy.count({
    where: { note: { startsWith: "webshare:" }, status: "ACTIVE" },
  }),
]).then(([g, h, w]) => {
  console.log(JSON.stringify({ byStatus: g, activeHome: h, activeWebshare: w }, null, 2));
}).finally(() => p.$disconnect());
