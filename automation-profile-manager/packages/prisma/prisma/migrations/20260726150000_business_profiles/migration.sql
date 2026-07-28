-- Business profiles for USER app (Active = default for project create)
CREATE TABLE IF NOT EXISTS "Business" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "website" TEXT,
    "brandDescription" TEXT NOT NULL DEFAULT '',
    "targetAudience" TEXT NOT NULL DEFAULT '',
    "targetMarket" TEXT NOT NULL DEFAULT '',
    "writingNotes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BusinessProduct" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessProduct_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Business_userId_idx" ON "Business"("userId");
CREATE INDEX IF NOT EXISTS "Business_userId_isActive_idx" ON "Business"("userId", "isActive");
CREATE INDEX IF NOT EXISTS "BusinessProduct_businessId_idx" ON "BusinessProduct"("businessId");

CREATE UNIQUE INDEX IF NOT EXISTS "BusinessProduct_businessId_name_key" ON "BusinessProduct"("businessId", "name");

ALTER TABLE "Business" DROP CONSTRAINT IF EXISTS "Business_userId_fkey";
ALTER TABLE "Business" ADD CONSTRAINT "Business_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessProduct" DROP CONSTRAINT IF EXISTS "BusinessProduct_businessId_fkey";
ALTER TABLE "BusinessProduct" ADD CONSTRAINT "BusinessProduct_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
