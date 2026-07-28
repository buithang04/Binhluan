-- AlterTable
ALTER TABLE "ReviewAssignment" ADD COLUMN IF NOT EXISTS "scheduledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ReviewAssignment_status_scheduledAt_idx" ON "ReviewAssignment"("status", "scheduledAt");
