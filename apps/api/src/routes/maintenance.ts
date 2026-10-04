import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import {
  attachmentUploadSchema,
  environmentListQuerySchema,
  environmentReadingCreateSchema,
  maintenanceCreateSchema,
  maintenanceListQuerySchema,
  maintenanceUpdateSchema,
  repairCreateSchema,
  repairListQuerySchema,
  repairUpdateSchema,
} from "@practice/contracts";
import { getConfig } from "../config/env.js";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { createPlaybackUrl, createUploadUrl, deleteObject, verifyObject } from "../lib/s3.js";
import { parseOrThrow } from "../lib/validation.js";
import { audit } from "../lib/audit.js";
import { syncInstrumentAlerts } from "../services/maintenance-service.js";

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
]);
const MAX_ATTACHMENT_BYTES = 20n * 1024n * 1024n;

function safeFileName(input: string): string {
  const base = path.basename(input).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 180);
  return base || "attachment";
}

async function requireActiveInstrument(instrumentId: string, userId: string) {
  const instrument = await prisma.instrument.findFirst({ where: { id: instrumentId, userId } });
  if (!instrument) throw notFound();
  if (instrument.status !== "ACTIVE") {
    throw new AppError(409, "INVALID_INSTRUMENT_STATE", "只有在用设备可以记录保养数据");
  }
  return instrument;
}

const maintenanceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/maintenance-alerts", async (request) => {
    const instruments = await prisma.instrument.findMany({
      where: { userId: request.authUser!.id, status: "ACTIVE" },
      select: { id: true, name: true, category: true },
    });
    const persisted = await prisma.maintenanceAlert.findMany({
      where: { userId: request.authUser!.id, resolvedAt: null },
      orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
    });
    const names = new Map(instruments.map((instrument) => [instrument.id, instrument]));
    return {
      data: persisted.map((alert) => ({
        ...alert,
        instrument: names.get(alert.instrumentId) ?? null,
      })),
    };
  });

  app.get("/instruments/:instrumentId/maintenances", async (request) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const query = parseOrThrow(maintenanceListQuerySchema, request.query);
    const instrument = await prisma.instrument.findFirst({
      where: { id: instrumentId, userId: request.authUser!.id },
      select: { id: true },
    });
    if (!instrument) throw notFound();
    const data = await prisma.maintenanceRecord.findMany({
      where: { instrumentId, userId: request.authUser!.id, ...(query.type ? { type: query.type } : {}) },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ performedAt: "desc" }, { id: "asc" }],
      include: { attachments: { select: { id: true, originalName: true, status: true } } },
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    return { data: items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.post("/instruments/:instrumentId/maintenances", async (request, reply) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const input = parseOrThrow(maintenanceCreateSchema, request.body);
    await requireActiveInstrument(instrumentId, request.authUser!.id);
    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.maintenanceRecord.create({
        data: {
          userId: request.authUser!.id,
          instrumentId,
          type: input.type,
          performedAt: input.performedAt,
          stringBrand: input.stringBrand ?? null,
          cost: input.cost ?? null,
          vendor: input.vendor ?? null,
          notes: input.notes ?? null,
        },
      });
      if (input.type === "STRING_CHANGE") {
        // 换弦联动弦龄起点：只前移不回退，避免误填的旧日期覆盖新记录
        await tx.instrument.updateMany({
          where: {
            id: instrumentId,
            OR: [{ stringChangedAt: null }, { stringChangedAt: { lt: input.performedAt } }],
          },
          data: { stringChangedAt: input.performedAt, version: { increment: 1 } },
        });
      }
      return created;
    });
    await syncInstrumentAlerts(instrumentId);
    return reply.status(201).send({ record });
  });

  app.patch("/maintenances/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(maintenanceUpdateSchema, request.body);
    const existing = await prisma.maintenanceRecord.findFirst({
      where: { id, userId: request.authUser!.id },
      include: { instrument: { select: { status: true } } },
    });
    if (!existing) throw notFound();
    if (existing.instrument.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "设备已归并或删除，保养记录只读");
    }
    const record = await prisma.maintenanceRecord.update({
      where: { id },
      data: {
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.performedAt === undefined ? {} : { performedAt: input.performedAt }),
        ...(input.stringBrand === undefined ? {} : { stringBrand: input.stringBrand }),
        ...(input.cost === undefined ? {} : { cost: input.cost }),
        ...(input.vendor === undefined ? {} : { vendor: input.vendor }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      },
    });
    await syncInstrumentAlerts(existing.instrumentId);
    return { record };
  });

  app.delete("/maintenances/:id", async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.maintenanceRecord.findFirst({
      where: { id, userId: request.authUser!.id },
      include: { instrument: { select: { status: true } } },
    });
    if (!existing) throw notFound();
    if (existing.instrument.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "设备已归并或删除，保养记录只读");
    }
    await prisma.maintenanceRecord.delete({ where: { id } });
    await syncInstrumentAlerts(existing.instrumentId);
    await audit(request, "MAINTENANCE_DELETED", "MAINTENANCE_RECORD", id, "SUCCESS");
    return { success: true };
  });

  app.get("/instruments/:instrumentId/environments", async (request) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const query = parseOrThrow(environmentListQuerySchema, request.query);
    const instrument = await prisma.instrument.findFirst({
      where: { id: instrumentId, userId: request.authUser!.id },
      select: { id: true },
    });
    if (!instrument) throw notFound();
    const data = await prisma.environmentReading.findMany({
      where: {
        instrumentId,
        userId: request.authUser!.id,
        ...(query.from ? { recordedAt: { gte: query.from } } : {}),
        ...(query.to ? { recordedAt: { lte: query.to } } : {}),
      },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ recordedAt: "desc" }, { id: "asc" }],
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    return { data: items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.post("/instruments/:instrumentId/environments", async (request, reply) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const input = parseOrThrow(environmentReadingCreateSchema, request.body);
    await requireActiveInstrument(instrumentId, request.authUser!.id);
    // 以 (instrumentId, recordedAt) 为幂等键 upsert：重复上报同一时刻读数不会产生重复历史
    const reading = await prisma.environmentReading.upsert({
      where: { instrumentId_recordedAt: { instrumentId, recordedAt: input.recordedAt } },
      create: {
        userId: request.authUser!.id,
        instrumentId,
        temperatureC: input.temperatureC,
        humidityPct: input.humidityPct,
        source: input.source ?? null,
        note: input.note ?? null,
        recordedAt: input.recordedAt,
      },
      update: {
        temperatureC: input.temperatureC,
        humidityPct: input.humidityPct,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });
    await syncInstrumentAlerts(instrumentId);
    return reply.status(201).send({ reading });
  });

  app.get("/instruments/:instrumentId/repairs", async (request) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const query = parseOrThrow(repairListQuerySchema, request.query);
    const instrument = await prisma.instrument.findFirst({
      where: { id: instrumentId, userId: request.authUser!.id },
      select: { id: true },
    });
    if (!instrument) throw notFound();
    const data = await prisma.repairItem.findMany({
      where: { instrumentId, userId: request.authUser!.id, ...(query.status ? { status: query.status } : {}) },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    return { data: items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.post("/instruments/:instrumentId/repairs", async (request, reply) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const input = parseOrThrow(repairCreateSchema, request.body);
    await requireActiveInstrument(instrumentId, request.authUser!.id);
    const repair = await prisma.repairItem.create({
      data: {
        userId: request.authUser!.id,
        instrumentId,
        title: input.title,
        description: input.description ?? null,
        dueDate: input.dueDate ?? null,
        cost: input.cost ?? null,
      },
    });
    await syncInstrumentAlerts(instrumentId);
    return reply.status(201).send({ repair });
  });

  app.patch("/repairs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(repairUpdateSchema, request.body);
    const existing = await prisma.repairItem.findFirst({
      where: { id, userId: request.authUser!.id },
      include: { instrument: { select: { status: true } } },
    });
    if (!existing) throw notFound();
    if (existing.instrument.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "设备已归并或删除，维修事项只读");
    }
    const closing = input.status === "DONE" || input.status === "CANCELLED";
    const updated = await prisma.repairItem.updateMany({
      where: { id, userId: request.authUser!.id, version: input.version },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        ...(input.cost === undefined ? {} : { cost: input.cost }),
        ...(input.status === undefined
          ? {}
          : { resolvedAt: closing ? new Date() : null }),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "维修事项已在其他窗口被修改");
    await syncInstrumentAlerts(existing.instrumentId);
    const repair = await prisma.repairItem.findUniqueOrThrow({ where: { id } });
    return { repair };
  });

  app.post("/repairs/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.repairItem.findFirst({
      where: { id, userId: request.authUser!.id },
      include: { instrument: { select: { status: true } } },
    });
    if (!existing) throw notFound();
    if (existing.instrument.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "设备已归并或删除，维修事项只读");
    }
    if (["DONE", "CANCELLED"].includes(existing.status)) {
      return { repair: existing };
    }
    const repair = await prisma.repairItem.update({
      where: { id },
      data: { status: "DONE", resolvedAt: new Date(), version: { increment: 1 } },
    });
    await syncInstrumentAlerts(existing.instrumentId);
    await audit(request, "REPAIR_COMPLETED", "REPAIR_ITEM", id, "SUCCESS");
    return { repair };
  });

  app.post("/instruments/:instrumentId/attachments/uploads", async (request, reply) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const input = parseOrThrow(attachmentUploadSchema, request.body);
    await requireActiveInstrument(instrumentId, request.authUser!.id);
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(input.mimeType.toLowerCase())) {
      throw new AppError(415, "UNSUPPORTED_MEDIA", "仅支持常见图片或 PDF 附件");
    }
    if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new AppError(413, "FILE_TOO_LARGE", "单个附件不能超过 20 MB");
    }
    if (input.maintenanceId) {
      const maintenance = await prisma.maintenanceRecord.findFirst({
        where: { id: input.maintenanceId, instrumentId, userId: request.authUser!.id },
        select: { id: true },
      });
      if (!maintenance) throw new AppError(400, "VALIDATION_ERROR", "关联保养记录不属于该设备");
    }
    const attachmentId = randomUUID();
    const objectKey = `users/${request.authUser!.id}/instruments/${instrumentId}/${attachmentId}/${safeFileName(input.originalName)}`;
    const uploadUrl = await createUploadUrl(objectKey, input.mimeType, input.sha256.toLowerCase());
    const attachment = await prisma.maintenanceAttachment.create({
      data: {
        id: attachmentId,
        userId: request.authUser!.id,
        instrumentId,
        maintenanceId: input.maintenanceId ?? null,
        status: "PENDING_UPLOAD",
        objectKey,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256.toLowerCase(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
      select: { id: true, status: true, originalName: true, sizeBytes: true, createdAt: true },
    });
    return reply.status(201).send({
      attachment,
      uploadUrl,
      requiredHeaders: {
        "Content-Type": input.mimeType,
        "x-amz-meta-sha256": input.sha256.toLowerCase(),
      },
      expiresAt: new Date(Date.now() + getConfig().UPLOAD_URL_TTL_SECONDS * 1000),
    });
  });

  app.post("/attachments/:id/complete-upload", async (request) => {
    const { id } = request.params as { id: string };
    const attachment = await prisma.maintenanceAttachment.findFirst({
      where: { id, userId: request.authUser!.id },
    });
    if (!attachment) throw notFound();
    if (attachment.status === "READY") return { attachment };
    if (attachment.status !== "PENDING_UPLOAD") {
      throw new AppError(409, "INVALID_ATTACHMENT_STATE", "当前附件状态不能确认上传");
    }
    if (attachment.expiresAt && attachment.expiresAt < new Date()) {
      throw new AppError(409, "UPLOAD_SESSION_EXPIRED", "上传会话已过期，请重新创建");
    }
    await verifyObject(attachment.objectKey, attachment.sizeBytes, attachment.sha256);
    const updated = await prisma.maintenanceAttachment.update({
      where: { id },
      data: { status: "READY", expiresAt: null },
    });
    return { attachment: updated };
  });

  app.get("/attachments/:id/download-url", async (request) => {
    const { id } = request.params as { id: string };
    const attachment = await prisma.maintenanceAttachment.findFirst({
      where: { id, userId: request.authUser!.id },
    });
    if (!attachment) throw notFound();
    if (attachment.status !== "READY") throw new AppError(409, "ATTACHMENT_NOT_READY", "附件尚未完成校验");
    const url = await createPlaybackUrl(attachment.objectKey, attachment.originalName, attachment.mimeType);
    return { url, expiresIn: getConfig().PLAYBACK_URL_TTL_SECONDS };
  });

  app.delete("/attachments/:id", async (request) => {
    const { id } = request.params as { id: string };
    const attachment = await prisma.maintenanceAttachment.findFirst({
      where: { id, userId: request.authUser!.id },
    });
    if (!attachment) throw notFound();
    // 先清理对象存储，成功后再删除数据库记录；对象删除失败时保留记录以便重试
    await deleteObject(attachment.objectKey);
    await prisma.maintenanceAttachment.delete({ where: { id } });
    await audit(request, "ATTACHMENT_DELETED", "MAINTENANCE_ATTACHMENT", id, "SUCCESS");
    return { success: true };
  });
};

export default maintenanceRoutes;
