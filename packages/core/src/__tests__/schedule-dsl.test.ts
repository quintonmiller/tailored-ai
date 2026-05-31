import { describe, expect, it } from "vitest";
import { compileSchedule, scheduleToCron } from "../cron/schedule-dsl.js";

describe("scheduleToCron", () => {
  it("passes through cron expressions unchanged", () => {
    const r = compileSchedule("0 9 * * 1-5");
    expect(r.cron).toBe("0 9 * * 1-5");
    expect(r.passthrough).toBe(true);
  });

  it("recognises */N minute intervals", () => {
    expect(scheduleToCron("every 5 minutes")).toBe("*/5 * * * *");
    expect(scheduleToCron("every 15 minutes")).toBe("*/15 * * * *");
    expect(scheduleToCron("every 1 minute")).toBe("*/1 * * * *");
    expect(scheduleToCron("every minute")).toBe("* * * * *");
  });

  it("recognises hour intervals", () => {
    expect(scheduleToCron("every hour")).toBe("0 * * * *");
    expect(scheduleToCron("hourly")).toBe("0 * * * *");
    expect(scheduleToCron("every 2 hours")).toBe("0 */2 * * *");
  });

  it("recognises 'every day at <time>' with am/pm", () => {
    expect(scheduleToCron("every day at 9am")).toBe("0 9 * * *");
    expect(scheduleToCron("every day at 12pm")).toBe("0 12 * * *");
    expect(scheduleToCron("every day at 12am")).toBe("0 0 * * *");
    expect(scheduleToCron("daily at 6pm")).toBe("0 18 * * *");
  });

  it("recognises 24h times and bare hours", () => {
    expect(scheduleToCron("every day at 14:30")).toBe("30 14 * * *");
    expect(scheduleToCron("every day at 09:00")).toBe("0 9 * * *");
    expect(scheduleToCron("every day at 17")).toBe("0 17 * * *");
  });

  it("handles weekdays and weekends", () => {
    expect(scheduleToCron("weekdays at 9am")).toBe("0 9 * * 1-5");
    expect(scheduleToCron("every weekday at 5pm")).toBe("0 17 * * 1-5");
    expect(scheduleToCron("weekends at 10am")).toBe("0 10 * * 0,6");
  });

  it("handles specific day names", () => {
    expect(scheduleToCron("every monday at 9am")).toBe("0 9 * * 1");
    expect(scheduleToCron("every friday at 5pm")).toBe("0 17 * * 5");
    expect(scheduleToCron("mondays at 8:30am")).toBe("30 8 * * 1");
  });

  it("'at <time>' is shorthand for 'every day at <time>'", () => {
    expect(scheduleToCron("at 9am")).toBe("0 9 * * *");
    expect(scheduleToCron("at noon")).toBe("0 12 * * *");
    expect(scheduleToCron("at midnight")).toBe("0 0 * * *");
  });

  it("rejects malformed DSL with a useful error", () => {
    expect(() => scheduleToCron("every blursday at 9am")).toThrow();
    expect(() => scheduleToCron("every day at 25:00")).toThrow();
    expect(() => scheduleToCron("nonsense")).toThrow();
    expect(() => scheduleToCron("")).toThrow(/empty/);
  });
});
