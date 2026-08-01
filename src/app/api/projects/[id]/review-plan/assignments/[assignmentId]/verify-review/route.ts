import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveProjectPlaceKey } from "@/lib/place-key";
import { updateReviewVisibility } from "@/lib/profile-place-review";
import { verifyReviewOnMaps } from "@/lib/review-verify";

export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string; assignmentId: string }> };

/** Quét 1 bài COMPLETED — cập nhật visibility trên sổ cái. */
export async function POST(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, assignmentId } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: {
      id: true,
      googleMapsUrl: true,
      resolvedUrl: true,
      placeKey: true,
    },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const assignment = await prisma.reviewAssignment.findFirst({
    where: { id: assignmentId, plan: { projectId: id } },
    select: {
      id: true,
      status: true,
      stars: true,
      reviewText: true,
      reviewLink: true,
      apmProfileId: true,
      profileEmail: true,
    },
  });
  if (!assignment) {
    return NextResponse.json({ error: "Không tìm thấy bài đăng" }, { status: 404 });
  }
  if (assignment.status !== "COMPLETED") {
    return NextResponse.json(
      { error: "Chỉ quét bài đã COMPLETED" },
      { status: 400 },
    );
  }
  if (!assignment.apmProfileId) {
    return NextResponse.json({ error: "Bài chưa có mail" }, { status: 400 });
  }

  const placeKey = resolveProjectPlaceKey(project.googleMapsUrl, project.placeKey);
  const result = await verifyReviewOnMaps({
    reviewLink: assignment.reviewLink,
    googleMapsUrl: project.googleMapsUrl,
    resolvedUrl: project.resolvedUrl,
    reviewText: assignment.reviewText,
    stars: assignment.stars,
  });

  await updateReviewVisibility(
    assignment.apmProfileId,
    placeKey,
    result.visibility,
    {
      accountEmail: assignment.profileEmail,
      assignmentId: assignment.id,
      projectId: project.id,
      reviewText: assignment.reviewText,
      reviewLink: assignment.reviewLink,
      stars: assignment.stars,
    },
  );

  return NextResponse.json({
    assignmentId: assignment.id,
    visibility: result.visibility,
    detail: result.detail,
    lastVerifiedAt: new Date().toISOString(),
  });
}
