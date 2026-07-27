-- CreateTable
CREATE TABLE `SalesRep` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `SalesRep_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ClientGroup` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `contact` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `salesRepId` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Company` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `cr` VARCHAR(191) NOT NULL,
    `industry` VARCHAR(191) NULL,
    `employees` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `overdue` INTEGER NOT NULL DEFAULT 0,
    `expiring` INTEGER NOT NULL DEFAULT 0,
    `contact` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `city` VARCHAR(191) NULL,
    `customData` JSON NULL,
    `groupId` VARCHAR(191) NULL,
    `salesRepId` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Package` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `tier` VARCHAR(191) NOT NULL,
    `basePrice` INTEGER NOT NULL,
    `billingCycle` VARCHAR(191) NOT NULL DEFAULT 'monthly',
    `empMin` INTEGER NOT NULL,
    `empMax` INTEGER NOT NULL,
    `features` JSON NOT NULL,
    `color` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Subscription` (
    `id` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `refId` VARCHAR(191) NOT NULL,
    `packageId` VARCHAR(191) NOT NULL,
    `price` INTEGER NOT NULL,
    `startDate` VARCHAR(191) NULL,
    `endDate` VARCHAR(191) NULL,
    `daysLeft` INTEGER NOT NULL DEFAULT 0,
    `autoRenew` BOOLEAN NOT NULL DEFAULT true,
    `custom` BOOLEAN NOT NULL DEFAULT false,
    `companyId` VARCHAR(191) NULL,
    `lastBilledFor` VARCHAR(191) NULL,
    `lastRenewedAt` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Employee` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NULL,
    `iqamaExpiry` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'valid',
    `customData` JSON NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `history` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomField` (
    `id` VARCHAR(191) NOT NULL,
    `entity` VARCHAR(191) NOT NULL DEFAULT 'employee',
    `label` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'text',
    `options` JSON NULL,
    `required` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Document` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `person` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NULL,
    `docType` VARCHAR(191) NOT NULL,
    `expiryDate` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'valid',
    `daysLeft` INTEGER NOT NULL DEFAULT 0,
    `customData` JSON NULL,
    `renewalRunId` VARCHAR(191) NULL,
    `renewalTaskId` VARCHAR(191) NULL,
    `docNumber` VARCHAR(191) NULL,
    `issueDate` VARCHAR(191) NULL,
    `issuingAuthority` VARCHAR(191) NULL,
    `history` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DocumentType` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `fields` JSON NULL,
    `prereqs` JSON NULL,
    `leadDays` INTEGER NULL,
    `defaultFee` INTEGER NULL,
    `requiresApproval` BOOLEAN NOT NULL DEFAULT false,
    `defaultAssigneeRole` VARCHAR(191) NULL,
    `subjectKind` VARCHAR(191) NOT NULL DEFAULT 'employee',

    UNIQUE INDEX `DocumentType_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomObject` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `icon` VARCHAR(191) NULL,
    `fields` JSON NULL,
    `kind` VARCHAR(191) NOT NULL DEFAULT 'object',
    `appliesTo` VARCHAR(191) NOT NULL DEFAULT '',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomRecord` (
    `id` VARCHAR(191) NOT NULL,
    `objectId` VARCHAR(191) NOT NULL,
    `data` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PrintLayout` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `target` VARCHAR(191) NOT NULL DEFAULT 'invoice',
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `blocks` JSON NULL,
    `settings` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Task` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NULL,
    `clientName` VARCHAR(191) NULL,
    `assignee` VARCHAR(191) NULL,
    `priority` VARCHAR(191) NOT NULL DEFAULT 'medium',
    `dueDate` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'todo',
    `docType` VARCHAR(191) NULL,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `workflowInstanceId` VARCHAR(191) NULL,
    `complianceDocId` VARCHAR(191) NULL,
    `employeeId` VARCHAR(191) NULL,
    `customData` JSON NULL,
    `blockedBy` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Invoice` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NULL,
    `clientName` VARCHAR(191) NULL,
    `amount` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'SAR',
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `date` VARCHAR(191) NULL,
    `dueDate` VARCHAR(191) NULL,
    `services` TEXT NULL,
    `items` JSON NULL,
    `notes` TEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NULL,
    `roleId` VARCHAR(191) NOT NULL DEFAULT 'admin',
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `lastActive` VARCHAR(191) NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'staff',
    `companyId` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `assignedClientIds` JSON NULL,
    `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    `tokenVersion` INTEGER NOT NULL DEFAULT 0,
    `failedLogins` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` VARCHAR(191) NULL,
    `resetTokenHash` VARCHAR(191) NULL,
    `resetExpires` VARCHAR(191) NULL,

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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

-- CreateTable
CREATE TABLE `UpgradeRequest` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `clientName` VARCHAR(191) NOT NULL,
    `fromPackageId` VARCHAR(191) NULL,
    `toPackageId` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `date` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SiteCredential` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `url` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NULL,
    `password` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Activity` (
    `id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `message` TEXT NULL,
    `user` VARCHAR(191) NULL,
    `time` VARCHAR(191) NULL,
    `date` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ServiceRequest` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NULL,
    `clientName` VARCHAR(191) NULL,
    `type` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `date` VARCHAR(191) NULL,
    `lastClientMsgAt` VARCHAR(191) NULL,
    `lastStaffMsgAt` VARCHAR(191) NULL,
    `staffReadAt` VARCHAR(191) NULL,
    `clientReadAt` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ServiceRequestMessage` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `authorType` VARCHAR(191) NOT NULL DEFAULT 'staff',
    `authorName` VARCHAR(191) NULL,
    `body` TEXT NOT NULL,
    `internal` BOOLEAN NOT NULL DEFAULT false,
    `at` VARCHAR(191) NULL,

    INDEX `ServiceRequestMessage_requestId_idx`(`requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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

-- CreateTable
CREATE TABLE `Notification` (
    `id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `message` TEXT NULL,
    `time` VARCHAR(191) NULL,
    `read` BOOLEAN NOT NULL DEFAULT false,
    `dedupeKey` VARCHAR(191) NULL,

    UNIQUE INDEX `Notification_dedupeKey_key`(`dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkflowTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `trigger` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `triggerConfig` JSON NULL,
    `entityType` VARCHAR(191) NOT NULL DEFAULT 'generic',
    `graph` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `active` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkflowInstance` (
    `id` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NULL,
    `clientName` VARCHAR(191) NULL,
    `variables` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'running',
    `startedAt` VARCHAR(191) NULL,
    `completedAt` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkflowTask` (
    `id` VARCHAR(191) NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `nodeType` VARCHAR(191) NOT NULL DEFAULT 'task',
    `title` VARCHAR(191) NOT NULL,
    `assignee` VARCHAR(191) NULL,
    `assigneeRole` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `priority` VARCHAR(191) NOT NULL DEFAULT 'medium',
    `dueDate` VARCHAR(191) NULL,
    `slaHours` INTEGER NULL,
    `checklist` JSON NULL,
    `checklistState` JSON NULL,
    `requireVerification` BOOLEAN NOT NULL DEFAULT false,
    `captures` JSON NULL,
    `outcome` VARCHAR(191) NULL,
    `completedBy` VARCHAR(191) NULL,
    `completedAt` VARCHAR(191) NULL,
    `createdAt` VARCHAR(191) NULL,
    `slaState` VARCHAR(191) NULL,
    `escalatedAt` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChecklistRule` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `rows` JSON NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkflowLog` (
    `id` VARCHAR(191) NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `nodeId` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `detail` TEXT NULL,
    `actor` VARCHAR(191) NULL,
    `at` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AppSetting` (
    `key` VARCHAR(191) NOT NULL,
    `value` JSON NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GovCenter` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `sub` VARCHAR(191) NULL,
    `color` VARCHAR(191) NULL,
    `bg` VARCHAR(191) NULL,
    `officer` VARCHAR(191) NULL,
    `pending` INTEGER NOT NULL DEFAULT 0,
    `submitted` INTEGER NOT NULL DEFAULT 0,
    `approved` INTEGER NOT NULL DEFAULT 0,
    `rejected` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Appointment` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NULL,
    `companyId` VARCHAR(191) NULL,
    `clientName` VARCHAR(191) NULL,
    `employee` VARCHAR(191) NULL,
    `location` VARCHAR(191) NULL,
    `date` VARCHAR(191) NULL,
    `time` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'scheduled',
    `notes` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CourierShipment` (
    `id` VARCHAR(191) NOT NULL,
    `ref` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `companyId` VARCHAR(191) NULL,
    `clientName` VARCHAR(191) NULL,
    `carrier` VARCHAR(191) NULL,
    `direction` VARCHAR(191) NOT NULL DEFAULT 'outbound',
    `status` VARCHAR(191) NOT NULL DEFAULT 'in_transit',
    `eta` VARCHAR(191) NULL,
    `at` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Payment` (
    `id` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NULL,
    `invoiceNumber` VARCHAR(191) NULL,
    `companyId` VARCHAR(191) NULL,
    `clientName` VARCHAR(191) NULL,
    `amount` INTEGER NOT NULL,
    `method` VARCHAR(191) NULL,
    `reference` VARCHAR(191) NULL,
    `date` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Quotation` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NULL,
    `clientName` VARCHAR(191) NULL,
    `service` VARCHAR(191) NULL,
    `amount` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
    `date` VARCHAR(191) NULL,
    `validUntil` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ServiceItem` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `govFee` INTEGER NOT NULL DEFAULT 0,
    `serviceFee` INTEGER NOT NULL DEFAULT 0,
    `time` VARCHAR(191) NULL,
    `sla` VARCHAR(191) NULL,
    `docs` INTEGER NOT NULL DEFAULT 0,
    `included` BOOLEAN NOT NULL DEFAULT true,
    `docType` VARCHAR(191) NULL,
    `workflowId` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ApiKey` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `prefix` VARCHAR(191) NOT NULL,
    `keyHash` VARCHAR(191) NOT NULL,
    `createdAt` VARCHAR(191) NOT NULL,
    `lastUsedAt` VARCHAR(191) NULL,
    `revoked` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FileAsset` (
    `id` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `size` INTEGER NOT NULL DEFAULT 0,
    `uploadedBy` VARCHAR(191) NULL,
    `at` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ClientGroup` ADD CONSTRAINT `ClientGroup_salesRepId_fkey` FOREIGN KEY (`salesRepId`) REFERENCES `SalesRep`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Company` ADD CONSTRAINT `Company_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `ClientGroup`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Company` ADD CONSTRAINT `Company_salesRepId_fkey` FOREIGN KEY (`salesRepId`) REFERENCES `SalesRep`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_packageId_fkey` FOREIGN KEY (`packageId`) REFERENCES `Package`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Employee` ADD CONSTRAINT `Employee_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Document` ADD CONSTRAINT `Document_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Task` ADD CONSTRAINT `Task_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Invoice` ADD CONSTRAINT `Invoice_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UpgradeRequest` ADD CONSTRAINT `UpgradeRequest_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SiteCredential` ADD CONSTRAINT `SiteCredential_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowInstance` ADD CONSTRAINT `WorkflowInstance_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `WorkflowTemplate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowTask` ADD CONSTRAINT `WorkflowTask_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `WorkflowInstance`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkflowLog` ADD CONSTRAINT `WorkflowLog_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `WorkflowInstance`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

