-- Decouple mail/profile from sticky proxy; job-time proxy lock + cooldown; project proxy cooldown
ALTER TABLE "Proxy" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);
ALTER TABLE "Proxy" ADD COLUMN IF NOT EXISTS "lockedByJobId" TEXT;
ALTER TABLE "Proxy" ADD COLUMN IF NOT EXISTS "cooldownUntil" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Proxy_lockedUntil_idx" ON "Proxy"("lockedUntil");
CREATE INDEX IF NOT EXISTS "Proxy_cooldownUntil_idx" ON "Proxy"("cooldownUntil");

ALTER TABLE "Profile" ALTER COLUMN "proxyId" DROP NOT NULL;

ALTER TABLE "JobRun" ADD COLUMN IF NOT EXISTS "proxyId" TEXT;
CREATE INDEX IF NOT EXISTS "JobRun_proxyId_idx" ON "JobRun"("proxyId");

DO $$ BEGIN
  ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_proxyId_fkey"
    FOREIGN KEY ("proxyId") REFERENCES "Proxy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "proxyCooldownMinutes" INTEGER NOT NULL DEFAULT 60;
