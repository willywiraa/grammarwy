// @vitest-environment node
import { APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { API_ERRORS, type ApiErrorCode } from "@/lib/api-errors";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { POST } from "./route";

// The mock AI's pause is skipped, so the tests run instantly.
vi.mock("@/lib/wait", () => ({ wait: vi.fn(async () => {}) }));

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
