import { API_ERRORS, type ApiErrorBody } from "@/lib/api-errors";
import { CorrectionResultSchema, type CorrectionResult } from "@/lib/correction-schema";

/** Shown when the request can't reach the server at all. */
export const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";

/** What the page gets back: the result, or a friendly message to show as it is. */
export type CorrectionOutcome =
  | { ok: true; result: CorrectionResult }
  | { ok: false; message: string };

/**
 * Sends the text to POST /api/correct and reads the answer.
 * It never throws. Every problem comes back as a friendly message.
 */
export async function requestCorrection(text: string): Promise<CorrectionOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/correct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    // fetch only fails like this when no answer arrives at all: offline, server down, and so on.
    return { ok: false, message: NETWORK_ERROR_MESSAGE };
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

  // The server has already checked the answer. Checking again with the same
  // schema guarantees the page never shows a broken or half-filled result.
  const parsed = CorrectionResultSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: API_ERRORS.AI_ERROR.message };
  }
  return { ok: true, result: parsed.data };
}

/** A friendly message for an answer that didn't include one. */
function messageForStatus(status: number): string {
  // 504 is what the hosting service sends when the server took too long.
  return status === 504 ? API_ERRORS.AI_TIMEOUT.message : API_ERRORS.AI_ERROR.message;
}
