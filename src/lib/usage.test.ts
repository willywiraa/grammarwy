import { describe, expect, it } from "vitest";
import {
  describeUsage,
  formatCount,
  formatResetTime,
  parseUsage,
  readUsageHeaders,
  usageHeaders,
  type DailyUsage,
} from "./usage";

const USAGE: DailyUsage = { limit: 100, remaining: 87, resetAt: "2026-11-15T00:00:00.000Z" };
// Jakarta is 7 hours ahead of UTC, so 00:00 UTC is 07:00 there.
const JAKARTA = { locale: "en-GB", timeZone: "Asia/Jakarta" };

describe("usage headers", () => {
  it("carry today's count from the server to the page", () => {
    expect(usageHeaders(USAGE)).toEqual({
      "X-Daily-Limit": "100",
      "X-Daily-Remaining": "87",
      "X-Daily-Reset": "2026-11-15T00:00:00.000Z",
    });
    expect(readUsageHeaders(new Headers(usageHeaders(USAGE)))).toEqual(USAGE);
  });

  it("are left out when corrections aren't counted", () => {
    expect(usageHeaders(null)).toEqual({});
    expect(readUsageHeaders(new Headers())).toBeNull();
  });

  it.each<[string, Record<string, string>]>([
    ["a missing limit", { "X-Daily-Remaining": "87", "X-Daily-Reset": USAGE.resetAt }],
    ["a count that isn't a number", { ...usageHeaders(USAGE), "X-Daily-Remaining": "lots" }],
    ["an empty count", { ...usageHeaders(USAGE), "X-Daily-Remaining": "" }],
    ["a time that isn't a time", { ...usageHeaders(USAGE), "X-Daily-Reset": "tomorrow" }],
  ])("are ignored with %s", (_, headers) => {
    expect(readUsageHeaders(new Headers(headers))).toBeNull();
  });
});

describe("parseUsage", () => {
  it("accepts a count from the server", () => {
    expect(parseUsage({ ...USAGE, extra: true })).toEqual(USAGE);
    expect(parseUsage({ ...USAGE, remaining: 0 })).toEqual({ ...USAGE, remaining: 0 });
  });

  it.each<[string, unknown]>([
    ["nothing", null],
    ["text", "87"],
    ["a limit of 0", { ...USAGE, limit: 0 }],
    ["more left than the limit", { ...USAGE, remaining: 101 }],
    ["fewer than 0 left", { ...USAGE, remaining: -1 }],
    ["a count with a fraction", { ...USAGE, remaining: 1.5 }],
    ["a count as text", { ...USAGE, remaining: "87" }],
    ["no reset time", { limit: 100, remaining: 87 }],
  ])("rejects %s", (_, value) => {
    expect(parseUsage(value)).toBeNull();
  });
});

describe("describeUsage", () => {
  it("says how many corrections are left today", () => {
    expect(describeUsage(USAGE)).toBe("87 of 100 corrections left today");
    expect(describeUsage({ ...USAGE, limit: 1000, remaining: 1 })).toBe("1 of 1,000 corrections left today");
  });

  it("says when more are possible once none are left", () => {
    const evening = new Date("2026-11-14T15:00:00.000Z"); // 22:00 in Jakarta
    expect(describeUsage({ ...USAGE, remaining: 0 }, evening, JAKARTA)).toBe(
      "No corrections left today. You can correct more from 7:00 tomorrow.",
    );
  });
});

describe("formatResetTime", () => {
  it("shows the time in your own time zone, on the same day", () => {
    const early = new Date("2026-11-14T20:00:00.000Z"); // 03:00 on the 15th in Jakarta
    expect(formatResetTime(USAGE.resetAt, early, JAKARTA)).toBe("7:00");
  });

  it('adds "tomorrow" when the time is on the next day', () => {
    const morning = new Date("2026-11-14T03:00:00.000Z"); // 10:00 on the 14th in Jakarta
    expect(formatResetTime(USAGE.resetAt, morning, JAKARTA)).toBe("7:00 tomorrow");
  });

  it("follows the language's clock style", () => {
    const early = new Date("2026-11-14T20:00:00.000Z");
    expect(formatResetTime(USAGE.resetAt, early, { locale: "en-US", timeZone: "Asia/Jakarta" })).toBe("7:00 AM");
  });
});

describe("formatCount", () => {
  it("adds thousands separators", () => {
    expect(formatCount(5000)).toBe("5,000");
    expect(formatCount(87)).toBe("87");
  });
});
