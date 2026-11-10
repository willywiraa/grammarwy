// @vitest-environment node
import {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ApiErrorCode } from "@/lib/api-errors";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { askClaude, DEADLINE_MS } from "./claude";
import { SYSTEM_PROMPT } from "./prompt";

// A fake Anthropic client, so no test ever calls the real API. Each test
// decides what the fake stream answers. The SDK's real error classes are
// kept, so the code sees exactly the errors it would see in production.
const fake = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  stream: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  class FakeAnthropic {
    beta = { messages: { stream: fake.stream } };
    constructor(options: unknown) {
      fake.clientOptions.push(options);
    }
  }
  return { ...actual, default: FakeAnthropic };
});

const TEXT = "He go to office every days.";
const KEY = "sk-ant-test-key-0123456789";
const ANSWER = SAMPLE_WITH_FIXES.result;

/** A finished message from Claude. By default it contains a valid answer. */
function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify(ANSWER) }],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 1500, output_tokens: 900, iterations: null },
    ...overrides,
  };
}

function answersWith(finished: ReturnType<typeof message>) {
  fake.stream.mockReturnValue({ finalMessage: async () => finished, request_id: "req_test" });
}

function failsWith(error: unknown) {
  fake.stream.mockReturnValue({
    finalMessage: async () => {
      throw error;
    },
    request_id: undefined,
  });
}

type ErrorType = NonNullable<APIError["type"]>;

/** An error answer from the API, built the way the SDK builds it. */
function httpError(status: number, type: ErrorType, apiMessage = "Something went wrong") {
  return APIError.generate(
    status,
    { type: "error", error: { type, message: apiMessage } },
    undefined,
    new Headers({ "request-id": "req_failed" }),
  );
}

/** An error in the middle of an answer. It has a type, but no HTTP status. */
function midStreamError(type: ErrorType) {
  return new APIError(undefined, { type: "error", error: { type, message: "Stopped" } }, undefined, new Headers(), type);
}

/** Matches a CorrectionError with the given code. */
function correctionError(code: ApiErrorCode) {
  return expect.objectContaining({ name: "CorrectionError", code });
}

/** The details a failed call writes to the server log. */
async function failureDetails(): Promise<string> {
  try {
    await askClaude(TEXT);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected askClaude to fail");
}

function sentParams() {
  return fake.stream.mock.calls[0][0];
}

let consoleInfo: MockInstance<typeof console.info>;

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", KEY);
  fake.clientOptions.length = 0;
  fake.stream.mockReset();
  answersWith(message());
  consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  consoleInfo.mockRestore();
});

describe("askClaude", () => {
  describe("the request", () => {
    it("returns Claude's answer as parsed JSON", async () => {
      await expect(askClaude(TEXT)).resolves.toEqual(ANSWER);
    });

    it("sends the expected request settings", async () => {
      await askClaude(TEXT);

      const params = sentParams();
      expect(params).toMatchObject({
        model: "claude-opus-5-5",
        max_tokens: 16_000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `<text>\n${TEXT}\n</text>` }],
        output_config: { effort: "low", format: { type: "json_schema" } },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      // Opus 5.5 rejects sampling settings, and its thinking is always on.
      expect(params).not.toHaveProperty("temperature");
      expect(params).not.toHaveProperty("thinking");
    });

    it("sends the JSON schema of our answer format, without the SDK's own parser", async () => {
      await askClaude(TEXT);

      const { format } = sentParams().output_config;
      expect(Object.keys(format).sort()).toEqual(["schema", "type"]);
      expect(format.schema.required).toEqual([
        "correctedText",
        "professionalVersion",
        "naturalVersion",
        "conciseVersion",
        "explanations",
        "alreadyCorrect",
      ]);
    });

    it("gives up at a deadline that is shorter than Vercel's 300-second limit", async () => {
      await askClaude(TEXT);

      expect(fake.stream.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(DEADLINE_MS).toBeLessThan(300_000);
    });

    it("sends the key only to Anthropic's API, whatever the environment says", async () => {
      vi.stubEnv("ANTHROPIC_BASE_URL", "http://localhost:9999");
      vi.stubEnv("ANTHROPIC_LOG", "debug");

      await askClaude(TEXT);

      expect(fake.clientOptions).toEqual([
        { apiKey: KEY, baseURL: "https://api.anthropic.com", logLevel: "warn", maxRetries: 1 },
      ]);
    });

    it("uses ANTHROPIC_MODEL and ANTHROPIC_EFFORT when they are set", async () => {
      vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
      vi.stubEnv("ANTHROPIC_EFFORT", "medium");

      await askClaude(TEXT);

      expect(sentParams()).toMatchObject({
        model: "claude-sonnet-5-5",
        output_config: { effort: "medium" },
      });
    });
  });

  describe("setup problems fail with SERVER_CONFIG, without calling the API", () => {
    it.each([
      ["missing", ""],
      ["only spaces", "   "],
    ])("the API key is %s", async (_label, key) => {
      vi.stubEnv("ANTHROPIC_API_KEY", key);

      const details = await failureDetails();

      expect(details).toContain("ANTHROPIC_API_KEY");
      await expect(askClaude(TEXT)).rejects.toThrow(correctionError("SERVER_CONFIG"));
      expect(fake.stream).not.toHaveBeenCalled();
    });

    it("ANTHROPIC_EFFORT has a value the API doesn't know", async () => {
      vi.stubEnv("ANTHROPIC_EFFORT", "fast");

      await expect(askClaude(TEXT)).rejects.toThrow(correctionError("SERVER_CONFIG"));
      expect(await failureDetails()).toContain("low, medium, high");
      expect(fake.stream).not.toHaveBeenCalled();
    });
  });

  describe("reading the answer", () => {
    it("joins an answer that a backup model finished in a second text block", async () => {
      const json = JSON.stringify(ANSWER);
      answersWith(
        message({
          content: [
            { type: "text", text: json.slice(0, 40) },
            { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
            { type: "text", text: json.slice(40) },
          ],
        }),
      );

      await expect(askClaude(TEXT)).resolves.toEqual(ANSWER);
    });

    it("a refusal fails with AI_REFUSED, and only its category is logged", async () => {
      answersWith(
        message({
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "About your text" },
        }),
      );

      await expect(askClaude(TEXT)).rejects.toThrow(correctionError("AI_REFUSED"));
      const details = await failureDetails();
      expect(details).toContain("cyber");
      expect(details).not.toContain("About your text");
    });

    it("an answer cut off at max_tokens fails with AI_INCOMPLETE", async () => {
      answersWith(
        message({
          content: [{ type: "text", text: '{"correctedText": "He goes to' }],
          stop_reason: "max_tokens",
        }),
      );

      await expect(askClaude(TEXT)).rejects.toThrow(correctionError("AI_INCOMPLETE"));
    });

    it("an answer that isn't JSON fails with AI_ERROR, without quoting it", async () => {
      answersWith(message({ content: [{ type: "text", text: "He goes to the office." }] }));

      await expect(askClaude(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
      expect(await failureDetails()).not.toContain("He goes");
    });

    it("an answer without any text fails with AI_ERROR", async () => {
      answersWith(message({ content: [] }));

      await expect(askClaude(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
    });
  });

  describe("API errors", () => {
    it.each<[string, () => unknown, ApiErrorCode]>([
      ["429 rate limit", () => httpError(429, "rate_limit_error"), "RATE_LIMITED"],
      ["529 overloaded", () => httpError(529, "overloaded_error"), "RATE_LIMITED"],
      ["overloaded in the middle of the answer", () => midStreamError("overloaded_error"), "RATE_LIMITED"],
      ["500 server error", () => httpError(500, "api_error"), "AI_ERROR"],
      ["400 bad request", () => httpError(400, "invalid_request_error"), "SERVER_CONFIG"],
      ["401 wrong API key", () => httpError(401, "authentication_error"), "SERVER_CONFIG"],
      ["402 no credits", () => httpError(402, "billing_error"), "SERVER_CONFIG"],
      ["403 no permission", () => httpError(403, "permission_error"), "SERVER_CONFIG"],
      ["404 unknown model", () => httpError(404, "not_found_error"), "SERVER_CONFIG"],
      ["504 gateway timeout", () => httpError(504, "timeout_error"), "AI_TIMEOUT"],
      ["a connection timeout", () => new APIConnectionTimeoutError(), "AI_TIMEOUT"],
      ["our own deadline", () => new APIUserAbortError(), "AI_TIMEOUT"],
      ["a connection error", () => new APIConnectionError({ message: "Connection error." }), "AI_ERROR"],
      ["another SDK error", () => new AnthropicError("request ended without sending any chunks"), "AI_ERROR"],
      ["an unexpected error", () => new TypeError("Something broke"), "AI_ERROR"],
    ])("%s fails with %s", async (_label, makeError, code) => {
      failsWith(makeError());

      await expect(askClaude(TEXT)).rejects.toThrow(correctionError(code));
    });

    it("keeps the status, error type, message and request ID for the server log", async () => {
      failsWith(httpError(401, "authentication_error", "invalid x-api-key"));

      const details = await failureDetails();

      for (const part of ["401", "authentication_error", "invalid x-api-key", "req_failed"]) {
        expect(details).toContain(part);
      }
    });
  });

  describe("logging", () => {
    it("logs one line of metadata per answer", async () => {
      await askClaude(TEXT);

      expect(consoleInfo).toHaveBeenCalledTimes(1);
      expect(consoleInfo.mock.calls[0][0]).toMatch(
        /^\[ai\/claude\] model=claude-opus-5-5 effort=low stop=end_turn in=1500 out=900 ms=\d+ chars=27 fallback=no request=req_test$/,
      );
    });

    it("notes when a backup model wrote the answer", async () => {
      answersWith(
        message({
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 1600,
            output_tokens: 950,
            iterations: [
              { type: "message", input_tokens: 1500, output_tokens: 0 },
              { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1600, output_tokens: 950 },
            ],
          },
        }),
      );

      await askClaude(TEXT);

      const line = String(consoleInfo.mock.calls[0][0]);
      expect(line).toContain("model=claude-opus-4-8");
      expect(line).toContain("fallback=yes");
    });

    it("never writes the text or the API key to the log or the error details", async () => {
      const text = "My private message";
      const written: string[] = [];
      const record = async () => {
        try {
          await askClaude(text);
        } catch (error) {
          written.push((error as Error).message);
        }
      };

      await record(); // a success
      answersWith(message({ content: [{ type: "text", text: `${text}, but not as JSON` }] }));
      await record(); // an answer that isn't JSON
      failsWith(httpError(400, "invalid_request_error", "Bad request"));
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
