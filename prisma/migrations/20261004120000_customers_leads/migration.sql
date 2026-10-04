-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "lostReason" TEXT;

-- CreateIndex
CREATE INDEX "Customer_organizationId_lastSeenAt_idx" ON "Customer"("organizationId", "lastSeenAt" DESC);

-- CreateIndex
CREATE INDEX "Customer_mergedIntoId_idx" ON "Customer"("mergedIntoId");

