-- CreateEnum
CREATE TYPE "ReviewVisibility" AS ENUM ('UNKNOWN', 'VISIBLE', 'DELETED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "ProfilePlaceReviewSource" AS ENUM ('POSTED', 'DETECTED_ABORT', 'MANUAL', 'BACKFILL');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "placeKey" TEXT,
ADD COLUMN "resolvedUrl" TEXT,
ADD COLUMN "placeMeta" JSONB,
ADD COLUMN "placeResolvedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Project_placeKey_idx" ON "Project"("placeKey");

-- CreateTable
CREATE TABLE "ProfilePlaceReview" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "placeKey" TEXT NOT NULL,
    "placeName" TEXT,
    "placeAddress" TEXT,
    "placePhone" TEXT,
    "placeWebsite" TEXT,
    "googleMapsUrl" TEXT,
    "resolvedUrl" TEXT,
    "stars" INTEGER,
    "reviewText" TEXT,
    "reviewLink" TEXT,
    "assignmentId" TEXT,
    "projectId" TEXT,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "visibility" "ReviewVisibility" NOT NULL DEFAULT 'UNKNOWN',
    "source" "ProfilePlaceReviewSource" NOT NULL DEFAULT 'POSTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfilePlaceReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePlaceReview_profileId_placeKey_key" ON "ProfilePlaceReview"("profileId", "placeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePlaceReview_assignmentId_key" ON "ProfilePlaceReview"("assignmentId");

-- CreateIndex
CREATE INDEX "ProfilePlaceReview_placeKey_idx" ON "ProfilePlaceReview"("placeKey");

-- CreateIndex
CREATE INDEX "ProfilePlaceReview_accountEmail_placeKey_idx" ON "ProfilePlaceReview"("accountEmail", "placeKey");

-- CreateIndex
CREATE INDEX "ProfilePlaceReview_visibility_idx" ON "ProfilePlaceReview"("visibility");

-- AddForeignKey
ALTER TABLE "ProfilePlaceReview" ADD CONSTRAINT "ProfilePlaceReview_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill ledger from COMPLETED assignments (placeKey from URL when project.placeKey null)
INSERT INTO "ProfilePlaceReview" (
    "id", "profileId", "accountEmail", "placeKey", "placeName",
    "googleMapsUrl", "stars", "reviewText", "reviewLink",
    "assignmentId", "projectId", "postedAt", "visibility", "source", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    ra."apmProfileId",
    COALESCE(ra."profileEmail", ''),
    COALESCE(
        NULLIF(p."placeKey", ''),
        NULLIF(substring(p."googleMapsUrl" from '19s(ChIJ[^!?&]+)'), ''),
        NULLIF(lower(substring(p."googleMapsUrl" from '1s(0x[a-f0-9]+:0x[a-f0-9]+)')), ''),
        md5(lower(trim(p."googleMapsUrl")))
    ),
    p."brandName",
    p."googleMapsUrl",
    ra."stars",
    ra."reviewText",
    ra."reviewLink",
    ra."id",
    p."id",
    COALESCE(ra."updatedAt", ra."createdAt"),
    CASE WHEN ra."reviewLink" IS NOT NULL AND ra."reviewLink" <> '' THEN 'UNKNOWN'::"ReviewVisibility" ELSE 'VISIBLE'::"ReviewVisibility" END,
    'BACKFILL'::"ProfilePlaceReviewSource",
    NOW()
FROM "ReviewAssignment" ra
JOIN "ReviewPlan" rp ON rp."id" = ra."planId"
JOIN "Project" p ON p."id" = rp."projectId"
WHERE ra."status" = 'COMPLETED'
  AND ra."apmProfileId" IS NOT NULL
  AND COALESCE(
        NULLIF(p."placeKey", ''),
        NULLIF(substring(p."googleMapsUrl" from '19s(ChIJ[^!?&]+)'), ''),
        NULLIF(lower(substring(p."googleMapsUrl" from '1s(0x[a-f0-9]+:0x[a-f0-9]+)')), ''),
        md5(lower(trim(p."googleMapsUrl")))
      ) IS NOT NULL
ON CONFLICT ("profileId", "placeKey") DO NOTHING;
