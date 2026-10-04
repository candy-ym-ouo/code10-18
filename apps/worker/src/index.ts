import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { Prisma } from "@prisma/client";
import { buildMaintenanceAlerts } from "@practice/contracts";
import { getConfig } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { deleteObject, getObjectStream, putObject } from "./lib/s3.js";
import { generatePeaks, probeAudio } from "./lib/media.js";
import { buildUserExport } from "./lib/export.js";

const config = getConfig();
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const log = (level: "info" | "error" | "warn", data: Record<string, unknown>, message: string) => {
  const output = JSON.stringify({ timestamp: new Date().toISOString(), level, service: "worker", ...data, message });
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
};

async function processMedia(mediaId: string) {
  const media = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!media) return;
  await prisma.mediaAsset.update({
    where: { id: mediaId },
    data: { status: "PROCESSING", failureCode: null, failureMessage: null },
  });

  const workDir = await mkdtemp(path.join(tmpdir(), "practice-media-"));
  const extension = path.extname(media.originalName).slice(0, 12);
  const localPath = path.join(workDir, `audio${extension}`);
  try {
    const stream = await getObjectStream(media.objectKey);
    await pipeline(stream, createWriteStream(localPath));
    const [probe, peaks] = await Promise.all([probeAudio(localPath), generatePeaks(localPath)]);
    await prisma.$transaction(async (tx) => {
      await tx.mediaAsset.update({
        where: { id: mediaId },
        data: {
          status: "READY",
          durationMs: probe.durationMs,
          codec: probe.codec,
          sampleRate: probe.sampleRate,
          channels: probe.channels,
          peaks,
          processedAt: new Date(),
          expiresAt: null,
          failureCode: null,
          failureMessage: null,
        },
      });
      await tx.practiceSession.updateMany({
        where: { id: media.sessionId, userId: media.userId, status: "DRAFT" },
        data: { status: "IN_REVIEW", version: { increment: 1 } },
      });
    });
    log("info", { mediaId, durationMs: Number(probe.durationMs) }, "media probe completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_MEDIA_ERROR";
    const code = message === "NO_AUDIO_STREAM" ? "NO_AUDIO_STREAM" : message === "INVALID_DURATION" ? "INVALID_DURATION" : "MEDIA_PROBE_FAILED";
    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: {
        status: "FAILED",
        failureCode: code,
        failureMessage: message === "NO_AUDIO_STREAM" ? "文件中没有可用的音轨" : "音频无法解析，请替换文件后重试",
        processedAt: new Date(),
      },
    });
    log("error", { mediaId, err: message }, "media probe failed");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function cleanupSession(sessionId: string) {
  const session = await prisma.practiceSession.findUnique({
    where: { id: sessionId },
    include: { mediaAssets: { select: { objectKey: true } } },
  });
  if (!session) return;
  try {
    const keys = new Set(session.mediaAssets.map((media) => media.objectKey));
    for (const objectKey of keys) {
      const references = await prisma.mediaAsset.count({ where: { objectKey, sessionId: { not: sessionId } } });
      if (references === 0) await deleteObject(objectKey);
    }
    await prisma.practiceSession.delete({ where: { id: sessionId } });
    log("info", { sessionId }, "session cleanup completed");
  } catch (error) {
    await prisma.practiceSession.updateMany({ where: { id: sessionId }, data: { status: "DELETE_FAILED" } });
    throw error;
  }
}

async function exportData(exportId: string) {
  const task = await prisma.dataExport.findUnique({ where: { id: exportId } });
  if (!task || !task.objectKey) return;
  await prisma.dataExport.update({ where: { id: exportId }, data: { status: "PROCESSING" } });
  try {
    const output = await buildUserExport(task.userId, task.format);
    await putObject(task.objectKey, output.body, output.contentType);
    await prisma.dataExport.update({ where: { id: exportId }, data: { status: "READY", failure: null } });
  } catch (error) {
    await prisma.dataExport.update({
      where: { id: exportId },
      data: { status: "FAILED", failure: error instanceof Error ? error.message.slice(0, 500) : "EXPORT_FAILED" },
    });
    throw error;
  }
}

async function scanOverdueGoals() {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const result = await prisma.goal.updateMany({
    where: {
      dueDate: { lt: startOfToday },
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
    data: { status: "MISSED" },
  });
  if (result.count > 0) log("info", { count: result.count }, "overdue goals marked missed");
}

/**
 * 设备删除清理：先把附件对象从对象存储移除，再删除数据库行。
 * 对象删除与行删除都可重复执行，任务重跑时已清理的部分会被安全跳过。
 */
async function cleanupInstrument(instrumentId: string) {
  const instrument = await prisma.instrument.findUnique({
    where: { id: instrumentId },
    include: { attachments: { select: { objectKey: true } } },
  });
  if (!instrument) return;
  try {
    const keys = new Set(instrument.attachments.map((attachment) => attachment.objectKey));
    for (const objectKey of keys) {
      await deleteObject(objectKey);
    }
    await prisma.instrument.delete({ where: { id: instrumentId } });
    log("info", { instrumentId, objects: keys.size }, "instrument cleanup completed");
  } catch (error) {
    await prisma.instrument.updateMany({ where: { id: instrumentId }, data: { status: "DELETE_FAILED" } });
    throw error;
  }
}

/**
 * 保养预警扫描：对每台在用设备重算预警并 upsert 到 maintenance_alerts，
 * 已解除的预警标记 resolvedAt。同一设备同一类型只有一行，重复扫描结果一致。
 */
async function scanMaintenanceAlerts() {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const instruments = await prisma.instrument.findMany({
    where: { status: "ACTIVE" },
    include: {
      environments: { orderBy: { recordedAt: "desc" }, take: 1 },
      repairs: { where: { status: { in: ["OPEN", "IN_PROGRESS"] }, dueDate: { lt: startOfToday } } },
    },
  });
  let active = 0;
  for (const instrument of instruments) {
    const latest = instrument.environments[0] ?? null;
    const oldestOverdueDays = instrument.repairs.length
      ? Math.max(
          ...instrument.repairs.map((repair) =>
            repair.dueDate ? Math.floor((startOfToday.getTime() - repair.dueDate.getTime()) / 86_400_000) : 0,
          ),
        )
      : null;
    const alerts = buildMaintenanceAlerts({
      now,
      stringChangedAt: instrument.stringChangedAt,
      stringMaxAgeDays: instrument.stringMaxAgeDays,
      latestEnvironment: latest
        ? { temperatureC: Number(latest.temperatureC), humidityPct: Number(latest.humidityPct), recordedAt: latest.recordedAt }
        : null,
      environmentRange: {
        humidityMinPct: instrument.humidityMinPct == null ? null : Number(instrument.humidityMinPct),
        humidityMaxPct: instrument.humidityMaxPct == null ? null : Number(instrument.humidityMaxPct),
        temperatureMinC: instrument.temperatureMinC == null ? null : Number(instrument.temperatureMinC),
        temperatureMaxC: instrument.temperatureMaxC == null ? null : Number(instrument.temperatureMaxC),
      },
      overdueRepairCount: instrument.repairs.length,
      oldestOverdueRepairDays: oldestOverdueDays,
    });
    const activeTypes = alerts.map((alert) => alert.type);
    await prisma.maintenanceAlert.updateMany({
      where: { instrumentId: instrument.id, resolvedAt: null, ...(activeTypes.length ? { type: { notIn: activeTypes } } : {}) },
      data: { resolvedAt: now },
    });
    for (const alert of alerts) {
      await prisma.maintenanceAlert.upsert({
        where: { instrumentId_type: { instrumentId: instrument.id, type: alert.type } },
        create: {
          userId: instrument.userId,
          instrumentId: instrument.id,
          type: alert.type,
          severity: alert.severity,
          message: alert.message.slice(0, 300),
          detail: alert.detail as Prisma.InputJsonValue,
          detectedAt: now,
        },
        update: {
          severity: alert.severity,
          message: alert.message.slice(0, 300),
          detail: alert.detail as Prisma.InputJsonValue,
          resolvedAt: null,
        },
      });
    }
    active += alerts.length;
  }
  // 非在用设备的未解除预警统一关闭
  await prisma.maintenanceAlert.updateMany({
    where: { resolvedAt: null, instrument: { status: { not: "ACTIVE" } } },
    data: { resolvedAt: now },
  });
  log("info", { instruments: instruments.length, alerts: active }, "maintenance alert scan completed");
}

const worker = new Worker(
  "media-processing",
  async (job) => {
    if (job.name === "probe-media") return processMedia(String(job.data.mediaId));
    if (job.name === "cleanup-session") return cleanupSession(String(job.data.sessionId));
    if (job.name === "cleanup-instrument") return cleanupInstrument(String(job.data.instrumentId));
    if (job.name === "export-data") return exportData(String(job.data.exportId));
    throw new Error(`Unknown job: ${job.name}`);
  },
  { connection: redis, concurrency: config.WORKER_CONCURRENCY },
);

worker.on("failed", (job, error) => log("error", { jobId: job?.id, jobName: job?.name, err: error.message }, "job failed"));
worker.on("error", (error) => log("error", { err: error.message }, "worker error"));

const heartbeat = setInterval(async () => {
  await redis.set("worker:heartbeat", new Date().toISOString(), "EX", 30);
}, 10_000);
await redis.set("worker:heartbeat", new Date().toISOString(), "EX", 30);
await scanOverdueGoals().catch((error) => log("error", { err: error instanceof Error ? error.message : String(error) }, "overdue scan failed"));
const overdueInterval = setInterval(() => {
  void scanOverdueGoals().catch((error) => log("error", { err: error instanceof Error ? error.message : String(error) }, "overdue scan failed"));
}, 24 * 60 * 60_000);
await scanMaintenanceAlerts().catch((error) => log("error", { err: error instanceof Error ? error.message : String(error) }, "maintenance alert scan failed"));
const maintenanceAlertInterval = setInterval(() => {
  void scanMaintenanceAlerts().catch((error) => log("error", { err: error instanceof Error ? error.message : String(error) }, "maintenance alert scan failed"));
}, 60 * 60_000);

async function shutdown(signal: string) {
  log("info", { signal }, "shutting down worker");
  clearInterval(heartbeat);
  clearInterval(overdueInterval);
  clearInterval(maintenanceAlertInterval);
  await worker.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
log("info", {}, "worker started");
