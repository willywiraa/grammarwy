import { Allow, parse } from "partial-json";
import type { ApiErrorCode } from "@/lib/api-errors";
import type { CorrectionResult } from "@/lib/correction-schema";

// The live answer of POST /api/correct. When the page asks for it (with the
// header "Accept: application/x-ndjson"), the server sends one JSON event per
// line while the AI writes, instead of one JSON answer at the end.

/** The content type of the live answer: newline-delimited JSON. */
export const STREAM_CONTENT_TYPE = "application/x-ndjson";

/** One line of the live answer. */
export type StreamEvent =
  /** The next piece of the AI's answer, which is JSON in our answer format. */
  | { type: "text"; text: string }
  /** The backup model starts again, so the pieces sent so far are dropped. */
  | { type: "restart" }
  /** The final result, checked by the server. It replaces everything shown so far. */
  | { type: "done"; result: CorrectionResult }
  /** The correction failed. The message is the friendly one from API_ERRORS. */
  | { type: "error"; error: { code: ApiErrorCode; message: string } };

/** The four versions, in the order the AI writes them. */
export const VERSION_FIELDS = [
  "correctedText",
  "professionalVersion",
  "naturalVersion",
  "conciseVersion",
] as const;

export type VersionField = (typeof VERSION_FIELDS)[number];

/** The versions as far as the AI has written them. A version it hasn't started is missing. */
export type PartialAnswer = Partial<Record<VersionField, string>>;

/**
 * Reads the versions written so far from the AI's unfinished JSON, such as
 * `{"correctedText": "He goes to the off`. Returns null when nothing can be
 * read yet. The final result always comes from the server's "done" event.
 */
export function readPartialAnswer(json: string): PartialAnswer | null {
  let value: unknown;
  try {
    value = parse(json, Allow.ALL);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const answer: PartialAnswer = {};
  for (const field of VERSION_FIELDS) {
    const version = (value as Record<string, unknown>)[field];
    if (typeof version === "string") {
      // An emoji arrives as two halves. A lone first half would show as "�"
      // until the second arrives, so it is left out until then.
      answer[field] = version.replace(/[\uD800-\uDBFF]$/, "");
    }
  }
  return answer;
}
