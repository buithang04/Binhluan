-- CreateEnum
CREATE TYPE "ProxyHealth" AS ENUM ('WORKING', 'FAILED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Proxy" ADD COLUMN "city" TEXT;
ALTER TABLE "Proxy" ADD COLUMN "health" "ProxyHealth" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "Proxy" ADD COLUMN "lastCheckedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Proxy_health_idx" ON "Proxy"("health");
