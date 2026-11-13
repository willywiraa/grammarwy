import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ERRORS } from "@/lib/api-errors";
import type { PartialAnswer, StreamEvent } from "@/lib/correction-stream";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { ANSWER_STOPPED_MESSAGE, NETWORK_ERROR_MESSAGE, requestCorrection } from "./api-client";

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
