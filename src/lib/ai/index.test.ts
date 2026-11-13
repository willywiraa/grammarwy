// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askClaude } from "@/lib/ai/claude";
import { askClaudeCode } from "@/lib/ai/claude-code";
import { askGemini } from "@/lib/ai/gemini";
import { CorrectionError, type ApiErrorCode } from "@/lib/api-errors";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { checkAnswer, getCorrection, MAX_EXPLANATIONS, readProvider } from "./index";

// The mock AI's pause is skipped, so the tests run instantly.
vi.mock("@/lib/wait", () => ({ wait: vi.fn(async () => {}) }));
// The three connections are tested in claude.test.ts, claude-code.test.ts and
// gemini.test.ts. Here we only check which one is used.
vi.mock("@/lib/ai/claude", () => ({ askClaude: vi.fn(), DEADLINE_MS: 240_000 }));
vi.mock("@/lib/ai/claude-code", () => ({ askClaudeCode: vi.fn() }));
// Gemini keeps its real model settings (readGeminiModels); only the call is mocked.
vi.mock("@/lib/ai/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/gemini")>()),
  askGemini: vi.fn(),
}));

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

  describe("safety checks", () => {
    it("rejects an answer that explains fixes but returns the text unchanged", () => {
      const answer = { ...VALID, correctedText: ` ${TEXT} ` };
      expect(() => checkAnswer(answer, TEXT)).toThrow(correctionError("AI_ERROR"));
    });

    it("treats an unchanged text without explanations as already correct", () => {
      const result = checkAnswer({ ...VALID, correctedText: TEXT, explanations: [] }, TEXT);

      expect(result.alreadyCorrect).toBe(true);
      expect(result.correctedText).toBe(TEXT);
    });

    it("rejects an answer that lost all the line breaks of the text", () => {
      const text = "Hi Sarah,\n\nThe job is done.\n\nThanks,\nAlex";
      const answer = { ...VALID, correctedText: "Hi Sarah, The job is done. Thanks, Alex" };
      expect(() => checkAnswer(answer, text)).toThrow(correctionError("AI_ERROR"));
    });

    it("accepts an answer that keeps the line breaks", () => {
      const text = "Hi Sarah,\n\nThe job are done.\n\nThanks,\nAlex";
      const answer = { ...VALID, correctedText: "Hi Sarah,\n\nThe job is done.\n\nThanks,\nAlex", explanations: [] };
      expect(checkAnswer(answer, text).correctedText).toBe(answer.correctedText);
    });

    it("leaves out an explanation whose fix isn't in the corrected text", () => {
      const wrong = { ...VALID.explanations[1], rule: "Wrong", corrected: "to the main office" };

      const result = checkAnswer({ ...VALID, explanations: [...VALID.explanations, wrong] }, TEXT);

      expect(result.explanations.map((item) => item.rule)).toEqual(VALID.explanations.map((item) => item.rule));
    });

    it("matches explanation quotes regardless of case, spacing, curly quotes and joined pieces", () => {
      const explanation = {
        ...VALID.explanations[0],
        corrected: "“He  GOES” … and checks; every day",
      };
      const removedWord = { ...VALID.explanations[0], rule: "Removed word", corrected: "" };

      const result = checkAnswer({ ...VALID, explanations: [explanation, removedWord] }, TEXT);

      expect(result.explanations).toHaveLength(2);
    });
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
    vi.mocked(askGemini).mockReset();
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

  it.each(["claude-code", "anthropic-api", "gemini"])(
    "doesn't call any AI in mock mode, even with AI_PROVIDER=%s",
    async (provider) => {
      vi.stubEnv("AI_PROVIDER", provider);
      await getCorrection(TEXT);
      expect(askClaude).not.toHaveBeenCalled();
      expect(askClaudeCode).not.toHaveBeenCalled();
      expect(askGemini).not.toHaveBeenCalled();
    },
  );

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

  describe("with Gemini", () => {
    beforeEach(() => {
      vi.stubEnv("USE_MOCK_AI", "false");
      vi.stubEnv("AI_PROVIDER", "gemini");
    });

    it("asks Gemini and returns its checked answer", async () => {
      vi.mocked(askGemini).mockResolvedValue({ ...VALID, confidence: 0.9 });

      const result = await getCorrection(TEXT);

      expect(askGemini).toHaveBeenCalledTimes(1);
      // With a backup ready, the main model gets one try and 10 seconds to start writing.
      expect(askGemini).toHaveBeenCalledWith(TEXT, {
        model: "gemini-3.1-flash-lite",
        deadline: expect.any(AbortSignal),
        tries: 1,
        firstTextMs: 10_000,
      });
      expect(askClaude).not.toHaveBeenCalled();
      expect(askClaudeCode).not.toHaveBeenCalled();
      expect(result).toEqual(VALID);
    });

    it("gives the main model its usual tries and time when there is no backup", async () => {
      vi.stubEnv("GEMINI_FALLBACK_MODEL", "none");
      vi.mocked(askGemini).mockResolvedValue(VALID);

      await getCorrection(TEXT);

      expect(askGemini).toHaveBeenCalledWith(TEXT, {
        model: "gemini-3.1-flash-lite",
        deadline: expect.any(AbortSignal),
      });
    });

    it("passes the pieces of the answer on as Gemini writes them", async () => {
      vi.mocked(askGemini).mockResolvedValue(VALID);
      const onText = vi.fn();
      const onRestart = vi.fn();

      await getCorrection(TEXT, { onText, onRestart });

      expect(vi.mocked(askGemini).mock.calls[0][1]?.onText).toBe(onText);
      expect(onRestart).not.toHaveBeenCalled();
    });

    it("uses GEMINI_MODEL as the main model", async () => {
      vi.stubEnv("GEMINI_MODEL", "gemini-3.6-flash");
      vi.mocked(askGemini).mockResolvedValue(VALID);

      await getCorrection(TEXT);

      expect(vi.mocked(askGemini).mock.calls[0][1]).toMatchObject({ model: "gemini-3.6-flash" });
    });

    it("applies the already-correct rule to Gemini's answer", async () => {
      vi.mocked(askGemini).mockResolvedValue({ ...VALID, alreadyCorrect: true });

      const result = await getCorrection(TEXT);

      expect(result.correctedText).toBe(TEXT);
      expect(result.explanations).toEqual([]);
    });

    it("rejects an answer in the wrong format with AI_ERROR when the backup's is wrong too", async () => {
      vi.mocked(askGemini).mockResolvedValue({ correctedText: "Only one field." });
      await expect(getCorrection(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
    });

    describe("the backup model", () => {
      it.each([
        ["the daily limit", new CorrectionError("RATE_LIMITED", "429")],
        ["no answer in time", new CorrectionError("AI_TIMEOUT", "timeout")],
        ["a server error", new CorrectionError("AI_ERROR", "500")],
      ])("answers when the main model fails with %s", async (_label, error) => {
        vi.mocked(askGemini).mockRejectedValueOnce(error).mockResolvedValueOnce(VALID);

        const result = await getCorrection(TEXT);

        expect(result).toEqual(VALID);
        const calls = vi.mocked(askGemini).mock.calls;
        expect(calls.map((call) => call[1]?.model)).toEqual(["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]);
        expect(calls[1][1]?.deadline).toBe(calls[0][1]?.deadline); // one shared deadline
      });

      it("tells the page to start again, and gives the backup its usual tries and time", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const order: string[] = [];
        vi.mocked(askGemini)
          .mockImplementationOnce(async () => {
            order.push("main model");
            throw new CorrectionError("AI_TIMEOUT", "No text from Gemini within 10000 ms");
          })
          .mockImplementationOnce(async () => {
            order.push("backup model");
            return VALID;
          });
        const onText = vi.fn();
        const onRestart = vi.fn(() => order.push("restart"));

        await expect(getCorrection(TEXT, { onText, onRestart })).resolves.toEqual(VALID);

        expect(order).toEqual(["main model", "restart", "backup model"]);
        expect(vi.mocked(askGemini).mock.calls[1][1]).toEqual({
          model: "gemini-3.5-flash-lite",
          deadline: expect.any(AbortSignal),
          onText,
        });
      });

      it("answers when the main model's answer fails the safety checks", async () => {
        vi.mocked(askGemini)
          .mockResolvedValueOnce({ ...VALID, correctedText: TEXT }) // explains fixes it didn't make
          .mockResolvedValueOnce(VALID);

        await expect(getCorrection(TEXT)).resolves.toEqual(VALID);
        expect(askGemini).toHaveBeenCalledTimes(2);
      });

      it("passes the backup's error on when both models fail", async () => {
        vi.mocked(askGemini)
          .mockRejectedValueOnce(new CorrectionError("RATE_LIMITED", "429"))
          .mockRejectedValueOnce(new CorrectionError("AI_TIMEOUT", "timeout"));

        await expect(getCorrection(TEXT)).rejects.toThrow(correctionError("AI_TIMEOUT"));
      });

      it("logs why the main model failed, without the text", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.mocked(askGemini).mockRejectedValueOnce(new CorrectionError("RATE_LIMITED", "429 daily")).mockResolvedValueOnce(VALID);

        await getCorrection(TEXT);

        expect(warn).toHaveBeenCalledWith(
          "[ai] gemini-3.1-flash-lite failed (RATE_LIMITED: 429 daily); asking gemini-3.5-flash-lite",
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain(TEXT);
        warn.mockRestore();
      });

      it("uses GEMINI_FALLBACK_MODEL", async () => {
        vi.stubEnv("GEMINI_FALLBACK_MODEL", "gemini-3.8-flash");
        vi.mocked(askGemini).mockRejectedValueOnce(new CorrectionError("AI_ERROR", "500")).mockResolvedValueOnce(VALID);
        vi.spyOn(console, "warn").mockImplementation(() => {});

        await getCorrection(TEXT);

        expect(vi.mocked(askGemini).mock.calls[1][1]).toMatchObject({ model: "gemini-3.8-flash" });
      });

      it.each([
        ["GEMINI_FALLBACK_MODEL=none", "", "none"],
        ["a backup that is the main model", "gemini-3.5-flash-lite", ""],
      ])("isn't used with %s", async (_label, model, fallback) => {
        vi.stubEnv("GEMINI_MODEL", model);
        vi.stubEnv("GEMINI_FALLBACK_MODEL", fallback);
        vi.mocked(askGemini).mockRejectedValue(new CorrectionError("RATE_LIMITED", "429"));

        await expect(getCorrection(TEXT)).rejects.toThrow(correctionError("RATE_LIMITED"));
        expect(askGemini).toHaveBeenCalledTimes(1);
      });
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

  // Columns: AI_PROVIDER, ANTHROPIC_API_KEY, GEMINI_API_KEY, the connection used.
  it.each([
    ["no setting and no API key", "", "", "", "claude-code"],
    ["no setting and an Anthropic key", "", "sk-ant-test", "", "anthropic-api"],
    ["no setting and a Gemini key", "", "", "gemini-test", "gemini"],
    ["no setting and both keys", "", "sk-ant-test", "gemini-test", "anthropic-api"],
    ["claude-code, even with API keys", "claude-code", "sk-ant-test", "gemini-test", "claude-code"],
    ["anthropic-api", "anthropic-api", "", "", "anthropic-api"],
    ["gemini", "gemini", "", "", "gemini"],
    ["a value with spaces", " claude-code ", "", "", "claude-code"],
  ])("with %s, picks the right connection", (_label, setting, anthropicKey, geminiKey, expected) => {
    vi.stubEnv("AI_PROVIDER", setting);
    vi.stubEnv("ANTHROPIC_API_KEY", anthropicKey);
    vi.stubEnv("GEMINI_API_KEY", geminiKey);
    vi.stubEnv("VERCEL", ""); // not on Vercel
    expect(readProvider()).toBe(expected);
  });

  it("uses Gemini on Vercel even without a key, so the log names the missing key", () => {
    vi.stubEnv("AI_PROVIDER", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("VERCEL", "1");
    expect(readProvider()).toBe("gemini");
  });

  it("uses the Anthropic API on Vercel when its key is set", () => {
    vi.stubEnv("AI_PROVIDER", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("VERCEL", "1");
    expect(readProvider()).toBe("anthropic-api");
  });

  it("reports an unknown value as SERVER_CONFIG", () => {
    vi.stubEnv("AI_PROVIDER", "openai");
    expect(() => readProvider()).toThrow(correctionError("SERVER_CONFIG"));
  });
});
