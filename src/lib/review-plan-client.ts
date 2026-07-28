import { enrichPlanAssignments, type MediaThumb } from "@/lib/review-media";

export type ClientStarPlan = {
  projectedRating: number;
  desiredRating: number;
  currentRating: number;
  reviewsToPost: number;
  countsByStar: Record<string, number>;
  delta: number;
};

export type ClientAssignment = {
  id: string;
  sortOrder: number;
  stars: number;
  reviewText: string;
  profileEmail: string | null;
  status: string;
  reviewLink: string | null;
  error: string | null;
  scheduledAt?: string | null;
  mediaAssetIds?: unknown;
  mediaAssets?: MediaThumb[];
  mediaAsset: MediaThumb | null;
};

export type ClientReviewPlan = {
  id: string;
  status: string;
  snapshot: ClientStarPlan | null;
  assignments: ClientAssignment[];
};

/** Prisma Json → StarPlan (tránh snapshot không parse được → UI mãi “Đang tải”). */
export function normalizeStarPlan(raw: unknown): ClientStarPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.reviewsToPost !== "number") return null;
  if (!o.countsByStar || typeof o.countsByStar !== "object") return null;
  return {
    projectedRating: Number(o.projectedRating) || 0,
    desiredRating: Number(o.desiredRating) || 0,
    currentRating: Number(o.currentRating) || 0,
    reviewsToPost: o.reviewsToPost,
    countsByStar: o.countsByStar as Record<string, number>,
    delta: Number(o.delta) || 0,
  };
}

type DbAssignment = {
  id: string;
  sortOrder: number;
  stars: number;
  reviewText: string;
  profileEmail: string | null;
  status: string;
  reviewLink: string | null;
  error: string | null;
  scheduledAt: Date | string | null;
  mediaAssetIds?: unknown;
  mediaAssetId?: string | null;
  mediaAsset?: MediaThumb | null;
};

type DbPlan = {
  id: string;
  status: string;
  snapshot: unknown;
  assignments: DbAssignment[];
};

/** Serialize plan + assignments từ Prisma sang props/JSON client. */
export function toClientReviewPlan(
  plan: DbPlan | null | undefined,
  media: MediaThumb[],
): ClientReviewPlan | null {
  if (!plan) return null;
  const enriched = enrichPlanAssignments(plan.assignments, media);
  return {
    id: plan.id,
    status: plan.status,
    snapshot: normalizeStarPlan(plan.snapshot),
    assignments: enriched.map((a) => ({
      id: a.id,
      sortOrder: a.sortOrder,
      stars: a.stars,
      reviewText: a.reviewText,
      profileEmail: a.profileEmail,
      status: a.status,
      reviewLink: a.reviewLink,
      error: a.error,
      scheduledAt:
        a.scheduledAt instanceof Date
          ? a.scheduledAt.toISOString()
          : a.scheduledAt
            ? String(a.scheduledAt)
            : null,
      mediaAssetIds: a.mediaAssetIds,
      mediaAssets: a.mediaAssets,
      mediaAsset: a.mediaAsset ?? null,
    })),
  };
}
