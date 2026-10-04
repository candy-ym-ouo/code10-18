import {
  evaluateEnvironmentHumidity,
  evaluateStringAge,
  evaluateTaskDue,
  planAlertTransitions,
  type DesiredAlert,
} from "@practice/contracts";
import { prisma } from "./prisma.js";

/**
 * 扫描在用设备，刷新保养预警快照。
 *
 * 幂等设计：期望预警集合由当前数据纯函数推导，与既有快照对比后只做
 * 最小 upsert/resolve；同一数据重复扫描不会产生重复预警或多余写入，
 * 因此周期任务、手动触发和失败重试都可安全重跑。
 */
export async function scanMaintenanceAlerts(userId?: string): Promise<{ upserted: number; resolved: number }> {
  const now = new Date();
  const instruments = await prisma.instrument.findMany({
    where: { status: "ACTIVE", ...(userId ? { userId } : {}) },
    include: {
      stringChanges: { orderBy: { changedAt: "desc" }, take: 1, select: { changedAt: true } },
      environmentReadings: { orderBy: { recordedAt: "desc" }, take: 1, select: { humidityPct: true } },
      maintenanceTasks: {
        where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
        select: { id: true, title: true, dueDate: true, status: true },
      },
    },
  });

  const desiredByUser = new Map<string, Array<DesiredAlert & { instrumentId: string }>>();
  for (const instrument of instruments) {
    const desired: Array<DesiredAlert & { instrumentId: string }> = [];
    const stringAge = evaluateStringAge(instrument.stringChanges[0]?.changedAt ?? null, instrument.stringLifespanDays, now);
    if (stringAge.level !== "NONE" && stringAge.message) {
      desired.push({
        dedupeKey: `string-age:${instrument.id}`,
        type: "STRING_AGE",
        severity: stringAge.level,
        message: stringAge.message.slice(0, 300),
        instrumentId: instrument.id,
      });
    }
    const humidity = evaluateEnvironmentHumidity(
      instrument.environmentReadings[0]?.humidityPct == null ? null : Number(instrument.environmentReadings[0].humidityPct),
      Number(instrument.humidityMin),
      Number(instrument.humidityMax),
    );
    if (humidity.level !== "NONE" && humidity.message) {
      desired.push({
        dedupeKey: `environment:${instrument.id}`,
        type: "ENVIRONMENT",
        severity: humidity.level,
        message: humidity.message.slice(0, 300),
        instrumentId: instrument.id,
      });
    }
    for (const task of instrument.maintenanceTasks) {
      const due = evaluateTaskDue(task.dueDate, task.status, now);
      if (due.level !== "NONE" && due.message) {
        desired.push({
          dedupeKey: `task-due:${task.id}`,
          type: "TASK_DUE",
          severity: due.level,
          message: `${task.title}：${due.message}`.slice(0, 300),
          instrumentId: instrument.id,
        });
      }
    }
    const bucket = desiredByUser.get(instrument.userId) ?? [];
    desiredByUser.set(instrument.userId, [...bucket, ...desired]);
  }

  // 既有快照按用户加载：不在期望集合中的 ACTIVE 预警（含已退役/已归并设备的）统一解除
  const existing = await prisma.maintenanceAlert.findMany({
    where: userId ? { userId } : {},
    select: { userId: true, dedupeKey: true, status: true, severity: true, message: true },
  });
  const existingByUser = new Map<string, typeof existing>();
  for (const alert of existing) {
    const bucket = existingByUser.get(alert.userId) ?? [];
    existingByUser.set(alert.userId, [...bucket, alert]);
  }
  const userIds = new Set([...desiredByUser.keys(), ...existingByUser.keys()]);

  let upserted = 0;
  let resolved = 0;
  for (const currentUserId of userIds) {
    const desired = desiredByUser.get(currentUserId) ?? [];
    const plan = planAlertTransitions(existingByUser.get(currentUserId) ?? [], desired);
    for (const item of plan.upserts) {
      // planAlertTransitions 原样返回传入对象，instrumentId 随引用保留
      const { instrumentId } = item as DesiredAlert & { instrumentId: string };
      await prisma.maintenanceAlert.upsert({
        where: { userId_dedupeKey: { userId: currentUserId, dedupeKey: item.dedupeKey } },
        create: {
          userId: currentUserId,
          instrumentId,
          type: item.type,
          dedupeKey: item.dedupeKey,
          severity: item.severity,
          message: item.message,
          status: "ACTIVE",
          detectedAt: now,
        },
        update: {
          instrumentId,
          type: item.type,
          severity: item.severity,
          message: item.message,
          status: "ACTIVE",
          resolvedAt: null,
        },
      });
      upserted += 1;
    }
    if (plan.resolveKeys.length > 0) {
      const result = await prisma.maintenanceAlert.updateMany({
        where: { userId: currentUserId, dedupeKey: { in: plan.resolveKeys }, status: "ACTIVE" },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      resolved += result.count;
    }
  }
  return { upserted, resolved };
}
