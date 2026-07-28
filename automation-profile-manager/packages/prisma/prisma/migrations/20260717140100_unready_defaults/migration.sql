-- Apply UNREADY defaults after enum value exists (separate txn from ADD VALUE)
ALTER TABLE "GoogleAccount" ALTER COLUMN "status" SET DEFAULT 'UNREADY';
ALTER TABLE "Profile" ALTER COLUMN "status" SET DEFAULT 'UNREADY';
