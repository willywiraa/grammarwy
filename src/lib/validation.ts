import { API_ERRORS } from "@/lib/api-errors";

// Input rules shared by the browser and the server, so both always agree.

/** The most characters one correction may contain (about 800 words). */
export const MAX_INPUT_LENGTH = 5000;

/** The result of checking a text: either OK, or the problem and its friendly message. */
export type TextCheck =
  | { ok: true; text: string }
  | { ok: false; code: "INVALID_REQUEST" | "EMPTY_TEXT" | "TEXT_TOO_LONG"; message: string };

type TextProblem = Extract<TextCheck, { ok: false }>["code"];

/**
 * Checks a text before it is sent for correction.
 * The value is `unknown` because on the server it comes straight from the
 * request, which could contain anything.
 */
export function checkText(value: unknown): TextCheck {
  if (typeof value !== "string") {
    return problem("INVALID_REQUEST");
  }
  // Text with only spaces or line breaks counts as empty.
  if (value.trim() === "") {
    return problem("EMPTY_TEXT");
  }
  // .length counts characters the same way as the counter on the page.
  if (value.length > MAX_INPUT_LENGTH) {
    return problem("TEXT_TOO_LONG");
  }
  // The text is passed on exactly as written, so nothing the user typed is lost.
  return { ok: true, text: value };
}

function problem(code: TextProblem): TextCheck {
  return { ok: false, code, message: API_ERRORS[code].message };
}
