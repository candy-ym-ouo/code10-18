import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import {
  attachmentUploadSchema,
  maintenanceAlertListQuerySchema,
  maintenanceTaskCreateSchema,
  maintenanceTaskListQuerySchema,
  maintenanceTaskUpdateSchema,
} from "@practice/contracts";
import { getConfig } from "../config/env.js";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { createPlaybackUrl, createUploadUrl, verifyObject } from "../lib/s3.js";
import { parseOrThrow } from "../lib/validation.js";
import { audit } from "../lib/audit.js";
import { enqueueMaintenanceScan } from "../lib/queue.js";
import { deleteAttachment } from "../services/maintenance-service.js";

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
]);

function safeFileName(input: string): string {
  const base = path.basename(input).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 180);
  return base || "attachment";
}

const taskInclude = {
  instrument: { select: { id: true, name: true, category: true } },
  attachments: { orderBy: { createdAt: "asc" as const } },
} as const;

const maintenanceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  async function getOwnTask(userId: string, id: string) {
    const task = await prisma.maintenanceTask.findFirst({ where: { id, userId } });
    if (!task) throw notFound();
    return task;
  }

  app.get("/instruments/:instrumentId/tasks", async (request) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const query = parseOrThrow(maintenanceTaskListQuerySchema, request.query);
    const instrument = await prisma.instrument.findFirst({ where: { id: instrumentId, userId: request.authUser!.id }, select: { id: true } });
    if (!instrument) throw notFound();
    const data = await prisma.maintenanceTask.findMany({
      where: {
        instrumentId,
        userId: request.authUser!.id,
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
      },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
      include: taskInclude,
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    return { data: items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.post("/instruments/:instrumentId/tasks", async (request, reply) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const input = parseOrThrow(maintenanceTaskCreateSchema, request.body);
    const instrument = await prisma.instrument.findFirst({ where: { id: instrumentId, userId: request.authUser!.id } });
    if (!instrument) throw notFound();
    if (instrument.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "只有在用设备可以创建保养事项");
    }
    try {
      const task = await prisma.maintenanceTask.create({
        data: {
          userId: request.authUser!.id,
          instrumentId,
          type: input.type,
          title: input.title,
          description: input.description ?? null,
          dueDate: input.dueDate ?? null,
          cost: input.cost ?? null,
          shop: input.shop ?? null,
          dedupeKey: input.dedupeKey ?? null,
        },
        include: taskInclude,
      });
      await enqueueMaintenanceScan(request.authUser!.id).catch(() => undefined);
      return reply.status(201).send({ task, deduplicated: false });
    } catch (error) {
      // dedupeKey 唯一约束命中：同一事项重复提交时返回既有记录（幂等）
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && input.dedupeKey) {
        const existing = await prisma.maintenanceTask.findFirst({
          where: { instrumentId, dedupeKey: input.dedupeKey },
          include: taskInclude,
        });
        if (existing) return reply.status(200).send({ task: existing, deduplicated: true });
      }
      throw error;
    }
  });

  app.get("/maintenance-tasks/:id", async (request) => {
    const { id } = request.params as { id: string };
    const task = await prisma.maintenanceTask.findFirst({
      where: { id, userId: request.authUser!.id },
      include: taskInclude,
    });
    if (!task) throw notFound();
    return { task };
  });

  app.patch("/maintenance-tasks/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(maintenanceTaskUpdateSchema, request.body);
    await getOwnTask(request.authUser!.id, id);
    const updated = await prisma.maintenanceTask.updateMany({
      where: { id, userId: request.authUser!.id, version: input.version },
      data: {
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        ...(input.cost === undefined ? {} : { cost: input.cost }),
        ...(input.shop === undefined ? {} : { shop: input.shop }),
        ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "保养事项已在其他窗口被修改");
    const task = await prisma.maintenanceTask.findUniqueOrThrow({ where: { id }, include: taskInclude });
    await enqueueMaintenanceScan(request.authUser!.id).catch(() => undefined);
    return { task };
  });

  app.post("/maintenance-tasks/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    const existing = await getOwnTask(request.authUser!.id, id);
    if (["DONE", "CANCELLED"].includes(existing.status)) {
      throw new AppError(409, "INVALID_TASK_STATE", "当前事项已关闭");
    }
    const task = await prisma.maintenanceTask.update({
      where: { id },
      data: { status: "DONE", completedAt: new Date(), version: { increment: 1 } },
      include: taskInclude,
    });
    await audit(request, "MAINTENANCE_TASK_COMPLETED", "MAINTENANCE_TASK", id, "SUCCESS");
    await enqueueMaintenanceScan(request.authUser!.id).catch(() => undefined);
    return { task };
  });

  app.post("/maintenance-tasks/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    const existing = await getOwnTask(request.authUser!.id, id);
    if (["DONE", "CANCELLED"].includes(existing.status)) {
      throw new AppError(409, "INVALID_TASK_STATE", "当前事项已关闭");
    }
    const task = await prisma.maintenanceTask.update({
      where: { id },
      data: { status: "CANCELLED", version: { increment: 1 } },
      include: taskInclude,
    });
    await enqueueMaintenanceScan(request.authUser!.id).catch(() => undefined);
    return { task };
  });

  app.post("/maintenance-tasks/:id/attachments/uploads", async (request, reply) => {
    const config = getConfig();
    const { id } = request.params as { id: string };
    const input = parseOrThrow(attachmentUploadSchema, request.body);
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(input.mimeType.toLowerCase())) {
      throw new AppError(415, "UNSUPPORTED_MEDIA", "仅支持常见图片或 PDF 附件");
    }
    const maxBytes = BigInt(config.MAX_ATTACHMENT_SIZE_MB) * 1024n * 1024n;
    if (input.sizeBytes > maxBytes) {
      throw new AppError(413, "FILE_TOO_LARGE", `单个附件不能超过 ${config.MAX_ATTACHMENT_SIZE_MB} MB`);
    }
    const task = await getOwnTask(request.authUser!.id, id);
    const count = await prisma.maintenanceAttachment.count({ where: { taskId: task.id } });
    if (count >= config.MAX_ATTACHMENTS_PER_TASK) {
      throw new AppError(400, "ATTACHMENT_LIMIT_REACHED", `每个事项最多 ${config.MAX_ATTACHMENTS_PER_TASK} 个附件`);
    }

    const attachmentId = randomUUID();
    const objectKey = `users/${request.authUser!.id}/maintenance/${task.id}/${attachmentId}/${safeFileName(input.originalName)}`;
    const uploadUrl = await createUploadUrl(objectKey, input.mimeType, input.sha256.toLowerCase());
    const attachment = await prisma.maintenanceAttachment.create({
      data: {
        id: attachmentId,
        userId: request.authUser!.id,
        taskId: task.id,
        status: "PENDING_UPLOAD",
        objectKey,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256.toLowerCase(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    return reply.status(201).send({
      attachment,
      uploadUrl,
      requiredHeaders: {
        "Content-Type": input.mimeType,
        "x-amz-meta-sha256": input.sha256.toLowerCase(),
      },
      expiresAt: new Date(Date.now() + config.UPLOAD_URL_TTL_SECONDS * 1000),
    });
  });

  app.post("/maintenance-attachments/:id/complete-upload", async (request) => {
    const { id } = request.params as { id: string };
    const attachment = await prisma.maintenanceAttachment.findFirst({ where: { id, userId: request.authUser!.id } });
    if (!attachment) throw notFound();
    if (attachment.status === "READY") return { attachment };
    if (attachment.status !== "PENDING_UPLOAD") {
      throw new AppError(409, "INVALID_ATTACHMENT_STATE", "当前附件状态不能确认上传");
    }
    if (attachment.expiresAt && attachment.expiresAt < new Date()) {
      await prisma.maintenanceAttachment.update({ where: { id }, data: { status: "FAILED" } });
      throw new AppError(409, "UPLOAD_SESSION_EXPIRED", "上传会话已过期，请重新创建");
    }
    await verifyObject(attachment.objectKey, attachment.sizeBytes, attachment.sha256);
    const updated = await prisma.maintenanceAttachment.update({
      where: { id },
      data: { status: "READY", expiresAt: null },
    });
    return { attachment: updated };
  });

  app.get("/maintenance-attachments/:id/download-url", async (request) => {
    const { id } = request.params as { id: string };
    const attachment = await prisma.maintenanceAttachment.findFirst({ where: { id, userId: request.authUser!.id } });
    if (!attachment) throw notFound();
    if (attachment.status !== "READY") throw new AppError(409, "ATTACHMENT_NOT_READY", "附件尚未完成校验");
    const url = await createPlaybackUrl(attachment.objectKey, attachment.originalName, attachment.mimeType);
    return { url, expiresIn: getConfig().PLAYBACK_URL_TTL_SECONDS };
  });

  // 删除附件：先在对象存储清理对象，成功后才删除数据库行；失败时行保留可重试
  app.delete("/maintenance-attachments/:id", async (request) => {
    const { id } = request.params as { id: string };
    await deleteAttachment(request.authUser!.id, id);
    await audit(request, "MAINTENANCE_ATTACHMENT_DELETED", "MAINTENANCE_ATTACHMENT", id, "SUCCESS");
    return { success: true };
  });

  app.get("/maintenance/alerts", async (request) => {
    const query = parseOrThrow(maintenanceAlertListQuerySchema, request.query);
    const data = await prisma.maintenanceAlert.findMany({
      where: {
        userId: request.authUser!.id,
        ...(query.status === "ALL" ? {} : { status: query.status }),
        ...(query.instrumentId ? { instrumentId: query.instrumentId } : {}),
      },
      orderBy: [{ status: "asc" }, { severity: "desc" }, { detectedAt: "desc" }],
      take: 200,
      include: { instrument: { select: { id: true, name: true, category: true } } },
    });
    return { data };
  });

  app.post("/maintenance/alerts/:id/resolve", async (request) => {
    const { id } = request.params as { id: string };
    const alert = await prisma.maintenanceAlert.findFirst({ where: { id, userId: request.authUser!.id } });
    if (!alert) throw notFound();
    if (alert.status === "RESOLVED") return { alert };
    const updated = await prisma.maintenanceAlert.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    return { alert: updated };
  });

  // 手动触发预警扫描；扫描任务幂等，可安全重复调用
  app.post("/maintenance/scan", async (request) => {
    await enqueueMaintenanceScan(request.authUser!.id);
    return { queued: true };
  });
};

export default maintenanceRoutes;
