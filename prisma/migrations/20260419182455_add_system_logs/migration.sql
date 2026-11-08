-- CreateTable
CREATE TABLE "system_logs" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "component" TEXT,
    "userId" TEXT,
    "sessionId" TEXT,
    "requestId" TEXT,
    "metadata" JSONB,
    "errorName" TEXT,
    "errorMsg" TEXT,
    "errorStack" TEXT,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_logs_category_timestamp_idx" ON "system_logs"("category", "timestamp");

-- CreateIndex
CREATE INDEX "system_logs_level_timestamp_idx" ON "system_logs"("level", "timestamp");

-- CreateIndex
CREATE INDEX "system_logs_userId_timestamp_idx" ON "system_logs"("userId", "timestamp");
