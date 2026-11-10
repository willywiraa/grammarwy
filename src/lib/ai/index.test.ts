// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askClaude } from "@/lib/ai/claude";
import { askClaudeCode } from "@/lib/ai/claude-code";
import { CorrectionError, type ApiErrorCode } from "@/lib/api-errors";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { checkAnswer, getCorrection, MAX_EXPLANATIONS, readProvider } from "./index";

// The mock AI's pause is skipped, so the tests run instantly.
vi.mock("@/lib/wait", () => ({ wait: vi.fn(async () => {}) }));
// The two connections are tested in claude.test.ts and claude-code.test.ts.
// Here we only check which one is used.
vi.mock("@/lib/ai/claude", () => ({ askClaude: vi.fn() }));
vi.mock("@/lib/ai/claude-code", () => ({ askClaudeCode: vi.fn() }));

const TEXT = "He go to office every days.";
const VALID = SAMPLE_WITH_FIXES.result;

/** Matches a CorrectionError with the given code. */
function correctionError(code: ApiErrorCode) {
  return expect.objectContaining({ name: "CorrectionError", code });
}

describe("checkAnswer", () => {
  it("accepts an answer in the right format", () => {
    expect(checkAnswer(VALID, TEXT)).toEqual(VALID);
  });

  it("drops extra fields the AI adds", () => {
    expect(checkAnswer({ ...VALID, confidence: 0.9 }, TEXT)).not.toHaveProperty("confidence");
  });

  it.each([
    ["isn't an object", "Just some text"],
    ["is missing a field", { ...VALID, conciseVersion: undefined }],
    ["has a field of the wrong type", { ...VALID, alreadyCorrect: "no" }],
    ["has explanations that aren't a list", { ...VALID, explanations: "none" }],
    ["has an incomplete explanation", { ...VALID, explanations: [{ rule: "Articles" }] }],
  ])("rejects an answer that %s", (_label, answer) => {
    expect(() => checkAnswer(answer, TEXT)).toThrow(correctionError("AI_ERROR"));
  });

  it("rejects an answer with an empty version", () => {
    const answer = { ...VALID, professionalVersion: "  \n" };
    expect(() => checkAnswer(answer, TEXT)).toThrow(correctionError("AI_ERROR"));
  });

  it("keeps only the first 6 explanations", () => {
    const explanations = Array.from({ length: 8 }, (_, index) => ({
      ...VALID.explanations[0],
      rule: `Rule ${index + 1}`,
    }));

    const result = checkAnswer({ ...VALID, explanations }, TEXT);

    expect(MAX_EXPLANATIONS).toBe(6);
    expect(result.explanations.map((item) => item.rule)).toEqual([
      "Rule 1",
      "Rule 2",
      "Rule 3",
      "Rule 4",
      "Rule 5",
      "Rule 6",
    ]);
  });

  it("for already-correct text, keeps the original text and drops any explanations", () => {
    const answer = { ...VALID, alreadyCorrect: true, correctedText: "A quietly reworded text." };

    const result = checkAnswer(answer, TEXT);

    expect(result.correctedText).toBe(TEXT);
    expect(result.explanations).toEqual([]);
    expect(result.professionalVersion).toBe(VALID.professionalVersion); // still shown
  });

  it("names the broken field in the error details, but never copies the text", () => {
    let details = "";
    try {
      checkAnswer({ ...VALID, alreadyCorrect: "Private words" }, TEXT);
    } catch (error) {
      details = (error as Error).message;
    }
    expect(details).toContain("alreadyCorrect");
    expect(details).not.toContain("Private words");
  });
});

describe("getCorrection", () => {
  beforeEach(() => {
    vi.stubEnv("USE_MOCK_AI", "true");
    vi.mocked(askClaude).mockReset();
    vi.mocked(askClaudeCode).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the checked mock answer in mock mode", async () => {
    await expect(getCorrection(TEXT)).resolves.toEqual(VALID);
  });

  it("[correct] returns the original text as the corrected version", async () => {
    const text = "Thanks for the update. [correct]";

    const result = await getCorrection(text);

    expect(result.alreadyCorrect).toBe(true);
    expect(result.correctedText).toBe(text);
    expect(result.explanations).toEqual([]);
  });

  it("[invalid] fails with AI_ERROR", async () => {
    await expect(getCorrection("Hello [invalid]")).rejects.toThrow(correctionError("AI_ERROR"));
  });

  it("doesn't call Claude in mock mode", async () => {
    vi.stubEnv("AI_PROVIDER", "claude-code");
    await getCorrection(TEXT);
    expect(askClaude).not.toHaveBeenCalled();
    expect(askClaudeCode).not.toHaveBeenCalled();
  });

  describe("with Claude Code", () => {
    beforeEach(() => {
      vi.stubEnv("USE_MOCK_AI", "false");
      vi.stubEnv("AI_PROVIDER", "claude-code");
    });

    it("asks Claude Code and returns its checked answer", async () => {
      vi.mocked(askClaudeCode).mockResolvedValue({ ...VALID, confidence: 0.9 });

      const result = await getCorrection(TEXT);

      expect(askClaudeCode).toHaveBeenCalledWith(TEXT);
      expect(askClaude).not.toHaveBeenCalled();
      expect(result).toEqual(VALID);
    });

    it("rejects an answer in the wrong format with AI_ERROR", async () => {
      vi.mocked(askClaudeCode).mockResolvedValue({ correctedText: "Only one field." });
      await expect(getCorrection(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
    });
  });

  describe("with mock mode off", () => {
    beforeEach(() => {
      vi.stubEnv("USE_MOCK_AI", "false");
    });

    it("asks Claude and returns its checked answer", async () => {
      vi.mocked(askClaude).mockResolvedValue({ ...VALID, confidence: 0.9 });

      const result = await getCorrection(TEXT);

      expect(askClaude).toHaveBeenCalledWith(TEXT);
      expect(result).toEqual(VALID); // checked: the extra field is gone
    });

    it("applies the already-correct rule to Claude's answer", async () => {
      vi.mocked(askClaude).mockResolvedValue({ ...VALID, alreadyCorrect: true });

      const result = await getCorrection(TEXT);

      expect(result.correctedText).toBe(TEXT);
      expect(result.explanations).toEqual([]);
    });

    it("rejects an answer from Claude in the wrong format with AI_ERROR", async () => {
      vi.mocked(askClaude).mockResolvedValue({ correctedText: "Only one field." });
      await expect(getCorrection(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
    });

    it("passes Claude's errors on unchanged", async () => {
      vi.mocked(askClaude).mockRejectedValue(new CorrectionError("RATE_LIMITED", "429"));

      await expect(getCorrection(TEXT)).rejects.toThrow(correctionError("RATE_LIMITED"));
    });
  });
});

describe("readProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["no setting and no API key", "", "", "claude-code"],
    ["no setting and an API key", "", "sk-ant-test", "anthropic-api"],
    ["claude-code, even with an API key", "claude-code", "sk-ant-test", "claude-code"],
    ["anthropic-api", "anthropic-api", "", "anthropic-api"],
    ["a value with spaces", " claude-code ", "", "claude-code"],
  ])("with %s, picks the right connection", (_label, setting, key, expected) => {
    vi.stubEnv("AI_PROVIDER", setting);
    vi.stubEnv("ANTHROPIC_API_KEY", key);
    vi.stubEnv("VERCEL", ""); // not on Vercel
    expect(readProvider()).toBe(expected);
  });

  it("uses the API on Vercel even without a key, so the log names the missing key", () => {
    vi.stubEnv("AI_PROVIDER", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("VERCEL", "1");
    expect(readProvider()).toBe("anthropic-api");
  });

  it("reports an unknown value as SERVER_CONFIG", () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    expect(() => readProvider()).toThrow(correctionError("SERVER_CONFIG"));
  });
});
