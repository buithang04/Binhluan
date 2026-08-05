const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

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

const p = new PrismaClient();

(async () => {
  const now = new Date();
  const due = await p.reviewAssignment.findMany({
    where: {
      status: "PENDING",
      apmProfileId: { not: null },
      plan: { status: "RUNNING" },
    },
    orderBy: [{ scheduledAt: "asc" }],
    take: 8,
    select: {
      id: true,
      sortOrder: true,
      scheduledAt: true,
      apmProfileId: true,
      plan: { select: { projectId: true, project: { select: { brandName: true } } } },
    },
  });

  const proxies = await p.proxy.findMany({
    where: {
      status: "ACTIVE",
      health: "WORKING",
      note: { startsWith: "homeproxy:" },
    },
    select: {
      id: true,
      host: true,
      port: true,
      lockedUntil: true,
      cooldownUntil: true,
    },
  });

  const avail = proxies.filter(
    (x) =>
      (!x.lockedUntil || x.lockedUntil < now) &&
      (!x.cooldownUntil || x.cooldownUntil < now),
  );

  const profiles = due.length
    ? await p.profile.findMany({
        where: { id: { in: due.map((d) => d.apmProfileId).filter(Boolean) } },
        select: {
          id: true,
          status: true,
          browserIndex: true,
          account: { select: { email: true, status: true } },
        },
      })
    : [];

  console.log(
    JSON.stringify(
      {
        pending: due.length,
        proxyActive: proxies.length,
        proxyAvail: avail.length,
        due: due.map((d) => ({
          id: d.id,
          n: d.sortOrder + 1,
          project: d.plan.project.brandName,
          projectId: d.plan.projectId,
          sched: d.scheduledAt,
          profileId: d.apmProfileId,
        })),
        profiles: profiles.map((x) => ({
          id: x.id,
          browserIndex: x.browserIndex,
          status: x.status,
          email: x.account?.email,
          accountStatus: x.account?.status,
        })),
      },
      null,
      2,
    ),
  );
  await p.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
