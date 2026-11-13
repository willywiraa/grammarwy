// Calls Gemini, Google's AI model, through the Gemini API, with an API key.
// Its free tier makes this the no-cost connection for the online site, where
// Claude Code can't run. On the free tier, Google may use the texts to improve
// its products (see the README's Privacy section).
// "server-only" makes the build fail if browser code ever imports this file,
// so the API key can never end up in the page.
import "server-only";

import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentResponse,
} from "@google/genai";

import { ANSWER_JSON_SCHEMA } from "@/lib/ai/answer-schema";
import { DEADLINE_MS } from "@/lib/ai/claude";
import { buildUserMessage, SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { CorrectionError, type ApiErrorCode } from "@/lib/api-errors";

/**
 * The main model. In our comparison of 40 texts (November 2026) it fixed 93% of
 * the known mistakes and answered every text within 15 seconds, with a free
 * daily allowance far above gemini-3.8-flash's 20 requests.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

/**
 * The backup model, tried when the main one fails. It has its own free
 * allowance, so it still works when the main model's runs out.
 */
export const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";

/** Google's Gemini API. The key is only ever sent here. */
export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/";

/** How much Gemini thinks before answering. Low is faster, and enough for grammar. */
export const GEMINI_THINKING_LEVEL = ThinkingLevel.LOW;

/** Room for thinking plus four versions of a 5,000-character text and the explanations. */
export const GEMINI_MAX_TOKENS = 16_000;

/**
 * How often one model may be tried: the first try and one more. After that the
 * backup model gets its turn. On the free tier every try, even a failed one,
 * counts toward the daily allowance.
 */
export const GEMINI_TRIES = 2;

/**
 * How long one try may take: 30 seconds, plus 8 more for every 1,000
 * characters, so a long answer has time to be written (30–70 seconds). The
 * Flash-Lite models answered every test text within 15 seconds. Google's free
 * tier sometimes leaves a request waiting for minutes; such a try is stopped,
 * so the backup model still has time. Two tries of the main model leave at
 * least 100 seconds of DEADLINE_MS for the backup.
 */
export function geminiTryTimeoutMs(text: string): number {
  return 30_000 + text.length * 8;
}

/** Finish reasons that mean Google's filters stopped the answer. */
const BLOCKED: ReadonlySet<string> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.LANGUAGE,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

/**
 * The main and backup models: GEMINI_MODEL and GEMINI_FALLBACK_MODEL, or the
 * defaults. GEMINI_FALLBACK_MODEL=none turns the backup off. A backup that is
 * the same as the main model is left out.
 */
export function readGeminiModels(): { primary: string; fallback: string | null } {
  const primary = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const setting = process.env.GEMINI_FALLBACK_MODEL?.trim() || DEFAULT_GEMINI_FALLBACK_MODEL;
  const fallback = setting.toLowerCase() === "none" || setting === primary ? null : setting;
  return { primary, fallback };
}

/** Which model to ask, and a deadline shared with other calls for the same correction. */
export type GeminiOptions = { model?: string; deadline?: AbortSignal };

/**
 * Asks Gemini to correct a text and returns its answer as parsed JSON, like
 * askClaude does. The answer is `unknown` until `checkAnswer`
 * (lib/ai/index.ts) has checked it. Every failure is thrown as a
 * CorrectionError whose details never contain the user's text or the API key.
 */
export async function askGemini(text: string, options: GeminiOptions = {}): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new CorrectionError("SERVER_CONFIG", "GEMINI_API_KEY is not set");
  }
  const model = options.model ?? readGeminiModels().primary;

  const client = new GoogleGenAI({
    apiKey,
    // Pinned so environment variables can't change them: the SDK would
    // otherwise read GOOGLE_GEMINI_BASE_URL (sending the key elsewhere) and
    // GOOGLE_GENAI_USE_VERTEXAI (another Google service, with other keys).
    vertexai: false,
    httpOptions: {
      baseUrl: GEMINI_API_URL,
      // A try that takes too long, or that meets a temporary server problem
      // (408, 500, 502, 503, 504), is sent once more. A 429 (a free-tier limit)
      // isn't retried: trying again at once won't help, so the backup model is
      // asked instead (getCorrection in index.ts).
      timeout: geminiTryTimeoutMs(text),
      retryOptions: { attempts: GEMINI_TRIES, httpStatusCodes: [408, 500, 502, 503, 504] },
    },
  });
  const deadline = options.deadline ?? AbortSignal.timeout(DEADLINE_MS);
  const started = Date.now();

  let response: GenerateContentResponse;
  try {
    response = await client.models.generateContent({
      model,
      contents: buildUserMessage(text),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        // The answer must be JSON in our format.
        responseMimeType: "application/json",
        responseJsonSchema: ANSWER_JSON_SCHEMA,
        maxOutputTokens: GEMINI_MAX_TOKENS,
        thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL },
        abortSignal: deadline,
      },
    });
  } catch (error) {
    throw toCorrectionError(error, deadline, Date.now() - started);
  }

  logCall(response, { model, ms: Date.now() - started, chars: text.length });
  return readAnswer(response);
}

/** Checks why Gemini stopped, then reads its JSON answer. */
function readAnswer(response: GenerateContentResponse): unknown {
  // Only the reasons are logged. Google's explanation could describe the text.
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new CorrectionError("AI_REFUSED", `Gemini declined the text (block reason: ${blockReason})`);
  }
  const finishReason = response.candidates?.[0]?.finishReason;
  if (finishReason === FinishReason.MAX_TOKENS) {
    throw new CorrectionError("AI_INCOMPLETE", "The answer was cut off (finish reason: MAX_TOKENS)");
  }
  if (finishReason && BLOCKED.has(finishReason)) {
    throw new CorrectionError("AI_REFUSED", `Gemini declined the text (finish reason: ${finishReason})`);
  }
  if (finishReason && finishReason !== FinishReason.STOP) {
    throw new CorrectionError("AI_ERROR", `Gemini stopped early (finish reason: ${finishReason})`);
  }

  // `text` joins the answer's text parts and skips Gemini's thinking.
  const json = response.text ?? "";
  if (json.trim() === "") {
    throw new CorrectionError("AI_ERROR", "The answer had no text");
  }
  try {
    return JSON.parse(json);
  } catch {
    // The parser's own error message quotes the answer, which contains the
    // user's text, so only the length is logged.
    throw new CorrectionError("AI_ERROR", `The answer wasn't valid JSON (${json.length} characters)`);
  }
}

/** Turns anything the SDK throws into one of our error codes. */
function toCorrectionError(error: unknown, deadline: AbortSignal, ms: number): CorrectionError {
  const after = `after ${ms} ms`;

  // Our own deadline (DEADLINE_MS) stopped the request, or every try ran out
  // of time. The SDK's retry helper notes the number of the last try.
  if (deadline.aborted || (error instanceof Error && error.name === "AbortError")) {
    const tries = (error as { attemptNumber?: number } | null | undefined)?.attemptNumber;
    return new CorrectionError("AI_TIMEOUT", `No complete answer from Gemini ${after}${tries ? ` (${tries} tries)` : ""}`);
  }
  if (error instanceof ApiError) {
    return new CorrectionError(codeForStatus(error.status), `${describeApiError(error)}, ${after}`);
  }
  // Only the error's name and system code, such as "TypeError (ECONNRESET)":
  // other messages could quote the answer, which contains the user's text.
  const name = error instanceof Error ? error.name : "unknown error";
  const code = error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined)?.code : undefined;
  return new CorrectionError("AI_ERROR", `Couldn't get an answer from the Gemini API ${after}: ${name}${code ? ` (${code})` : ""}`);
}

/** Errors are mapped by their HTTP status. */
function codeForStatus(status: number): ApiErrorCode {
  // 429: a free-tier limit was reached. 503: Google's servers are busy.
  if (status === 429 || status === 503) {
    return "RATE_LIMITED";
  }
  if (status === 408 || status === 504) {
    return "AI_TIMEOUT";
  }
  // A wrong key or model name, wrong settings, or a country without access.
  if (status >= 400 && status < 500) {
    return "SERVER_CONFIG";
  }
  return "AI_ERROR";
}

/**
 * Google answers an error with JSON such as
 * {"error": {"code": 400, "message": "API key not valid...", "status": "INVALID_ARGUMENT"}}.
 * Its message describes the request, not the text, and is kept short.
 */
function describeApiError(error: ApiError): string {
  let status: string | undefined;
  let message = error.message;
  try {
    const body = JSON.parse(error.message) as { error?: { status?: string; message?: string } };
    status = body.error?.status;
    message = body.error?.message ?? "";
  } catch {
    // Not JSON: keep the message as it is.
  }
  return [`Gemini API error ${error.status}`, status, message.slice(0, 200)].filter(Boolean).join(", ");
}

/** One line per answer, with metadata only: never the text or the key. */
function logCall(response: GenerateContentResponse, call: { model: string; ms: number; chars: number }): void {
  const usage = response.usageMetadata;
  const finish = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "none";
  console.info(
    [
      "[ai/gemini]",
      `model=${response.modelVersion ?? call.model}`,
      `finish=${finish}`,
      `in=${usage?.promptTokenCount ?? 0}`,
      `out=${usage?.candidatesTokenCount ?? 0}`,
      `thoughts=${usage?.thoughtsTokenCount ?? 0}`,
      `ms=${call.ms}`,
      `chars=${call.chars}`,
      `request=${response.responseId ?? "unknown"}`,
    ].join(" "),
  );
}
