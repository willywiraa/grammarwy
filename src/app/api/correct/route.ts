import { getCorrection } from "@/lib/ai";
import { API_ERRORS, CorrectionError, type ApiErrorCode } from "@/lib/api-errors";
import { STREAM_CONTENT_TYPE, type StreamEvent } from "@/lib/correction-stream";
import { checkText } from "@/lib/validation";

/**
 * The longest this route may run on Vercel, in seconds: the maximum (and
 * default) on the free Hobby plan. Our own deadline for the AI (DEADLINE_MS,
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
 *
 * With the header "Accept: application/x-ndjson", a text that passes the
 * checks gets the live answer instead (see lib/correction-stream.ts): the
 * pieces of the AI's answer as it writes them, then the checked result, or an
 * error event if the correction fails. A request that fails the checks still
 * gets a JSON error with its status.
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

  // 4. Correct it, live or in one answer. Details of any failure go to the
  //    server log, never to the browser, and the user's text is never logged.
  if (acceptsStream(request.headers.get("accept"))) {
    return streamCorrection(check.text);
  }
  try {
    const result = await getCorrection(check.text);
    return Response.json(result);
  } catch (error) {
    return errorResponse(logFailure(error));
  }
}

/**
 * The live answer: one JSON event per line, sent as soon as it is ready. The
 * status is already 200 when the answer starts, so a failure arrives as an
 * "error" event.
 */
function streamCorrection(text: string): Response {
  const encoder = new TextEncoder();
  // True once the browser stops reading, for example when the page is closed.
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };

      try {
        const result = await getCorrection(text, {
          onText: (piece) => send({ type: "text", text: piece }),
          onRestart: () => send({ type: "restart" }),
        });
        send({ type: "done", result });
      } catch (error) {
        const code = logFailure(error);
        send({ type: "error", error: { code, message: API_ERRORS[code].message } });
      }
      if (!closed) {
        controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": `${STREAM_CONTENT_TYPE}; charset=utf-8`,
      // Nothing between the server and the page may store the answer or hold it back.
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Writes a failure's details to the server log and returns the code to answer with. */
function logFailure(error: unknown): ApiErrorCode {
  if (error instanceof CorrectionError) {
    console.error(`[api/correct] ${error.code}: ${error.message}`);
    return error.code;
  }
  console.error("[api/correct] Unexpected error:", error);
  return "AI_ERROR";
}

function errorResponse(code: ApiErrorCode): Response {
  const { status, message } = API_ERRORS[code];
  return Response.json({ error: { code, message } }, { status });
}

/** True for "application/json", with or without "; charset=utf-8". */
function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0].trim().toLowerCase() === "application/json";
}

/** True when the Accept header asks for the live answer, among other types or not. */
function acceptsStream(accept: string | null): boolean {
  return (accept ?? "")
    .split(",")
    .some((type) => type.split(";")[0].trim().toLowerCase() === STREAM_CONTENT_TYPE);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
