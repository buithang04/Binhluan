const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
p.taskDefinition
  .upsert({
    where: { code: "MAPS_REVIEW" },
    update: {},
    create: {
      code: "MAPS_REVIEW",
      name: "Post Google Maps review",
      timeoutMs: 300000,
      maxRetries: 1,
      handlerKey: "maps_review",
    },
  })
  .then((r) => {
    console.log("ok", r.code);
    return p.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await p.$disconnect();
    process.exit(1);
  });
