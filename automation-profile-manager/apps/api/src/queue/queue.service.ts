import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import {
  QUEUE_BROWSER_CONTROL,
  QUEUE_PROFILE_TASKS,
  BrowserControlJob,
  ProfileTaskJob,
} from "@apm/shared";

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: IORedis;
  readonly profileTasks: Queue<ProfileTaskJob>;
  readonly browserControl: Queue<BrowserControlJob>;
  private readonly browserControlEvents: QueueEvents;

  constructor() {
    this.connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
      maxRetriesPerRequest: null,
    });
    this.profileTasks = new Queue<ProfileTaskJob>(QUEUE_PROFILE_TASKS, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 2000,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    });
    this.browserControl = new Queue<BrowserControlJob>(QUEUE_BROWSER_CONTROL, {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 200,
        attempts: 1,
      },
    });
    this.browserControlEvents = new QueueEvents(QUEUE_BROWSER_CONTROL, {
      connection: new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
        maxRetriesPerRequest: null,
      }),
    });
  }

  async enqueue(job: ProfileTaskJob) {
    // LOGIN / MAPS_REVIEW không retry — tránh lease mismatch / đăng review trùng
    const attempts =
      job.taskCode === "LOGIN" || job.taskCode === "MAPS_REVIEW" ? 1 : 3;
    return this.profileTasks.add(job.taskCode, job, {
      jobId: job.jobRunId,
      attempts,
    });
  }

  async enqueueFocus(profileId: string) {
    return this.browserControl.add(
      "focus",
      { type: "focus", profileId },
      { jobId: `focus-${profileId}-${Date.now()}` },
    );
  }

  /** Enqueue focus và chờ worker xong — để API/UI biết thành công hay lỗi thật. */
  async enqueueFocusAndWait(profileId: string, timeoutMs = 12_000) {
    const job = await this.enqueueFocus(profileId);
    try {
      const result = await job.waitUntilFinished(this.browserControlEvents, timeoutMs);
      return { ok: true as const, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const failedReason = job.failedReason || null;
      throw new Error(failedReason || msg || "Focus browser thất bại / hết thời gian chờ");
    }
  }

  /** Xóa job chờ/delayed của các profile — job đang active để worker tự abort qua lease. */
  async cancelForProfiles(profileIds: string[]) {
    if (!profileIds.length) return { removed: 0 };
    const want = new Set(profileIds);
    let removed = 0;
    const jobs = await this.profileTasks.getJobs(
      ["waiting", "delayed", "paused"],
      0,
      2000,
    );
    for (const job of jobs) {
      const pid = job.data?.profileId;
      if (!pid || !want.has(pid)) continue;
      try {
        await job.remove();
        removed += 1;
      } catch {
        /* already active / gone */
      }
    }
    return { removed };
  }

  async listWaitingProfileIds(): Promise<string[]> {
    const jobs = await this.profileTasks.getJobs(
      ["waiting", "delayed", "paused"],
      0,
      2000,
    );
    const ids = new Set<string>();
    for (const job of jobs) {
      const pid = job.data?.profileId;
      if (pid) ids.add(pid);
    }
    return [...ids];
  }

  async stats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.profileTasks.getWaitingCount(),
      this.profileTasks.getActiveCount(),
      this.profileTasks.getCompletedCount(),
      this.profileTasks.getFailedCount(),
      this.profileTasks.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  }

  async onModuleDestroy() {
    await this.browserControlEvents.close();
    await this.profileTasks.close();
    await this.browserControl.close();
    await this.connection.quit();
  }
}
