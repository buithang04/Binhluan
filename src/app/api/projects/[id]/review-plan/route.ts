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
  assignUniqueProfilesToSlots,
} from "@/lib/review-content";
import { pickRandomMediaAssets, enrichPlanAssignments } from "@/lib/review-media";
import {
  adjustScheduleForProfileReuse,
  clampScheduleNotBefore,
  campaignEndDatePassedMessage,
  formatScheduleDate,
  isCampaignEndDatePassed,
  planReviewScheduleDates,
  SCHEDULE_MIN_LEAD_MS,
  SCHEDULE_MIN_SLOT_GAP_MS,
} from "@/lib/review-schedule";
import {
  getBlockedProfileIdsForPlace,
  getProfileIdsReservedForPlace,
  fetchLedgerVisibilityByProfile,
} from "@/lib/profile-place-review";
import { resolveProjectPlaceKey } from "@/lib/place-key";
import {
  countDuplicatePlanProfiles,
  repairDuplicatePlanAssignments,
} from "@/lib/review-plan-profiles";

type Ctx = { params: Promise<{ id: string }> };

function formatScheduleHint(when: Date): string {
  return formatScheduleDate(when);
}

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

  if ((await countDuplicatePlanProfiles(plan.id)) > 0) {
    await repairDuplicatePlanAssignments(plan.id);
    plan.assignments = await prisma.reviewAssignment.findMany({
      where: { planId: plan.id },
      orderBy: { sortOrder: "asc" },
      include: { mediaAsset: { select: { id: true, filePath: true, fileName: true } } },
    });
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

  const now = new Date();
  if (isCampaignEndDatePassed(project.endAt, now)) {
    return NextResponse.json(
      { error: campaignEndDatePassedMessage(project.endAt) },
      { status: 400 },
    );
  }

  if (project.endAt < project.startAt) {
    return NextResponse.json(
      { error: "Ngày kết thúc phải nằm trong khoảng thời gian dự án" },
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

  /** Bài đã/đang đăng — không xóa, không đổi lịch/mail khi lập lại kế hoạch. */
  const LOCKED_ASSIGNMENT_STATUSES = ["COMPLETED", "QUEUED", "RUNNING"] as const;

  const existingPlan = await prisma.reviewPlan.findFirst({
    where: {
      projectId: id,
      status: { in: ["READY", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
    include: {
      assignments: {
        where: {
          status: {
            in: ["PENDING", "FAILED", "COMPLETED", "QUEUED", "RUNNING"],
          },
        },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  const lockedKeep = [
    ...(existingPlan?.assignments.filter((a) =>
      (LOCKED_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status),
    ) ?? []),
  ].sort((a, b) => a.sortOrder - b.sortOrder);
  const preservePending = [
    ...(existingPlan?.assignments.filter((a) =>
      ["PENDING", "FAILED"].includes(a.status),
    ) ?? []),
  ].sort((a, b) => a.sortOrder - b.sortOrder);
  const remainingSlots = Math.max(0, reviewsToPost - lockedKeep.length);
  if (remainingSlots === 0 && preservePending.length === 0) {
    return NextResponse.json(
      {
        error: `Đã có ${lockedKeep.length} bài đã/đang đăng — đủ gói ${reviewsToPost}, không cần lập lại`,
      },
      { status: 400 },
    );
  }

  const blockedAtPlace = await getBlockedProfileIdsForPlace(placeKey);
  for (const c of lockedKeep) {
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

  const assignedProfiles = assignUniqueProfilesToSlots({
    pool,
    slotCount: remainingSlots,
    excludeIds: excludeForPick,
    preserveProfileIds: preservePending.map((p) => p.apmProfileId),
  });

  const profileIdsForNewSlots = assignedProfiles.map((p, i) => p?.id ?? `empty-${i}`);

  /** Lần đầu: từ max(hôm nay, startAt). Lập lại: chỉ phân bổ từ thời điểm lập → endAt. */
  const effectiveScheduleStart = existingPlan
    ? now
    : new Date(Math.max(now.getTime(), project.startAt.getTime()));
  const minProfileGapMs = 6 * 60 * 60_000;
  const scheduleDatesForNew = clampScheduleNotBefore(
    adjustScheduleForProfileReuse(
      planReviewScheduleDates(
        effectiveScheduleStart,
        project.endAt,
        remainingSlots,
        now,
      ),
      profileIdsForNewSlots,
      minProfileGapMs,
    ),
    now,
    SCHEDULE_MIN_SLOT_GAP_MS,
    SCHEDULE_MIN_LEAD_MS,
  );

  const planned = planReviewStars({
    currentRating:
      project.currentRating != null ? Number(project.currentRating) : 0,
    reviewCount: project.reviewCount ?? 0,
    desiredRating: Number(project.desiredRating),
    reviewsToPost,
  });

  const newSlots = planned.slots.slice(lockedKeep.length);

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

  const newAssignmentsData = newSlots.map((slot, i) => {
    const sortOrder = lockedKeep.length + i;
    const reviewText = resolveReviewTextForStar(
      slot.stars,
      spinByStar,
      project,
      project.brandName,
    );
    const pickedMedia = media.length ? pickRandomMediaAssets(media) : [];
    const profile = assignedProfiles[i] ?? null;
    return {
      sortOrder,
      stars: slot.stars,
      reviewText,
      mediaAssetId: pickedMedia[0]?.id ?? null,
      mediaAssetIds: pickedMedia.map((m) => m.id),
      scheduledAt:
        scheduleDatesForNew[i] ??
        scheduleDatesForNew[scheduleDatesForNew.length - 1] ??
        effectiveScheduleStart,
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
    completedKept: lockedKeep.length,
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
      for (let i = 0; i < lockedKeep.length; i++) {
        await tx.reviewAssignment.update({
          where: { id: lockedKeep[i]!.id },
          data: { sortOrder: i },
        });
      }
      await tx.reviewAssignment.deleteMany({
        where: {
          planId: existingPlan.id,
          status: { in: ["PENDING", "FAILED"] },
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

  let repairedDupes = 0;
  if ((await countDuplicatePlanProfiles(plan.id)) > 0) {
    repairedDupes = await repairDuplicatePlanAssignments(plan.id);
    if (repairedDupes > 0) {
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
      if (refreshed) {
        enriched.assignments = enrichPlanAssignments(refreshed.assignments, media);
      }
    }
  }

  let message: string | undefined;
  if (lockedKeep.length > 0) {
    message = `Đã giữ ${lockedKeep.length} bài đã/đang đăng, lập ${newAssignmentsData.length} bài còn lại từ ${formatScheduleHint(now)} — gán ${assignedCount} mail`;
  } else {
    message = `Đã lập kế hoạch từ ${formatScheduleHint(now)} — gán ${assignedCount}/${remainingSlots} mail (1 mail / 1 bình luận / địa điểm)`;
  }
  if (unassignedSlots > 0) {
    message += `. ${unassignedSlots} bài chưa có mail — bổ sung account hoặc chọn mail thủ công.`;
  }
  if (repairedDupes > 0) {
    message = `${message ?? ""} Đã gỡ ${repairedDupes} mail trùng trong kế hoạch.`.trim();
  }

  return NextResponse.json({
    plan: enriched,
    planned,
    unassignedSlots,
    assignedCount,
    message,
  });
}
