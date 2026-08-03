import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { dispatchDueReviewAssignments } from "@/lib/review-dispatch";
import { resolveAssignmentMedia } from "@/lib/review-media";
import { getScheduleState } from "@/lib/review-schedule";
import { syncProjectStatusFromReviewPlan } from "@/lib/project-status";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Kích hoạt lịch đăng (READY → RUNNING) hoặc đẩy tối đa 1 bài trong cửa sổ lịch.
 * Quá hạn / FAILED không auto — phải lập lại lịch hoặc Đăng tay từng bài.
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
      { error: "Không có kế hoạch READY để kích hoạt" },
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

  const dispatch = justActivated
    ? { dispatched: 0, errors: [] as string[], assignmentIds: [] as string[] }
    : await dispatchDueReviewAssignments({
        projectId: id,
        limit: 1,
        ignorePause: true,
      });

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
  const failedCount =
    enrichedPlan?.assignments.filter((a) => a.status === "FAILED").length ?? 0;

  let message: string;
  if (justActivated) {
    const parts: string[] = ["Đã bật lịch đăng."];
    if (pendingReady > 0) {
      parts.push(
        `${pendingReady} bài trong cửa sổ lịch sẽ tự đăng đúng giờ (1 bài/phút).`,
      );
    }
    if (pendingWaiting > 0) {
      parts.push(`${pendingWaiting} bài chưa tới lịch.`);
    }
    if (pendingOverdue > 0 || failedCount > 0) {
      parts.push(
        `${pendingOverdue + failedCount} bài quá hạn/lỗi — lập lại lịch hoặc bấm Đăng tay (không auto).`,
      );
    }
    if (pendingReady === 0 && pendingWaiting === 0) {
      parts.push("Chưa có bài trong cửa sổ lịch.");
    }
    message = parts.join(" ");
  } else if (dispatch.dispatched > 0) {
    message = `Đã enqueue 1 bài theo lịch. Còn ${pendingReady} trong cửa sổ · ${pendingWaiting} chờ lịch · ${pendingOverdue} quá hạn.`;
  } else if (dispatch.errors.length > 0) {
    message = `Chưa đăng được bài theo lịch: ${dispatch.errors[0]}`;
  } else {
    message =
      pendingOverdue > 0
        ? `Không có bài trong cửa sổ lịch. ${pendingOverdue} bài quá hạn — lập lại lịch hoặc Đăng tay.`
        : `Chưa có bài tới lịch đăng. ${pendingWaiting} bài đang chờ lịch.`;
  }

  return NextResponse.json({
    plan: enrichedPlan,
    dispatch,
    message,
  });
}
