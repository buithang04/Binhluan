import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { ReviewVisibility } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveProjectPlaceKey } from "@/lib/place-key";
import { updateReviewVisibility } from "@/lib/profile-place-review";
import { verifyReviewOnMaps } from "@/lib/review-verify";

export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** Quét hàng loạt các bài COMPLETED trong kế hoạch mới nhất. */
export async function POST(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
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

  const plan = await prisma.reviewPlan.findFirst({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      assignments: {
        where: { status: "COMPLETED", apmProfileId: { not: null } },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          sortOrder: true,
          stars: true,
          reviewText: true,
          reviewLink: true,
          apmProfileId: true,
          profileEmail: true,
        },
      },
    },
  });
  if (!plan?.assignments.length) {
    return NextResponse.json({
      checked: 0,
      summary: {},
      results: [],
      message: "Không có bài COMPLETED để quét",
    });
  }

  const placeKey = resolveProjectPlaceKey(project.googleMapsUrl, project.placeKey);
  const summary: Partial<Record<ReviewVisibility, number>> = {};
  const results: Array<{
    assignmentId: string;
    sortOrder: number;
    visibility: ReviewVisibility;
    detail: string;
  }> = [];

  for (const a of plan.assignments) {
    if (!a.apmProfileId) continue;
    try {
      const result = await verifyReviewOnMaps({
        reviewLink: a.reviewLink,
        googleMapsUrl: project.googleMapsUrl,
        resolvedUrl: project.resolvedUrl,
        reviewText: a.reviewText,
        stars: a.stars,
      });
      await updateReviewVisibility(a.apmProfileId, placeKey, result.visibility, {
        accountEmail: a.profileEmail,
        assignmentId: a.id,
        projectId: project.id,
        reviewText: a.reviewText,
        reviewLink: a.reviewLink,
        stars: a.stars,
      });
      summary[result.visibility] = (summary[result.visibility] ?? 0) + 1;
      results.push({
        assignmentId: a.id,
        sortOrder: a.sortOrder,
        visibility: result.visibility,
        detail: result.detail,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.UNKNOWN = (summary.UNKNOWN ?? 0) + 1;
      results.push({
        assignmentId: a.id,
        sortOrder: a.sortOrder,
        visibility: "UNKNOWN",
        detail: msg.slice(0, 120),
      });
    }
  }

  return NextResponse.json({
    checked: results.length,
    summary,
    results,
    message: `Đã quét ${results.length} bài`,
  });
}
