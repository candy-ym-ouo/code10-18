import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { deleteObject } from "../lib/s3.js";
import { enqueueMaintenanceScan } from "../lib/queue.js";

export interface MergeResult {
  sourceId: string;
  targetId: string;
  alreadyMerged: boolean;
  moved: Record<"stringChanges" | "environmentReadings" | "maintenanceTasks", number>;
  droppedDuplicates: Record<"stringChanges" | "environmentReadings" | "maintenanceTasks", number>;
}

/**
 * 设备归并：把来源设备的全部保养历史转移到目标设备。
 *
 * 防重复历史：转移前先删除来源设备中与目标设备完全重复的记录
 * （同时间同型号的换弦、同时间的环境读数、同 dedupeKey 的维修事项），
 * 被删维修事项的附件对象先在 S3 清理，再进入数据库事务。
 *
 * 可安全重跑：来源设备已处于 MERGED 时直接返回既有结果；
 * S3 删除幂等，事务外任一步失败都不会留下半截状态。
 */
export async function mergeInstruments(userId: string, sourceId: string, targetId: string): Promise<MergeResult> {
  if (sourceId === targetId) {
    throw new AppError(400, "MERGE_TARGET_INVALID", "不能把设备归并到自身");
  }
  const [source, target] = await Promise.all([
    prisma.instrument.findFirst({ where: { id: sourceId, userId } }),
    prisma.instrument.findFirst({ where: { id: targetId, userId } }),
  ]);
  if (!source || !target) throw new AppError(404, "RESOURCE_NOT_FOUND", "资源不存在或无权访问");
  if (target.status !== "ACTIVE") {
    throw new AppError(409, "MERGE_TARGET_INVALID", "目标设备必须是在用状态");
  }
  const empty = { stringChanges: 0, environmentReadings: 0, maintenanceTasks: 0 };
  if (source.status === "MERGED") {
    if (source.mergedIntoId !== targetId) {
      throw new AppError(409, "MERGE_ALREADY_DONE", "来源设备已归并到其他设备");
    }
    return { sourceId, targetId, alreadyMerged: true, moved: empty, droppedDuplicates: empty };
  }
  if (source.status !== "ACTIVE") {
    throw new AppError(409, "MERGE_SOURCE_INVALID", "只有未退役的在用设备可以归并");
  }

  // 1. 找出与目标设备重复、归并时会被丢弃的维修事项及其附件对象
  const targetDedupeKeys = (
    await prisma.maintenanceTask.findMany({
      where: { instrumentId: targetId, dedupeKey: { not: null } },
      select: { dedupeKey: true },
    })
  ).map((task) => task.dedupeKey as string);
  const duplicateTasks = targetDedupeKeys.length
    ? await prisma.maintenanceTask.findMany({
        where: { instrumentId: sourceId, dedupeKey: { in: targetDedupeKeys } },
        select: { id: true, attachments: { select: { objectKey: true } } },
      })
    : [];
  const orphanKeys = new Set(duplicateTasks.flatMap((task) => task.attachments.map((attachment) => attachment.objectKey)));

  // 2. 先清理对象存储，失败则整个归并中止，数据未变可重试
  for (const objectKey of orphanKeys) {
    await deleteObject(objectKey);
  }

  // 3. 事务：去重 -> 转移 -> 标记来源已归并 -> 解除来源设备的生效预警
  const result = await prisma.$transaction(async (tx) => {
    const [targetChanges, targetReadings] = await Promise.all([
      tx.stringChange.findMany({ where: { instrumentId: targetId }, select: { changedAt: true, stringSet: true } }),
      tx.environmentReading.findMany({ where: { instrumentId: targetId }, select: { recordedAt: true } }),
    ]);
    const droppedChanges = targetChanges.length
      ? await tx.stringChange.deleteMany({
          where: {
            instrumentId: sourceId,
            OR: targetChanges.map((change) => ({ changedAt: change.changedAt, stringSet: change.stringSet })),
          },
        })
      : { count: 0 };
    const droppedReadings = targetReadings.length
      ? await tx.environmentReading.deleteMany({
          where: {
            instrumentId: sourceId,
            OR: targetReadings.map((reading) => ({ recordedAt: reading.recordedAt })),
          },
        })
      : { count: 0 };
    const droppedTasks = duplicateTasks.length
      ? await tx.maintenanceTask.deleteMany({ where: { id: { in: duplicateTasks.map((task) => task.id) } } })
      : { count: 0 };

    const movedChanges = await tx.stringChange.updateMany({ where: { instrumentId: sourceId }, data: { instrumentId: targetId } });
    const movedReadings = await tx.environmentReading.updateMany({ where: { instrumentId: sourceId }, data: { instrumentId: targetId } });
    const movedTasks = await tx.maintenanceTask.updateMany({ where: { instrumentId: sourceId }, data: { instrumentId: targetId } });

    await tx.maintenanceAlert.updateMany({
      where: { instrumentId: sourceId, status: "ACTIVE" },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await tx.instrument.update({
      where: { id: sourceId },
      data: { status: "MERGED", mergedIntoId: targetId, version: { increment: 1 } },
    });
    return {
      moved: { stringChanges: movedChanges.count, environmentReadings: movedReadings.count, maintenanceTasks: movedTasks.count },
      droppedDuplicates: { stringChanges: droppedChanges.count, environmentReadings: droppedReadings.count, maintenanceTasks: droppedTasks.count },
    };
  });

  // 4. 目标设备历史已变化，异步重算预警（任务幂等，可安全重跑）
  await enqueueMaintenanceScan(userId).catch(() => undefined);
  return { sourceId, targetId, alreadyMerged: false, ...result };
}

/** 删除维修事项附件：先清理对象存储，再删除数据库行。对象删除失败时行保留，可安全重试。 */
export async function deleteAttachment(userId: string, attachmentId: string): Promise<void> {
  const attachment = await prisma.maintenanceAttachment.findFirst({ where: { id: attachmentId, userId } });
  if (!attachment) throw new AppError(404, "RESOURCE_NOT_FOUND", "资源不存在或无权访问");
  await deleteObject(attachment.objectKey);
  await prisma.maintenanceAttachment.deleteMany({ where: { id: attachment.id, userId } });
}
