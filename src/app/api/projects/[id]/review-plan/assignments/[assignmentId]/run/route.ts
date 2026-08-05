import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { dispatchDueReviewAssignments } from "@/lib/review-dispatch";
import { resolveAssignmentMedia } from "@/lib/review-media";

type Ctx = { params: Promise<{ id: string; assignmentId: string }> };

/** Đăng lẻ một bài (PENDING/FAILED), không cần kích hoạt cả lịch. */
export async function POST(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, assignmentId } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const assignment = await prisma.reviewAssignment.findFirst({
    where: { id: assignmentId, plan: { projectId: id } },
    include: { plan: { select: { id: true, status: true } } },
  });
  if (!assignment) {
    return NextResponse.json({ error: "Không tìm thấy bài đăng" }, { status: 404 });
  }

  if (!["PENDING", "FAILED"].includes(assignment.status)) {
    return NextResponse.json(
      {
        error: `Chỉ đăng được bài PENDING hoặc FAILED (hiện: ${assignment.status})`,
      },
      { status: 400 },
    );
  }

  if (!["READY", "RUNNING"].includes(assignment.plan.status)) {
    return NextResponse.json(
      {
        error: `Kế hoạch phải READY hoặc RUNNING (hiện: ${assignment.plan.status})`,
      },
      { status: 400 },
    );
  }

  const dispatch = await dispatchDueReviewAssignments({
    projectId: id,
    assignmentId,
    ignorePause: true,
  });

  const refreshed = await prisma.reviewPlan.findUnique({
    where: { id: assignment.plan.id },
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

  let message: string;
  if (dispatch.dispatched > 0) {
    message = `Đã enqueue bài #${assignment.sortOrder + 1}`;
  } else if (dispatch.errors.length > 0) {
    message = dispatch.errors[0]!;
  } else {
    message = "Không enqueue được bài";
  }

  // Phân biệt: đã mở Chrome login (sẽ tự đăng) vs lỗi thật
  const openedLogin =
    /Đang đăng nhập|hệ thống sẽ TỰ đăng|đã mở Chrome|đưa Chrome lên|sẽ tự đăng/i.test(
      message,
    );

  return NextResponse.json({
    plan: enrichedPlan,
    dispatch,
    message,
    openedLogin,
  });
}
