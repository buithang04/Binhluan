import type {
  Prisma,
  PrismaClient,
  ReviewVisibility,
  ProfilePlaceReviewSource,
} from "@prisma/client";

const BLOCKING: ReviewVisibility[] = ["UNKNOWN", "VISIBLE", "HIDDEN"];

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

export async function upsertProfilePlaceReviewTx(
  tx: Prisma.TransactionClient,
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

  await tx.profilePlaceReview.upsert({
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

export async function profileBlockedAtPlaceTx(
  tx: Prisma.TransactionClient,
  profileId: string,
  placeKey: string,
): Promise<boolean> {
  const hit = await tx.profilePlaceReview.findFirst({
    where: { profileId, placeKey, visibility: { in: BLOCKING } },
    select: { id: true },
  });
  return Boolean(hit);
}

export function extractPlaceKeyFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const hex = trimmed.match(/1s(0x[a-f0-9]+:0x[a-f0-9]+)/i)?.[1];
  if (hex) return hex.toLowerCase();
  const chij = trimmed.match(/19s(ChIJ[^!?&]+)/i)?.[1];
  if (chij) return chij;
  const chijBare = trimmed.match(/(ChIJ[\w-]{20,})/i)?.[1];
  if (chijBare) return chijBare;
  return null;
}

export function resolvePlaceKey(
  googleMapsUrl: string,
  stored?: string | null,
): string {
  if (stored?.trim()) return stored.trim();
  let h = 0;
  const n = googleMapsUrl.trim().toLowerCase();
  for (let i = 0; i < n.length; i++) h = (Math.imul(31, h) + n.charCodeAt(i)) | 0;
  return extractPlaceKeyFromUrl(googleMapsUrl) ?? `url:${Math.abs(h).toString(36)}`;
}

export async function loadAssignmentPlaceContext(
  prisma: Pick<PrismaClient, "reviewAssignment">,
  assignmentId: string,
): Promise<{
  assignment: {
    id: string;
    stars: number;
    reviewText: string;
    profileEmail: string | null;
    apmProfileId: string | null;
  };
  project: {
    id: string;
    brandName: string;
    googleMapsUrl: string;
    placeKey: string | null;
    resolvedUrl: string | null;
  };
  placeKey: string;
} | null> {
  const assignment = await prisma.reviewAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      stars: true,
      reviewText: true,
      profileEmail: true,
      apmProfileId: true,
      plan: {
        select: {
          project: {
            select: {
              id: true,
              brandName: true,
              googleMapsUrl: true,
              placeKey: true,
              resolvedUrl: true,
            },
          },
        },
      },
    },
  });
  if (!assignment?.plan?.project) return null;
  const project = assignment.plan.project;
  const placeKey = resolvePlaceKey(project.googleMapsUrl, project.placeKey);
  return { assignment, project, placeKey };
}
