-- AlterTable
ALTER TABLE `User` ADD COLUMN `failedLogins` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lockedUntil` VARCHAR(191) NULL,
    ADD COLUMN `resetExpires` VARCHAR(191) NULL,
    ADD COLUMN `resetTokenHash` VARCHAR(191) NULL,
    ADD COLUMN `tokenVersion` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `Audit` (
    `id` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `actorEmail` VARCHAR(191) NULL,
    `target` VARCHAR(191) NULL,
    `detail` TEXT NULL,
    `ip` VARCHAR(191) NULL,
    `at` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
