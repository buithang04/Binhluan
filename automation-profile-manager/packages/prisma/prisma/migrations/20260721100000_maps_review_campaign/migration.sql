-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN IF NOT EXISTS "payload" JSONB;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "reviewsToPost" INTEGER;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReviewPlanStatus" AS ENUM ('DRAFT', 'READY', 'RUNNING', 'DONE', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ReviewAssignmentStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ReviewPlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "ReviewPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ReviewAssignment" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "stars" INTEGER NOT NULL,
    "reviewText" TEXT NOT NULL,
    "mediaAssetId" TEXT,
    "apmProfileId" TEXT,
    "apmJobRunId" TEXT,
    "profileEmail" TEXT,
    "status" "ReviewAssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "reviewLink" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ReviewPlan_projectId_idx" ON "ReviewPlan"("projectId");
CREATE INDEX IF NOT EXISTS "ReviewPlan_status_idx" ON "ReviewPlan"("status");
CREATE INDEX IF NOT EXISTS "ReviewAssignment_planId_idx" ON "ReviewAssignment"("planId");
CREATE INDEX IF NOT EXISTS "ReviewAssignment_status_idx" ON "ReviewAssignment"("status");
CREATE INDEX IF NOT EXISTS "ReviewAssignment_apmJobRunId_idx" ON "ReviewAssignment"("apmJobRunId");

DO $$ BEGIN
  ALTER TABLE "ReviewPlan" ADD CONSTRAINT "ReviewPlan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ReviewPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "ReviewAssignment" ADD CONSTRAINT "ReviewAssignment_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
