-- AlterTable
ALTER TABLE `Package` ADD COLUMN `targetContents` INTEGER NOT NULL DEFAULT 100;

-- CreateTable
CREATE TABLE `ContentTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `type` ENUM('OUTREACH_EMAIL', 'CONSULT_MESSAGE', 'BRAND_COPY') NOT NULL DEFAULT 'OUTREACH_EMAIL',
    `bodySpin` TEXT NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ContentTemplate_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ContentCampaign` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NOT NULL,
    `targetCount` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'COMPLETED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ContentCampaign_projectId_idx`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeneratedContent` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `rawSpin` TEXT NOT NULL,
    `resolvedText` TEXT NOT NULL,
    `variantIndex` INTEGER NOT NULL,
    `status` ENUM('GENERATED', 'EXPORTED', 'ARCHIVED') NOT NULL DEFAULT 'GENERATED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GeneratedContent_campaignId_idx`(`campaignId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ContentCampaign` ADD CONSTRAINT `ContentCampaign_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ContentCampaign` ADD CONSTRAINT `ContentCampaign_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `ContentTemplate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GeneratedContent` ADD CONSTRAINT `GeneratedContent_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `ContentCampaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
