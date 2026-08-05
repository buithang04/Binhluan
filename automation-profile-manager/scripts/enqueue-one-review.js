/**
 * Enqueue 1 bài PENDING (ignorePause) để test luồng MAPS + HomeProxy.
 */
const path = require("path");
const fs = require("fs");

// Load root + APM env
for (const envFile of [
  path.join(__dirname, "..", "..", ".env"),
  path.join(__dirname, "..", ".env"),
]) {
  if (!fs.existsSync(envFile)) continue;
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main() {
  const assignmentId = process.argv[2] || "2c6736ca-829f-453d-ba1a-6904c68f13d2";
  const projectId = process.argv[3] || "5d730a61-9d79-479e-897e-e125eee01f57";

  // Dynamic import compiled next isn't easy — call HTTP API on localhost if session-less internal exists.
  // Prefer APM path: look up assignment and use profiles enqueue via internal isn't public.
  // Use Next cron with secret:
  const secret = process.env.REVIEW_CRON_SECRET;
  if (!secret) {
    console.log("No REVIEW_CRON_SECRET — will try Next assignment run via fetch needs auth");
  }

  // Call Next.js API route for assignment run requires session.
  // Instead use prisma + direct call to APM profiles run isn't right.
  // Use review-dispatch via tsx from src:
  const { register } = require("tsx/cjs/api");
  register();
  const { dispatchDueReviewAssignments } = require(
    path.join(__dirname, "..", "..", "src", "lib", "review-dispatch.ts"),
  );

  console.log("Dispatching assignment", assignmentId, "project", projectId);
  const result = await dispatchDueReviewAssignments({
    projectId,
    assignmentId,
    ignorePause: true,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
