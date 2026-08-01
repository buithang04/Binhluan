import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveAssignmentMedia } from "@/lib/review-media";
import { assertProfileEligibleForPlace } from "@/lib/eligible-profiles";
import { resolveProjectPlaceKey } from "@/lib/place-key";

type Ctx = { params: Promise<{ id: string; assignmentId: string }> };

/** Cập nhật lịch hoặc gán mail (PENDING/FAILED). */
export async function PATCH(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, assignmentId } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true, startAt: true, endAt: true, googleMapsUrl: true, placeKey: true },
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
      { error: `Chỉ sửa bài PENDING/FAILED (hiện: ${assignment.status})` },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    scheduledAt?: string | null;
    apmProfileId?: string | null;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "Body không hợp lệ" }, { status: 400 });
  }

  const data: {
    scheduledAt?: Date;
    apmProfileId?: string | null;
    profileEmail?: string | null;
    error?: string | null;
    status?: "PENDING";
  } = {};

  if (body.scheduledAt) {
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
    data.scheduledAt = scheduledAt;
  }

  if (body.apmProfileId !== undefined) {
    const placeKey = resolveProjectPlaceKey(project.googleMapsUrl, project.placeKey);
    if (body.apmProfileId === null || body.apmProfileId === "") {
      data.apmProfileId = null;
      data.profileEmail = null;
    } else {
      const check = await assertProfileEligibleForPlace({
        profileId: body.apmProfileId,
        placeKey,
        planId: assignment.plan.id,
        excludeAssignmentId: assignmentId,
      });
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
      const profile = await prisma.profile.findUnique({
        where: { id: body.apmProfileId },
        include: { account: { select: { email: true } } },
      });
      if (!profile) {
        return NextResponse.json({ error: "Không tìm thấy profile" }, { status: 400 });
      }
      data.apmProfileId = profile.id;
      data.profileEmail = profile.account.email;
    }
    data.error = null;
    data.status = "PENDING";
  }

  if (!Object.keys(data).length) {
    return NextResponse.json(
      { error: "Cần scheduledAt hoặc apmProfileId" },
      { status: 400 },
    );
  }

  await prisma.reviewAssignment.update({
    where: { id: assignmentId },
    data,
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
    message: data.apmProfileId !== undefined
      ? `Đã gán mail bài #${assignment.sortOrder + 1}`
      : `Đã cập nhật lịch bài #${assignment.sortOrder + 1}`,
  });
}
