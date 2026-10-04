-- CreateEnum
CREATE TYPE "InstrumentStatus" AS ENUM ('ACTIVE', 'RETIRED', 'MERGED');

-- CreateEnum
CREATE TYPE "MaintenanceTaskType" AS ENUM ('STRING_CHANGE', 'SETUP', 'REPAIR', 'CLEANING', 'INSPECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "MaintenanceTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MaintenanceAlertType" AS ENUM ('STRING_AGE', 'ENVIRONMENT', 'TASK_DUE');

-- CreateEnum
CREATE TYPE "MaintenanceAlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MaintenanceAlertStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING_UPLOAD', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "instruments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "brand" VARCHAR(80),
    "model" VARCHAR(80),
    "serial_no" VARCHAR(80),
    "acquired_at" DATE,
    "status" "InstrumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "merged_into_id" UUID,
    "string_set" VARCHAR(120),
    "string_lifespan_days" INTEGER NOT NULL DEFAULT 90,
    "humidity_min" DECIMAL(5,2) NOT NULL DEFAULT 40,
    "humidity_max" DECIMAL(5,2) NOT NULL DEFAULT 60,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "string_changes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "string_set" VARCHAR(120) NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "string_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environment_readings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "temperature_c" DECIMAL(5,2),
    "humidity_pct" DECIMAL(5,2),
    "location" VARCHAR(120),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environment_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_tasks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "type" "MaintenanceTaskType" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "status" "MaintenanceTaskStatus" NOT NULL DEFAULT 'OPEN',
    "due_date" DATE,
    "completed_at" TIMESTAMPTZ(6),
    "cost" DECIMAL(12,2),
    "shop" VARCHAR(120),
    "dedupe_key" VARCHAR(80),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_attachments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "object_key" TEXT NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_alerts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "type" "MaintenanceAlertType" NOT NULL,
    "dedupe_key" VARCHAR(120) NOT NULL,
    "severity" "MaintenanceAlertSeverity" NOT NULL,
    "message" VARCHAR(300) NOT NULL,
    "status" "MaintenanceAlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instruments_user_id_status_idx" ON "instruments"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "string_changes_instrument_id_changed_at_string_set_key" ON "string_changes"("instrument_id", "changed_at", "string_set");

-- CreateIndex
CREATE INDEX "string_changes_instrument_id_changed_at_idx" ON "string_changes"("instrument_id", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "string_changes_user_id_idx" ON "string_changes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "environment_readings_instrument_id_recorded_at_key" ON "environment_readings"("instrument_id", "recorded_at");

-- CreateIndex
CREATE INDEX "environment_readings_instrument_id_recorded_at_idx" ON "environment_readings"("instrument_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "environment_readings_user_id_idx" ON "environment_readings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_tasks_instrument_id_dedupe_key_key" ON "maintenance_tasks"("instrument_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "maintenance_tasks_user_id_status_due_date_idx" ON "maintenance_tasks"("user_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "maintenance_tasks_instrument_id_status_idx" ON "maintenance_tasks"("instrument_id", "status");

-- CreateIndex
CREATE INDEX "maintenance_attachments_task_id_idx" ON "maintenance_attachments"("task_id");

-- CreateIndex
CREATE INDEX "maintenance_attachments_user_id_idx" ON "maintenance_attachments"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_alerts_user_id_dedupe_key_key" ON "maintenance_alerts"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "maintenance_alerts_user_id_status_idx" ON "maintenance_alerts"("user_id", "status");

-- AddForeignKey
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "instruments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "string_changes" ADD CONSTRAINT "string_changes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "string_changes" ADD CONSTRAINT "string_changes_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_readings" ADD CONSTRAINT "environment_readings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_readings" ADD CONSTRAINT "environment_readings_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tasks" ADD CONSTRAINT "maintenance_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_tasks" ADD CONSTRAINT "maintenance_tasks_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "maintenance_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_alerts" ADD CONSTRAINT "maintenance_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_alerts" ADD CONSTRAINT "maintenance_alerts_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
