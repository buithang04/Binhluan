import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enrichPlanAssignments } from "@/lib/review-media";
import {
  assertProfileEligibleForPlace,
  getEligibleProfilesForProject,
} from "@/lib/eligible-profiles";
import { resolveProjectPlaceKey } from "@/lib/place-key";
import {
  availableReviewProfileWhere,
  prioritizeProfilesWith2Fa,
} from "@/lib/review-content";
import { getBlockedProfileIdsForPlace } from "@/lib/profile-place-review";

type Ctx = { params: Promise<{ id: string }> };

/** Gán mail eligible vào các slot trống (apmProfileId null). */
export async function POST(_req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true, googleMapsUrl: true, placeKey: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const plan = await prisma.reviewPlan.findFirst({
    where: { projectId: id, status: { in: ["READY", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!plan) {
    return NextResponse.json({ error: "Không có kế hoạch active" }, { status: 400 });
  }

  const empty = await prisma.reviewAssignment.findMany({
    where: {
      planId: plan.id,
      status: { in: ["PENDING", "FAILED"] },
      apmProfileId: null,
    },
    orderBy: { sortOrder: "asc" },
    select: { id: true, sortOrder: true },
  });

  if (!empty.length) {
    return NextResponse.json({ filled: 0, message: "Không có slot trống" });
  }

  const placeKey = resolveProjectPlaceKey(project.googleMapsUrl, project.placeKey);
  const snap = await getEligibleProfilesForProject(id, { planId: plan.id });
  const pool = [...(snap?.profiles ?? [])];

  let filled = 0;
  const usedThisRun = new Set<string>();
  for (const slot of empty) {
    let assigned = false;
    while (pool.length) {
      const pick = pool.shift()!;
      if (usedThisRun.has(pick.id)) continue;
      const check = await assertProfileEligibleForPlace({
        profileId: pick.id,
        placeKey,
        planId: plan.id,
        excludeAssignmentId: slot.id,
      });
      if (!check.ok) continue;

      await prisma.reviewAssignment.update({
        where: { id: slot.id },
        data: {
          apmProfileId: pick.id,
          profileEmail: pick.email,
          status: "PENDING",
          error: null,
        },
      });
      usedThisRun.add(pick.id);
      filled++;
      assigned = true;
      break;
    }
    if (!assigned) break;
  }

  // Fallback: vẫn còn slot trống -> dùng toàn bộ mail READY chưa review place
  // (không trùng trong plan hiện tại, không trùng trong lượt chạy này).
  if (filled < empty.length) {
    const blockedAtPlace = await getBlockedProfileIdsForPlace(placeKey);
    const allReady = prioritizeProfilesWith2Fa(
      await prisma.profile.findMany({
        where: availableReviewProfileWhere(new Date()),
        include: { account: { select: { email: true, totpSecretEnc: true } } },
      }),
    ).filter((p) => !blockedAtPlace.has(p.id));

    const alreadyUsedInPlan = new Set(
      (
        await prisma.reviewAssignment.findMany({
          where: {
            planId: plan.id,
            status: { in: ["PENDING", "QUEUED", "RUNNING", "FAILED"] },
            apmProfileId: { not: null },
          },
          select: { apmProfileId: true },
        })
      )
        .map((r) => r.apmProfileId)
        .filter(Boolean) as string[],
    );
    for (const id of usedThisRun) alreadyUsedInPlan.add(id);

    const remainingSlots = empty.slice(filled);
    for (const slot of remainingSlots) {
      const pick = allReady.find((p) => !alreadyUsedInPlan.has(p.id));
      if (!pick) break;
      await prisma.reviewAssignment.update({
        where: { id: slot.id },
        data: {
          apmProfileId: pick.id,
          profileEmail: pick.account.email,
          status: "PENDING",
          error: null,
        },
      });
      alreadyUsedInPlan.add(pick.id);
      filled++;
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

  const media = await prisma.mediaAsset.findMany({
    where: { projectId: id },
    select: { id: true, filePath: true, fileName: true },
  });

  const remaining = empty.length - filled;

  return NextResponse.json({
    filled,
    remaining,
    plan: refreshed
      ? {
          ...refreshed,
          assignments: enrichPlanAssignments(refreshed.assignments, media),
        }
      : null,
    message:
      filled > 0
        ? `Đã gán mail cho ${filled} bài${remaining > 0 ? ` — còn ${remaining} bài chưa có mail` : ""}`
        : "Không có mail khả dụng để gán",
  });
}
