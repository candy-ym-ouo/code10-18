import { Queue } from "bullmq";
import { getConfig } from "../config/env.js";
import { getRedis } from "./redis.js";

let queue: Queue | undefined;

export function getMediaQueue(): Queue {
  if (!queue) {
    queue = new Queue("media-processing", { connection: getRedis().duplicate() });
  }
  return queue;
}

export async function enqueueProbe(mediaId: string): Promise<void> {
  await getMediaQueue().add(
    "probe-media",
    { mediaId },
    {
      jobId: `probe:${mediaId}:${Date.now()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

export async function enqueueCleanup(sessionId: string): Promise<void> {
  await getMediaQueue().add(
    "cleanup-session",
    { sessionId },
    {
      jobId: `cleanup:${sessionId}:${Date.now()}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

export async function enqueueExport(exportId: string): Promise<void> {
  await getMediaQueue().add(
    "export-data",
    { exportId },
    {
      jobId: `export:${exportId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}

/**
 * 触发指定用户的保养预警扫描。
 * jobId 按用户固定：排队或执行中的重复触发会被 BullMQ 去重；
 * 完成后立即移除任务记录，后续触发可再次入队，任务可安全重跑。
 */
export async function enqueueMaintenanceScan(userId: string): Promise<void> {
  await getMediaQueue().add(
    "maintenance-scan",
    { userId },
    {
      jobId: `maintenance-scan:${userId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: 500,
    },
  );
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
