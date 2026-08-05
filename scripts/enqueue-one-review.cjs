const Module = require("module");
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "server-only") return {};
  return orig.apply(this, arguments);
};

require("dotenv").config({ path: ".env" });
require("dotenv").config({ path: "automation-profile-manager/.env" });

const assignmentId =
  process.argv[2] || "2c6736ca-829f-453d-ba1a-6904c68f13d2";
const projectId =
  process.argv[3] || "5d730a61-9d79-479e-897e-e125eee01f57";

async function main() {
  const { register } = require("tsx/cjs/api");
  register();

  const { dispatchDueReviewAssignments } = require("../src/lib/review-dispatch.ts");
  const { prisma } = require("../src/lib/prisma.ts");

  const before = await prisma.reviewAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      status: true,
      sortOrder: true,
      apmJobRunId: true,
      plan: { select: { project: { select: { brandName: true } } } },
    },
  });
  console.log("Before", before);

  const result = await dispatchDueReviewAssignments({
    projectId,
    assignmentId,
    ignorePause: true,
  });
  console.log("Dispatch", result);

  const after = await prisma.reviewAssignment.findUnique({
    where: { id: assignmentId },
    select: { status: true, apmJobRunId: true, error: true },
  });
  console.log("After", after);

  if (after?.apmJobRunId) {
    const job = await prisma.jobRun.findUnique({
      where: { id: after.apmJobRunId },
      select: {
        id: true,
        status: true,
        proxyId: true,
        error: true,
        proxy: { select: { host: true, port: true, note: true } },
      },
    });
    console.log("Job", job);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
