import { API_ERRORS, type ApiErrorBody } from "@/lib/api-errors";
import { CorrectionResultSchema, type CorrectionResult } from "@/lib/correction-schema";
import {
  readPartialAnswer,
  STREAM_CONTENT_TYPE,
  VERSION_FIELDS,
  type PartialAnswer,
} from "@/lib/correction-stream";

/** Shown when the request can't reach the server at all. */
export const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";

/** Shown when the answer stops before it is complete, for example when the connection breaks. */
export const ANSWER_STOPPED_MESSAGE = "The answer stopped before it was complete. Please try again.";

/** What the page gets back: the result, or a friendly message to show as it is. */
export type CorrectionOutcome =
  | { ok: true; result: CorrectionResult }
  | { ok: false; message: string };

/** What the page hears while the AI is writing. Both are optional. */
export type CorrectionEvents = {
  /** The versions as far as the AI has written them. */
  onPartial?: (answer: PartialAnswer) => void;
  /** The backup model starts again, so the versions shown so far are dropped. */
  onRestart?: () => void;
};

/**
 * Sends the text to POST /api/correct and reads the answer. It asks for the
 * live answer, so `events` hears about the text while the AI writes it. An
 * answer in one piece, as JSON, works too.
 * It never throws. Every problem comes back as a friendly message.
 */
export async function requestCorrection(
  text: string,
  events: CorrectionEvents = {},
): Promise<CorrectionOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/correct", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: `${STREAM_CONTENT_TYPE}, application/json`,
      },
      body: JSON.stringify({ text }),
    });
  } catch {
    // fetch only fails like this when no answer arrives at all: offline, server down, and so on.
    return { ok: false, message: NETWORK_ERROR_MESSAGE };
  }

  if (response.ok && response.body && isStream(response.headers.get("content-type"))) {
    return readStream(response.body, events);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON, for example an error page from the hosting service.
    return { ok: false, message: messageForStatus(response.status) };
  }

  if (!response.ok) {
    // Our API's errors look like { error: { code, message } }.
    const message = (body as ApiErrorBody | null)?.error?.message;
    return {
      ok: false,
      message: typeof message === "string" && message ? message : messageForStatus(response.status),
    };
  }
  return checkResult(body);
}

/**
 * Reads the live answer line by line: the versions while the AI writes them,
 * then the final result or an error.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  events: CorrectionEvents,
): Promise<CorrectionOutcome> {
  let json = ""; // the AI's answer so far
  let shown: PartialAnswer = {};
  try {
    for await (const line of readLines(body)) {
      const event = parseEvent(line);
      switch (event?.type) {
        case "text": {
          json += event.text;
          const answer = readPartialAnswer(json);
          // While the AI writes the explanations, the versions don't change.
          if (answer && !sameVersions(answer, shown)) {
            shown = answer;
            events.onPartial?.(answer);
          }
          break;
        }
        case "restart":
          json = "";
          shown = {};
          events.onRestart?.();
          break;
        case "done":
          return checkResult(event.result);
        case "error":
          return { ok: false, message: event.message || API_ERRORS.AI_ERROR.message };
      }
    }
  } catch {
    // The connection broke while the answer was being written.
    return { ok: false, message: ANSWER_STOPPED_MESSAGE };
  }
  // The answer ended without a result, for example because the server stopped.
  return { ok: false, message: ANSWER_STOPPED_MESSAGE };
}

/** Splits the live answer into lines as it arrives. */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      yield* lines;
    }
    buffer += decoder.decode();
    if (buffer) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

/** One line of the live answer, as far as the page needs it. */
type ParsedEvent =
  | { type: "text"; text: string }
  | { type: "restart" }
  | { type: "done"; result: unknown }
  | { type: "error"; message: string };

/** Reads one line of the live answer. Empty or unreadable lines are skipped. */
function parseEvent(line: string): ParsedEvent | null {
  if (!line.trim()) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value)) {
    return null;
  }
  switch (value.type) {
    case "text":
      return typeof value.text === "string" ? { type: "text", text: value.text } : null;
    case "restart":
      return { type: "restart" };
    case "done":
      return { type: "done", result: value.result };
    case "error": {
      const message = isObject(value.error) ? value.error.message : undefined;
      return { type: "error", message: typeof message === "string" ? message : "" };
    }
    default:
      return null;
  }
}

/**
 * The server has already checked the answer. Checking again with the same
 * schema guarantees the page never shows a broken or half-filled result.
 */
function checkResult(body: unknown): CorrectionOutcome {
  const parsed = CorrectionResultSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: API_ERRORS.AI_ERROR.message };
  }
  return { ok: true, result: parsed.data };
}

function sameVersions(a: PartialAnswer, b: PartialAnswer): boolean {
  return VERSION_FIELDS.every((field) => a[field] === b[field]);
}

/** True for the live answer's content type, with or without "; charset=utf-8". */
function isStream(contentType: string | null): boolean {
  return contentType?.split(";")[0].trim().toLowerCase() === STREAM_CONTENT_TYPE;
}

/** A friendly message for an answer that didn't include one. */
function messageForStatus(status: number): string {
  // 504 is what the hosting service sends when the server took too long.
  return status === 504 ? API_ERRORS.AI_TIMEOUT.message : API_ERRORS.AI_ERROR.message;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
