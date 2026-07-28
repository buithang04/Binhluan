-- New enum values (usable after this migration commits)
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'UNREADY';
ALTER TYPE "ProfileStatus" ADD VALUE IF NOT EXISTS 'UNREADY';

-- Browser session index + alive flags
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "browserIndex" INTEGER;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "browserAlive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "browserWorkerId" TEXT;

-- Backfill browserIndex for existing rows
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) AS rn
  FROM "Profile"
  WHERE "browserIndex" IS NULL
)
UPDATE "Profile" p
SET "browserIndex" = numbered.rn
FROM numbered
WHERE p.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS "Profile_browserIndex_key" ON "Profile"("browserIndex");
CREATE INDEX IF NOT EXISTS "Profile_browserAlive_idx" ON "Profile"("browserAlive");

ALTER TABLE "Profile" ALTER COLUMN "browserIndex" SET NOT NULL;
