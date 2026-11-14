// @vitest-environment node
import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { askGemini } from "@/lib/ai/gemini";
import { API_ERRORS, CorrectionError, type ApiErrorCode } from "@/lib/api-errors";
import { countCorrection } from "@/lib/limits";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { POST } from "./route";

// The mock AI's pause is skipped, so the tests run instantly.
vi.mock("@/lib/wait", () => ({ wait: vi.fn(async () => {}) }));

// A fake count, so no test needs a database. limits.test.ts covers the counting.
vi.mock("@/lib/limits", () => ({ countCorrection: vi.fn() }));

// A fake Gemini call for the live answer's tests. gemini.test.ts covers the
// Gemini code itself.
vi.mock("@/lib/ai/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/gemini")>()),
  askGemini: vi.fn(),
}));

// A fake Anthropic client for the tests with mock mode off, so they never
// call the real API. claude.test.ts covers the Claude code in detail.
const fakeStream = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic {
    beta = { messages: { stream: fakeStream } };
  }
  return { ...actual, default: FakeAnthropic };
});

/** Makes the fake Claude finish with this message. */
function claudeAnswers(overrides: Record<string, unknown>) {
  fakeStream.mockReturnValue({
    finalMessage: async () => ({
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify(SAMPLE_WITH_FIXES.result) }],
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 1500, output_tokens: 900, iterations: null },
      ...overrides,
    }),
    request_id: "req_test",
  });
}

/** Makes the fake Claude fail with this error. */
function claudeFails(error: unknown) {
  fakeStream.mockReturnValue({
    finalMessage: async () => {
      throw error;
    },
  });
}

/** Sends a request to the route, the way the page will. */
function post(body: unknown, contentType = "application/json"): Promise<Response> {
  return POST(
    new Request("http://localhost/api/correct", {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

/** The exact error answer for a code: the code and the friendly message, nothing more. */
function errorBody(code: ApiErrorCode) {
  return { error: { code, message: API_ERRORS[code].message } };
}

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.stubEnv("USE_MOCK_AI", "true");
  fakeStream.mockReset();
  vi.mocked(countCorrection).mockReset().mockResolvedValue({ allowed: true, usage: null });
  // Failures are logged with console.error. Keep them out of the test output,
  // but record them so we can check what was logged.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  consoleError.mockRestore();
});

describe("POST /api/correct", () => {
  describe("success", () => {
    it("answers 200 with the corrected text", async () => {
      const response = await post({ text: "He go to office every days." });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(SAMPLE_WITH_FIXES.result);
    });

    it("accepts a JSON content type that includes a charset", async () => {
      const response = await post({ text: "Hello" }, "application/json; charset=utf-8");
      expect(response.status).toBe(200);
    });

    it("accepts exactly 5,000 characters", async () => {
      const response = await post({ text: "a".repeat(5000) });
      expect(response.status).toBe(200);
    });

    it("[correct] answers with the original text unchanged", async () => {
      const text = "Thanks for the update. [correct]";

      const result = await (await post({ text })).json();

      expect(result.alreadyCorrect).toBe(true);
      expect(result.correctedText).toBe(text);
      expect(result.explanations).toEqual([]);
    });
  });

  describe("bad requests answer 400", () => {
    const cases: [string, unknown, ApiErrorCode][] = [
      ["empty text", { text: "" }, "EMPTY_TEXT"],
      ["only spaces and line breaks", { text: "  \n\n  " }, "EMPTY_TEXT"],
      ["more than 5,000 characters", { text: "a".repeat(5001) }, "TEXT_TOO_LONG"],
      ["a missing text field", { message: "Hello" }, "INVALID_REQUEST"],
      ["text that isn't a string", { text: 42 }, "INVALID_REQUEST"],
      ["a body that isn't an object", ["Hello"], "INVALID_REQUEST"],
      ["invalid JSON", "{ text: Hello", "INVALID_REQUEST"],
    ];

    it.each(cases)("%s", async (_label, body, code) => {
      const response = await post(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(errorBody(code));
    });

    it("the wrong content type, like a form post from another website", async () => {
      const response = await post("text=Hello", "application/x-www-form-urlencoded");

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(errorBody("INVALID_REQUEST"));
    });
  });

  describe("AI failures", () => {
    it("answers 502 when the AI service fails ([error])", async () => {
      const response = await post({ text: "Hello [error]" });

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual(errorBody("AI_ERROR"));
    });

    it("answers 502 when the AI's answer has the wrong format ([invalid])", async () => {
      const response = await post({ text: "Hello [invalid]" });

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual(errorBody("AI_ERROR"));
    });

    it("answers 500 when mock mode is off and there is no API key", async () => {
      vi.stubEnv("USE_MOCK_AI", "false");
      vi.stubEnv("ANTHROPIC_API_KEY", "");

      const response = await post({ text: "Hello" });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(errorBody("SERVER_CONFIG"));
      expect(fakeStream).not.toHaveBeenCalled();
    });
  });

  describe("with Claude (a fake Anthropic SDK)", () => {
    let consoleInfo: MockInstance<typeof console.info>;

    beforeEach(() => {
      vi.stubEnv("USE_MOCK_AI", "false");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
      consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleInfo.mockRestore();
    });

    it("answers 200 with Claude's checked answer", async () => {
      claudeAnswers({});

      const response = await post({ text: "He go to office every days." });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(SAMPLE_WITH_FIXES.result);
    });

    it("answers 422 when Claude declines the text", async () => {
      claudeAnswers({ content: [], stop_reason: "refusal" });

      const response = await post({ text: "Hello" });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual(errorBody("AI_REFUSED"));
    });

    it("answers 429 when the AI service is busy", async () => {
      claudeFails(
        APIError.generate(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
          undefined,
          new Headers(),
        ),
      );

      const response = await post({ text: "Hello" });

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual(errorBody("RATE_LIMITED"));
    });

    it("answers 504 when Claude takes too long", async () => {
      claudeFails(new APIUserAbortError());

      const response = await post({ text: "Hello" });

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual(errorBody("AI_TIMEOUT"));
    });

    it("answers 500 with only the friendly message when the API key is wrong", async () => {
      claudeFails(
        APIError.generate(
          401,
          { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
          undefined,
          new Headers({ "request-id": "req_secret_detail" }),
        ),
      );

      const response = await post({ text: "Hello" });

      const answer = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(answer)).toEqual(errorBody("SERVER_CONFIG"));
      expect(answer).not.toContain("x-api-key");
      expect(answer).not.toContain("req_secret_detail");
      // The details are in the server log instead.
      const logged = consoleError.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("invalid x-api-key");
    });
  });

  describe("the live answer (Accept: application/x-ndjson)", () => {
    const ANSWER_JSON = JSON.stringify(SAMPLE_WITH_FIXES.result);
    const PIECES = [ANSWER_JSON.slice(0, 30), ANSWER_JSON.slice(30)];

    /** Sends a request that asks for the live answer, the way the page does. */
    function postLive(body: unknown, accept = "application/x-ndjson, application/json"): Promise<Response> {
      return POST(
        new Request("http://localhost/api/correct", {
          method: "POST",
          headers: { "content-type": "application/json", accept },
          body: JSON.stringify(body),
        }),
      );
    }

    /** The events of a live answer, one per line. */
    async function events(response: Response): Promise<unknown[]> {
      const text = await response.text();
      expect(text.endsWith("\n")).toBe(true);
      return text.trimEnd().split("\n").map((line) => JSON.parse(line));
    }

    /** Makes the fake Gemini write these pieces, then answer with the whole answer. */
    function geminiWrites(pieces: string[]) {
      vi.mocked(askGemini).mockImplementationOnce(async (_text, options) => {
        for (const piece of pieces) {
          options?.onText?.(piece);
        }
        return JSON.parse(pieces.join(""));
      });
    }

    beforeEach(() => {
      vi.stubEnv("USE_MOCK_AI", "false");
      vi.stubEnv("AI_PROVIDER", "gemini");
      vi.mocked(askGemini).mockReset();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("sends the pieces of the answer as Gemini writes them, then the checked result", async () => {
      geminiWrites(PIECES);

      const response = await postLive({ text: "He go to office every days." });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
      expect(await events(response)).toEqual([
        { type: "text", text: PIECES[0] },
        { type: "text", text: PIECES[1] },
        { type: "done", result: SAMPLE_WITH_FIXES.result },
      ]);
    });

    it("finds the live answer's type among the other accepted types", async () => {
      geminiWrites(PIECES);

      const response = await postLive({ text: "Hello" }, "application/json;q=0.9, Application/X-NDJSON");

      expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    });

    it("says when the backup model starts again", async () => {
      vi.mocked(askGemini).mockImplementationOnce(async (_text, options) => {
        options?.onText?.(PIECES[0]);
        throw new CorrectionError("AI_ERROR", "The AI answer lost the line breaks of the text");
      });
      geminiWrites(PIECES);

      const response = await postLive({ text: "Hello" });

      expect(await events(response)).toEqual([
        { type: "text", text: PIECES[0] },
        { type: "restart" },
        { type: "text", text: PIECES[0] },
        { type: "text", text: PIECES[1] },
        { type: "done", result: SAMPLE_WITH_FIXES.result },
      ]);
    });

    it("ends with an error event that has only the friendly message", async () => {
      vi.mocked(askGemini)
        .mockRejectedValueOnce(new CorrectionError("RATE_LIMITED", "429 daily limit"))
        .mockRejectedValueOnce(new CorrectionError("AI_TIMEOUT", "No complete answer from Gemini after 70000 ms"));

      const response = await postLive({ text: "Hello" });

      const answer = await events(response);
      expect(answer).toEqual([{ type: "restart" }, { type: "error", ...errorBody("AI_TIMEOUT") }]);
      expect(JSON.stringify(answer)).not.toContain("70000");
      const logged = consoleError.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("AI_TIMEOUT: No complete answer from Gemini after 70000 ms");
    });

    it("sends just the result when the AI doesn't write in pieces (mock mode)", async () => {
      vi.stubEnv("USE_MOCK_AI", "true");

      const response = await postLive({ text: "He go to office every days." });

      expect(await events(response)).toEqual([{ type: "done", result: SAMPLE_WITH_FIXES.result }]);
    });

    it("answers a request that fails the checks with a JSON error and its status", async () => {
      const response = await postLive({ text: "   " });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(errorBody("EMPTY_TEXT"));
      expect(askGemini).not.toHaveBeenCalled();
    });

    it("stops sending, without an error, when the browser stops reading", async () => {
      let finish: () => void = () => {};
      vi.mocked(askGemini).mockImplementationOnce(async (_text, options) => {
        options?.onText?.(PIECES[0]);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        options?.onText?.(PIECES[1]);
        return SAMPLE_WITH_FIXES.result;
      });

      const response = await postLive({ text: "Hello" });
      const reader = response.body!.getReader();
      await reader.read(); // the first piece
      await reader.cancel(); // the page was closed
      finish();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  describe("limits", () => {
    const MIDNIGHT = "2026-11-15T00:00:00.000Z";
    const USAGE = { limit: 100, remaining: 87, resetAt: MIDNIGHT };
    const MINUTE_LIMIT = {
      allowed: false,
      period: "minute",
      limit: 10,
      retryAfter: 20,
      resetAt: "2026-11-14T03:26:00.000Z",
      usage: { ...USAGE, remaining: 58 },
    } as const;
    let consoleInfo: MockInstance<typeof console.info>;
    let consoleWarn: MockInstance<typeof console.warn>;

    function postLive(body: unknown): Promise<Response> {
      return POST(
        new Request("http://localhost/api/correct", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/x-ndjson" },
          body: JSON.stringify(body),
        }),
      );
    }

    beforeEach(() => {
      vi.stubEnv("USE_MOCK_AI", "false");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
      consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
      consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleInfo.mockRestore();
      consoleWarn.mockRestore();
    });

    it("counts each correction and says how many are left today", async () => {
      vi.mocked(countCorrection).mockResolvedValue({ allowed: true, usage: USAGE });
      claudeAnswers({});

      const response = await post({ text: "He go to office every days." });

      expect(response.status).toBe(200);
      expect(countCorrection).toHaveBeenCalledOnce();
      expect(response.headers.get("x-daily-limit")).toBe("100");
      expect(response.headers.get("x-daily-remaining")).toBe("87");
      expect(response.headers.get("x-daily-reset")).toBe(MIDNIGHT);
    });

    it("sends the count with the live answer and with a failed correction", async () => {
      vi.mocked(countCorrection).mockResolvedValue({ allowed: true, usage: USAGE });
      claudeAnswers({});
      const live = await postLive({ text: "Hello" });
      claudeAnswers({ content: [], stop_reason: "refusal" });
      const failed = await post({ text: "Hello" });

      expect(live.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
      expect(live.headers.get("x-daily-remaining")).toBe("87");
      expect(failed.status).toBe(422);
      expect(failed.headers.get("x-daily-remaining")).toBe("87");
    });

    it("sends no count when corrections aren't counted", async () => {
      claudeAnswers({});
      const response = await post({ text: "Hello" });
      expect(response.headers.get("x-daily-limit")).toBeNull();
    });

    it("answers 429 with Retry-After once the limit per minute is reached, without asking the AI", async () => {
      vi.mocked(countCorrection).mockResolvedValue(MINUTE_LIMIT);

      const response = await post({ text: "Hello" });

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("20");
      expect(response.headers.get("x-daily-remaining")).toBe("58");
      expect(await response.json()).toEqual({
        error: {
          code: "LIMIT_REACHED",
          message: API_ERRORS.LIMIT_REACHED.message,
          period: "minute",
          limit: 10,
          retryAfter: 20,
          resetAt: "2026-11-14T03:26:00.000Z",
        },
      });
      expect(fakeStream).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        "[api/correct] LIMIT_REACHED: the limit of 10 corrections per minute",
      );
    });

    it("answers the day's limit with a JSON 429, even when the live answer was asked for", async () => {
      vi.mocked(countCorrection).mockResolvedValue({
        allowed: false,
        period: "day",
        limit: 100,
        retryAfter: 74_060,
        resetAt: MIDNIGHT,
        usage: { ...USAGE, remaining: 0 },
      });

      const response = await postLive({ text: "Hello" });

      expect(response.status).toBe(429);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("retry-after")).toBe("74060");
      expect(await response.json()).toMatchObject({
        error: { code: "LIMIT_REACHED", period: "day", limit: 100, resetAt: MIDNIGHT },
      });
    });

    it("doesn't count a text that fails its checks", async () => {
      await post({ text: "   " });
      await post({ text: "a".repeat(5001) });
      expect(countCorrection).not.toHaveBeenCalled();
    });

    it("doesn't count sample answers in mock mode", async () => {
      vi.stubEnv("USE_MOCK_AI", "true");
      const response = await post({ text: "Hello" });
      expect(response.status).toBe(200);
      expect(countCorrection).not.toHaveBeenCalled();
    });

    describe("when Gemini's free daily allowance is used up", () => {
      const used = () =>
        new CorrectionError("AI_DAILY_LIMIT", "Gemini API error 429, RESOURCE_EXHAUSTED", {
          retryAfter: 3_600,
          resetAt: "2026-11-14T08:00:00.000Z",
        });

      beforeEach(() => {
        vi.stubEnv("ANTHROPIC_API_KEY", "");
        vi.stubEnv("AI_PROVIDER", "gemini");
        vi.mocked(askGemini).mockReset().mockRejectedValueOnce(used()).mockRejectedValueOnce(used());
      });

      it("says when it comes back, in the JSON answer", async () => {
        const response = await post({ text: "Hello" });

        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("3600");
        expect(await response.json()).toEqual({
          error: {
            code: "AI_DAILY_LIMIT",
            message: API_ERRORS.AI_DAILY_LIMIT.message,
            retryAfter: 3_600,
            resetAt: "2026-11-14T08:00:00.000Z",
          },
        });
      });

      it("says when it comes back, in the live answer's error event", async () => {
        const text = await (await postLive({ text: "Hello" })).text();
        const last = JSON.parse(text.trimEnd().split("\n").at(-1)!);

        expect(last).toEqual({
          type: "error",
          error: {
            code: "AI_DAILY_LIMIT",
            message: API_ERRORS.AI_DAILY_LIMIT.message,
            retryAfter: 3_600,
            resetAt: "2026-11-14T08:00:00.000Z",
          },
        });
      });
    });
  });

  describe("privacy", () => {
    it("writes failure details to the server log, not to the answer", async () => {
      const response = await post({ text: "Hello [invalid]" });

      const answer = await response.text();
      const logged = consoleError.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("didn't match the schema");
      expect(answer).not.toContain("schema");
    });

    it("never writes the user's text to the log", async () => {
      await post({ text: "My private message [error]" });
      await post({ text: "My private message [invalid]" });

      expect(consoleError).toHaveBeenCalledTimes(2);
      const logged = consoleError.mock.calls.flat().map(String).join("\n");
      expect(logged).not.toContain("My private message");
    });
  });
});
