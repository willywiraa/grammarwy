// Today's count of corrections, shared by the server and the page. The server
// counts in lib/limits.ts; the page shows "87 of 100 corrections left today".

/** How many corrections are left today. */
export type DailyUsage = {
  /** How many corrections the site allows per day. */
  limit: number;
  /** How many are left today. */
  remaining: number;
  /** When the count starts again (00:00 UTC), as an ISO time. */
  resetAt: string;
};

/** The response headers that carry today's count after each correction. */
export const USAGE_HEADERS = {
  limit: "X-Daily-Limit",
  remaining: "X-Daily-Remaining",
  reset: "X-Daily-Reset",
} as const;

/** The headers for a response, or none when corrections aren't counted. */
export function usageHeaders(usage: DailyUsage | null): Record<string, string> {
  if (!usage) {
    return {};
  }
  return {
    [USAGE_HEADERS.limit]: String(usage.limit),
    [USAGE_HEADERS.remaining]: String(usage.remaining),
    [USAGE_HEADERS.reset]: usage.resetAt,
  };
}

/** Today's count from a response's headers, or null if they're missing or wrong. */
export function readUsageHeaders(headers: Headers): DailyUsage | null {
  return parseUsage({
    limit: toCount(headers.get(USAGE_HEADERS.limit)),
    remaining: toCount(headers.get(USAGE_HEADERS.remaining)),
    resetAt: headers.get(USAGE_HEADERS.reset),
  });
}

/** Checks a count that came from the server, for example from GET /api/usage. */
export function parseUsage(value: unknown): DailyUsage | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { limit, remaining, resetAt } = value as Record<string, unknown>;
  if (!isCount(limit) || limit < 1 || !isCount(remaining) || remaining > limit) {
    return null;
  }
  if (typeof resetAt !== "string" || Number.isNaN(Date.parse(resetAt))) {
    return null;
  }
  return { limit, remaining, resetAt };
}

/** A fixed language and time zone, for the tests. The page uses the browser's own. */
export type TimeFormat = { locale?: string; timeZone?: string };

/** "87 of 100 corrections left today", or when none are left, when more are possible. */
export function describeUsage(usage: DailyUsage, now = new Date(), format: TimeFormat = {}): string {
  if (usage.remaining > 0) {
    return `${formatCount(usage.remaining)} of ${formatCount(usage.limit)} corrections left today`;
  }
  return `No corrections left today. You can correct more from ${formatResetTime(usage.resetAt, now, format)}.`;
}

/**
 * A time in your own time zone, for example "07:00", or "07:00 tomorrow" when
 * it falls on a later day than `now`.
 */
export function formatResetTime(resetAt: string, now = new Date(), { locale, timeZone }: TimeFormat = {}): string {
  const reset = new Date(resetAt);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone }).format(reset);
  // "2026-11-14": the calendar day in that time zone.
  const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
  return day.format(reset) === day.format(now) ? time : `${time} tomorrow`;
}

/** 1000 → "1,000", the same on the server and in the browser. */
export function formatCount(count: number): string {
  return new Intl.NumberFormat("en-US").format(count);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A header's whole number, or NaN when it is missing or anything else. */
function toCount(text: string | null): number {
  return text !== null && /^\d+$/.test(text) ? Number(text) : Number.NaN;
}
