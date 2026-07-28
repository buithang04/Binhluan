import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  computeProjectStarPlan,
  getStarPlanBlockers,
  getStarPlanInputs,
  availableReviewProfileWhere,
} from "@/lib/review-content";
import { getReviewInfraWarnings } from "@/lib/review-preflight";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    include: { package: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const blockers = getStarPlanBlockers(project);
  const inputs = getStarPlanInputs(project);
  const planned = computeProjectStarPlan(project);
  const now = new Date();
  const [readyProfileCount, infra] = await Promise.all([
    prisma.profile.count({
      where: availableReviewProfileWhere(now),
    }),
    getReviewInfraWarnings(now),
  ]);

  return NextResponse.json({
    planned,
    blockers,
    inputs,
    contentGenerated: !!project.reviewContentGeneratedAt,
    ratingScannedAt: project.ratingScannedAt,
    readyProfileCount,
    reviewsToPost: project.package.targetContents,
    packageLimit: project.package.targetContents,
    infraWarnings: infra.warnings,
    availableProxyCount: infra.proxyCount,
    readyProfilesWithoutBrowser: infra.readyNoBrowser,
  });
}
