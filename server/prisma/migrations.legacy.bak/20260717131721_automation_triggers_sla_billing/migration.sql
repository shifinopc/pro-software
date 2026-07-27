-- AlterTable
ALTER TABLE `Document` ADD COLUMN `renewalRunId` VARCHAR(191) NULL,
    ADD COLUMN `renewalTaskId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Notification` ADD COLUMN `dedupeKey` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Subscription` ADD COLUMN `lastBilledFor` VARCHAR(191) NULL,
    ADD COLUMN `lastRenewedAt` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `WorkflowTask` ADD COLUMN `escalatedAt` VARCHAR(191) NULL,
    ADD COLUMN `slaState` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Notification_dedupeKey_key` ON `Notification`(`dedupeKey`);

