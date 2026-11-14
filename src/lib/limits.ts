import "server-only";
import { Redis } from "@upstash/redis";
import type { DailyUsage } from "@/lib/usage";

// Site-wide limits on corrections, counted in a free Upstash Redis database.
// They guard against runaway use or a leaked password, and keep the site
// inside Gemini's free allowance. Every correction counts, whoever sends it.
//
// The limits never break corrections: without a database, or when it doesn't
// answer within LIMITS_TIMEOUT_MS, the correction goes ahead uncounted and the
// server log says why.

export const DEFAULT_LIMIT_PER_MINUTE = 10;
export const DEFAULT_LIMIT_PER_DAY = 100;

/** How long the database may take to answer before the correction goes ahead uncounted. */
export const LIMITS_TIMEOUT_MS = 1_000;

/** The highest value LIMIT_PER_MINUTE and LIMIT_PER_DAY accept. */
const MAX_LIMIT = 1_000_000;

/** How long each counter is kept: a little longer than its minute or its day. */
const MINUTE_COUNTER_SECONDS = 120;
const DAY_COUNTER_SECONDS = 2 * 24 * 60 * 60;

/** What countCorrection decided. */
export type LimitDecision =
  /** The correction may go ahead. `usage` is null when it wasn't counted. */
  | { allowed: true; usage: DailyUsage | null }
  /** A limit is reached: no correction until `resetAt`, `retryAfter` seconds from now. */
  | {
      allowed: false;
      period: "minute" | "day";
      limit: number;
      retryAfter: number;
      resetAt: string;
      usage: DailyUsage;
    };

/**
 * Runs inside the database in one step, so two corrections at the same moment
 * can't both slip past a limit. A correction stopped by a limit isn't counted.
 * KEYS: this minute's counter, today's counter.
 * ARGV: the limit per minute, the limit per day, and how many seconds each
 * counter is kept.
 * Returns {result, today's count}: result 0 = counted, 1 = the minute's limit
 * is reached, 2 = the day's limit is reached.
 */
const COUNT_SCRIPT = `
local minute = tonumber(redis.call("GET", KEYS[1]) or "0")
local day = tonumber(redis.call("GET", KEYS[2]) or "0")
if day >= tonumber(ARGV[2]) then return {2, day} end
if minute >= tonumber(ARGV[1]) then return {1, day} end
if redis.call("INCR", KEYS[1]) == 1 then redis.call("EXPIRE", KEYS[1], ARGV[3]) end
day = redis.call("INCR", KEYS[2])
if day == 1 then redis.call("EXPIRE", KEYS[2], ARGV[4]) end
return {0, day}
`;

/**
 * Counts one correction, unless the limit per minute or per day is reached.
 * Call it after the text has passed its checks and before the AI is asked.
 */
export async function countCorrection(now = new Date()): Promise<LimitDecision> {
  const redis = getRedis();
  if (!redis) {
    return { allowed: true, usage: null };
  }
  const { perMinute, perDay } = readLimits();
  const keys = counterKeys(now);

  let reply: unknown;
  try {
    reply = await redis.eval(
      COUNT_SCRIPT,
      [keys.minute, keys.day],
      [perMinute, perDay, MINUTE_COUNTER_SECONDS, DAY_COUNTER_SECONDS],
    );
  } catch (error) {
    warnUnavailable(error, "this correction isn't counted");
    return { allowed: true, usage: null };
  }

  const [result, today] = Array.isArray(reply) ? reply.map(Number) : [];
  if (![0, 1, 2].includes(result) || !Number.isInteger(today)) {
    console.warn("[limits] The database gave an unexpected answer, so this correction isn't counted");
    return { allowed: true, usage: null };
  }
  const usage = dailyUsage(today, perDay, now);
  if (result === 0) {
    return { allowed: true, usage };
  }
  const period = result === 1 ? "minute" : "day";
  const resetAt = period === "minute" ? nextMinute(now) : nextMidnight(now);
  return {
    allowed: false,
    period,
    limit: period === "minute" ? perMinute : perDay,
    retryAfter: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
    resetAt: resetAt.toISOString(),
    usage,
  };
}

/** Today's count, for GET /api/usage. Null when it can't be read. */
export async function readUsage(now = new Date()): Promise<DailyUsage | null> {
  const redis = getRedis();
  if (!redis) {
    return null;
  }
  try {
    const today = Number((await redis.get<number>(counterKeys(now).day)) ?? 0);
    return Number.isInteger(today) ? dailyUsage(today, readLimits().perDay, now) : null;
  } catch (error) {
    warnUnavailable(error, "the count can't be shown");
    return null;
  }
}

let client: { settings: string; redis: Redis } | undefined;
let warnedNotSetUp = false;

/**
 * The database client, from the settings Upstash's Vercel integration adds.
 * Null when they aren't set. The client is kept for the next request, so its
 * connection can be reused.
 */
function getRedis(): Redis | null {
  const url = firstSetting("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL");
  const token = firstSetting("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN");
  if (!url || !token) {
    if (!warnedNotSetUp) {
      warnedNotSetUp = true;
      console.warn("[limits] No Upstash database is set up, so corrections aren't counted or limited");
    }
    return null;
  }
  const settings = `${url} ${token}`;
  if (client?.settings !== settings) {
    try {
      const redis = new Redis({
        url,
        token,
        // One try, stopped after LIMITS_TIMEOUT_MS: a slow database must not hold up the correction.
        retry: { retries: 0 },
        signal: () => AbortSignal.timeout(LIMITS_TIMEOUT_MS),
        enableTelemetry: false,
      });
      client = { settings, redis };
    } catch {
      // The address isn't a valid URL. It isn't logged, in case a secret was pasted there.
      console.warn("[limits] The Upstash database address isn't a valid URL, so corrections aren't counted or limited");
      return null;
    }
  }
  return client.redis;
}

/** The first of these settings that isn't empty, without spaces at either end. */
function firstSetting(...names: string[]): string | undefined {
  return names.map((name) => process.env[name]?.trim()).find(Boolean);
}

/** LIMIT_PER_MINUTE and LIMIT_PER_DAY, or their defaults. */
function readLimits(): { perMinute: number; perDay: number } {
  return {
    perMinute: readLimit("LIMIT_PER_MINUTE", DEFAULT_LIMIT_PER_MINUTE),
    perDay: readLimit("LIMIT_PER_DAY", DEFAULT_LIMIT_PER_DAY),
  };
}

function readLimit(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  const limit = Number(value);
  if (/^\d+$/.test(value) && limit >= 1 && limit <= MAX_LIMIT) {
    return limit;
  }
  console.warn(`[limits] ${name} must be a whole number from 1 to ${MAX_LIMIT}; using ${fallback}`);
  return fallback;
}

/**
 * The two counters' names, for example "grammarwy:production:day:2026-11-14".
 * Each Vercel environment has its own counters, and your own computer counts
 * as "development", so trying the site locally never uses up the live count.
 */
function counterKeys(now: Date): { minute: string; day: string } {
  const prefix = `grammarwy:${process.env.VERCEL_ENV?.trim() || "development"}`;
  const time = now.toISOString(); // 2026-11-14T03:25:40.123Z, in UTC
  return { minute: `${prefix}:minute:${time.slice(0, 16)}`, day: `${prefix}:day:${time.slice(0, 10)}` };
}

function dailyUsage(today: number, perDay: number, now: Date): DailyUsage {
  return { limit: perDay, remaining: Math.max(0, perDay - today), resetAt: nextMidnight(now).toISOString() };
}

/** The start of the next minute. */
function nextMinute(now: Date): Date {
  return new Date((Math.floor(now.getTime() / 60_000) + 1) * 60_000);
}

/** The next 00:00 UTC, when the day's count starts again. */
function nextMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** Logs why the database couldn't be used. Never the token. */
function warnUnavailable(error: unknown, consequence: string): void {
  let reason = "unknown error";
  if (error instanceof Error) {
    reason =
      error.name === "TimeoutError"
        ? `no answer within ${LIMITS_TIMEOUT_MS} ms`
        : // Upstash adds the command to its message; the reason comes first.
          `${error.name}: ${error.message.split(", command was:")[0].slice(0, 200)}`;
  }
  console.warn(`[limits] The Upstash database couldn't be used (${reason}), so ${consequence}`);
}
