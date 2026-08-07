-- CreateEnum
CREATE TYPE "ProfileSyncStatus" AS ENUM ('PENDING', 'SYNCING', 'SYNCED', 'NEEDS_MANUAL', 'FAILED');

-- AlterTable
ALTER TABLE "GoogleAccount"
  ADD COLUMN "desiredName" TEXT,
  ADD COLUMN "desiredAddress" TEXT,
  ADD COLUMN "desiredAvatarUrl" TEXT,
  ADD COLUMN "avatarLocalPath" TEXT,
  ADD COLUMN "profileSyncStatus" "ProfileSyncStatus",
  ADD COLUMN "profileSyncError" TEXT,
  ADD COLUMN "profileSyncedAt" TIMESTAMP(3);

-- Task đồng bộ hồ sơ Google
INSERT INTO "TaskDefinition" ("code", "name", "timeoutMs", "maxRetries", "handlerKey", "createdAt")
VALUES ('ACCOUNT_PROFILE_UPDATE', 'Update Google account profile', 900000, 1, 'account.profileUpdate', NOW())
ON CONFLICT ("code") DO NOTHING;
