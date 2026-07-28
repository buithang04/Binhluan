-- Unify Role ADMIN|USER + CRM tables on shared Postgres

-- 1) Role enum: OPERATOR→ADMIN, VIEWER→USER
ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User"
  ALTER COLUMN "role" TYPE "Role"
  USING (
    CASE
      WHEN "role"::text IN ('ADMIN', 'OPERATOR') THEN 'ADMIN'::"Role"
      ELSE 'USER'::"Role"
    END
  );
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER'::"Role";
DROP TYPE "Role_old";

-- 2) User.name for CRM display
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "name" TEXT;

-- 3) CRM enums + tables
DO $$ BEGIN
  CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ContentType" AS ENUM ('OUTREACH_EMAIL', 'CONSULT_MESSAGE', 'BRAND_COPY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "ContentTone" AS ENUM ('FORMAL', 'FRIENDLY', 'CASUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "GeneratedStatus" AS ENUM ('GENERATED', 'EXPORTED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Package" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "maxProducts" INTEGER NOT NULL DEFAULT 20,
  "maxMedia" INTEGER NOT NULL DEFAULT 50,
  "targetContents" INTEGER NOT NULL DEFAULT 100,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Package_code_key" ON "Package"("code");

CREATE TABLE IF NOT EXISTS "ContentTemplate" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "ContentType" NOT NULL DEFAULT 'OUTREACH_EMAIL',
  "tone" "ContentTone" NOT NULL DEFAULT 'FRIENDLY',
  "bodySpin" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ContentTemplate_code_key" ON "ContentTemplate"("code");

CREATE TABLE IF NOT EXISTS "Project" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "brandName" TEXT NOT NULL,
  "website" TEXT,
  "brandDescription" TEXT NOT NULL,
  "targetAudience" TEXT NOT NULL,
  "targetMarket" TEXT NOT NULL,
  "writingNotes" TEXT,
  "googleMapsUrl" TEXT NOT NULL,
  "desiredRating" DECIMAL(2,1),
  "currentRating" DECIMAL(2,1),
  "reviewCount" INTEGER,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Project_userId_googleMapsUrl_key" ON "Project"("userId", "googleMapsUrl");
CREATE INDEX IF NOT EXISTS "Project_userId_idx" ON "Project"("userId");
CREATE INDEX IF NOT EXISTS "Project_status_idx" ON "Project"("status");

CREATE TABLE IF NOT EXISTS "Product" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Product_projectId_name_key" ON "Product"("projectId", "name");
CREATE INDEX IF NOT EXISTS "Product_projectId_idx" ON "Product"("projectId");

CREATE TABLE IF NOT EXISTS "MediaAsset" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "filePath" TEXT NOT NULL,
  "caption" TEXT,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MediaAsset_projectId_idx" ON "MediaAsset"("projectId");

CREATE TABLE IF NOT EXISTS "ContentCampaign" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "targetCount" INTEGER NOT NULL,
  "status" "CampaignStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ContentCampaign_projectId_idx" ON "ContentCampaign"("projectId");

CREATE TABLE IF NOT EXISTS "GeneratedContent" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "rawSpin" TEXT NOT NULL,
  "resolvedText" TEXT NOT NULL,
  "variantIndex" INTEGER NOT NULL,
  "status" "GeneratedStatus" NOT NULL DEFAULT 'GENERATED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GeneratedContent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "GeneratedContent_campaignId_idx" ON "GeneratedContent"("campaignId");

-- FKs (ignore if already exist)
DO $$ BEGIN
  ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Project" ADD CONSTRAINT "Project_packageId_fkey"
    FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Product" ADD CONSTRAINT "Product_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ContentCampaign" ADD CONSTRAINT "ContentCampaign_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ContentCampaign" ADD CONSTRAINT "ContentCampaign_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "ContentTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "GeneratedContent" ADD CONSTRAINT "GeneratedContent_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "ContentCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
