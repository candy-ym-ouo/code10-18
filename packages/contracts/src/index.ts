import { z } from "zod";

export const SESSION_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "COMPLETED",
  "ARCHIVED",
  "DELETING",
  "DELETE_FAILED",
] as const;
export const MEDIA_STATUSES = [
  "PENDING_UPLOAD",
  "UPLOADING",
  "UPLOADED",
  "PROCESSING",
  "READY",
  "FAILED",
  "CANCELLED",
] as const;
export const ANNOTATION_TYPES = ["RHYTHM", "FINGERING", "EMOTION"] as const;
export const GOAL_CATEGORIES = [
  "RHYTHM",
  "FINGERING",
  "EMOTION",
  "CONTINUITY",
  "PITCH",
  "SPEED",
  "REPERTOIRE",
  "OTHER",
] as const;
export const METRIC_TYPES = [
  "DURATION",
  "COUNT",
  "SPEED",
  "ACCURACY",
  "SUBJECTIVE_SCORE",
  "CUSTOM",
] as const;
export const EVIDENCE_REQUIREMENTS = ["NONE", "AUDIO", "SELF_REVIEW", "AUDIO_AND_SELF_REVIEW"] as const;
export const GOAL_STATUSES = ["OPEN", "IN_PROGRESS", "ACHIEVED", "MISSED", "CANCELLED"] as const;
export const INSTRUMENT_STATUSES = ["ACTIVE", "RETIRED", "MERGED"] as const;
export const MAINTENANCE_TASK_TYPES = ["STRING_CHANGE", "SETUP", "REPAIR", "CLEANING", "INSPECTION", "OTHER"] as const;
export const MAINTENANCE_TASK_STATUSES = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export const MAINTENANCE_ALERT_TYPES = ["STRING_AGE", "ENVIRONMENT", "TASK_DUE"] as const;
export const MAINTENANCE_ALERT_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;
export const ATTACHMENT_STATUSES = ["PENDING_UPLOAD", "READY", "FAILED"] as const;

export const DEFAULT_STRING_LIFESPAN_DAYS = 90;
export const DEFAULT_HUMIDITY_MIN = 40;
export const DEFAULT_HUMIDITY_MAX = 60;
export const TASK_DUE_SOON_DAYS = 7;

const requiredText = (label: string, max: number) =>
  z.string().trim().min(1, `${label}不能为空`).max(max, `${label}不能超过 ${max} 个字符`);
const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label}不能超过 ${max} 个字符`).optional().nullable();

export const emailSchema = z.string().trim().toLowerCase().email("邮箱格式不正确").max(254);
export const passwordSchema = z
  .string()
  .min(10, "密码至少 10 位")
  .max(128, "密码不能超过 128 位")
  .regex(/[A-Za-z]/, "密码必须包含字母")
  .regex(/[0-9]/, "密码必须包含数字");

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: requiredText("展示名", 80),
});
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "请输入密码").max(128),
});
export const updateProfileSchema = z.object({
  displayName: requiredText("展示名", 80).optional(),
  defaultInstrument: optionalText(60, "默认乐器"),
  timezone: z.string().trim().min(1).max(64).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const sessionCreateSchema = z.object({
  title: requiredText("练习标题", 120),
  instrument: requiredText("乐器", 60),
  startedAt: z.coerce.date(),
  focus: optionalText(500, "本次重点"),
  location: optionalText(120, "练习地点"),
  notes: optionalText(5000, "总体备注"),
  actualDurationMs: z.coerce.number().int().positive().max(86_400_000).optional().nullable(),
});
export const sessionUpdateSchema = sessionCreateSchema
  .partial()
  .extend({ version: z.coerce.number().int().nonnegative() });
export const sessionBatchSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
export const sessionListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum([...SESSION_STATUSES, "ALL"]).default("COMPLETED"),
  instrument: z.string().trim().max(60).optional(),
  annotationType: z.enum(ANNOTATION_TYPES).optional(),
  goalStatus: z.enum(GOAL_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sortBy: z.enum(["startedAt", "actualDurationMs", "annotationCount", "updatedAt"]).default("startedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const annotationCreateBaseSchema = z.object({
  mediaId: z.string().uuid(),
  type: z.enum(ANNOTATION_TYPES),
  severity: z.coerce.number().int().min(1).max(5),
  startMs: z.coerce.number().int().nonnegative(),
  endMs: z.coerce.number().int().positive(),
  title: requiredText("短标题", 80),
  description: optionalText(2000, "详细描述"),
  nextAction: optionalText(1000, "建议动作"),
});

export const annotationCreateSchema = annotationCreateBaseSchema
  .refine((value) => value.endMs > value.startMs, {
    path: ["endMs"],
    message: "结束时间必须晚于开始时间",
  })
  .refine((value) => value.endMs - value.startMs >= 100, {
    path: ["endMs"],
    message: "标记区间至少 100 毫秒",
  });
export const annotationUpdateSchema = annotationCreateBaseSchema.partial().omit({ mediaId: true });
export const annotationListQuerySchema = z.object({
  mediaId: z.string().uuid().optional(),
  type: z.enum(ANNOTATION_TYPES).optional(),
});

export const reviewDraftSchema = z.object({
  goodPoints: optionalText(3000, "做得好的地方"),
  mainIssues: optionalText(3000, "主要问题"),
  nextFocus: optionalText(500, "下次练习重点"),
  noIssues: z.boolean().default(false),
  suggestedNextPracticeAt: z.coerce.date().optional().nullable(),
});
export const reviewSaveSchema = reviewDraftSchema.extend({
  version: z.coerce.number().int().nonnegative(),
});

export const goalCreateSchema = z.object({
  sourceSessionId: z.string().uuid(),
  annotationId: z.string().uuid().optional().nullable(),
  title: requiredText("目标标题", 160),
  category: z.enum(GOAL_CATEGORIES),
  metricType: z.enum(METRIC_TYPES),
  baselineValue: z.coerce.number().finite().optional().nullable(),
  targetValue: z.coerce.number().finite(),
  unit: requiredText("单位", 24),
  dueDate: z.coerce.date(),
  method: optionalText(3000, "练习方法"),
  evidenceRequirement: z.enum(EVIDENCE_REQUIREMENTS),
});
export const goalUpdateSchema = goalCreateSchema
  .omit({ sourceSessionId: true })
  .partial()
  .extend({ version: z.coerce.number().int().nonnegative() });
export const goalListQuerySchema = z.object({
  status: z.enum(GOAL_STATUSES).optional(),
  category: z.enum(GOAL_CATEGORIES).optional(),
  instrument: z.string().trim().max(60).optional(),
  dueBefore: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const goalProgressCreateSchema = z.object({
  sessionId: z.string().uuid(),
  actualValue: z.coerce.number().finite(),
  note: optionalText(1000, "进度备注"),
  evidenceMediaId: z.string().uuid().optional().nullable(),
  recordedAt: z.coerce.date().optional(),
});
export const goalCancelSchema = z.object({ reason: requiredText("取消原因", 1000) });
export const goalActivateSchema = z.object({
  dueDate: z.coerce.date().optional(),
  targetValue: z.coerce.number().finite().optional(),
});

export const completionGoalProgressSchema = goalProgressCreateSchema.omit({ sessionId: true }).extend({
  goalId: z.string().uuid(),
});

export const completionSchema = z.object({
  version: z.coerce.number().int().nonnegative(),
  review: reviewDraftSchema.extend({ nextFocus: requiredText("下次练习重点", 500) }),
  goalCreates: z.array(goalCreateSchema.omit({ sourceSessionId: true })).default([]),
  goalProgressUpdates: z.array(completionGoalProgressSchema).default([]),
  annotationVersion: z.coerce.number().int().nonnegative().optional(),
});

export const statisticsRangeSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  timezone: z.string().trim().min(1).max(64).default("Asia/Shanghai"),
  instrument: z.string().trim().max(60).optional(),
});

export const createExportSchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const instrumentCreateSchema = z.object({
  name: requiredText("设备名称", 80),
  category: requiredText("乐器类别", 60),
  brand: optionalText(80, "品牌"),
  model: optionalText(80, "型号"),
  serialNo: optionalText(80, "序列号"),
  acquiredAt: z.coerce.date().optional().nullable(),
  stringSet: optionalText(120, "当前琴弦"),
  stringLifespanDays: z.coerce.number().int().min(7).max(730).default(DEFAULT_STRING_LIFESPAN_DAYS),
  humidityMin: z.coerce.number().min(0).max(100).default(DEFAULT_HUMIDITY_MIN),
  humidityMax: z.coerce.number().min(0).max(100).default(DEFAULT_HUMIDITY_MAX),
  notes: optionalText(2000, "备注"),
});
export const instrumentUpdateSchema = instrumentCreateSchema.partial().extend({
  version: z.coerce.number().int().nonnegative(),
});
export const instrumentMergeSchema = z.object({
  targetId: z.string().uuid(),
});
export const instrumentListQuerySchema = z.object({
  status: z.enum([...INSTRUMENT_STATUSES, "ALL"]).default("ACTIVE"),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const stringChangeCreateSchema = z.object({
  stringSet: requiredText("琴弦型号", 120),
  changedAt: z.coerce.date(),
  note: optionalText(1000, "备注"),
});

export const environmentReadingCreateSchema = z
  .object({
    recordedAt: z.coerce.date(),
    temperatureC: z.coerce.number().min(-40).max(60).optional().nullable(),
    humidityPct: z.coerce.number().min(0).max(100).optional().nullable(),
    location: optionalText(120, "存放位置"),
    note: optionalText(1000, "备注"),
  })
  .refine((value) => value.temperatureC != null || value.humidityPct != null, {
    path: ["humidityPct"],
    message: "温度和湿度至少填写一项",
  });

export const maintenanceTaskCreateSchema = z.object({
  type: z.enum(MAINTENANCE_TASK_TYPES),
  title: requiredText("事项标题", 160),
  description: optionalText(3000, "详细描述"),
  dueDate: z.coerce.date().optional().nullable(),
  cost: z.coerce.number().min(0).max(10_000_000).optional().nullable(),
  shop: optionalText(120, "维修店铺"),
  dedupeKey: z.string().trim().min(1).max(80).optional().nullable(),
});
export const maintenanceTaskUpdateSchema = maintenanceTaskCreateSchema.partial().extend({
  version: z.coerce.number().int().nonnegative(),
});
export const maintenanceTaskListQuerySchema = z.object({
  status: z.enum(MAINTENANCE_TASK_STATUSES).optional(),
  type: z.enum(MAINTENANCE_TASK_TYPES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const attachmentUploadSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  sizeBytes: z.coerce.bigint().positive(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/, "SHA-256 摘要格式不正确"),
});

export const maintenanceAlertListQuerySchema = z.object({
  status: z.enum(["ACTIVE", "RESOLVED", "ALL"]).default("ACTIVE"),
  instrumentId: z.string().uuid().optional(),
});

export const idSchema = z.string().uuid();

export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type MediaStatus = (typeof MEDIA_STATUSES)[number];
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];
export type MetricType = (typeof METRIC_TYPES)[number];
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type EvidenceRequirement = (typeof EVIDENCE_REQUIREMENTS)[number];
export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number];
export type MaintenanceTaskType = (typeof MAINTENANCE_TASK_TYPES)[number];
export type MaintenanceTaskStatus = (typeof MAINTENANCE_TASK_STATUSES)[number];
export type MaintenanceAlertType = (typeof MAINTENANCE_ALERT_TYPES)[number];
export type MaintenanceAlertSeverity = (typeof MAINTENANCE_ALERT_SEVERITIES)[number];

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    traceId?: string;
  };
}

const allowedTransitions: Record<SessionStatus, SessionStatus[]> = {
  DRAFT: ["IN_REVIEW", "DELETING"],
  IN_REVIEW: ["DRAFT", "COMPLETED", "DELETING"],
  COMPLETED: ["ARCHIVED", "DELETING", "COMPLETED"],
  ARCHIVED: ["COMPLETED", "DELETING"],
  DELETING: ["DELETE_FAILED"],
  DELETE_FAILED: ["DELETING"],
};

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

export function validateAnnotationRange(
  startMs: number,
  endMs: number,
  durationMs?: number | null,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!Number.isInteger(startMs) || startMs < 0) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "开始时间必须是非负整数毫秒值" };
  }
  if (!Number.isInteger(endMs) || endMs <= startMs) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "结束时间必须晚于开始时间" };
  }
  if (endMs - startMs < 100) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "标记区间至少 100 毫秒" };
  }
  if (durationMs != null && endMs > durationMs) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "标记结束时间不能超出音频时长" };
  }
  return { ok: true };
}

export function isGoalProgressValid(actualValue: number, targetValue: number): boolean {
  return Number.isFinite(actualValue) && Number.isFinite(targetValue) && actualValue >= targetValue;
}

export function calculateSessionDuration(mediaDurationsMs: Array<number | null | undefined>): number {
  return mediaDurationsMs.reduce<number>((total, duration) => total + (duration && duration > 0 ? duration : 0), 0);
}

const MS_PER_DAY = 86_400_000;

export interface MaintenanceEvaluation {
  level: "NONE" | MaintenanceAlertSeverity;
  message: string | null;
}

/**
 * 弦龄评估：以最近一次换弦时间为起点，按设备寿命阈值分级。
 * 未记录换弦时给出 INFO，提醒补录；超过 1.5 倍寿命升级为 CRITICAL。
 */
export function evaluateStringAge(
  lastChangeAt: Date | null,
  lifespanDays: number,
  now: Date = new Date(),
): MaintenanceEvaluation & { ageDays: number | null } {
  if (!lastChangeAt) {
    return { level: "INFO", ageDays: null, message: "尚未记录换弦，建议补录换弦时间以跟踪弦龄" };
  }
  const ageDays = Math.floor((now.getTime() - lastChangeAt.getTime()) / MS_PER_DAY);
  if (ageDays >= Math.ceil(lifespanDays * 1.5)) {
    return { level: "CRITICAL", ageDays, message: `琴弦已使用 ${ageDays} 天，远超 ${lifespanDays} 天建议寿命，请尽快更换` };
  }
  if (ageDays >= lifespanDays) {
    return { level: "WARNING", ageDays, message: `琴弦已使用 ${ageDays} 天，达到 ${lifespanDays} 天建议寿命，建议更换` };
  }
  return { level: "NONE", ageDays, message: null };
}

/** 环境评估：湿度超出设备安全区间时预警。 */
export function evaluateEnvironmentHumidity(
  humidityPct: number | null,
  humidityMin: number,
  humidityMax: number,
): MaintenanceEvaluation {
  if (humidityPct == null) return { level: "NONE", message: null };
  if (humidityPct < humidityMin) {
    return { level: "WARNING", message: `环境湿度 ${humidityPct}% 低于安全下限 ${humidityMin}%，注意加湿防裂` };
  }
  if (humidityPct > humidityMax) {
    return { level: "WARNING", message: `环境湿度 ${humidityPct}% 高于安全上限 ${humidityMax}%，注意防潮` };
  }
  return { level: "NONE", message: null };
}

/** 维修事项到期评估：逾期 WARNING，7 天内到期 INFO。 */
export function evaluateTaskDue(
  dueDate: Date | null,
  status: MaintenanceTaskStatus,
  now: Date = new Date(),
): MaintenanceEvaluation {
  if (!dueDate || status === "DONE" || status === "CANCELLED") return { level: "NONE", message: null };
  const days = Math.ceil((dueDate.getTime() - now.getTime()) / MS_PER_DAY);
  if (days < 0) return { level: "WARNING", message: `保养事项已逾期 ${-days} 天` };
  if (days <= TASK_DUE_SOON_DAYS) return { level: "INFO", message: `保养事项将于 ${days} 天后到期` };
  return { level: "NONE", message: null };
}

export interface DesiredAlert {
  dedupeKey: string;
  type: MaintenanceAlertType;
  severity: MaintenanceAlertSeverity;
  message: string;
}

export interface ExistingAlert {
  dedupeKey: string;
  status: "ACTIVE" | "RESOLVED";
  severity: string;
  message: string;
}

export interface AlertTransitionPlan {
  /** 需要写入的预警（新建、重新激活或内容变化），按 dedupeKey upsert，重复执行结果一致 */
  upserts: DesiredAlert[];
  /** 条件已不满足、需要解除的预警 */
  resolveKeys: string[];
}

/**
 * 对比期望预警与已有快照，计算最小写集合。
 * 应用结果后再次运行会得到空的 upserts/resolveKeys，因此扫描任务可安全重跑。
 */
export function planAlertTransitions(existing: ExistingAlert[], desired: DesiredAlert[]): AlertTransitionPlan {
  const existingByKey = new Map(existing.map((alert) => [alert.dedupeKey, alert]));
  const upserts = desired.filter((item) => {
    const current = existingByKey.get(item.dedupeKey);
    return !current || current.status !== "ACTIVE" || current.severity !== item.severity || current.message !== item.message;
  });
  const desiredKeys = new Set(desired.map((item) => item.dedupeKey));
  const resolveKeys = existing
    .filter((alert) => alert.status === "ACTIVE" && !desiredKeys.has(alert.dedupeKey))
    .map((alert) => alert.dedupeKey);
  return { upserts, resolveKeys };
}

export function describeMissingReview(input: {
  readyMediaCount: number;
  annotationCount: number;
  noIssues: boolean;
  nextFocus?: string | null;
  openGoalCount: number;
  newGoalCount: number;
  progressUpdateCount: number;
}): string[] {
  const missing: string[] = [];
  if (input.readyMediaCount < 1) missing.push("至少需要一段已解析完成的音频");
  if (input.annotationCount < 1 && !input.noIssues) missing.push("请至少添加一个问题标记，或声明本次无异常");
  if (!input.nextFocus?.trim()) missing.push("请填写下次练习重点");
  if (input.openGoalCount < 1 && input.newGoalCount < 1) missing.push("请至少创建一个可执行目标");
  if (input.openGoalCount > 0 && input.progressUpdateCount < 1) {
    missing.push("已有未关闭目标时，本次至少记录一次目标进度");
  }
  return missing;
}
