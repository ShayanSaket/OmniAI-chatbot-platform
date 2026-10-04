
-- CreateTable
CREATE TABLE "InsightReport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "content" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InsightReport_organizationId_createdAt_idx" ON "InsightReport"("organizationId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "InsightReport" ADD CONSTRAINT "InsightReport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsightReport" ADD CONSTRAINT "InsightReport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

