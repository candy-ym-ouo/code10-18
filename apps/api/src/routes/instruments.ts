import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import {
  environmentReadingCreateSchema,
  instrumentCreateSchema,
  instrumentListQuerySchema,
  instrumentMergeSchema,
  instrumentUpdateSchema,
  stringChangeCreateSchema,
} from "@practice/contracts";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { parseOrThrow } from "../lib/validation.js";
import { audit } from "../lib/audit.js";
import { enqueueMaintenanceScan } from "../lib/queue.js";
import { mergeInstruments } from "../services/maintenance-service.js";

const instrumentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  async function getOwnInstrument(userId: string, id: string) {
    const instrument = await prisma.instrument.findFirst({ where: { id, userId } });
    if (!instrument) throw notFound();
    return instrument;
  }

  app.get("/", async (request) => {
    const query = parseOrThrow(instrumentListQuerySchema, request.query);
    const data = await prisma.instrument.findMany({
      where: {
        userId: request.authUser!.id,
        ...(query.status === "ALL" ? {} : { status: query.status }),
      },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: {
        stringChanges: { orderBy: { changedAt: "desc" }, take: 1 },
        environmentReadings: { orderBy: { recordedAt: "desc" }, take: 1 },
        _count: { select: { alerts: { where: { status: "ACTIVE" } }, maintenanceTasks: { where: { status: { in: ["OPEN", "IN_PROGRESS"] } } } } },
      },
    });
    const hasMore = data.length > query.limit;
    const items = hasMore ? data.slice(0, query.limit) : data;
    return { data: items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  });

  app.post("/", async (request, reply) => {
    const input = parseOrThrow(instrumentCreateSchema, request.body);
    if (input.humidityMin >= input.humidityMax) {
      throw new AppError(400, "VALIDATION_ERROR", "湿度下限必须小于上限");
    }
    const instrument = await prisma.instrument.create({
      data: {
        userId: request.authUser!.id,
        name: input.name,
        category: input.category,
        brand: input.brand ?? null,
        model: input.model ?? null,
        serialNo: input.serialNo ?? null,
        acquiredAt: input.acquiredAt ?? null,
        stringSet: input.stringSet ?? null,
        stringLifespanDays: input.stringLifespanDays,
        humidityMin: input.humidityMin,
        humidityMax: input.humidityMax,
        notes: input.notes ?? null,
      },
    });
    await audit(request, "INSTRUMENT_CREATED", "INSTRUMENT", instrument.id, "SUCCESS");
    await enqueueMaintenanceScan(request.authUser!.id).catch(() => undefined);
    return reply.status(201).send({ instrument });
  });

  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const instrument = await prisma.instrument.findFirst({
      where: { id, userId: request.authUser!.id },
      include: {
        stringChanges: { orderBy: { changedAt: "desc" }, take: 1 },
        environmentReadings: { orderBy: { recordedAt: "desc" }, take: 1 },
        alerts: { where: { status: "ACTIVE" }, orderBy: { detectedAt: "desc" } },
        mergedInto: { select: { id: true, name: true } },
        _count: { select: { stringChanges: true, environmentReadings: true, maintenanceTasks: true, mergedFrom: true } },
      },
    });
    if (!instrument) throw notFound();
    return { instrument };
  });

  app.patch("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(instrumentUpdateSchema, request.body);
    const existing = await getOwnInstrument(request.authUser!.id, id);
    if (existing.status === "MERGED") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "已归并的设备不能再修改");
    }
    const humidityMin = input.humidityMin ?? Number(existing.humidityMin);
    const humidityMax = input.humidityMax ?? Number(existing.humidityMax);
    if (humidityMin >= humidityMax) {
      throw new AppError(400, "VALIDATION_ERROR", "湿度下限必须小于上限");
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
        ...(input.stringSet === undefined ? {} : { stringSet: input.stringSet }),
        ...(input.stringLifespanDays === undefined ? {} : { stringLifespanDays: input.stringLifespanDays }),
        ...(input.humidityMin === undefined ? {} : { humidityMin: input.humidityMin }),
        ...(input.humidityMax === undefined ? {} : { humidityMax: input.humidityMax }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "设备已在其他窗口被修改");
    const instrument = await prisma.instrument.findUniqueOrThrow({ where: { id } });
    await enqueueMaintenanceScan(request.authUser!.id).catch(() => undefined);
    return { instrument };
  });

  app.post("/:id/retire", async (request) => {
    const { id } = request.params as { id: string };
    const existing = await getOwnInstrument(request.authUser!.id, id);
    if (existing.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "只有在用设备可以退役");
    }
    const instrument = await prisma.instrument.update({
      where: { id },
      data: { status: "RETIRED", version: { increment: 1 } },
    });
    await prisma.maintenanceAlert.updateMany({
      where: { instrumentId: id, status: "ACTIVE" },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await audit(request, "INSTRUMENT_RETIRED", "INSTRUMENT", id, "SUCCESS");
    return { instrument };
  });

  app.post("/:id/reactivate", async (request) => {
    const { id } = request.params as { id: string };
    const existing = await getOwnInstrument(request.authUser!.id, id);
    if (existing.status !== "RETIRED") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "只有已退役设备可以重新启用");
    }
    const instrument = await prisma.instrument.update({
      where: { id },
      data: { status: "ACTIVE", version: { increment: 1 } },
    });
    await enqueueMaintenanceScan(request.authUser!.id).catch(() => undefined);
    return { instrument };
  });

  app.post("/:id/merge", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(instrumentMergeSchema, request.body);
    const result = await mergeInstruments(request.authUser!.id, id, input.targetId);
    await audit(request, "INSTRUMENT_MERGED", "INSTRUMENT", id, "SUCCESS", { targetId: input.targetId, ...result.moved });
    return result;
  });

  app.get("/:id/string-changes", async (request) => {
    const { id } = request.params as { id: string };
    await getOwnInstrument(request.authUser!.id, id);
    const data = await prisma.stringChange.findMany({
      where: { instrumentId: id, userId: request.authUser!.id },
      orderBy: { changedAt: "desc" },
    });
    return { data };
  });

  app.post("/:id/string-changes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(stringChangeCreateSchema, request.body);
    const instrument = await getOwnInstrument(request.authUser!.id, id);
    if (instrument.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "只有在用设备可以记录换弦");
    }
    try {
      const change = await prisma.$transaction(async (tx) => {
        const created = await tx.stringChange.create({
          data: {
            userId: request.authUser!.id,
            instrumentId: id,
            stringSet: input.stringSet,
            changedAt: input.changedAt,
            note: input.note ?? null,
          },
        });
        // 同步设备当前琴弦：仅当本次换弦是最新记录时覆盖
        await tx.instrument.updateMany({
          where: { id, stringChanges: { none: { changedAt: { gt: input.changedAt } } } },
          data: { stringSet: input.stringSet },
        });
        return created;
      });
      await enqueueMaintenanceScan(request.authUser!.id).catch(() => undefined);
      return reply.status(201).send({ change, deduplicated: false });
    } catch (error) {
      // 唯一约束命中说明同一换弦已记录，重复提交直接返回既有记录（幂等）
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await prisma.stringChange.findFirst({
          where: { instrumentId: id, changedAt: input.changedAt, stringSet: input.stringSet },
        });
        if (existing) return reply.status(200).send({ change: existing, deduplicated: true });
      }
      throw error;
    }
  });

  app.get("/:id/environment", async (request) => {
    const { id } = request.params as { id: string };
    await getOwnInstrument(request.authUser!.id, id);
    const data = await prisma.environmentReading.findMany({
      where: { instrumentId: id, userId: request.authUser!.id },
      orderBy: { recordedAt: "desc" },
      take: 100,
    });
    return { data };
  });

  app.post("/:id/environment", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(environmentReadingCreateSchema, request.body);
    const instrument = await getOwnInstrument(request.authUser!.id, id);
    if (instrument.status !== "ACTIVE") {
      throw new AppError(409, "INVALID_INSTRUMENT_STATE", "只有在用设备可以记录环境");
    }
    // 同一设备同一时刻只保留一条读数，重复提交覆盖更新（幂等）
    const reading = await prisma.environmentReading.upsert({
      where: { instrumentId_recordedAt: { instrumentId: id, recordedAt: input.recordedAt } },
      create: {
        userId: request.authUser!.id,
        instrumentId: id,
        recordedAt: input.recordedAt,
        temperatureC: input.temperatureC ?? null,
        humidityPct: input.humidityPct ?? null,
        location: input.location ?? null,
        note: input.note ?? null,
      },
      update: {
        temperatureC: input.temperatureC ?? null,
        humidityPct: input.humidityPct ?? null,
        location: input.location ?? null,
        note: input.note ?? null,
      },
    });
    await enqueueMaintenanceScan(request.authUser!.id).catch(() => undefined);
    return reply.status(201).send({ reading });
  });
};

export default instrumentRoutes;
