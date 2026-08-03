import "server-only";
import type { ReviewVisibility } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveProjectPlaceKey } from "@/lib/place-key";
import { updateReviewVisibility } from "@/lib/profile-place-review";
import { verifyReviewOnMaps } from "@/lib/review-verify";

export type VerifyBatchResult = {
  projects: number;
  checked: number;
  summary: Partial<Record<ReviewVisibility, number>>;
  errors: string[];
};

const VERIFY_DELAY_MS = Math.max(
  500,
  Number(process.env.REVIEW_VERIFY_DELAY_MS || 2500),
);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Quét tất cả bài COMPLETED (mọi dự án hoặc 1 dự án). */
export async function verifyAllCompletedReviews(options?: {
  projectId?: string;
  limit?: number;
}): Promise<VerifyBatchResult> {
  const limit = options?.limit ?? 150;
  const rows = await prisma.reviewAssignment.findMany({
    where: {
      status: "COMPLETED",
      apmProfileId: { not: null },
      ...(options?.projectId
        ? { plan: { projectId: options.projectId } }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    take: limit,
    select: {
      id: true,
      sortOrder: true,
      stars: true,
      reviewText: true,
      reviewLink: true,
      apmProfileId: true,
      profileEmail: true,
      plan: {
        select: {
          project: {
            select: {
              id: true,
              googleMapsUrl: true,
              resolvedUrl: true,
              placeKey: true,
            },
          },
        },
      },
    },
  });

  const summary: Partial<Record<ReviewVisibility, number>> = {};
  const errors: string[] = [];
  const projectIds = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]!;
    const project = a.plan.project;
    if (!a.apmProfileId) continue;
    projectIds.add(project.id);
    const placeKey = resolveProjectPlaceKey(
      project.googleMapsUrl,
      project.placeKey,
    );

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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.UNKNOWN = (summary.UNKNOWN ?? 0) + 1;
      if (errors.length < 8) {
        errors.push(`#${a.sortOrder + 1} ${project.id.slice(0, 8)}: ${msg.slice(0, 80)}`);
      }
    }

    if (i < rows.length - 1) {
      await sleep(VERIFY_DELAY_MS);
    }
  }

  return {
    projects: projectIds.size,
    checked: rows.length,
    summary,
    errors,
  };
}
