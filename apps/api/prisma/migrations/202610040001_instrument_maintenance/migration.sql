-- CreateEnum
CREATE TYPE "InstrumentStatus" AS ENUM ('ACTIVE', 'MERGED', 'RETIRED', 'DELETING', 'DELETE_FAILED');

-- CreateEnum
CREATE TYPE "MaintenanceType" AS ENUM ('STRING_CHANGE', 'CLEANING', 'SETUP', 'REPAIR', 'INSPECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING_UPLOAD', 'READY', 'DELETING');

-- CreateEnum
CREATE TYPE "MaintenanceAlertType" AS ENUM ('STRING_AGE', 'ENVIRONMENT', 'REPAIR_OVERDUE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

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
    "string_changed_at" TIMESTAMPTZ(6),
    "string_max_age_days" INTEGER NOT NULL DEFAULT 90,
    "humidity_min_pct" DECIMAL(5,2),
    "humidity_max_pct" DECIMAL(5,2),
    "temperature_min_c" DECIMAL(5,2),
    "temperature_max_c" DECIMAL(5,2),
    "notes" TEXT,
    "status" "InstrumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "merged_into_id" UUID,
    "merged_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "type" "MaintenanceType" NOT NULL,
    "performed_at" TIMESTAMPTZ(6) NOT NULL,
    "string_brand" VARCHAR(120),
    "cost" DECIMAL(10,2),
    "vendor" VARCHAR(120),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environment_readings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "temperature_c" DECIMAL(5,2) NOT NULL,
    "humidity_pct" DECIMAL(5,2) NOT NULL,
    "source" VARCHAR(60),
    "note" TEXT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environment_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "status" "RepairStatus" NOT NULL DEFAULT 'OPEN',
    "due_date" DATE,
    "resolved_at" TIMESTAMPTZ(6),
    "cost" DECIMAL(10,2),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "repair_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_attachments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "maintenance_id" UUID,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "object_key" TEXT NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_alerts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "type" "MaintenanceAlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "message" VARCHAR(300) NOT NULL,
    "detail" JSONB,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instruments_user_id_status_idx" ON "instruments"("user_id", "status");

-- CreateIndex
CREATE INDEX "instruments_merged_into_id_idx" ON "instruments"("merged_into_id");

-- CreateIndex
CREATE INDEX "maintenance_records_instrument_id_performed_at_idx" ON "maintenance_records"("instrument_id", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "maintenance_records_user_id_type_idx" ON "maintenance_records"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "environment_readings_instrument_id_recorded_at_key" ON "environment_readings"("instrument_id", "recorded_at");

-- CreateIndex
CREATE INDEX "environment_readings_instrument_id_recorded_at_idx" ON "environment_readings"("instrument_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "repair_items_instrument_id_status_idx" ON "repair_items"("instrument_id", "status");

-- CreateIndex
CREATE INDEX "repair_items_user_id_status_due_date_idx" ON "repair_items"("user_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "maintenance_attachments_instrument_id_idx" ON "maintenance_attachments"("instrument_id");

-- CreateIndex
CREATE INDEX "maintenance_attachments_object_key_idx" ON "maintenance_attachments"("object_key");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_alerts_instrument_id_type_key" ON "maintenance_alerts"("instrument_id", "type");

-- CreateIndex
CREATE INDEX "maintenance_alerts_user_id_resolved_at_idx" ON "maintenance_alerts"("user_id", "resolved_at");

-- AddForeignKey
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "instruments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_readings" ADD CONSTRAINT "environment_readings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environment_readings" ADD CONSTRAINT "environment_readings_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_items" ADD CONSTRAINT "repair_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_items" ADD CONSTRAINT "repair_items_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_maintenance_id_fkey" FOREIGN KEY ("maintenance_id") REFERENCES "maintenance_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_alerts" ADD CONSTRAINT "maintenance_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_alerts" ADD CONSTRAINT "maintenance_alerts_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
