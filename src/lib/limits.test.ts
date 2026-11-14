// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// A fake Upstash client: the tests never reach a real database.
const fake = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[], eval: vi.fn(), get: vi.fn() }));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    eval = fake.eval;
    get = fake.get;
    constructor(config: Record<string, unknown>) {
      if (config.url === "not a url") {
        throw new Error(`Upstash Redis client was passed an invalid URL: ${config.url}`);
      }
      fake.configs.push(config);
    }
  },
}));

const URL = "https://example-db.upstash.io";
const NOW = new Date("2026-11-14T03:25:40.000Z");
const MIDNIGHT = "2026-11-15T00:00:00.000Z";
const KEYS = ["grammarwy:development:minute:2026-11-14T03:25", "grammarwy:development:day:2026-11-14"];

/** A fresh copy of the module, so its saved client and "warned once" note start empty. */
async function load() {
  vi.resetModules();
  return import("./limits");
}

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  fake.configs.length = 0;
  fake.eval.mockReset();
  fake.get.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("UPSTASH_REDIS_REST_URL", URL);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
  for (const name of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "LIMIT_PER_MINUTE", "LIMIT_PER_DAY", "VERCEL_ENV"]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("countCorrection", () => {
  it("counts a correction and says how many are left today", async () => {
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([0, 13]);

    expect(await countCorrection(NOW)).toEqual({
      allowed: true,
      usage: { limit: 100, remaining: 87, resetAt: MIDNIGHT },
    });
    expect(fake.eval).toHaveBeenCalledWith(expect.stringContaining('redis.call("INCR"'), KEYS, [10, 100, 120, 172_800]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks the database once, stops waiting after 1 second and sends no telemetry", async () => {
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([0, 1]);
    await countCorrection(NOW);

    expect(fake.configs).toEqual([
      expect.objectContaining({ url: URL, token: "test-token", retry: { retries: 0 }, enableTelemetry: false }),
    ]);
    const signal = (fake.configs[0].signal as () => AbortSignal)();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("reuses the client for the next correction", async () => {
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([0, 1]);
    await countCorrection(NOW);
    await countCorrection(NOW);
    expect(fake.configs).toHaveLength(1);
  });

  it("also reads the settings under the names Vercel KV used, without spaces", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", " ");
    vi.stubEnv("KV_REST_API_URL", ` ${URL} `);
    vi.stubEnv("KV_REST_API_TOKEN", "kv-token\n");
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([0, 1]);
    await countCorrection(NOW);
    expect(fake.configs[0]).toMatchObject({ url: URL, token: "kv-token" });
  });

  it.each(["production", "preview"])("keeps the %s counters apart from the others", async (environment) => {
    vi.stubEnv("VERCEL_ENV", environment);
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([0, 1]);
    await countCorrection(NOW);
    expect(fake.eval.mock.calls[0][1]).toEqual([
      `grammarwy:${environment}:minute:2026-11-14T03:25`,
      `grammarwy:${environment}:day:2026-11-14`,
    ]);
  });

  it("stops a correction when the limit per minute is reached", async () => {
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([1, 42]);
    expect(await countCorrection(NOW)).toEqual({
      allowed: false,
      period: "minute",
      limit: 10,
      retryAfter: 20,
      resetAt: "2026-11-14T03:26:00.000Z",
      usage: { limit: 100, remaining: 58, resetAt: MIDNIGHT },
    });
  });

  it("stops a correction when the limit per day is reached, until 00:00 UTC", async () => {
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([2, 100]);
    expect(await countCorrection(NOW)).toEqual({
      allowed: false,
      period: "day",
      limit: 100,
      retryAfter: 20 * 3600 + 34 * 60 + 20,
      resetAt: MIDNIGHT,
      usage: { limit: 100, remaining: 0, resetAt: MIDNIGHT },
    });
  });

  it("waits at least 1 second", async () => {
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([1, 5]);
    const decision = await countCorrection(new Date("2026-11-14T03:25:59.900Z"));
    expect(decision).toMatchObject({ retryAfter: 1 });
  });

  it("takes the limits from LIMIT_PER_MINUTE and LIMIT_PER_DAY", async () => {
    vi.stubEnv("LIMIT_PER_MINUTE", "2");
    vi.stubEnv("LIMIT_PER_DAY", " 5 ");
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([0, 3]);

    expect(await countCorrection(NOW)).toEqual({ allowed: true, usage: { limit: 5, remaining: 2, resetAt: MIDNIGHT } });
    expect(fake.eval).toHaveBeenCalledWith(expect.any(String), KEYS, [2, 5, 120, 172_800]);
  });

  it.each(["abc", "0", "-3", "1.5", "1000001"])("uses the default for LIMIT_PER_DAY=%s and says why", async (value) => {
    vi.stubEnv("LIMIT_PER_DAY", value);
    const { countCorrection } = await load();
    fake.eval.mockResolvedValue([0, 1]);
    await countCorrection(NOW);

    expect(fake.eval).toHaveBeenCalledWith(expect.any(String), KEYS, [10, 100, 120, 172_800]);
    expect(warn).toHaveBeenCalledWith("[limits] LIMIT_PER_DAY must be a whole number from 1 to 1000000; using 100");
  });

  describe("lets the correction go ahead uncounted", () => {
    it("when no database is set up, and says so once", async () => {
      vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
      const { countCorrection } = await load();

      expect(await countCorrection(NOW)).toEqual({ allowed: true, usage: null });
      expect(await countCorrection(NOW)).toEqual({ allowed: true, usage: null });
      expect(fake.configs).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "[limits] No Upstash database is set up, so corrections aren't counted or limited",
      );
    });

    it("when the database doesn't answer within 1 second", async () => {
      const { countCorrection } = await load();
      fake.eval.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

      expect(await countCorrection(NOW)).toEqual({ allowed: true, usage: null });
      expect(warn).toHaveBeenCalledWith(
        "[limits] The Upstash database couldn't be used (no answer within 1000 ms), so this correction isn't counted",
      );
    });

    it("when the database answers with an error, logged without the command", async () => {
      const { countCorrection } = await load();
      fake.eval.mockRejectedValue(new Error('ERR max requests limit exceeded, command was: ["eval","..."]'));

      expect(await countCorrection(NOW)).toEqual({ allowed: true, usage: null });
      expect(warn).toHaveBeenCalledWith(
        "[limits] The Upstash database couldn't be used (Error: ERR max requests limit exceeded), so this correction isn't counted",
      );
    });

    it("when the answer isn't what the script returns", async () => {
      const { countCorrection } = await load();
      fake.eval.mockResolvedValue("OK");

      expect(await countCorrection(NOW)).toEqual({ allowed: true, usage: null });
      expect(warn).toHaveBeenCalledWith(
        "[limits] The database gave an unexpected answer, so this correction isn't counted",
      );
    });

    it("when the address isn't a URL, without logging it", async () => {
      vi.stubEnv("UPSTASH_REDIS_REST_URL", "not a url");
      const { countCorrection } = await load();

      expect(await countCorrection(NOW)).toEqual({ allowed: true, usage: null });
      expect(warn).toHaveBeenCalledWith(
        "[limits] The Upstash database address isn't a valid URL, so corrections aren't counted or limited",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("not a url");
    });
  });
});

describe("readUsage", () => {
  it("reads today's count", async () => {
    const { readUsage } = await load();
    fake.get.mockResolvedValue(13);

    expect(await readUsage(NOW)).toEqual({ limit: 100, remaining: 87, resetAt: MIDNIGHT });
    expect(fake.get).toHaveBeenCalledWith(KEYS[1]);
  });

  it("starts each day with the whole limit", async () => {
    const { readUsage } = await load();
    fake.get.mockResolvedValue(null);
    expect(await readUsage(NOW)).toEqual({ limit: 100, remaining: 100, resetAt: MIDNIGHT });
  });

  it("never shows fewer than 0 left, for example after the limit was lowered", async () => {
    vi.stubEnv("LIMIT_PER_DAY", "20");
    const { readUsage } = await load();
    fake.get.mockResolvedValue(35);
    expect(await readUsage(NOW)).toEqual({ limit: 20, remaining: 0, resetAt: MIDNIGHT });
  });

  it("gives nothing without a database", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const { readUsage } = await load();
    expect(await readUsage(NOW)).toBeNull();
    expect(fake.get).not.toHaveBeenCalled();
  });

  it("gives nothing when the database fails, and says why", async () => {
    const { readUsage } = await load();
    fake.get.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    expect(await readUsage(NOW)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[limits] The Upstash database couldn't be used (no answer within 1000 ms), so the count can't be shown",
    );
  });
});
