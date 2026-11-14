// @vitest-environment node
import { connection } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readUsage } from "@/lib/limits";
import { GET } from "./route";

// A fake count, so the tests need no database. limits.test.ts covers the reading.
vi.mock("@/lib/limits", () => ({ readUsage: vi.fn() }));

// connection() only works inside a real Next.js request. Here it just records the call.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: vi.fn(async () => {}),
}));

const USAGE = { limit: 100, remaining: 87, resetAt: "2026-11-15T00:00:00.000Z" };

beforeEach(() => {
  vi.stubEnv("USE_MOCK_AI", "false");
  vi.mocked(readUsage).mockReset().mockResolvedValue(USAGE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/usage", () => {
  it("answers with today's count, never stored along the way", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ usage: USAGE });
  });

  it("waits for a real request, so the build never saves a count", async () => {
    await GET();
    expect(connection).toHaveBeenCalledOnce();
    expect(vi.mocked(connection).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(readUsage).mock.invocationCallOrder[0],
    );
  });

  it("answers null when corrections aren't counted", async () => {
    vi.mocked(readUsage).mockResolvedValue(null);
    expect(await (await GET()).json()).toEqual({ usage: null });
  });

  it("answers null in mock mode, where nothing is counted", async () => {
    vi.stubEnv("USE_MOCK_AI", "true");

    expect(await (await GET()).json()).toEqual({ usage: null });
    expect(readUsage).not.toHaveBeenCalled();
  });
});
