-- DropForeignKey
ALTER TABLE "Profile" DROP CONSTRAINT "Profile_proxyId_fkey";

-- AlterTable
ALTER TABLE "Business" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BusinessProduct" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "GoogleAccount" ADD COLUMN     "googleAvatar" TEXT,
ADD COLUMN     "googleName" TEXT;

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_proxyId_fkey" FOREIGN KEY ("proxyId") REFERENCES "Proxy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
