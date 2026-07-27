-- CreateTable
CREATE TABLE `KanbanCard` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NULL,
    `clientName` VARCHAR(191) NULL,
    `assignee` VARCHAR(191) NULL,
    `priority` VARCHAR(191) NOT NULL DEFAULT 'medium',
    `dueDate` VARCHAR(191) NULL,
    `column` VARCHAR(191) NOT NULL DEFAULT 'backlog',
    `docType` VARCHAR(191) NULL,
    `checklist` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
