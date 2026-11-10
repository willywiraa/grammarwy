import { getCorrection } from "@/lib/ai";
import { API_ERRORS, CorrectionError, type ApiErrorCode } from "@/lib/api-errors";
import { checkText } from "@/lib/validation";

/**
 * The longest this route may run on Vercel, in seconds: the maximum (and
 * default) on the free Hobby plan. Our own deadline for Claude (DEADLINE_MS,
 * 240 seconds) ends first, so a slow answer gets our friendly timeout message
 * instead of Vercel's error.
 */
export const maxDuration = 300;

/**
 * POST /api/correct
 *
 * Takes `{ "text": "..." }` as JSON and answers with a CorrectionResult.
 * Every failure answers with `{ "error": { "code", "message" } }` and a
 * matching HTTP status.
 */
export async function POST(request: Request): Promise<Response> {
  // 1. Only JSON is accepted. This also blocks form posts from other websites.
  if (!isJson(request.headers.get("content-type"))) {
    return errorResponse("INVALID_REQUEST");
  }

  // 2. Read the JSON body.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST");
  }

  // 3. Check the text with the same rules the page uses.
  const check = checkText(isObject(body) ? body.text : undefined);
  if (!check.ok) {
    return errorResponse(check.code);
  }

  // 4. Correct it. Details of any failure go to the server log, never to the
  //    browser, and the user's text is never logged.
  try {
    const result = await getCorrection(check.text);
    return Response.json(result);
  } catch (error) {
    if (error instanceof CorrectionError) {
      console.error(`[api/correct] ${error.code}: ${error.message}`);
      return errorResponse(error.code);
    }
    console.error("[api/correct] Unexpected error:", error);
    return errorResponse("AI_ERROR");
  }
}

function errorResponse(code: ApiErrorCode): Response {
  const { status, message } = API_ERRORS[code];
  return Response.json({ error: { code, message } }, { status });
}

/** True for "application/json", with or without "; charset=utf-8". */
function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0].trim().toLowerCase() === "application/json";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
