import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveAssignmentMedia } from "@/lib/review-media";

type Ctx = { params: Promise<{ id: string; assignmentId: string }> };

/** Cập nhật ngày giờ đăng của 1 bài (PENDING/FAILED). */
export async function PATCH(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, assignmentId } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true, startAt: true, endAt: true },
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
      { error: `Chỉ sửa lịch bài PENDING/FAILED (hiện: ${assignment.status})` },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    scheduledAt?: string | null;
  } | null;
  if (!body?.scheduledAt) {
    return NextResponse.json({ error: "Thiếu scheduledAt" }, { status: 400 });
  }

  const scheduledAt = new Date(body.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) {
    return NextResponse.json({ error: "Ngày giờ không hợp lệ" }, { status: 400 });
  }

  const dayStart = new Date(project.startAt);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(project.endAt);
  dayEnd.setHours(23, 59, 59, 999);
  if (scheduledAt < dayStart || scheduledAt > dayEnd) {
    return NextResponse.json(
      { error: "Ngày đăng phải nằm trong khoảng thời gian dự án" },
      { status: 400 },
    );
  }

  await prisma.reviewAssignment.update({
    where: { id: assignmentId },
    data: { scheduledAt },
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

  return NextResponse.json({
    plan: enrichedPlan,
    message: `Đã cập nhật lịch bài #${assignment.sortOrder + 1}`,
  });
}
