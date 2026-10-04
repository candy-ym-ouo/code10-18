import type { FastifyPluginAsync } from "fastify";
import {
  canMergeInstruments,
  instrumentCreateSchema,
  instrumentListQuerySchema,
  instrumentMergeSchema,
  instrumentUpdateSchema,
} from "@practice/contracts";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { enqueueInstrumentCleanup } from "../lib/queue.js";
import { parseOrThrow } from "../lib/validation.js";
import { audit } from "../lib/audit.js";
import { getInstrumentAlerts, syncInstrumentAlerts } from "../services/maintenance-service.js";

const instrumentInclude = {
  alerts: { where: { resolvedAt: null } },
  mergedInto: { select: { id: true, name: true } },
  _count: { select: { maintenances: true, repairs: true, environments: true, attachments: true } },
} as const;

const instrumentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    const query = parseOrThrow(instrumentListQuerySchema, request.query);
    const data = await prisma.instrument.findMany({
      where: {
        userId: request.authUser!.id,
        ...(query.status === "ALL" ? {} : { status: query.status }),
        ...(query.category ? { category: query.category } : {}),
        ...(query.q ? { name: { contains: query.q, mode: "insensitive" as const } } : {}),
      },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: instrumentInclude,
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    return { data: items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.post("/", async (request, reply) => {
    const input = parseOrThrow(instrumentCreateSchema, request.body);
    const instrument = await prisma.instrument.create({
      data: {
        userId: request.authUser!.id,
        name: input.name,
        category: input.category,
        brand: input.brand ?? null,
        model: input.model ?? null,
        serialNo: input.serialNo ?? null,
        acquiredAt: input.acquiredAt ?? null,
        stringChangedAt: input.stringChangedAt ?? null,
        stringMaxAgeDays: input.stringMaxAgeDays,
        humidityMinPct: input.humidityMinPct ?? null,
        humidityMaxPct: input.humidityMaxPct ?? null,
        temperatureMinC: input.temperatureMinC ?? null,
        temperatureMaxC: input.temperatureMaxC ?? null,
        notes: input.notes ?? null,
      },
      include: instrumentInclude,
    });
    await syncInstrumentAlerts(instrument.id);
    await audit(request, "INSTRUMENT_CREATED", "INSTRUMENT", instrument.id, "SUCCESS");
    return reply.status(201).send({ instrument });
  });

  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const instrument = await prisma.instrument.findFirst({
      where: { id, userId: request.authUser!.id },
      include: {
        ...instrumentInclude,
        mergedFrom: { select: { id: true, name: true, mergedAt: true } },
        maintenances: { orderBy: { performedAt: "desc" as const }, take: 10 },
        environments: { orderBy: { recordedAt: "desc" as const }, take: 10 },
        repairs: { orderBy: [{ status: "asc" as const }, { createdAt: "desc" as const }], take: 20 },
        attachments: { orderBy: { createdAt: "desc" as const }, take: 20 },
      },
    });
    if (!instrument) throw notFound();
    const alerts = instrument.status === "ACTIVE" ? await getInstrumentAlerts(instrument.id) : [];
    return { instrument, alerts };
  });

  app.patch("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(instrumentUpdateSchema, request.body);
    const existing = await prisma.instrument.findFirst({ where: { id, userId: request.authUser!.id } });
    if (!existing) throw notFound();
    if (existing.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "只有在用设备可以编辑");
    }
    const humidityMin = input.humidityMinPct === undefined ? existing.humidityMinPct : input.humidityMinPct;
    const humidityMax = input.humidityMaxPct === undefined ? existing.humidityMaxPct : input.humidityMaxPct;
    const temperatureMin = input.temperatureMinC === undefined ? existing.temperatureMinC : input.temperatureMinC;
    const temperatureMax = input.temperatureMaxC === undefined ? existing.temperatureMaxC : input.temperatureMaxC;
    if (humidityMin != null && humidityMax != null && Number(humidityMin) > Number(humidityMax)) {
      throw new AppError(400, "VALIDATION_ERROR", "湿度上限不能低于下限");
    }
    if (temperatureMin != null && temperatureMax != null && Number(temperatureMin) > Number(temperatureMax)) {
      throw new AppError(400, "VALIDATION_ERROR", "温度上限不能低于下限");
    }
    const updated = await prisma.instrument.updateMany({
      where: { id, userId: request.authUser!.id, version: input.version },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.brand === undefined ? {} : { brand: input.brand }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.serialNo === undefined ? {} : { serialNo: input.serialNo }),
        ...(input.acquiredAt === undefined ? {} : { acquiredAt: input.acquiredAt }),
        ...(input.stringChangedAt === undefined ? {} : { stringChangedAt: input.stringChangedAt }),
        ...(input.stringMaxAgeDays === undefined ? {} : { stringMaxAgeDays: input.stringMaxAgeDays }),
        ...(input.humidityMinPct === undefined ? {} : { humidityMinPct: input.humidityMinPct }),
        ...(input.humidityMaxPct === undefined ? {} : { humidityMaxPct: input.humidityMaxPct }),
        ...(input.temperatureMinC === undefined ? {} : { temperatureMinC: input.temperatureMinC }),
        ...(input.temperatureMaxC === undefined ? {} : { temperatureMaxC: input.temperatureMaxC }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "设备已在其他窗口被修改");
    await syncInstrumentAlerts(id);
    const instrument = await prisma.instrument.findUniqueOrThrow({ where: { id }, include: instrumentInclude });
    return { instrument };
  });

  app.post("/:id/merge", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(instrumentMergeSchema, request.body);
    if (input.targetId === id) {
      throw new AppError(400, "VALIDATION_ERROR", "不能把设备归并到自身");
    }
    const [source, target] = await Promise.all([
      prisma.instrument.findFirst({ where: { id, userId: request.authUser!.id } }),
      prisma.instrument.findFirst({ where: { id: input.targetId, userId: request.authUser!.id } }),
    ]);
    if (!source || !target) throw notFound();
    const guard = canMergeInstruments(
      { status: source.status, mergedIntoId: source.mergedIntoId },
      target.id,
    );
    if (!guard.ok) throw new AppError(409, guard.code, guard.message);
    if (guard.alreadyMerged) {
      return { merged: true, alreadyMerged: true, sourceId: source.id, targetId: target.id };
    }
    if (target.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "归并目标必须是在用设备");
    }

    await prisma.$transaction(async (tx) => {
      // 环境读数按 (instrumentId, recordedAt) 唯一：先删除与目标冲突的源读数，避免归并出重复历史
      const targetReadings = await tx.environmentReading.findMany({
        where: { instrumentId: target.id },
        select: { recordedAt: true },
      });
      if (targetReadings.length) {
        await tx.environmentReading.deleteMany({
          where: { instrumentId: source.id, recordedAt: { in: targetReadings.map((reading) => reading.recordedAt) } },
        });
      }
      // 历史记录整体转移而非复制，归并后只存在一份
      await tx.environmentReading.updateMany({ where: { instrumentId: source.id }, data: { instrumentId: target.id } });
      await tx.maintenanceRecord.updateMany({ where: { instrumentId: source.id }, data: { instrumentId: target.id } });
      await tx.repairItem.updateMany({ where: { instrumentId: source.id }, data: { instrumentId: target.id } });
      await tx.maintenanceAttachment.updateMany({ where: { instrumentId: source.id }, data: { instrumentId: target.id } });
      // 源设备的持久化预警随归并失效，目标设备的预警由 syncInstrumentAlerts 重建
      await tx.maintenanceAlert.deleteMany({ where: { instrumentId: source.id } });
      const merged = await tx.instrument.updateMany({
        where: { id: source.id, status: { in: ["ACTIVE", "RETIRED"] } },
        data: { status: "MERGED", mergedIntoId: target.id, mergedAt: new Date(), version: { increment: 1 } },
      });
      if (merged.count !== 1) {
        throw new AppError(409, "INVALID_INSTRUMENT_STATE", "设备状态已变化，请刷新后重试归并");
      }
      await tx.instrument.update({ where: { id: target.id }, data: { version: { increment: 1 } } });
    });
    await syncInstrumentAlerts(target.id);
    await audit(request, "INSTRUMENT_MERGED", "INSTRUMENT", source.id, "SUCCESS", { targetId: target.id });
    return { merged: true, alreadyMerged: false, sourceId: source.id, targetId: target.id };
  });

  app.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const instrument = await prisma.instrument.findFirst({ where: { id, userId: request.authUser!.id } });
    if (!instrument) throw notFound();
    if (instrument.status === "DELETING") {
      return reply.status(202).send({ success: true, status: "DELETING" });
    }
    if (!["ACTIVE", "RETIRED", "MERGED", "DELETE_FAILED"].includes(instrument.status)) {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "当前设备状态不能删除");
    }
    await prisma.instrument.update({
      where: { id },
      data: { status: "DELETING", version: { increment: 1 } },
    });
    try {
      await enqueueInstrumentCleanup(id);
    } catch {
      await prisma.instrument.update({ where: { id }, data: { status: "DELETE_FAILED" } });
      throw new AppError(503, "PROCESSING_UNAVAILABLE", "清理服务暂不可用，请稍后重试");
    }
    await audit(request, "INSTRUMENT_DELETE_QUEUED", "INSTRUMENT", id, "SUCCESS");
    return reply.status(202).send({ success: true, status: "DELETING" });
  });

  app.get("/:id/alerts", async (request) => {
    const { id } = request.params as { id: string };
    const instrument = await prisma.instrument.findFirst({
      where: { id, userId: request.authUser!.id },
      select: { id: true, status: true },
    });
    if (!instrument) throw notFound();
    const alerts = instrument.status === "ACTIVE" ? await getInstrumentAlerts(id) : [];
    return { data: alerts };
  });
};

export default instrumentRoutes;
