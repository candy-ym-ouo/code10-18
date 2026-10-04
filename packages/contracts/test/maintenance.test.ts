import { describe, expect, it } from "vitest";
import {
  buildMaintenanceAlerts,
  calculateStringAgeDays,
  canMergeInstruments,
  environmentReadingCreateSchema,
  evaluateEnvironmentReading,
  evaluateStringAge,
  instrumentCreateSchema,
} from "../src/index.js";

const now = new Date("2026-10-04T00:00:00.000Z");

describe("string age", () => {
  it("calculates whole days since the string change", () => {
    expect(calculateStringAgeDays(new Date("2026-07-06T12:00:00.000Z"), now)).toBe(89);
    expect(calculateStringAgeDays(null, now)).toBeNull();
    expect(calculateStringAgeDays(new Date("2026-10-05T00:00:00.000Z"), now)).toBeNull();
  });

  it("warns past the threshold and escalates beyond 1.5x", () => {
    expect(evaluateStringAge(90, 90)).toBeNull();
    expect(evaluateStringAge(91, 90)?.severity).toBe("WARNING");
    expect(evaluateStringAge(136, 90)?.severity).toBe("CRITICAL");
    expect(evaluateStringAge(null, 90)?.severity).toBe("INFO");
  });
});

describe("environment evaluation", () => {
  const range = { humidityMinPct: 40, humidityMaxPct: 60, temperatureMinC: 15, temperatureMaxC: 28 };

  it("passes readings inside the safe range", () => {
    expect(evaluateEnvironmentReading({ temperatureC: 22, humidityPct: 50, recordedAt: now }, range)).toBeNull();
    expect(evaluateEnvironmentReading(null, range)).toBeNull();
  });

  it("flags breaches and escalates when far outside the range", () => {
    const warning = evaluateEnvironmentReading({ temperatureC: 22, humidityPct: 63, recordedAt: now }, range);
    expect(warning?.severity).toBe("WARNING");
    expect(warning?.breaches[0]).toContain("湿度");
    const critical = evaluateEnvironmentReading({ temperatureC: 22, humidityPct: 25, recordedAt: now }, range);
    expect(critical?.severity).toBe("CRITICAL");
  });
});

describe("maintenance alerts", () => {
  it("combines string age, environment and overdue repairs", () => {
    const alerts = buildMaintenanceAlerts({
      now,
      stringChangedAt: new Date("2026-05-01T00:00:00.000Z"),
      stringMaxAgeDays: 90,
      latestEnvironment: { temperatureC: 22, humidityPct: 70, recordedAt: now },
      environmentRange: { humidityMinPct: 40, humidityMaxPct: 60, temperatureMinC: null, temperatureMaxC: null },
      overdueRepairCount: 2,
      oldestOverdueRepairDays: 10,
    });
    expect(alerts.map((alert) => alert.type)).toEqual(["STRING_AGE", "ENVIRONMENT", "REPAIR_OVERDUE"]);
    expect(alerts.find((alert) => alert.type === "REPAIR_OVERDUE")?.severity).toBe("CRITICAL");
  });

  it("stays quiet when everything is healthy", () => {
    const alerts = buildMaintenanceAlerts({
      now,
      stringChangedAt: new Date("2026-09-20T00:00:00.000Z"),
      stringMaxAgeDays: 90,
      latestEnvironment: { temperatureC: 22, humidityPct: 50, recordedAt: now },
      environmentRange: { humidityMinPct: 40, humidityMaxPct: 60, temperatureMinC: 15, temperatureMaxC: 28 },
      overdueRepairCount: 0,
      oldestOverdueRepairDays: null,
    });
    expect(alerts).toHaveLength(0);
  });
});

describe("instrument merge guard", () => {
  it("allows merging an active instrument and repeats are safe", () => {
    expect(canMergeInstruments({ status: "ACTIVE", mergedIntoId: null }, "target")).toEqual({ ok: true, alreadyMerged: false });
    expect(canMergeInstruments({ status: "MERGED", mergedIntoId: "target" }, "target")).toEqual({ ok: true, alreadyMerged: true });
  });

  it("rejects merging into a different target or while deleting", () => {
    expect(canMergeInstruments({ status: "MERGED", mergedIntoId: "other" }, "target")).toMatchObject({ ok: false, code: "INSTRUMENT_ALREADY_MERGED" });
    expect(canMergeInstruments({ status: "DELETING", mergedIntoId: null }, "target")).toMatchObject({ ok: false, code: "INVALID_INSTRUMENT_STATE" });
  });
});

describe("maintenance schemas", () => {
  it("rejects inverted humidity ranges", () => {
    const result = instrumentCreateSchema.safeParse({ name: "小提琴", category: "提琴", humidityMinPct: 70, humidityMaxPct: 40 });
    expect(result.success).toBe(false);
  });

  it("accepts a valid environment reading payload", () => {
    const result = environmentReadingCreateSchema.safeParse({ temperatureC: 21.5, humidityPct: 48, recordedAt: "2026-10-04T08:00:00.000Z" });
    expect(result.success).toBe(true);
  });
});
