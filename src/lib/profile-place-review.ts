import "server-only";
import type { Prisma, ReviewVisibility, ProfilePlaceReviewSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveProjectPlaceKey } from "@/lib/place-key";

/** Mail đã review place — chặn gán lại (trừ DELETED). */
export const BLOCKING_VISIBILITIES: ReviewVisibility[] = [
  "UNKNOWN",
  "VISIBLE",
  "HIDDEN",
];

export async function getBlockedProfileIdsForPlace(
  placeKey: string,
): Promise<Set<string>> {
  const rows = await prisma.profilePlaceReview.findMany({
    where: {
      placeKey,
      visibility: { in: BLOCKING_VISIBILITIES },
    },
    select: { profileId: true },
  });
  return new Set(rows.map((r) => r.profileId));
}

/**
 * Mail đã gán ở kế hoạch active (PENDING→FAILED) cho CÙNG placeKey — kể cả dự án khác.
 * Khác placeKey → không chặn (cùng mail được review nhiều địa điểm).
 */
export async function getProfileIdsReservedForPlace(
  placeKey: string,
  options?: {
    excludeProjectId?: string;
    excludePlanId?: string;
    excludeAssignmentId?: string;
  },
): Promise<Set<string>> {
  if (!placeKey) return new Set();

  const matchingProjects = await prisma.project.findMany({
    where: {
      placeKey,
      ...(options?.excludeProjectId ? { id: { not: options.excludeProjectId } } : {}),
    },
    select: { id: true },
  });
  const projectIds = matchingProjects.map((p) => p.id);
  if (!projectIds.length) return new Set();

  const rows = await prisma.reviewAssignment.findMany({
    where: {
      apmProfileId: { not: null },
      status: { in: ["PENDING", "QUEUED", "RUNNING", "FAILED"] },
      ...(options?.excludeAssignmentId
        ? { id: { not: options.excludeAssignmentId } }
        : {}),
      plan: {
        status: { in: ["READY", "RUNNING"] },
        ...(options?.excludePlanId ? { id: { not: options.excludePlanId } } : {}),
        projectId: { in: projectIds },
      },
    },
    select: { apmProfileId: true },
  });

  const reserved = new Set<string>();
  for (const row of rows) {
    if (row.apmProfileId) reserved.add(row.apmProfileId);
  }
  return reserved;
}

export type UpsertPlaceReviewInput = {
  profileId: string;
  accountEmail: string;
  placeKey: string;
  placeName?: string | null;
  googleMapsUrl?: string | null;
  resolvedUrl?: string | null;
  stars?: number | null;
  reviewText?: string | null;
  reviewLink?: string | null;
  assignmentId?: string | null;
  projectId?: string | null;
  source?: ProfilePlaceReviewSource;
  visibility?: ReviewVisibility;
};

export async function upsertProfilePlaceReview(
  input: UpsertPlaceReviewInput,
): Promise<void> {
  const data: Prisma.ProfilePlaceReviewUncheckedCreateInput = {
    profileId: input.profileId,
    accountEmail: input.accountEmail,
    placeKey: input.placeKey,
    placeName: input.placeName ?? null,
    googleMapsUrl: input.googleMapsUrl ?? null,
    resolvedUrl: input.resolvedUrl ?? null,
    stars: input.stars ?? null,
    reviewText: input.reviewText ?? null,
    reviewLink: input.reviewLink ?? null,
    assignmentId: input.assignmentId ?? null,
    projectId: input.projectId ?? null,
    source: input.source ?? "POSTED",
    visibility: input.visibility ?? (input.reviewLink ? "UNKNOWN" : "VISIBLE"),
    postedAt: new Date(),
  };

  await prisma.profilePlaceReview.upsert({
    where: {
      profileId_placeKey: {
        profileId: input.profileId,
        placeKey: input.placeKey,
      },
    },
    create: data,
    update: {
      accountEmail: data.accountEmail,
      placeName: data.placeName,
      googleMapsUrl: data.googleMapsUrl,
      resolvedUrl: data.resolvedUrl,
      stars: data.stars,
      reviewText: data.reviewText,
      reviewLink: data.reviewLink ?? undefined,
      assignmentId: data.assignmentId,
      projectId: data.projectId,
      source: data.source,
      visibility: data.visibility,
      postedAt: data.postedAt,
    },
  });
}

export async function profileHasReviewAtPlace(
  profileId: string,
  placeKey: string,
): Promise<boolean> {
  const hit = await prisma.profilePlaceReview.findFirst({
    where: {
      profileId,
      placeKey,
      visibility: { in: BLOCKING_VISIBILITIES },
    },
    select: { id: true },
  });
  return Boolean(hit);
}

export async function updateReviewVisibility(
  profileId: string,
  placeKey: string,
  visibility: ReviewVisibility,
  opts?: {
    accountEmail?: string | null;
    assignmentId?: string | null;
    projectId?: string | null;
    reviewText?: string | null;
    reviewLink?: string | null;
    stars?: number | null;
  },
): Promise<void> {
  const now = new Date();
  const existing = await prisma.profilePlaceReview.findUnique({
    where: { profileId_placeKey: { profileId, placeKey } },
  });
  if (existing) {
    await prisma.profilePlaceReview.update({
      where: { id: existing.id },
      data: { visibility, lastVerifiedAt: now },
    });
    return;
  }
  if (!opts?.accountEmail?.trim()) return;
  await prisma.profilePlaceReview.create({
    data: {
      profileId,
      placeKey,
      accountEmail: opts.accountEmail.trim(),
      visibility,
      lastVerifiedAt: now,
      assignmentId: opts.assignmentId ?? null,
      projectId: opts.projectId ?? null,
      reviewText: opts.reviewText ?? null,
      reviewLink: opts.reviewLink ?? null,
      stars: opts.stars ?? null,
      source: "POSTED",
    },
  });
}

export type LedgerVisibilityRow = {
  profileId: string;
  visibility: ReviewVisibility;
  lastVerifiedAt: Date | null;
};

/** Gắn visibility từ sổ cái cho các assignment COMPLETED. */
export async function fetchLedgerVisibilityByProfile(
  placeKey: string,
  profileIds: string[],
): Promise<Map<string, LedgerVisibilityRow>> {
  if (!profileIds.length) return new Map();
  const rows = await prisma.profilePlaceReview.findMany({
    where: { placeKey, profileId: { in: profileIds } },
    select: { profileId: true, visibility: true, lastVerifiedAt: true },
  });
  return new Map(
    rows.map((r) => [
      r.profileId,
      {
        profileId: r.profileId,
        visibility: r.visibility,
        lastVerifiedAt: r.lastVerifiedAt,
      },
    ]),
  );
}
