import { prisma } from "@apm/prisma";
import { QUEUE_PROFILE_TASKS, ProfileTaskJob, TaskCode } from "@apm/shared";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { randomUUID } from "crypto";

const BATCH = Number(process.env.SCHEDULER_BATCH_SIZE || 50);
const INTERVAL_MS = 60_000;

async function tick(queue: Queue<ProfileTaskJob>) {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 5 * 60 * 1000);

  const claimed = await prisma.$transaction(async (tx) => {
    // Không healthcheck profile sắp/đang đăng review (tránh chiếm slot đúng giờ đăng)
    const reviewSoon = new Date(now.getTime() + 30 * 60 * 1000);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Profile" p
      WHERE p.status = 'READY'
        AND p."browserAlive" = true
        AND p."nextRun" <= ${now}
        AND (p."leaseUntil" IS NULL OR p."leaseUntil" < ${now})
        AND NOT EXISTS (
          SELECT 1 FROM "ReviewAssignment" ra
          JOIN "ReviewPlan" rp ON ra."planId" = rp.id
          WHERE ra."apmProfileId" = p.id
            AND rp.status = 'RUNNING'
            AND (
              ra.status IN ('QUEUED', 'RUNNING')
              OR (
                ra.status = 'PENDING'
                AND ra."scheduledAt" IS NOT NULL
                AND ra."scheduledAt" <= ${reviewSoon}
              )
            )
        )
      ORDER BY p."nextRun" ASC
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    `;

    const result: Array<{ id: string; leaseToken: string; jobRunId: string }> = [];
    for (const row of rows) {
      const leaseToken = randomUUID();
      const job = await tx.jobRun.create({
        data: {
          profileId: row.id,
          taskCode: TaskCode.HEALTHCHECK,
          status: "PENDING",
        },
      });
      await tx.profile.update({
        where: { id: row.id },
        data: {
          status: "QUEUED",
          leaseToken,
          leaseUntil,
          currentTask: TaskCode.HEALTHCHECK,
        },
      });
      result.push({ id: row.id, leaseToken, jobRunId: job.id });
    }
    return result;
  });

  for (const item of claimed) {
    await queue.add(
      TaskCode.HEALTHCHECK,
      {
        profileId: item.id,
        taskCode: TaskCode.HEALTHCHECK,
        leaseToken: item.leaseToken,
        jobRunId: item.jobRunId,
      },
      { jobId: item.jobRunId },
    );
  }

  if (claimed.length) {
    console.log(`[scheduler] enqueued ${claimed.length} profiles`);
  }
}

async function main() {
  const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue<ProfileTaskJob>(QUEUE_PROFILE_TASKS, { connection });

  console.log("[scheduler] started, interval 60s");
  await tick(queue);
  setInterval(() => {
    tick(queue).catch((err) => console.error("[scheduler] tick failed", err));
  }, INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
