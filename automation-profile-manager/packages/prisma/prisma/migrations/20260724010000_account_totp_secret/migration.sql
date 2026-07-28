-- AlterTable
ALTER TABLE "GoogleAccount" ADD COLUMN IF NOT EXISTS "totpSecretEnc" BYTEA;
