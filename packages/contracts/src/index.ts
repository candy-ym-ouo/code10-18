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
export const INSTRUMENT_STATUSES = ["ACTIVE", "MERGED", "RETIRED", "DELETING", "DELETE_FAILED"] as const;
export const MAINTENANCE_TYPES = ["STRING_CHANGE", "CLEANING", "SETUP", "REPAIR", "INSPECTION", "OTHER"] as const;
export const REPAIR_STATUSES = ["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export const ATTACHMENT_STATUSES = ["PENDING_UPLOAD", "READY", "DELETING"] as const;
export const MAINTENANCE_ALERT_TYPES = ["STRING_AGE", "ENVIRONMENT", "REPAIR_OVERDUE"] as const;
export const ALERT_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;

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

const humiditySchema = (label: string) =>
  z.coerce.number().min(0, `${label}不能低于 0%`).max(100, `${label}不能高于 100%`).optional().nullable();
const temperatureSchema = (label: string) =>
  z.coerce.number().min(-40, `${label}不能低于 -40℃`).max(60, `${label}不能高于 60℃`).optional().nullable();

export const instrumentCreateSchema = z
  .object({
    name: requiredText("设备名称", 80),
    category: requiredText("乐器类别", 60),
    brand: optionalText(80, "品牌"),
    model: optionalText(80, "型号"),
    serialNo: optionalText(80, "序列号"),
    acquiredAt: z.coerce.date().optional().nullable(),
    stringChangedAt: z.coerce.date().optional().nullable(),
    stringMaxAgeDays: z.coerce.number().int().min(7, "弦龄预警阈值至少 7 天").max(730, "弦龄预警阈值不能超过 730 天").default(90),
    humidityMinPct: humiditySchema("湿度下限"),
    humidityMaxPct: humiditySchema("湿度上限"),
    temperatureMinC: temperatureSchema("温度下限"),
    temperatureMaxC: temperatureSchema("温度上限"),
    notes: optionalText(2000, "备注"),
  })
  .refine((value) => value.humidityMinPct == null || value.humidityMaxPct == null || value.humidityMinPct <= value.humidityMaxPct, {
    path: ["humidityMaxPct"],
    message: "湿度上限不能低于下限",
  })
  .refine((value) => value.temperatureMinC == null || value.temperatureMaxC == null || value.temperatureMinC <= value.temperatureMaxC, {
    path: ["temperatureMaxC"],
    message: "温度上限不能低于下限",
  });
export const instrumentUpdateSchema = z.object({
  name: requiredText("设备名称", 80).optional(),
  category: requiredText("乐器类别", 60).optional(),
  brand: optionalText(80, "品牌"),
  model: optionalText(80, "型号"),
  serialNo: optionalText(80, "序列号"),
  acquiredAt: z.coerce.date().optional().nullable(),
  stringChangedAt: z.coerce.date().optional().nullable(),
  stringMaxAgeDays: z.coerce.number().int().min(7).max(730).optional(),
  humidityMinPct: humiditySchema("湿度下限"),
  humidityMaxPct: humiditySchema("湿度上限"),
  temperatureMinC: temperatureSchema("温度下限"),
  temperatureMaxC: temperatureSchema("温度上限"),
  notes: optionalText(2000, "备注"),
  version: z.coerce.number().int().nonnegative(),
});
export const instrumentListQuerySchema = z.object({
  status: z.enum(["ACTIVE", "MERGED", "RETIRED", "ALL"]).default("ACTIVE"),
  category: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const instrumentMergeSchema = z.object({
  targetId: z.string().uuid(),
});

export const maintenanceCreateSchema = z.object({
  type: z.enum(MAINTENANCE_TYPES),
  performedAt: z.coerce.date(),
  stringBrand: optionalText(120, "琴弦型号"),
  cost: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
  vendor: optionalText(120, "店家或技师"),
  notes: optionalText(2000, "保养备注"),
});
export const maintenanceUpdateSchema = maintenanceCreateSchema.partial();
export const maintenanceListQuerySchema = z.object({
  type: z.enum(MAINTENANCE_TYPES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const environmentReadingCreateSchema = z.object({
  temperatureC: z.coerce.number().min(-40, "温度不能低于 -40℃").max(60, "温度不能高于 60℃"),
  humidityPct: z.coerce.number().min(0, "湿度不能低于 0%").max(100, "湿度不能高于 100%"),
  recordedAt: z.coerce.date(),
  source: optionalText(60, "来源"),
  note: optionalText(500, "备注"),
});
export const environmentListQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const repairCreateSchema = z.object({
  title: requiredText("维修事项", 160),
  description: optionalText(2000, "问题描述"),
  dueDate: z.coerce.date().optional().nullable(),
  cost: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
});
export const repairUpdateSchema = z.object({
  title: requiredText("维修事项", 160).optional(),
  description: optionalText(2000, "问题描述"),
  status: z.enum(REPAIR_STATUSES).optional(),
  dueDate: z.coerce.date().optional().nullable(),
  cost: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
  version: z.coerce.number().int().nonnegative(),
});
export const repairListQuerySchema = z.object({
  status: z.enum(REPAIR_STATUSES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const attachmentUploadSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  sizeBytes: z.coerce.bigint().positive(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/, "SHA-256 摘要格式不正确"),
  maintenanceId: z.string().uuid().optional().nullable(),
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
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];
export type RepairStatus = (typeof REPAIR_STATUSES)[number];
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];
export type MaintenanceAlertType = (typeof MAINTENANCE_ALERT_TYPES)[number];
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

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

const DAY_MS = 86_400_000;

export function calculateStringAgeDays(stringChangedAt: Date | null | undefined, now: Date): number | null {
  if (!stringChangedAt) return null;
  const ageMs = now.getTime() - stringChangedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return Math.floor(ageMs / DAY_MS);
}

export function evaluateStringAge(ageDays: number | null, maxAgeDays: number): { severity: AlertSeverity; message: string } | null {
  if (ageDays == null) return { severity: "INFO", message: "尚未记录换弦时间，无法评估弦龄" };
  if (maxAgeDays <= 0) return null;
  if (ageDays > maxAgeDays * 1.5) {
    return { severity: "CRITICAL", message: `琴弦已使用 ${ageDays} 天，严重超过建议更换周期 ${maxAgeDays} 天` };
  }
  if (ageDays > maxAgeDays) {
    return { severity: "WARNING", message: `琴弦已使用 ${ageDays} 天，超过建议更换周期 ${maxAgeDays} 天` };
  }
  return null;
}

export interface EnvironmentRange {
  humidityMinPct: number | null;
  humidityMaxPct: number | null;
  temperatureMinC: number | null;
  temperatureMaxC: number | null;
}

export interface EnvironmentSnapshot {
  temperatureC: number;
  humidityPct: number;
  recordedAt: Date;
}

export function evaluateEnvironmentReading(
  reading: EnvironmentSnapshot | null,
  range: EnvironmentRange,
): { severity: AlertSeverity; message: string; breaches: string[] } | null {
  if (!reading) return null;
  const breaches: string[] = [];
  let worst = 0;
  const check = (value: number, min: number | null, max: number | null, label: string, unit: string) => {
    if (min != null && value < min) {
      breaches.push(`${label} ${value}${unit} 低于安全下限 ${min}${unit}`);
      worst = Math.max(worst, min - value);
    }
    if (max != null && value > max) {
      breaches.push(`${label} ${value}${unit} 高于安全上限 ${max}${unit}`);
      worst = Math.max(worst, value - max);
    }
  };
  check(reading.humidityPct, range.humidityMinPct, range.humidityMaxPct, "湿度", "%");
  check(reading.temperatureC, range.temperatureMinC, range.temperatureMaxC, "温度", "℃");
  if (!breaches.length) return null;
  return {
    severity: worst > 5 ? "CRITICAL" : "WARNING",
    message: breaches.join("；"),
    breaches,
  };
}

export interface MaintenanceAlertResult {
  type: MaintenanceAlertType;
  severity: AlertSeverity;
  message: string;
  detail: Record<string, unknown>;
}

export function buildMaintenanceAlerts(input: {
  now: Date;
  stringChangedAt: Date | null;
  stringMaxAgeDays: number;
  latestEnvironment: EnvironmentSnapshot | null;
  environmentRange: EnvironmentRange;
  overdueRepairCount: number;
  oldestOverdueRepairDays: number | null;
}): MaintenanceAlertResult[] {
  const alerts: MaintenanceAlertResult[] = [];
  const ageDays = calculateStringAgeDays(input.stringChangedAt, input.now);
  const stringAlert = evaluateStringAge(ageDays, input.stringMaxAgeDays);
  if (stringAlert) {
    alerts.push({
      type: "STRING_AGE",
      severity: stringAlert.severity,
      message: stringAlert.message,
      detail: { ageDays, maxAgeDays: input.stringMaxAgeDays },
    });
  }
  const environmentAlert = evaluateEnvironmentReading(input.latestEnvironment, input.environmentRange);
  if (environmentAlert) {
    alerts.push({
      type: "ENVIRONMENT",
      severity: environmentAlert.severity,
      message: environmentAlert.message,
      detail: {
        breaches: environmentAlert.breaches,
        recordedAt: input.latestEnvironment?.recordedAt.toISOString() ?? null,
      },
    });
  }
  if (input.overdueRepairCount > 0) {
    const days = input.oldestOverdueRepairDays ?? 0;
    alerts.push({
      type: "REPAIR_OVERDUE",
      severity: days > 7 ? "CRITICAL" : "WARNING",
      message: `有 ${input.overdueRepairCount} 项维修事项已逾期，最早逾期 ${days} 天`,
      detail: { overdueCount: input.overdueRepairCount, oldestOverdueDays: days },
    });
  }
  return alerts;
}

export function canMergeInstruments(
  source: { status: InstrumentStatus; mergedIntoId: string | null },
  targetId: string,
): { ok: true; alreadyMerged: boolean } | { ok: false; code: string; message: string } {
  if (source.status === "MERGED") {
    if (source.mergedIntoId === targetId) return { ok: true, alreadyMerged: true };
    return { ok: false, code: "INSTRUMENT_ALREADY_MERGED", message: "设备已归并到其他设备，不能重复归并" };
  }
  if (source.status === "DELETING" || source.status === "DELETE_FAILED") {
    return { ok: false, code: "INVALID_INSTRUMENT_STATE", message: "设备正在删除中，不能归并" };
  }
  return { ok: true, alreadyMerged: false };
}
