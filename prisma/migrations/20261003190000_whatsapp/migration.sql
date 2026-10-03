-- AlterEnum
ALTER TYPE "UsageKind" ADD VALUE 'TRANSCRIPTION';

-- DropIndex
DROP INDEX "InboundWebhookEvent_status_createdAt_idx";

-- DropIndex

-- AlterTable
ALTER TABLE "InboundWebhookEvent" ADD COLUMN     "eventType" TEXT NOT NULL DEFAULT 'message',
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "payload" JSONB;

-- AlterTable
ALTER TABLE "WhatsAppAccount" ADD COLUMN     "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "qualityRating" TEXT,
ADD COLUMN     "verifiedName" TEXT;

-- CreateTable
CREATE TABLE "WhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "components" JSONB NOT NULL DEFAULT '[]',
    "metaTemplateId" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_organizationId_name_language_key" ON "WhatsAppTemplate"("organizationId", "name", "language");

-- CreateIndex
CREATE INDEX "InboundWebhookEvent_status_nextAttemptAt_idx" ON "InboundWebhookEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "InboundWebhookEvent_organizationId_createdAt_idx" ON "InboundWebhookEvent"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "WhatsAppTemplate" ADD CONSTRAINT "WhatsAppTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

