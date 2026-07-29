import "server-only";
import { prisma } from "@/lib/prisma";
import { apmServerFetch } from "@/lib/apm-server";
import { mediaAbsolutePath } from "@/lib/media-path";
import {
  parseReviewSpinByStar,
  resolveReviewTextForStar,
} from "@/lib/review-content";
import { parseMediaAssetIds } from "@/lib/review-media";
import { formatReviewError } from "@/lib/review-errors";
import {
  countAvailableProxies,
  needsBrowserLoginOpen,
  validateProfileForReview,
  type ProfileForReview,
} from "@/lib/review-preflight";
import { isWithinScheduleWindow, scheduleGraceMs } from "@/lib/review-schedule";
import { registerLoginWait, clearLoginWait } from "@/lib/review-login-wait";

export type DispatchResult = {
  dispatched: number;
  errors: string[];
  assignmentIds: string[];
};

type AssignmentWithPlan = Awaited<
  ReturnType<typeof loadAssignmentsForDispatch>
>[number];

const assignmentInclude = {
  mediaAsset: true,
  plan: {
    include: {
      project: { include: { products: true } },
    },
  },
} as const;

/** Giới hạn bài/tick theo proxy khả dụng và worker concurrency. */
function dispatchBatchLimit(proxyCount: number, explicit?: number): number {
  if (explicit != null && explicit > 0) return explicit;
  const workerConcurrency = Math.max(
    1,
    Number(process.env.WORKER_CONCURRENCY || 1),
  );
  return Math.min(Math.max(1, proxyCount), workerConcurrency);
}

async function loadAssignmentsForDispatch(options: {
  projectId?: string;
  assignmentId?: string;
  /** Đăng tay 1 bài — bỏ qua cửa sổ lịch (PENDING/FAILED). */
  ignoreSchedule?: boolean;
  limit?: number;
}) {
  const now = new Date();
  const limit = options.limit ?? 30;

  if (options.assignmentId) {
    const one = await prisma.reviewAssignment.findFirst({
      where: {
        id: options.assignmentId,
        status: { in: ["PENDING", "FAILED"] },
        plan: {
          status: { in: ["READY", "RUNNING"] },
          ...(options.projectId ? { projectId: options.projectId } : {}),
        },
      },
      include: assignmentInclude,
    });
    return one ? [one] : [];
  }

  // Auto theo lịch: chỉ PENDING trong cửa sổ [scheduledAt, scheduledAt+grace]
  // Quá hạn / FAILED không vào đây — phải lập lại lịch hoặc Đăng tay.
  const graceMs = scheduleGraceMs();
  const windowStart = new Date(now.getTime() - graceMs);

  const candidates = await prisma.reviewAssignment.findMany({
    where: {
      status: "PENDING",
      scheduledAt: {
        not: null,
        lte: now,
        gte: windowStart,
      },
      plan: {
        status: "RUNNING",
        ...(options.projectId ? { projectId: options.projectId } : {}),
      },
    },
    orderBy: [{ scheduledAt: "asc" }, { sortOrder: "asc" }],
    take: Math.max(limit * 5, 20),
    include: assignmentInclude,
  });

  return candidates
    .filter((a) => isWithinScheduleWindow(a.scheduledAt, now, graceMs))
    .slice(0, limit);
}

async function enqueueOneAssignment(
  a: AssignmentWithPlan,
  now: Date,
  mediaCache: Map<string, Map<string, { id: string; fileName: string }>>,
  profileCache: Map<string, ProfileForReview | null>,
  result: DispatchResult,
  /** Lần retry tự động sau khi đã mở login — KHÔNG mở lại Chrome, chỉ chờ READY. */
  autoContinue = false,
) {
  const project = a.plan.project;
  const projectId = project.id;

  if (!a.apmProfileId) {
    const err = "Chưa gán account cho bài đăng — lập lại kế hoạch";
    await prisma.reviewAssignment.update({
      where: { id: a.id },
      data: { status: "SKIPPED", error: err },
    });
    result.errors.push(`#${a.sortOrder + 1}: ${err}`);
    return;
  }

  let profile = profileCache.get(a.apmProfileId);
  if (profile === undefined) {
    profile = await prisma.profile.findUnique({
      where: { id: a.apmProfileId },
      select: {
        id: true,
        status: true,
        browserAlive: true,
        leaseUntil: true,
        currentTask: true,
        account: { select: { status: true, email: true, loginIssue: true } },
      },
    });
    profileCache.set(a.apmProfileId, profile);
  }

  // Chưa READY / login issue / đang LOGIN → mở Chrome như thêm mail (để nhìn thấy)
  const needLogin = needsBrowserLoginOpen(profile);
  if (needLogin.open) {
    // Lần retry tự động: đừng mở lại Chrome — chỉ chờ profile READY rồi vòng sau đăng.
    if (autoContinue) {
      result.errors.push(
        `#${a.sortOrder + 1}: đang chờ ${needLogin.email} đăng nhập xong (sẽ tự đăng)`,
      );
      return;
    }
    try {
      await apmServerFetch(`/profiles/${a.apmProfileId}/open-browser`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      // Ghi vào hàng đợi chờ-login → tự đăng khi READY (không cần bấm lại)
      registerLoginWait(a.id, projectId);
      const msg =
        `Account ${needLogin.email} chưa READY — ${needLogin.reason}. ` +
        `Đang đăng nhập; hệ thống sẽ TỰ đăng khi sẵn sàng.`;
      // Giữ PENDING — không FAILED; auto-continue sẽ đăng tiếp
      await prisma.reviewAssignment.update({
        where: { id: a.id },
        data: { status: "PENDING", error: msg.slice(0, 2000) },
      });
      result.errors.push(`#${a.sortOrder + 1}: ${msg}`);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg =
        formatReviewError(raw) ||
        `Không mở được Chrome cho ${needLogin.email}: ${raw}`;
      await prisma.reviewAssignment.update({
        where: { id: a.id },
        data: { status: "FAILED", error: msg.slice(0, 2000) },
      });
      result.errors.push(`#${a.sortOrder + 1}: ${msg}`);
    }
    return;
  }

  const preflight = validateProfileForReview(profile, now);
  if (!preflight.ok) {
    // Busy / lock tạm thời → giữ PENDING để tick sau thử lại (không đánh FAILED)
    const transient =
      /đang chạy job|đang bị lock|thử lại sau|chưa mở Chrome|Chrome đã đóng|chưa READY|đã mở Chrome/i.test(
        preflight.error,
      );
    if (!transient) {
      await prisma.reviewAssignment.update({
        where: { id: a.id },
        data: { status: "FAILED", error: preflight.error.slice(0, 2000) },
      });
      clearLoginWait(a.id);
    }
    result.errors.push(`#${a.sortOrder + 1}: ${preflight.error}`);
    return;
  }

  if (!mediaCache.has(projectId)) {
    const rows = await prisma.mediaAsset.findMany({
      where: { projectId },
      select: { id: true, fileName: true },
    });
    mediaCache.set(projectId, new Map(rows.map((m) => [m.id, m])));
  }
  const mediaById = mediaCache.get(projectId)!;

  const mediaIds = parseMediaAssetIds(a.mediaAssetIds);
  const resolvedIds =
    mediaIds.length > 0
      ? mediaIds
      : a.mediaAssetId
        ? [a.mediaAssetId]
        : [];
  const imagePaths = resolvedIds
    .map((mediaId) => {
      const asset = mediaById.get(mediaId);
      return asset ? mediaAbsolutePath(projectId, asset.fileName) : null;
    })
    .filter((p): p is string => !!p);

  const spinByStar = parseReviewSpinByStar(project.reviewSpinByStar);
  const reviewText = resolveReviewTextForStar(
    a.stars,
    spinByStar,
    project,
    project.brandName,
  );

  try {
    // READY + Chrome đóng: worker MAPS tự launch — không cần open-browser trước.
    if (profile && !profile.browserAlive) {
      console.log(
        `[review-dispatch] #${a.sortOrder + 1} ${profile.account.email} Chrome đóng — enqueue MAPS (worker sẽ tự mở)`,
      );
    }
    const res = await apmServerFetch<{ jobRunId: string }>(
      `/profiles/${a.apmProfileId}/run`,
      {
        method: "POST",
        body: JSON.stringify({
          taskCode: "MAPS_REVIEW",
          payload: {
            placeUrl: project.googleMapsUrl,
            rating: a.stars,
            reviewText,
            imagePath: imagePaths[0] ?? null,
            imagePaths: imagePaths.length ? imagePaths : null,
            assignmentId: a.id,
            proxyCooldownMinutes: project.proxyCooldownMinutes ?? 60,
          },
        }),
      },
    );

    await prisma.reviewAssignment.update({
      where: { id: a.id },
      data: {
        status: "QUEUED",
        apmJobRunId: res.jobRunId,
        reviewText,
        error: null,
      },
    });
    clearLoginWait(a.id);
    result.dispatched += 1;
    result.assignmentIds.push(a.id);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = formatReviewError(raw) || raw;
    const transient =
      /đang chạy job|already queued|đang bị lock|proxy|cooldown|lease/i.test(msg);
    if (!transient) {
      await prisma.reviewAssignment.update({
        where: { id: a.id },
        data: { status: "FAILED", error: msg.slice(0, 2000) },
      });
      clearLoginWait(a.id);
    }
    const label = a.profileEmail || profile?.account.email || a.apmProfileId;
    result.errors.push(`#${a.sortOrder + 1} (${label}): ${msg}`);
  }
}

/** Bài kẹt QUEUED/RUNNING do job chết/treo (worker restart, 401, timeout…) sẽ
 *  không bao giờ tự chạy lại vì auto-dispatch chỉ nhặt PENDING. Tự phục hồi:
 *  - Job đã FAILED/DEAD/COMPLETED mà bài chưa cập nhật → reset PENDING
 *  - QUEUED >12 phút mà job chưa được claim (PENDING/không có job) → reset
 *  - RUNNING >25 phút (job timeout của worker là 10 phút) → job treo → reset
 *  Đồng thời finalize JobRun cũ (job BullMQ cũ bị chặn claim lại) + nhả profile. */
async function recoverStuckAssignments(now: Date): Promise<void> {
  const STALE_QUEUED_MS = 12 * 60_000;
  const STALE_RUNNING_MS = 25 * 60_000;

  const stuck = await prisma.reviewAssignment.findMany({
    where: {
      status: { in: ["QUEUED", "RUNNING"] },
      plan: { status: "RUNNING" },
    },
    select: {
      id: true,
      status: true,
      sortOrder: true,
      apmJobRunId: true,
      apmProfileId: true,
      updatedAt: true,
    },
  });
  if (!stuck.length) return;

  const jobIds = stuck
    .map((s) => s.apmJobRunId)
    .filter((id): id is string => Boolean(id));
  const jobs = jobIds.length
    ? await prisma.jobRun.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, status: true, startedAt: true, createdAt: true },
      })
    : [];
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  let recovered = 0;
  for (const a of stuck) {
    const job = a.apmJobRunId ? jobById.get(a.apmJobRunId) : undefined;
    const ageMs = now.getTime() - a.updatedAt.getTime();

    const jobFinalized =
      job && ["FAILED", "DEAD", "COMPLETED"].includes(job.status);
    const queuedStale =
      a.status === "QUEUED" &&
      (!job || job.status === "PENDING") &&
      ageMs > STALE_QUEUED_MS;
    const runningStale =
      a.status === "RUNNING" &&
      (!job ||
        (job.status === "ACTIVE" &&
          (job.startedAt ?? job.createdAt) &&
          now.getTime() - (job.startedAt ?? job.createdAt).getTime() >
            STALE_RUNNING_MS)) &&
      ageMs > STALE_RUNNING_MS;

    if (!jobFinalized && !queuedStale && !runningStale) continue;

    // Finalize job cũ để BullMQ job còn trong queue không claim lại (claim guard)
    if (job && (job.status === "PENDING" || job.status === "ACTIVE")) {
      await prisma.jobRun
        .update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            finishedAt: now,
            error: "Auto-recover: job kẹt/treo — reset bài về PENDING để đăng lại",
          },
        })
        .catch(() => undefined);
    }

    await prisma.reviewAssignment.update({
      where: { id: a.id },
      data: { status: "PENDING", apmJobRunId: null, error: null },
    });

    // Nhả profile nếu còn kẹt QUEUED/RUNNING với lease đã hết hạn
    if (a.apmProfileId) {
      await prisma.profile
        .updateMany({
          where: {
            id: a.apmProfileId,
            status: { in: ["QUEUED", "RUNNING"] },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
          },
          data: {
            status: "READY",
            leaseToken: null,
            leaseUntil: null,
            currentTask: null,
          },
        })
        .catch(() => undefined);
    }

    console.log(
      `[review-dispatch] auto-recover #${a.sortOrder + 1}: ${a.status} kẹt (job=${job?.status ?? "mất"}) → PENDING, sẽ đăng lại theo lịch`,
    );
    recovered += 1;
  }
  if (recovered) {
    console.log(`[review-dispatch] đã phục hồi ${recovered} bài kẹt`);
  }
}

/** Enqueue bài PENDING đang trong cửa sổ lịch đăng (không dump quá hạn / FAILED).
 *  Quá hạn hoặc FAILED → lập lại lịch hoặc gọi với `assignmentId` (Đăng tay).
 *  Mặc định: min(proxy khả dụng, WORKER_CONCURRENCY) bài/tick. */
export async function dispatchDueReviewAssignments(options?: {
  projectId?: string;
  limit?: number;
  /** Đăng đúng 1 bài (bỏ qua lịch; cho phép PENDING/FAILED). */
  assignmentId?: string;
  /** Retry tự động sau login — không mở lại Chrome, chỉ đăng khi READY. */
  autoContinue?: boolean;
}): Promise<DispatchResult> {
  const now = new Date();

  await recoverStuckAssignments(now).catch((e) =>
    console.warn(
      "[review-dispatch] recover lỗi:",
      e instanceof Error ? e.message : e,
    ),
  );

  const proxyCount = await countAvailableProxies(now);
  if (proxyCount === 0 && !options?.assignmentId) {
    return {
      dispatched: 0,
      errors: [
        "Không còn proxy khả dụng (đang lock hoặc cooldown) — thêm proxy hoặc chờ cooldown",
      ],
      assignmentIds: [],
    };
  }

  const batchLimit = options?.assignmentId
    ? 1
    : dispatchBatchLimit(proxyCount, options?.limit);

  const assignments = await loadAssignmentsForDispatch({
    projectId: options?.projectId,
    assignmentId: options?.assignmentId,
    ignoreSchedule: Boolean(options?.assignmentId),
    limit: batchLimit,
  });

  const result: DispatchResult = { dispatched: 0, errors: [], assignmentIds: [] };
  if (!assignments.length) {
    if (options?.assignmentId) {
      result.errors.push(
        "Không tìm thấy bài PENDING/FAILED thuộc kế hoạch READY/RUNNING",
      );
    }
    return result;
  }

  if (proxyCount === 0) {
    result.errors.push(
      "Không còn proxy khả dụng (đang lock hoặc cooldown) — thêm proxy hoặc chờ cooldown",
    );
    return result;
  }

  const mediaCache = new Map<string, Map<string, { id: string; fileName: string }>>();
  const profileCache = new Map<string, ProfileForReview | null>();

  for (const a of assignments) {
    await enqueueOneAssignment(
      a,
      now,
      mediaCache,
      profileCache,
      result,
      options?.autoContinue ?? false,
    );
  }

  return result;
}
