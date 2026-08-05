import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { dispatchDueReviewAssignments } from "@/lib/review-dispatch";
import { resolveAssignmentMedia } from "@/lib/review-media";
import {
  formatScheduleDate,
  getScheduleState,
} from "@/lib/review-schedule";
import { syncProjectStatusFromReviewPlan } from "@/lib/project-status";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Nút tay: mỗi lần tối đa 1 bài.
 * 1) Bài trong cửa sổ lịch
 * 2) Nếu chưa có → đúng 1 bài PENDING kế tiếp (quá hạn trước, rồi chờ lịch)
 * Có QUEUED/RUNNING thì không đẩy thêm. Auto-loop vẫn chỉ đăng đúng cửa sổ.
 */
export async function POST(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const plan = await prisma.reviewPlan.findFirst({
    where: {
      projectId: id,
      status: { in: ["READY", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!plan) {
    return NextResponse.json(
      { error: "Không có kế hoạch READY/RUNNING để chạy" },
      { status: 400 },
    );
  }

  const justActivated = plan.status === "READY";
  if (justActivated) {
    await prisma.reviewPlan.update({
      where: { id: plan.id },
      data: { status: "RUNNING" },
    });
    await syncProjectStatusFromReviewPlan(id, "RUNNING");
  }

  const activeCount = await prisma.reviewAssignment.count({
    where: {
      planId: plan.id,
      status: { in: ["QUEUED", "RUNNING"] },
    },
  });

  let dispatch = {
    dispatched: 0,
    errors: [] as string[],
    assignmentIds: [] as string[],
  };
  let forcedNext = false;

  if (activeCount > 0) {
    dispatch.errors.push(
      `Đang có ${activeCount} bài QUEUED/RUNNING — chờ xong rồi bấm lại (mỗi lần chỉ 1 bài).`,
    );
  } else {
    dispatch = await dispatchDueReviewAssignments({
      projectId: id,
      limit: 1,
      ignorePause: true,
    });

    // Cửa sổ trống → đẩy đúng 1 PENDING kế tiếp (nút tay), không đụng auto-loop.
    if (dispatch.dispatched === 0 && dispatch.errors.length === 0) {
      const now = new Date();
      const candidates = await prisma.reviewAssignment.findMany({
        where: {
          planId: plan.id,
          status: "PENDING",
          apmProfileId: { not: null },
        },
        select: { id: true, scheduledAt: true, sortOrder: true },
        orderBy: [{ scheduledAt: "asc" }, { sortOrder: "asc" }],
        take: 80,
      });

      const ranked = [...candidates].sort((a, b) => {
        const sa = getScheduleState(a.scheduledAt, now);
        const sb = getScheduleState(b.scheduledAt, now);
        const rank = (s: string) =>
          s === "overdue" ? 0 : s === "ready" ? 1 : s === "waiting" ? 2 : 3;
        const d = rank(sa) - rank(sb);
        if (d !== 0) return d;
        const ta = a.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const tb = b.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
        if (ta !== tb) return ta - tb;
        return a.sortOrder - b.sortOrder;
      });

      const next = ranked[0];
      if (next) {
        await prisma.reviewAssignment.update({
          where: { id: next.id },
          data: { scheduledAt: now, error: null },
        });
        dispatch = await dispatchDueReviewAssignments({
          projectId: id,
          assignmentId: next.id,
          ignorePause: true,
        });
        forcedNext = true;
      }
    }
  }

  const refreshed = await prisma.reviewPlan.findUnique({
    where: { id: plan.id },
    include: {
      assignments: {
        orderBy: { sortOrder: "asc" },
        include: {
          mediaAsset: { select: { id: true, filePath: true, fileName: true } },
        },
      },
    },
  });

  const mediaFull = await prisma.mediaAsset.findMany({
    where: { projectId: id },
    select: { id: true, filePath: true, fileName: true },
  });
  const mediaFullById = new Map(mediaFull.map((m) => [m.id, m]));

  const enrichedPlan = refreshed
    ? {
        ...refreshed,
        assignments: refreshed.assignments.map((a) => ({
          ...a,
          mediaAssets: resolveAssignmentMedia(a, mediaFullById),
        })),
      }
    : null;

  const now = new Date();
  const pendingWaiting =
    enrichedPlan?.assignments.filter(
      (a) =>
        a.status === "PENDING" &&
        getScheduleState(a.scheduledAt, now) === "waiting",
    ).length ?? 0;
  const pendingReady =
    enrichedPlan?.assignments.filter(
      (a) =>
        a.status === "PENDING" &&
        getScheduleState(a.scheduledAt, now) === "ready",
    ).length ?? 0;
  const pendingOverdue =
    enrichedPlan?.assignments.filter(
      (a) =>
        a.status === "PENDING" &&
        getScheduleState(a.scheduledAt, now) === "overdue",
    ).length ?? 0;

  const nextWaiting = enrichedPlan?.assignments
    .filter(
      (a) =>
        a.status === "PENDING" &&
        getScheduleState(a.scheduledAt, now) === "waiting",
    )
    .sort(
      (a, b) =>
        (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0),
    )[0];

  let message: string;
  const prefix = justActivated ? "Đã bật lịch đăng. " : "";
  if (dispatch.dispatched > 0) {
    message =
      prefix +
      (forcedNext
        ? "Đã đẩy 1 bài PENDING kế tiếp (chưa tới/đã quá cửa sổ lịch)."
        : "Đã enqueue 1 bài trong cửa sổ lịch.") +
      ` Còn ${pendingReady} sẵn sàng · ${pendingWaiting} chờ lịch · ${pendingOverdue} quá hạn.`;
  } else if (dispatch.errors.length > 0) {
    message = prefix + dispatch.errors[0]!;
  } else if (pendingWaiting > 0) {
    const when = nextWaiting?.scheduledAt
      ? formatScheduleDate(nextWaiting.scheduledAt)
      : "—";
    message =
      prefix +
      `Chưa enqueue được. Bài kế tiếp theo lịch: ${when}.`;
  } else if (pendingOverdue > 0) {
    message =
      prefix +
      `${pendingOverdue} bài quá hạn — thử Đăng tay từng dòng hoặc lập lại lịch.`;
  } else {
    message = prefix + "Không còn bài PENDING để đăng.";
  }

  return NextResponse.json({
    plan: enrichedPlan,
    dispatch,
    message,
    forcedNext,
  });
}
