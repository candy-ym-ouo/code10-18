import { buildMaintenanceAlerts, type MaintenanceAlertResult } from "@practice/contracts";
import type { EnvironmentReading, Instrument, Prisma, RepairItem } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type DecimalLike = { toNumber(): number } | number | null;

function toNumberOrNull(value: DecimalLike): number | null {
  if (value == null) return null;
  return typeof value === "number" ? value : value.toNumber();
}

export function computeInstrumentAlerts(
  instrument: Instrument,
  latestEnvironment: EnvironmentReading | null,
  overdueRepairs: RepairItem[],
  now = new Date(),
): MaintenanceAlertResult[] {
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const oldestOverdueDays = overdueRepairs.length
    ? Math.max(
        ...overdueRepairs.map((repair) =>
          repair.dueDate ? Math.floor((startOfToday.getTime() - repair.dueDate.getTime()) / 86_400_000) : 0,
        ),
      )
    : null;
  return buildMaintenanceAlerts({
    now,
    stringChangedAt: instrument.stringChangedAt,
    stringMaxAgeDays: instrument.stringMaxAgeDays,
    latestEnvironment: latestEnvironment
      ? {
          temperatureC: toNumberOrNull(latestEnvironment.temperatureC) ?? 0,
          humidityPct: toNumberOrNull(latestEnvironment.humidityPct) ?? 0,
          recordedAt: latestEnvironment.recordedAt,
        }
      : null,
    environmentRange: {
      humidityMinPct: toNumberOrNull(instrument.humidityMinPct),
      humidityMaxPct: toNumberOrNull(instrument.humidityMaxPct),
      temperatureMinC: toNumberOrNull(instrument.temperatureMinC),
      temperatureMaxC: toNumberOrNull(instrument.temperatureMaxC),
    },
    overdueRepairCount: overdueRepairs.length,
    oldestOverdueRepairDays: oldestOverdueDays,
  });
}

async function loadAlertContext(tx: Prisma.TransactionClient | typeof prisma, instrumentId: string) {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const [instrument, latestEnvironment, overdueRepairs] = await Promise.all([
    tx.instrument.findUnique({ where: { id: instrumentId } }),
    tx.environmentReading.findFirst({ where: { instrumentId }, orderBy: { recordedAt: "desc" } }),
    tx.repairItem.findMany({
      where: { instrumentId, status: { in: ["OPEN", "IN_PROGRESS"] }, dueDate: { lt: startOfToday } },
    }),
  ]);
  return { instrument, latestEnvironment, overdueRepairs };
}

export async function getInstrumentAlerts(instrumentId: string): Promise<MaintenanceAlertResult[]> {
  const { instrument, latestEnvironment, overdueRepairs } = await loadAlertContext(prisma, instrumentId);
  if (!instrument || instrument.status !== "ACTIVE") return [];
  return computeInstrumentAlerts(instrument, latestEnvironment, overdueRepairs);
}

/**
 * 把实时计算出的预警幂等写入 maintenance_alerts：
 * 同一设备同一类型只保留一行（upsert），已解除的预警标记 resolvedAt。
 * 扫描任务和 API 变更后都会调用，重复执行结果一致。
 */
export async function syncInstrumentAlerts(instrumentId: string, now = new Date()): Promise<MaintenanceAlertResult[]> {
  return prisma.$transaction(async (tx) => {
    const { instrument, latestEnvironment, overdueRepairs } = await loadAlertContext(tx, instrumentId);
    if (!instrument || instrument.status !== "ACTIVE") {
      await tx.maintenanceAlert.updateMany({
        where: { instrumentId, resolvedAt: null },
        data: { resolvedAt: now },
      });
      return [];
    }
    const alerts = computeInstrumentAlerts(instrument, latestEnvironment, overdueRepairs, now);
    const activeTypes = alerts.map((alert) => alert.type);
    await tx.maintenanceAlert.updateMany({
      where: { instrumentId, resolvedAt: null, ...(activeTypes.length ? { type: { notIn: activeTypes } } : {}) },
      data: { resolvedAt: now },
    });
    for (const alert of alerts) {
      await tx.maintenanceAlert.upsert({
        where: { instrumentId_type: { instrumentId, type: alert.type } },
        create: {
          userId: instrument.userId,
          instrumentId,
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
    return alerts;
  });
}
