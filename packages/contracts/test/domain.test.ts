import { describe, expect, it } from "vitest";
import {
  calculateSessionDuration,
  canTransitionSession,
  describeMissingReview,
  evaluateEnvironmentHumidity,
  evaluateStringAge,
  evaluateTaskDue,
  isGoalProgressValid,
  planAlertTransitions,
  validateAnnotationRange,
  type DesiredAlert,
  type ExistingAlert,
} from "../src/index.js";

describe("session state machine", () => {
  it("allows the required completion transition", () => {
    expect(canTransitionSession("IN_REVIEW", "COMPLETED")).toBe(true);
    expect(canTransitionSession("DRAFT", "COMPLETED")).toBe(false);
  });
});

describe("annotation range", () => {
  it("rejects ranges under 100ms and outside media", () => {
    expect(validateAnnotationRange(100, 150, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(900, 1100, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(100, 250, 1000)).toEqual({ ok: true });
  });
});

describe("review completion", () => {
  it("returns every missing item instead of a generic failure", () => {
    expect(
      describeMissingReview({
        readyMediaCount: 0,
        annotationCount: 0,
        noIssues: false,
        nextFocus: "",
        openGoalCount: 0,
        newGoalCount: 0,
        progressUpdateCount: 0,
      }),
    ).toHaveLength(4);
  });
});

describe("goal values", () => {
  it("suggests achieved only when actual reaches target", () => {
    expect(isGoalProgressValid(90, 88)).toBe(true);
    expect(isGoalProgressValid(87, 88)).toBe(false);
  });

  it("sums only valid media durations", () => {
    expect(calculateSessionDuration([1000, null, 2500, -1])).toBe(3500);
  });
});

describe("string age evaluation", () => {
  const now = new Date("2026-10-04T00:00:00Z");

  it("asks for a record when no string change exists", () => {
    const result = evaluateStringAge(null, 90, now);
    expect(result.level).toBe("INFO");
    expect(result.ageDays).toBeNull();
  });

  it("stays quiet below the lifespan and warns beyond it", () => {
    expect(evaluateStringAge(new Date("2026-08-01T00:00:00Z"), 90, now).level).toBe("NONE");
    const warning = evaluateStringAge(new Date("2026-06-20T00:00:00Z"), 90, now);
    expect(warning.level).toBe("WARNING");
    expect(warning.ageDays).toBe(106);
  });

  it("escalates to critical beyond 1.5x the lifespan", () => {
    expect(evaluateStringAge(new Date("2026-04-01T00:00:00Z"), 90, now).level).toBe("CRITICAL");
  });
});

describe("environment humidity evaluation", () => {
  it("warns outside the safe range and stays quiet inside", () => {
    expect(evaluateEnvironmentHumidity(35, 40, 60).level).toBe("WARNING");
    expect(evaluateEnvironmentHumidity(65, 40, 60).level).toBe("WARNING");
    expect(evaluateEnvironmentHumidity(50, 40, 60).level).toBe("NONE");
    expect(evaluateEnvironmentHumidity(null, 40, 60).level).toBe("NONE");
  });
});

describe("task due evaluation", () => {
  const now = new Date("2026-10-04T00:00:00Z");

  it("warns when overdue and informs within the due-soon window", () => {
    expect(evaluateTaskDue(new Date("2026-10-01T00:00:00Z"), "OPEN", now).level).toBe("WARNING");
    expect(evaluateTaskDue(new Date("2026-10-06T00:00:00Z"), "IN_PROGRESS", now).level).toBe("INFO");
    expect(evaluateTaskDue(new Date("2026-12-01T00:00:00Z"), "OPEN", now).level).toBe("NONE");
  });

  it("ignores closed tasks and missing due dates", () => {
    expect(evaluateTaskDue(new Date("2026-10-01T00:00:00Z"), "DONE", now).level).toBe("NONE");
    expect(evaluateTaskDue(new Date("2026-10-01T00:00:00Z"), "CANCELLED", now).level).toBe("NONE");
    expect(evaluateTaskDue(null, "OPEN", now).level).toBe("NONE");
  });
});

describe("alert transition planning", () => {
  const desired: DesiredAlert[] = [
    { dedupeKey: "string-age:a", type: "STRING_AGE", severity: "WARNING", message: "琴弦已使用 100 天" },
    { dedupeKey: "task-due:b", type: "TASK_DUE", severity: "INFO", message: "保养事项将于 3 天后到期" },
  ];

  it("creates missing alerts and resolves stale ones", () => {
    const existing: ExistingAlert[] = [
      { dedupeKey: "string-age:a", status: "ACTIVE", severity: "WARNING", message: "琴弦已使用 100 天" },
      { dedupeKey: "environment:a", status: "ACTIVE", severity: "WARNING", message: "湿度过低" },
    ];
    const plan = planAlertTransitions(existing, desired);
    expect(plan.upserts.map((item) => item.dedupeKey)).toEqual(["task-due:b"]);
    expect(plan.resolveKeys).toEqual(["environment:a"]);
  });

  it("re-activates resolved alerts when the condition returns", () => {
    const existing: ExistingAlert[] = [
      { dedupeKey: "string-age:a", status: "RESOLVED", severity: "WARNING", message: "琴弦已使用 100 天" },
    ];
    const plan = planAlertTransitions(existing, desired);
    expect(plan.upserts.map((item) => item.dedupeKey)).toContain("string-age:a");
  });

  it("is idempotent: applying the plan yields an empty follow-up plan", () => {
    const first = planAlertTransitions([], desired);
    expect(first.upserts).toHaveLength(2);
    expect(first.resolveKeys).toHaveLength(0);
    // 应用首轮结果后的快照
    const snapshot: ExistingAlert[] = first.upserts.map((item) => ({
      dedupeKey: item.dedupeKey,
      status: "ACTIVE",
      severity: item.severity,
      message: item.message,
    }));
    const second = planAlertTransitions(snapshot, desired);
    expect(second.upserts).toHaveLength(0);
    expect(second.resolveKeys).toHaveLength(0);
  });
});
