const fs = require("fs");
const path = require("path");
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] = v;
}
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const id = process.argv[2] || "2c6736ca-829f-453d-ba1a-6904c68f13d2";

(async () => {
  const a = await p.reviewAssignment.findUnique({
    where: { id },
    select: {
      status: true,
      error: true,
      reviewLink: true,
      apmJobRunId: true,
      sortOrder: true,
      updatedAt: true,
    },
  });
  const j = a?.apmJobRunId
    ? await p.jobRun.findUnique({
        where: { id: a.apmJobRunId },
        select: {
          status: true,
          error: true,
          finishedAt: true,
          proxy: { select: { host: true, port: true, note: true } },
        },
      })
    : null;
  console.log(JSON.stringify({ assignment: a, job: j }, null, 2));
  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
