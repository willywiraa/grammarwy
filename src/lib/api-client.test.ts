import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ERRORS } from "@/lib/api-errors";
import type { PartialAnswer, StreamEvent } from "@/lib/correction-stream";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { usageHeaders } from "@/lib/usage";
import {
  ANSWER_STOPPED_MESSAGE,
  fetchUsage,
  messageForError,
  NETWORK_ERROR_MESSAGE,
  requestCorrection,
} from "./api-client";

// The tests replace the browser's fetch, so no real requests are sent.
const fetchMock = vi.fn<typeof fetch>();

/** Makes the pretend server answer with this body and status. */
function serverAnswers(body: string, status: number, contentType = "application/json") {
  fetchMock.mockResolvedValue(
    new Response(body, { status, headers: { "Content-Type": contentType } }),
  );
}

/** One line of a live answer. */
function line(event: StreamEvent | Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Makes the pretend server send a live answer in these chunks. A chunk can end
 * in the middle of a line, or even in the middle of a character. With
 * `breakAtEnd`, the connection breaks after the last chunk.
 */
function serverStreams(chunks: (string | Uint8Array)[], breakAtEnd = false) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      if (breakAtEnd) {
        controller.error(new TypeError("network error"));
      } else {
        controller.close();
      }
    },
  });
  fetchMock.mockResolvedValue(
    new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } }),
  );
}

/** The AI's answer as JSON, cut into pieces the way it streams in. */
const ANSWER_JSON = JSON.stringify(SAMPLE_WITH_FIXES.result);
const PIECES = [ANSWER_JSON.slice(0, 25), ANSWER_JSON.slice(25, 120), ANSWER_JSON.slice(120)];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestCorrection", () => {
  it("sends the text as JSON to /api/correct, and asks for the live answer", async () => {
    serverAnswers(JSON.stringify(SAMPLE_WITH_FIXES.result), 200);

    await requestCorrection("He go to office.");

    expect(fetchMock).toHaveBeenCalledWith("/api/correct", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
      body: JSON.stringify({ text: "He go to office." }),
    });
  });

  it("returns the result from a successful answer", async () => {
    serverAnswers(JSON.stringify(SAMPLE_WITH_FIXES.result), 200);

    await expect(requestCorrection("He go to office.")).resolves.toEqual({
      ok: true,
      result: SAMPLE_WITH_FIXES.result,
    });
  });

  it("returns the server's own message from an error answer", async () => {
    const { message } = API_ERRORS.RATE_LIMITED;
    serverAnswers(JSON.stringify({ error: { code: "RATE_LIMITED", message } }), 429);

    await expect(requestCorrection("Hello")).resolves.toEqual({ ok: false, message });
  });

  it("returns the connection message when the server can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: NETWORK_ERROR_MESSAGE,
    });
  });

  it("returns a general message when the answer isn't JSON", async () => {
    serverAnswers("<html>Internal Server Error</html>", 500, "text/html");

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: API_ERRORS.AI_ERROR.message,
    });
  });

  it("returns the timeout message when the hosting service gives up waiting (504)", async () => {
    serverAnswers("An error occurred with your deployment", 504, "text/plain");

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: API_ERRORS.AI_TIMEOUT.message,
    });
  });

  it("returns a general message when an error answer has no message", async () => {
    serverAnswers(JSON.stringify({ something: "else" }), 500);

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: API_ERRORS.AI_ERROR.message,
    });
  });

  it("never shows a successful answer in the wrong format", async () => {
    serverAnswers(JSON.stringify({ correctedText: "Only one field." }), 200);

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: API_ERRORS.AI_ERROR.message,
    });
  });

  describe("the live answer", () => {
    it("shows the versions while they are written, then returns the result", async () => {
      serverStreams([
        ...PIECES.map((text) => line({ type: "text", text })),
        line({ type: "done", result: SAMPLE_WITH_FIXES.result }),
      ]);
      const onPartial = vi.fn<(answer: PartialAnswer) => void>();

      const outcome = await requestCorrection("He go to office.", { onPartial });

      expect(outcome).toEqual({ ok: true, result: SAMPLE_WITH_FIXES.result });
      const shown = onPartial.mock.calls.map(([answer]) => answer);
      expect(shown.length).toBeGreaterThanOrEqual(2);
      // The first pieces hold part of the corrected text; the last hold every version.
      expect(SAMPLE_WITH_FIXES.result.correctedText.startsWith(shown[0].correctedText ?? "")).toBe(true);
      expect(shown[0].professionalVersion).toBeUndefined();
      expect(shown.at(-1)).toEqual({
        correctedText: SAMPLE_WITH_FIXES.result.correctedText,
        professionalVersion: SAMPLE_WITH_FIXES.result.professionalVersion,
        naturalVersion: SAMPLE_WITH_FIXES.result.naturalVersion,
        conciseVersion: SAMPLE_WITH_FIXES.result.conciseVersion,
      });
    });

    it("reads lines and characters that arrive split across chunks", async () => {
      const text = "Café 😊 déjà vu";
      const result = { ...SAMPLE_WITH_FIXES.result, correctedText: text };
      const bytes = new TextEncoder().encode(
        line({ type: "text", text: JSON.stringify({ correctedText: text }).slice(0, -2) }) +
          line({ type: "done", result }),
      );
      // Cut every 3 bytes, which splits the accented letters and the emoji.
      const chunks: Uint8Array[] = [];
      for (let start = 0; start < bytes.length; start += 3) {
        chunks.push(bytes.slice(start, start + 3));
      }
      serverStreams(chunks);
      const onPartial = vi.fn<(answer: PartialAnswer) => void>();

      await expect(requestCorrection("Hello", { onPartial })).resolves.toEqual({ ok: true, result });
      // The text event held the JSON up to the end of the text, without its closing quote.
      expect(onPartial).toHaveBeenLastCalledWith({ correctedText: text });
    });

    it("doesn't report the versions again while the explanations are written", async () => {
      const versionsEnd = ANSWER_JSON.indexOf('"explanations"');
      const rest = ANSWER_JSON.slice(versionsEnd);
      serverStreams([
        line({ type: "text", text: ANSWER_JSON.slice(0, versionsEnd) }),
        line({ type: "text", text: rest.slice(0, 40) }),
        line({ type: "text", text: rest.slice(40) }),
        line({ type: "done", result: SAMPLE_WITH_FIXES.result }),
      ]);
      const onPartial = vi.fn();

      await requestCorrection("Hello", { onPartial });

      expect(onPartial).toHaveBeenCalledTimes(1);
    });

    it("drops what was shown when the backup model starts again", async () => {
      serverStreams([
        line({ type: "text", text: '{"correctedText": "First try' }),
        line({ type: "restart" }),
        line({ type: "text", text: '{"correctedText": "Second' }),
        line({ type: "done", result: SAMPLE_WITH_FIXES.result }),
      ]);
      const events: string[] = [];
      const onPartial = (answer: PartialAnswer) => events.push(`partial: ${answer.correctedText}`);
      const onRestart = () => events.push("restart");

      await expect(requestCorrection("Hello", { onPartial, onRestart })).resolves.toMatchObject({ ok: true });
      expect(events).toEqual(["partial: First try", "restart", "partial: Second"]);
    });

    it("returns the message of an error event", async () => {
      const { message } = API_ERRORS.AI_TIMEOUT;
      serverStreams([
        line({ type: "text", text: PIECES[0] }),
        line({ type: "error", error: { code: "AI_TIMEOUT", message } }),
      ]);

      await expect(requestCorrection("Hello")).resolves.toEqual({ ok: false, message });
    });

    it("returns a general message for an error event without a message", async () => {
      serverStreams([line({ type: "error", error: {} })]);

      await expect(requestCorrection("Hello")).resolves.toEqual({
        ok: false,
        message: API_ERRORS.AI_ERROR.message,
      });
    });

    it("never shows a final result in the wrong format", async () => {
      serverStreams([line({ type: "done", result: { correctedText: "Only one field." } })]);

      await expect(requestCorrection("Hello")).resolves.toEqual({
        ok: false,
        message: API_ERRORS.AI_ERROR.message,
      });
    });

    it("skips empty and unreadable lines", async () => {
      serverStreams(["\n", "not json\n", line({ type: "unknown" }), line({ type: "done", result: SAMPLE_WITH_FIXES.result })]);

      await expect(requestCorrection("Hello")).resolves.toEqual({ ok: true, result: SAMPLE_WITH_FIXES.result });
    });

    it.each([
      ["ends without a result", false],
      ["breaks off", true],
    ])("returns the stopped message when the answer %s", async (_label, breakAtEnd) => {
      serverStreams([line({ type: "text", text: PIECES[0] })], breakAtEnd);

      await expect(requestCorrection("Hello")).resolves.toEqual({
        ok: false,
        message: ANSWER_STOPPED_MESSAGE,
      });
    });
  });
});

describe("today's count", () => {
  const USAGE = { limit: 100, remaining: 87, resetAt: "2026-11-15T00:00:00.000Z" };

  it("comes with the result, from the answer's headers", async () => {
    fetchMock.mockResolvedValue(
      Response.json(SAMPLE_WITH_FIXES.result, { headers: usageHeaders(USAGE) }),
    );
    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: true,
      result: SAMPLE_WITH_FIXES.result,
      usage: USAGE,
    });
  });

  it("comes with the live answer, and with a failed correction", async () => {
    const live = new Response(line({ type: "done", result: SAMPLE_WITH_FIXES.result }), {
      headers: { "Content-Type": "application/x-ndjson", ...usageHeaders(USAGE) },
    });
    fetchMock.mockResolvedValueOnce(live).mockResolvedValueOnce(
      Response.json(
        { error: { code: "AI_REFUSED", message: API_ERRORS.AI_REFUSED.message } },
        { status: 422, headers: usageHeaders(USAGE) },
      ),
    );

    await expect(requestCorrection("Hello")).resolves.toMatchObject({ ok: true, usage: USAGE });
    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: API_ERRORS.AI_REFUSED.message,
      usage: USAGE,
    });
  });
});

describe("messageForError", () => {
  // 10:00 in Jakarta, 7 hours ahead of UTC.
  const NOW = new Date("2026-11-14T03:00:00.000Z");
  const JAKARTA = { locale: "en-GB", timeZone: "Asia/Jakarta" };
  const limit = (fields: Record<string, unknown>) => ({
    code: "LIMIT_REACHED",
    message: API_ERRORS.LIMIT_REACHED.message,
    ...fields,
  });

  it("says how long to wait after too many corrections in one minute", () => {
    expect(messageForError(limit({ period: "minute", limit: 10, retryAfter: 20 }), "x")).toBe(
      "Too many corrections in one minute. Please wait 20 seconds.",
    );
    expect(messageForError(limit({ period: "minute", limit: 10, retryAfter: 1 }), "x")).toBe(
      "Too many corrections in one minute. Please wait 1 second.",
    );
  });

  it("says when more corrections are possible after the day's limit, in your own time", () => {
    const error = limit({ period: "day", limit: 1000, retryAfter: 75_600, resetAt: "2026-11-15T00:00:00.000Z" });
    expect(messageForError(error, "x", NOW, JAKARTA)).toBe(
      "You've used all 1,000 corrections for today. You can correct more from 7:00 tomorrow.",
    );
  });

  it("says when Gemini's free daily allowance comes back", () => {
    const error = {
      code: "AI_DAILY_LIMIT",
      message: API_ERRORS.AI_DAILY_LIMIT.message,
      retryAfter: 18_000,
      resetAt: "2026-11-14T08:00:00.000Z",
    };
    expect(messageForError(error, "x", NOW, JAKARTA)).toBe(
      "Today's free AI allowance is used up. You can correct more from 15:00.",
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ["no wait time", limit({ period: "minute" })],
    ["a wait time that isn't a whole number", limit({ period: "minute", retryAfter: "20" })],
    ["no reset time", limit({ period: "day", limit: 100 })],
    ["a reset time that isn't a time", limit({ period: "day", limit: 100, resetAt: "tomorrow" })],
    ["an unknown period", limit({ period: "week", retryAfter: 20 })],
  ])("falls back to the server's message with %s", (_, error) => {
    expect(messageForError(error, "x")).toBe(API_ERRORS.LIMIT_REACHED.message);
  });

  it("uses the error's own message for other errors, or the fallback", () => {
    expect(messageForError({ code: "AI_ERROR", message: "From the server" }, "x")).toBe("From the server");
    expect(messageForError({ code: "AI_ERROR", message: "" }, "Fallback")).toBe("Fallback");
    expect(messageForError("not an object", "Fallback")).toBe("Fallback");
  });

  it("is used for a 429 from the API and for the live answer's error event", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ error: limit({ period: "minute", limit: 10, retryAfter: 20 }) }, { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(
          line({
            type: "error",
            error: { code: "AI_DAILY_LIMIT", message: "x", retryAfter: 60, resetAt: "2026-11-14T08:00:00.000Z" },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } },
        ),
      );

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: "Too many corrections in one minute. Please wait 20 seconds.",
    });
    const outcome = await requestCorrection("Hello");
    expect(outcome.ok === false && outcome.message).toMatch(
      /^Today's free AI allowance is used up\. You can correct more from .+\.$/,
    );
  });
});

describe("fetchUsage", () => {
  const USAGE = { limit: 100, remaining: 87, resetAt: "2026-11-15T00:00:00.000Z" };

  it("asks GET /api/usage for today's count, fresh every time", async () => {
    fetchMock.mockResolvedValue(Response.json({ usage: USAGE }));

    await expect(fetchUsage()).resolves.toEqual(USAGE);
    expect(fetchMock).toHaveBeenCalledWith("/api/usage", { cache: "no-store" });
  });

  it.each<[string, () => Promise<Response>]>([
    ["corrections aren't counted", async () => Response.json({ usage: null })],
    ["the count is in the wrong format", async () => Response.json({ usage: { limit: "100" } })],
    ["the answer isn't JSON", async () => new Response("<html>")],
    ["the server answers with an error", async () => Response.json({ usage: USAGE }, { status: 500 })],
    ["the network fails", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("gives null when %s", async (_, answer) => {
    fetchMock.mockImplementation(answer);
    await expect(fetchUsage()).resolves.toBeNull();
  });
});
