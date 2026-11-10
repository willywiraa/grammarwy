// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CorrectionResultSchema } from "@/lib/correction-schema";
import { SAMPLE_ALREADY_CORRECT, SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { wait } from "@/lib/wait";
import { getMockAnswer, MOCK_DELAY_MS, MOCK_SLOW_DELAY_MS } from "./mock";

// Replace the pause with one that returns at once, so the tests run instantly.
vi.mock("@/lib/wait", () => ({ wait: vi.fn(async () => {}) }));

describe("getMockAnswer", () => {
  beforeEach(() => {
    vi.mocked(wait).mockClear();
  });

  it("answers with a normal correction after a short pause", async () => {
    await expect(getMockAnswer("He go to office.")).resolves.toEqual(SAMPLE_WITH_FIXES.result);
    expect(wait).toHaveBeenCalledWith(MOCK_DELAY_MS);
  });

  it("[correct] answers that the text needs no correction", async () => {
    await expect(getMockAnswer("All good here. [correct]")).resolves.toEqual(
      SAMPLE_ALREADY_CORRECT.result,
    );
  });

  it("[error] fails like a broken AI service", async () => {
    await expect(getMockAnswer("Hello [error]")).rejects.toThrow("Simulated AI failure");
  });

  it("[slow] waits 6 seconds, then answers normally", async () => {
    await expect(getMockAnswer("Hello [slow]")).resolves.toEqual(SAMPLE_WITH_FIXES.result);
    expect(MOCK_SLOW_DELAY_MS).toBe(6000);
    expect(wait).toHaveBeenCalledWith(MOCK_SLOW_DELAY_MS);
  });

  it("[invalid] answers in the wrong format", async () => {
    const answer = await getMockAnswer("Hello [invalid]");
    expect(CorrectionResultSchema.safeParse(answer).success).toBe(false);
  });
});
