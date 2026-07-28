-- Admin single-device: bump sessionVersion on each login invalidates prior sessions.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;
