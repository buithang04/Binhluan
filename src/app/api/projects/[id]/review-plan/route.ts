import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { planReviewStars } from "@/lib/review-planner";
import {
  parseReviewSpinByStar,
  resolveReviewTextForStar,
  availableReviewProfileWhere,
  prioritizeProfilesWith2Fa,
  pickUniqueProfilesForPlan,
} from "@/lib/review-content";
import { pickRandomMediaAssets, enrichPlanAssignments } from "@/lib/review-media";
import {
  adjustScheduleForProfileReuse,
  clampScheduleNotBefore,
  planReviewScheduleDates,
} from "@/lib/review-schedule";
import {
  getBlockedProfileIdsForPlace,
  getProfileIdsReservedForPlace,
  fetchLedgerVisibilityByProfile,
} from "@/lib/profile-place-review";
import { resolveProjectPlaceKey } from "@/lib/place-key";

type Ctx = { params: Promise<{ id: string }> };

async function getProject(id: string, userId: string, isAdmin: boolean) {
  return prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId },
    include: {
      package: true,
      media: { orderBy: { createdAt: "asc" } },
      products: true,
    },
  });
}

export async function GET(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const light = new URL(req.url).searchParams.get("light") === "1";

  const project = await prisma.project.findFirst({
    where: isAdmin ? { id } : { id, userId: session.user.id },
    select: { id: true, googleMapsUrl: true, placeKey: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const placeKey = resolveProjectPlaceKey(project.googleMapsUrl, project.placeKey);

  if (light) {
    const plan = await prisma.reviewPlan.findFirst({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        assignments: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            status: true,
            reviewLink: true,
            error: true,
            scheduledAt: true,
            apmProfileId: true,
            profileEmail: true,
          },
        },
      },
    });
    const mediaCount = await prisma.mediaAsset.count({ where: { projectId: id } });
    return NextResponse.json({ plan: plan ?? null, mediaCount });
  }

  const plan = await prisma.reviewPlan.findFirst({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    include: {
      assignments: {
        orderBy: { sortOrder: "asc" },
        include: { mediaAsset: { select: { id: true, filePath: true, fileName: true } } },
      },
    },
  });

  const media = await prisma.mediaAsset.findMany({
    where: { projectId: id },
    select: { id: true, filePath: true, fileName: true },
    orderBy: { createdAt: "asc" },
  });

  if (!plan) {
    return NextResponse.json({ plan: null, mediaCount: media.length });
  }

  const completedProfileIds = plan.assignments
    .filter((a) => a.status === "COMPLETED" && a.apmProfileId)
    .map((a) => a.apmProfileId as string);
  const ledgerByProfile = await fetchLedgerVisibilityByProfile(
    placeKey,
    completedProfileIds,
  );

  const assignmentsWithVisibility = enrichPlanAssignments(plan.assignments, media).map(
    (a) => {
      const ledger = a.apmProfileId ? ledgerByProfile.get(a.apmProfileId) : undefined;
      return {
        ...a,
        reviewVisibility: ledger?.visibility ?? null,
        lastVerifiedAt: ledger?.lastVerifiedAt?.toISOString() ?? null,
      };
    },
  );

  return NextResponse.json({
    plan: {
      ...plan,
      assignments: assignmentsWithVisibility,
    },
    mediaCount: media.length,
  });
}

export async function POST(req: Request, ctx: Ctx) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const isAdmin = session.user.role === "ADMIN";
  const project = await getProject(id, session.user.id, isAdmin);
  if (!project) {
    return NextResponse.json({ error: "Không tìm thấy dự án" }, { status: 404 });
  }

  const reviewsToPost = project.package.targetContents;
  const reviewCount = project.reviewCount ?? 0;
  const hasCurrent =
    project.currentRating != null || reviewCount <= 0;
  if (project.desiredRating == null || !hasCurrent) {
    return NextResponse.json(
      {
        error:
          "Cần có số sao hiện tại và số sao mong muốn trên dự án (place chưa có review: nhập 0 lượt / để trống sao)",
      },
      { status: 400 },
    );
  }

  if (!project.reviewContentGeneratedAt) {
    return NextResponse.json(
      {
        error:
          "Cần sinh nội dung review theo sao trước khi lập kế hoạch (Nội dung bình luận)",
      },
      { status: 400 },
    );
  }

  const placeKey = resolveProjectPlaceKey(project.googleMapsUrl, project.placeKey);
  if (!project.placeKey) {
    await prisma.project.update({
      where: { id },
      data: { placeKey, placeResolvedAt: new Date() },
    });
  }

  const spinByStar = parseReviewSpinByStar(project.reviewSpinByStar);

  const existingPlan = await prisma.reviewPlan.findFirst({
    where: {
      projectId: id,
      status: { in: ["READY", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
    include: {
      assignments: {
        where: { status: { in: ["PENDING", "FAILED", "COMPLETED"] } },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  const completedKeep = existingPlan?.assignments.filter((a) => a.status === "COMPLETED") ?? [];
  const preservePending = existingPlan?.assignments.filter((a) =>
    ["PENDING", "FAILED"].includes(a.status),
  ) ?? [];
  const preserveBySort = new Map(preservePending.map((a) => [a.sortOrder, a]));
  const remainingSlots = Math.max(0, reviewsToPost - completedKeep.length);
  if (remainingSlots === 0) {
    return NextResponse.json(
      {
        error: `Đã có ${completedKeep.length} bài COMPLETED — đủ gói ${reviewsToPost}, không cần lập lại`,
      },
      { status: 400 },
    );
  }

  const now = new Date();
  const blockedAtPlace = await getBlockedProfileIdsForPlace(placeKey);
  for (const c of completedKeep) {
    if (c.apmProfileId) blockedAtPlace.add(c.apmProfileId);
  }

  /** Mail đã gán ở dự án/kế hoạch khác CÙNG placeKey — không pick trùng. Khác Maps → vẫn được. */
  const reservedSamePlace = await getProfileIdsReservedForPlace(placeKey, {
    excludeProjectId: id,
  });
  const excludeForPick = new Set<string>([...blockedAtPlace, ...reservedSamePlace]);

  const pool = prioritizeProfilesWith2Fa(
    (
      await prisma.profile.findMany({
        where: availableReviewProfileWhere(now),
        include: { account: { select: { email: true, totpSecretEnc: true } } },
      })
    ).filter((p) => !blockedAtPlace.has(p.id)),
  );

  const assignedProfiles = pickUniqueProfilesForPlan(
    pool,
    remainingSlots,
    excludeForPick,
  );

  if (project.endAt < now) {
    return NextResponse.json(
      { error: "Chiến dịch đã hết hạn (ngày kết thúc đã qua) — gia hạn endAt trước khi lập kế hoạch" },
      { status: 400 },
    );
  }

  const profileIdsForSchedule: string[] = [];
  for (let i = 0; i < reviewsToPost; i++) {
    if (i < completedKeep.length) {
      profileIdsForSchedule.push(completedKeep[i]!.apmProfileId ?? `done-${i}`);
    } else {
      const slotIdx = i - completedKeep.length;
      const preserved = preserveBySort.get(i);
      let pid = assignedProfiles[slotIdx]?.id ?? null;
      if (preserved?.apmProfileId) {
        const stillOk =
          !blockedAtPlace.has(preserved.apmProfileId) &&
          !excludeForPick.has(preserved.apmProfileId);
        if (stillOk) pid = preserved.apmProfileId;
      }
      profileIdsForSchedule.push(pid ?? `empty-${i}`);
    }
  }

  const minProfileGapMs = 6 * 60 * 60_000;
  const scheduleDates = clampScheduleNotBefore(
    adjustScheduleForProfileReuse(
      planReviewScheduleDates(project.startAt, project.endAt, reviewsToPost, now),
      profileIdsForSchedule,
      minProfileGapMs,
    ),
    now,
  );

  const planned = planReviewStars({
    currentRating:
      project.currentRating != null ? Number(project.currentRating) : 0,
    reviewCount: project.reviewCount ?? 0,
    desiredRating: Number(project.desiredRating),
    reviewsToPost,
  });

  const newSlots = planned.slots.slice(completedKeep.length);

  const neededStars = new Set(newSlots.map((s) => String(s.stars)));
  for (const s of neededStars) {
    if (!spinByStar[s]) {
      return NextResponse.json(
        { error: `Thiếu template spin cho ${s}★ — sinh lại nội dung review` },
        { status: 400 },
      );
    }
  }

  const media = project.media;

  if (project.endAt < project.startAt) {
    return NextResponse.json(
      { error: "Ngày kết thúc phải nằm trong khoảng thời gian dự án" },
      { status: 400 },
    );
  }

  const newAssignmentsData = newSlots.map((slot, i) => {
    const globalIndex = completedKeep.length + i;
    const reviewText = resolveReviewTextForStar(
      slot.stars,
      spinByStar,
      project,
      project.brandName,
    );
    const pickedMedia = media.length ? pickRandomMediaAssets(media) : [];
    let profile = assignedProfiles[i];
    const preserved = preserveBySort.get(globalIndex);
    if (preserved?.apmProfileId) {
      const stillOk =
        !blockedAtPlace.has(preserved.apmProfileId) &&
        !excludeForPick.has(preserved.apmProfileId) &&
        pool.some((p) => p.id === preserved.apmProfileId);
      if (stillOk) {
        profile =
          pool.find((p) => p.id === preserved.apmProfileId) ??
          ({
            id: preserved.apmProfileId,
            account: { email: preserved.profileEmail ?? "" },
          } as (typeof pool)[number]);
      }
    }
    return {
      sortOrder: globalIndex,
      stars: slot.stars,
      reviewText,
      mediaAssetId: pickedMedia[0]?.id ?? null,
      mediaAssetIds: pickedMedia.map((m) => m.id),
      scheduledAt:
        preserved?.scheduledAt ??
        scheduleDates[globalIndex] ??
        scheduleDates[scheduleDates.length - 1] ??
        project.startAt,
      apmProfileId: profile?.id ?? null,
      profileEmail: profile?.account.email ?? null,
      status: "PENDING" as const,
    };
  });

  const assignedCount = newAssignmentsData.filter((a) => a.apmProfileId).length;
  const unassignedSlots = remainingSlots - assignedCount;

  if (project.reviewsToPost !== reviewsToPost) {
    await prisma.project.update({
      where: { id },
      data: { reviewsToPost },
    });
  }

  const snapshotExtras = {
    profileCount: assignedCount,
    profilesAssigned: assignedCount,
    unassignedSlots,
    eligibleAtPlanTime: pool.length,
    placeKey,
    profileReuse: false,
    ratingScannedAt: project.ratingScannedAt,
    completedKept: completedKeep.length,
    remainingPlanned: newAssignmentsData.length,
  };

  const plan = await prisma.$transaction(async (tx) => {
    await tx.reviewPlan.updateMany({
      where: {
        projectId: id,
        status: { in: ["DRAFT", "READY"] },
        ...(existingPlan ? { id: { not: existingPlan.id } } : {}),
      },
      data: { status: "FAILED" },
    });

    if (existingPlan) {
      await tx.reviewAssignment.deleteMany({
        where: {
          planId: existingPlan.id,
          status: { not: "COMPLETED" },
        },
      });
      if (newAssignmentsData.length) {
        await tx.reviewAssignment.createMany({
          data: newAssignmentsData.map((a) => ({
            ...a,
            planId: existingPlan.id,
          })),
        });
      }
      return tx.reviewPlan.update({
        where: { id: existingPlan.id },
        data: {
          status: existingPlan.status === "RUNNING" ? "RUNNING" : "READY",
          snapshot: { ...planned, ...snapshotExtras },
        },
        include: {
          assignments: {
            orderBy: { sortOrder: "asc" },
            include: {
              mediaAsset: { select: { id: true, filePath: true, fileName: true } },
            },
          },
        },
      });
    }

    return tx.reviewPlan.create({
      data: {
        projectId: id,
        status: "READY",
        snapshot: { ...planned, ...snapshotExtras },
        assignments: { create: newAssignmentsData },
      },
      include: {
        assignments: {
          orderBy: { sortOrder: "asc" },
          include: {
            mediaAsset: { select: { id: true, filePath: true, fileName: true } },
          },
        },
      },
    });
  });

  const enriched = {
    ...plan,
    assignments: enrichPlanAssignments(plan.assignments, media),
  };

  let message: string | undefined;
  if (completedKeep.length > 0) {
    message = `Đã giữ ${completedKeep.length} bài hoàn thành, lập ${newAssignmentsData.length} bài còn lại — gán ${assignedCount} mail`;
  } else {
    message = `Đã lập kế hoạch — gán ${assignedCount}/${remainingSlots} mail (1 mail / 1 bình luận / địa điểm)`;
  }
  if (unassignedSlots > 0) {
    message += `. ${unassignedSlots} bài chưa có mail — bổ sung account hoặc chọn mail thủ công.`;
  }

  return NextResponse.json({
    plan: enriched,
    planned,
    unassignedSlots,
    assignedCount,
    message,
  });
}
