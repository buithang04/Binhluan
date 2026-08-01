import "server-only";
import { prisma } from "@/lib/prisma";
import {
  availableReviewProfileWhere,
  prioritizeProfilesWith2Fa,
} from "@/lib/review-content";
import {
  getBlockedProfileIdsForPlace,
  getProfileIdsReservedForPlace,
  BLOCKING_VISIBILITIES,
} from "@/lib/profile-place-review";
import { resolveProjectPlaceKey } from "@/lib/place-key";

export type EligibleProfileRow = {
  id: string;
  email: string;
  disabled?: boolean;
  disabledReason?: string;
};

export type EligibleProfilesSnapshot = {
  placeKey: string;
  unassignedSlots: number;
  eligibleCount: number;
  blockedAtPlaceCount: number;
  needsVerifyCount: number;
  readyTotalCount: number;
  assignedInPlanCount: number;
  profiles: EligibleProfileRow[];
  updatedAt: string;
};

function accountNeedsVerify(profile: {
  status: string;
  account: {
    status: string;
    loginIssue: string | null;
  };
}): boolean {
  if (profile.account.loginIssue) return true;
  if (profile.account.status !== "READY") return true;
  if (profile.status !== "READY") return true;
  return false;
}

export async function getEligibleProfilesForProject(
  projectId: string,
  options?: { planId?: string; excludeAssignmentId?: string },
): Promise<EligibleProfilesSnapshot | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      googleMapsUrl: true,
      placeKey: true,
      brandName: true,
    },
  });
  if (!project) return null;

  const placeKey = resolveProjectPlaceKey(
    project.googleMapsUrl,
    project.placeKey,
  );

  const plan = options?.planId
    ? await prisma.reviewPlan.findUnique({
        where: { id: options.planId },
        select: { id: true },
      })
    : await prisma.reviewPlan.findFirst({
        where: { projectId, status: { in: ["READY", "RUNNING", "DRAFT"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

  const now = new Date();
  const allReady = await prisma.profile.findMany({
    where: availableReviewProfileWhere(now),
    include: { account: { select: { email: true, loginIssue: true, status: true, totpSecretEnc: true } } },
  });

  const blockedAtPlace = await getBlockedProfileIdsForPlace(placeKey);
  const reservedSamePlace = await getProfileIdsReservedForPlace(placeKey, {
    excludeProjectId: projectId,
    excludePlanId: plan?.id,
    excludeAssignmentId: options?.excludeAssignmentId,
  });
  const assignedInPlan = plan
    ? await prisma.reviewAssignment.findMany({
        where: {
          planId: plan.id,
          status: { in: ["PENDING", "QUEUED", "RUNNING", "FAILED"] },
          apmProfileId: { not: null },
          ...(options?.excludeAssignmentId
            ? { id: { not: options.excludeAssignmentId } }
            : {}),
        },
        select: { apmProfileId: true },
      })
    : [];
  const usedInPlan = new Set(
    assignedInPlan.map((a) => a.apmProfileId).filter(Boolean) as string[],
  );

  const unassignedSlots = plan
    ? await prisma.reviewAssignment.count({
        where: {
          planId: plan.id,
          status: { in: ["PENDING", "FAILED"] },
          apmProfileId: null,
        },
      })
    : 0;

  let needsVerifyCount = 0;
  let blockedAtPlaceCount = 0;
  const eligible: EligibleProfileRow[] = [];

  for (const p of prioritizeProfilesWith2Fa(allReady)) {
    if (accountNeedsVerify(p)) {
      needsVerifyCount++;
      continue;
    }
    if (blockedAtPlace.has(p.id)) {
      blockedAtPlaceCount++;
      continue;
    }
    if (reservedSamePlace.has(p.id)) {
      continue;
    }
    if (usedInPlan.has(p.id)) {
      continue;
    }
    eligible.push({ id: p.id, email: p.account.email });
  }

  const eligibleCount = eligible.length;

  return {
    placeKey,
    unassignedSlots,
    eligibleCount,
    blockedAtPlaceCount,
    needsVerifyCount,
    readyTotalCount: allReady.length,
    assignedInPlanCount: usedInPlan.size,
    profiles: eligible,
    updatedAt: now.toISOString(),
  };
}

/** Kiểm tra 1 profile có thể gán cho assignment. */
export async function assertProfileEligibleForPlace(input: {
  profileId: string;
  placeKey: string;
  planId: string;
  excludeAssignmentId?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const now = new Date();
  const profile = await prisma.profile.findFirst({
    where: { id: input.profileId, ...availableReviewProfileWhere(now) },
    include: { account: { select: { email: true, loginIssue: true, status: true } } },
  });
  if (!profile) {
    return { ok: false, error: "Mail không READY hoặc cần Verify" };
  }
  if (accountNeedsVerify(profile)) {
    return { ok: false, error: "Mail cần Verify trước khi gán" };
  }
  if (await getBlockedProfileIdsForPlace(input.placeKey).then((s) => s.has(input.profileId))) {
    return { ok: false, error: "Mail đã bình luận địa điểm này" };
  }
  const reserved = await getProfileIdsReservedForPlace(input.placeKey, {
    excludePlanId: input.planId,
    excludeAssignmentId: input.excludeAssignmentId,
  });
  if (reserved.has(input.profileId)) {
    return {
      ok: false,
      error: "Mail đã gán cho địa điểm Maps này ở dự án/kế hoạch khác",
    };
  }
  const dup = await prisma.reviewAssignment.findFirst({
    where: {
      planId: input.planId,
      apmProfileId: input.profileId,
      status: { in: ["PENDING", "QUEUED", "RUNNING", "FAILED"] },
      ...(input.excludeAssignmentId ? { id: { not: input.excludeAssignmentId } } : {}),
    },
    select: { id: true },
  });
  if (dup) {
    return { ok: false, error: "Mail đã gán cho bài khác trong kế hoạch" };
  }
  return { ok: true };
}

export { BLOCKING_VISIBILITIES };
