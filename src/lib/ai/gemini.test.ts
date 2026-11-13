// @vitest-environment node
import { ApiError, BlockedReason, FinishReason, GenerateContentResponse } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ApiErrorCode } from "@/lib/api-errors";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { MAX_INPUT_LENGTH } from "@/lib/validation";
import { ANSWER_JSON_SCHEMA } from "./answer-schema";
import { DEADLINE_MS } from "./claude";
import { askGemini, geminiTryTimeoutMs, readGeminiModels } from "./gemini";
import { SYSTEM_PROMPT } from "./prompt";

// A fake Gemini client, so no test ever calls the real API. Each test decides
// what the fake answers. The SDK's real answer class and error class are
// kept, so the code sees exactly what it would see in production.
const fake = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  generateContent: vi.fn(),
}));

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  class FakeGoogleGenAI {
    models = { generateContent: fake.generateContent };
    constructor(options: unknown) {
      fake.clientOptions.push(options);
    }
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

const TEXT = "He go to office every days.";
const KEY = "gemini-test-key-0123456789";
const ANSWER = SAMPLE_WITH_FIXES.result;

/** One answer candidate. By default, a complete and valid answer. */
function candidate(text = JSON.stringify(ANSWER), finishReason: FinishReason = FinishReason.STOP) {
  return { content: { role: "model", parts: [{ text }] }, finishReason };
}

/** A finished answer from Gemini, built the way the SDK builds it. */
function reply(fields: Record<string, unknown> = {}): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), {
    candidates: [candidate()],
    usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 900, thoughtsTokenCount: 200 },
    modelVersion: "gemini-3.1-flash-lite",
    responseId: "resp_test",
    ...fields,
  });
}

function answersWith(response: GenerateContentResponse) {
  fake.generateContent.mockResolvedValue(response);
}

function failsWith(error: unknown) {
  fake.generateContent.mockRejectedValue(error);
}

/** An error answer from the API, built the way the SDK builds it. */
function httpError(status: number, statusName: string, message = "Something went wrong") {
  return new ApiError({
    message: JSON.stringify({ error: { code: status, message, status: statusName } }),
    status,
  });
}

/** A failed connection, the way Node's fetch reports it. */
function networkError() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
}

/** Matches a CorrectionError with the given code. */
function correctionError(code: ApiErrorCode) {
  return expect.objectContaining({ name: "CorrectionError", code });
}

/** The details a failed call writes to the server log. */
async function failureDetails(): Promise<string> {
  try {
    await askGemini(TEXT);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected askGemini to fail");
}

function sentParams() {
  return fake.generateContent.mock.calls[0][0];
}

let consoleInfo: MockInstance<typeof console.info>;

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", KEY);
  fake.clientOptions.length = 0;
  fake.generateContent.mockReset();
  answersWith(reply());
  consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("askGemini", () => {
  describe("the request", () => {
    it("returns Gemini's answer as parsed JSON", async () => {
      await expect(askGemini(TEXT)).resolves.toEqual(ANSWER);
    });

    it("sends the expected request settings", async () => {
      await askGemini(TEXT);

      const params = sentParams();
      expect(params).toMatchObject({
        model: "gemini-3.1-flash-lite",
        contents: `<text>\n${TEXT}\n</text>`,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: "application/json",
          maxOutputTokens: 16_000,
          thinkingConfig: { thinkingLevel: "LOW" },
        },
      });
      // No sampling settings: the model's own defaults are used.
      expect(params.config).not.toHaveProperty("temperature");
    });

    it("sends the JSON schema of our answer format, without Zod's $schema line", async () => {
      await askGemini(TEXT);

      const schema = sentParams().config.responseJsonSchema;
      expect(schema).toBe(ANSWER_JSON_SCHEMA);
      expect(schema).not.toHaveProperty("$schema");
      expect(schema.required).toEqual([
        "correctedText",
        "professionalVersion",
        "naturalVersion",
        "conciseVersion",
        "explanations",
        "alreadyCorrect",
      ]);
    });

    it("gives up at a deadline that is shorter than Vercel's 300-second limit", async () => {
      await askGemini(TEXT);

      expect(sentParams().config.abortSignal).toBeInstanceOf(AbortSignal);
      expect(DEADLINE_MS).toBeLessThan(300_000);
    });

    it("sends the key only to Google's Gemini API, whatever the environment says", async () => {
      vi.stubEnv("GOOGLE_GEMINI_BASE_URL", "http://localhost:9999");
      vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");

      await askGemini(TEXT);

      expect(fake.clientOptions).toHaveLength(1);
      expect(fake.clientOptions[0]).toMatchObject({
        apiKey: KEY,
        vertexai: false,
        httpOptions: { baseUrl: "https://generativelanguage.googleapis.com/" },
      });
    });

    it("tries up to 2 times, and each try has its own time limit", async () => {
      await askGemini(TEXT);

      expect(fake.clientOptions[0]).toMatchObject({
        httpOptions: {
          timeout: 30_216, // 30 seconds, plus 8 ms for each of the 27 characters
          retryOptions: { attempts: 2, httpStatusCodes: [408, 500, 502, 503, 504] },
        },
      });
    });

    it("gives a long text more time per try, and leaves the backup model at least 100 seconds", () => {
      const longest = "x".repeat(MAX_INPUT_LENGTH);

      expect(geminiTryTimeoutMs(longest)).toBe(70_000);
      expect(DEADLINE_MS - 2 * geminiTryTimeoutMs(longest)).toBeGreaterThanOrEqual(100_000);
    });

    it("asks the model and uses the deadline it is given", async () => {
      const deadline = new AbortController().signal;

      await askGemini(TEXT, { model: "gemini-3.5-flash-lite", deadline });

      expect(sentParams().model).toBe("gemini-3.5-flash-lite");
      expect(sentParams().config.abortSignal).toBe(deadline);
    });

    it("uses GEMINI_MODEL when it is set", async () => {
      vi.stubEnv("GEMINI_MODEL", "gemini-3.6-flash");

      await askGemini(TEXT);

      expect(sentParams().model).toBe("gemini-3.6-flash");
    });
  });

  describe("readGeminiModels", () => {
    it.each([
      ["nothing set", "", "", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
      ["both set", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.8-flash"],
      ["the backup turned off", "", "none", "gemini-3.1-flash-lite", null],
      ["the backup turned off in capitals", "", " NONE ", "gemini-3.1-flash-lite", null],
      ["the backup the same as the main model", "gemini-3.5-flash-lite", "", "gemini-3.5-flash-lite", null],
    ])("with %s", (_label, model, fallbackModel, primary, fallback) => {
      vi.stubEnv("GEMINI_MODEL", model);
      vi.stubEnv("GEMINI_FALLBACK_MODEL", fallbackModel);
      expect(readGeminiModels()).toEqual({ primary, fallback });
    });
  });

  describe("setup problems fail with SERVER_CONFIG, without calling the API", () => {
    it.each([
      ["missing", ""],
      ["only spaces", "   "],
    ])("the API key is %s", async (_label, key) => {
      vi.stubEnv("GEMINI_API_KEY", key);

      const details = await failureDetails();

      expect(details).toContain("GEMINI_API_KEY");
      await expect(askGemini(TEXT)).rejects.toThrow(correctionError("SERVER_CONFIG"));
      expect(fake.generateContent).not.toHaveBeenCalled();
    });
  });

  describe("reading the answer", () => {
    it("reads only the answer, never Gemini's thinking", async () => {
      const thinking = { text: "The text has two verb mistakes.", thought: true };
      const answer = { text: JSON.stringify(ANSWER) };
      answersWith(
        reply({
          candidates: [{ content: { role: "model", parts: [thinking, answer] }, finishReason: FinishReason.STOP }],
        }),
      );

      await expect(askGemini(TEXT)).resolves.toEqual(ANSWER);
    });

    it("a text blocked before any answer fails with AI_REFUSED, and only the reason is logged", async () => {
      answersWith(
        reply({
          candidates: undefined,
          promptFeedback: { blockReason: BlockedReason.SAFETY, blockReasonMessage: "About your text" },
        }),
      );

      await expect(askGemini(TEXT)).rejects.toThrow(correctionError("AI_REFUSED"));
      const details = await failureDetails();
      expect(details).toContain("SAFETY");
      expect(details).not.toContain("About your text");
    });

    it.each([FinishReason.SAFETY, FinishReason.RECITATION, FinishReason.PROHIBITED_CONTENT, FinishReason.SPII])(
      "an answer stopped by Google's filters (%s) fails with AI_REFUSED",
      async (finishReason) => {
        answersWith(reply({ candidates: [candidate("", finishReason)] }));

        await expect(askGemini(TEXT)).rejects.toThrow(correctionError("AI_REFUSED"));
      },
    );

    it("an answer cut off at MAX_TOKENS fails with AI_INCOMPLETE", async () => {
      answersWith(reply({ candidates: [candidate('{"correctedText": "He goes to', FinishReason.MAX_TOKENS)] }));

      await expect(askGemini(TEXT)).rejects.toThrow(correctionError("AI_INCOMPLETE"));
    });

    it("an answer that stopped for another reason fails with AI_ERROR", async () => {
      answersWith(reply({ candidates: [candidate(JSON.stringify(ANSWER), FinishReason.OTHER)] }));

      await expect(askGemini(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
      expect(await failureDetails()).toContain("OTHER");
    });

    it("an answer that isn't JSON fails with AI_ERROR, without quoting it", async () => {
      answersWith(reply({ candidates: [candidate("He goes to the office.")] }));

      await expect(askGemini(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
      expect(await failureDetails()).not.toContain("He goes");
    });

    it("an answer without any candidate fails with AI_ERROR", async () => {
      answersWith(reply({ candidates: [] }));

      await expect(askGemini(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
    });
  });

  describe("API errors", () => {
    it.each<[string, ApiErrorCode, () => unknown]>([
      ["429 free-tier limit", "RATE_LIMITED", () => httpError(429, "RESOURCE_EXHAUSTED")],
      ["503 busy", "RATE_LIMITED", () => httpError(503, "UNAVAILABLE")],
      ["500 server error", "AI_ERROR", () => httpError(500, "INTERNAL")],
      ["400 wrong key or settings", "SERVER_CONFIG", () => httpError(400, "INVALID_ARGUMENT")],
      ["400 country without free access", "SERVER_CONFIG", () => httpError(400, "FAILED_PRECONDITION")],
      ["403 no permission", "SERVER_CONFIG", () => httpError(403, "PERMISSION_DENIED")],
      ["404 unknown model", "SERVER_CONFIG", () => httpError(404, "NOT_FOUND")],
      ["504 deadline exceeded", "AI_TIMEOUT", () => httpError(504, "DEADLINE_EXCEEDED")],
      ["a network error", "AI_ERROR", networkError],
      ["an unexpected error", "AI_ERROR", () => new Error("Something broke")],
    ])("%s fails with %s", async (_label, code, makeError) => {
      failsWith(makeError());

      await expect(askGemini(TEXT)).rejects.toThrow(correctionError(code));
    });

    it("every try running out of time fails with AI_TIMEOUT, and the log says how many tries", async () => {
      // How the SDK reports a try it stopped. Its retry helper adds the try number.
      const stopped = Object.assign(new DOMException("This operation was aborted", "AbortError"), {
        attemptNumber: 2,
      });
      failsWith(stopped);

      await expect(askGemini(TEXT)).rejects.toThrow(correctionError("AI_TIMEOUT"));
      expect(await failureDetails()).toContain("(2 tries)");
    });

    it("our own deadline fails with AI_TIMEOUT", async () => {
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
      failsWith(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

      await expect(askGemini(TEXT)).rejects.toThrow(correctionError("AI_TIMEOUT"));
    });

    it("keeps the status, Google's status name and message for the server log", async () => {
      failsWith(httpError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key."));

      const details = await failureDetails();

      for (const part of ["400", "INVALID_ARGUMENT", "API key not valid"]) {
        expect(details).toContain(part);
      }
    });

    it("keeps a long error message short", async () => {
      failsWith(httpError(429, "RESOURCE_EXHAUSTED", "Quota exceeded. ".repeat(100)));

      expect((await failureDetails()).length).toBeLessThan(300);
    });

    it("names other errors by type and system code, without their message", async () => {
      failsWith(networkError());
      expect(await failureDetails()).toContain("TypeError (ECONNRESET)");

      // A parser error can quote the answer, which contains the text.
      failsWith(new SyntaxError(`Unexpected token 'H', "${TEXT}" is not valid JSON`));
      const details = await failureDetails();
      expect(details).toContain("SyntaxError");
      expect(details).not.toContain("He go");
    });
  });

  describe("logging", () => {
    it("logs one line of metadata per answer", async () => {
      await askGemini(TEXT);

      expect(consoleInfo).toHaveBeenCalledTimes(1);
      expect(consoleInfo.mock.calls[0][0]).toMatch(
        /^\[ai\/gemini\] model=gemini-3.1-flash-lite finish=STOP in=1500 out=900 thoughts=200 ms=\d+ chars=27 request=resp_test$/,
      );
    });

    it("never writes the text or the API key to the log or the error details", async () => {
      const text = "My private message";
      const written: string[] = [];
      const record = async () => {
        try {
          await askGemini(text);
        } catch (error) {
          written.push((error as Error).message);
        }
      };

      await record(); // a success
      answersWith(reply({ candidates: [candidate(`${text}, but not as JSON`)] }));
      await record(); // an answer that isn't JSON
      failsWith(httpError(400, "INVALID_ARGUMENT", "Bad request"));
      await record(); // an API error

      written.push(...consoleInfo.mock.calls.flat().map(String));
      expect(written).toHaveLength(4); // 2 error details + 2 log lines
      for (const entry of written) {
        expect(entry).not.toContain(text);
        expect(entry).not.toContain(KEY);
      }
    });
  });
});
