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

/**
 * How much Gemini thinks before it starts writing. Low is fast, and enough for
 * grammar. Minimal would start the answer a fraction of a second sooner, but
 * in testing gemini-3.1-flash-lite then often joined the paragraphs of an
 * email into one line, an answer the app has to reject and ask again.
 */
export const GEMINI_THINKING_LEVEL = ThinkingLevel.LOW;

/** Room for thinking plus four versions of a 5,000-character text and the explanations. */
export const GEMINI_MAX_TOKENS = 16_000;

/**
 * How often one model may be tried: the first try and one more. When a backup
 * model is ready, the main model gets one try only (see getCorrection in
 * index.ts), so the backup starts sooner. On the free tier every try, even a
 * failed one, counts toward the daily allowance.
 */
export const GEMINI_TRIES = 2;

/**
 * How long the main model may take to start writing when a backup model is
 * ready. The answer usually starts within 1–4 seconds. With no text after 10
 * seconds, the request is most likely stuck at Google, so the backup is asked
 * instead.
 */
export const GEMINI_FIRST_TEXT_MS = 10_000;

/**
 * How long one try may take, including the time the answer takes to stream
 * in: 30 seconds, plus 8 more for every 1,000 characters, so a long answer has
 * time to be written (30–70 seconds). Our test texts were all answered within
 * 25 seconds. Google's free tier sometimes leaves a request waiting for
 * minutes; such a try is stopped, so the backup model still has time. The main
 * model's one try and the backup's two fit within DEADLINE_MS.
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

/** Settings for one call. All of them are optional. */
export type GeminiOptions = {
  /** The model to ask. Default: the main model (readGeminiModels). */
  model?: string;
  /** A deadline shared with other calls for the same correction. */
  deadline?: AbortSignal;
  /** How many tries the model gets. Default: GEMINI_TRIES. */
  tries?: number;
  /** Gives up when no text has arrived this many milliseconds after the start. */
  firstTextMs?: number;
  /** Gets each new piece of the answer's JSON as soon as Gemini writes it. */
  onText?: (piece: string) => void;
};

/** What a call collects while the answer streams in. */
type StreamedAnswer = {
  json: string;
  firstTextMs?: number;
  blockReason?: string;
  finishReason?: string;
  usage?: GenerateContentResponse["usageMetadata"];
  modelVersion?: string;
  responseId?: string;
};

/**
 * Asks Gemini to correct a text and returns its answer as parsed JSON, like
 * askClaude does. The answer streams in: `onText` gets each piece as it
 * arrives, so the page can show the text while Gemini is still writing. The
 * answer is `unknown` until `checkAnswer` (lib/ai/index.ts) has checked it.
 * Every failure is thrown as a CorrectionError whose details never contain
 * the user's text or the API key.
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
      // (408, 500, 502, 503, 504) before the answer starts, is sent once more.
      // A 429 (a free-tier limit) isn't retried: trying again at once won't
      // help, so the backup model is asked instead (getCorrection in index.ts).
      timeout: geminiTryTimeoutMs(text),
      retryOptions: {
        attempts: options.tries ?? GEMINI_TRIES,
        httpStatusCodes: [408, 500, 502, 503, 504],
      },
    },
  });
  const deadline = options.deadline ?? AbortSignal.timeout(DEADLINE_MS);
  // Stops the call when no text has arrived in time (firstTextMs).
  const noText = new AbortController();
  const noTextTimer =
    options.firstTextMs === undefined ? undefined : setTimeout(() => noText.abort(), options.firstTextMs);
  const signal = noTextTimer === undefined ? deadline : AbortSignal.any([deadline, noText.signal]);
  const started = Date.now();
  const answer: StreamedAnswer = { json: "" };

  try {
    const stream = await client.models.generateContentStream({
      model,
      contents: buildUserMessage(text),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        // The answer must be JSON in our format.
        responseMimeType: "application/json",
        responseJsonSchema: ANSWER_JSON_SCHEMA,
        maxOutputTokens: GEMINI_MAX_TOKENS,
        thinkingConfig: { thinkingLevel: GEMINI_THINKING_LEVEL },
        abortSignal: signal,
      },
    });
    for await (const chunk of stream) {
      const piece = collect(chunk, answer);
      if (!piece) {
        continue;
      }
      if (answer.firstTextMs === undefined) {
        answer.firstTextMs = Date.now() - started;
        clearTimeout(noTextTimer);
      }
      answer.json += piece;
      options.onText?.(piece);
    }
  } catch (error) {
    throw toCorrectionError(error, {
      deadline,
      noText: noText.signal,
      firstTextMs: options.firstTextMs,
      ms: Date.now() - started,
    });
  } finally {
    clearTimeout(noTextTimer);
  }

  logCall(answer, { model, ms: Date.now() - started, chars: text.length });
  return readAnswer(answer);
}

/**
 * Notes a streamed chunk's details and returns its text. `text` joins the
 * chunk's text parts and skips Gemini's thinking. Each chunk's usage is the
 * running total, so the last one counts.
 */
function collect(chunk: GenerateContentResponse, answer: StreamedAnswer): string {
  answer.blockReason = chunk.promptFeedback?.blockReason ?? answer.blockReason;
  answer.finishReason = chunk.candidates?.[0]?.finishReason ?? answer.finishReason;
  answer.usage = chunk.usageMetadata ?? answer.usage;
  answer.modelVersion = chunk.modelVersion ?? answer.modelVersion;
  answer.responseId = chunk.responseId ?? answer.responseId;
  return chunk.text ?? "";
}

/** Checks why Gemini stopped, then reads its JSON answer. */
function readAnswer(answer: StreamedAnswer): unknown {
  // Only the reasons are logged. Google's explanation could describe the text.
  const { blockReason, finishReason, json } = answer;
  if (blockReason) {
    throw new CorrectionError("AI_REFUSED", `Gemini declined the text (block reason: ${blockReason})`);
  }
  if (finishReason === FinishReason.MAX_TOKENS) {
    throw new CorrectionError("AI_INCOMPLETE", "The answer was cut off (finish reason: MAX_TOKENS)");
  }
  if (finishReason && BLOCKED.has(finishReason)) {
    throw new CorrectionError("AI_REFUSED", `Gemini declined the text (finish reason: ${finishReason})`);
  }
  if (finishReason && finishReason !== FinishReason.STOP) {
    throw new CorrectionError("AI_ERROR", `Gemini stopped early (finish reason: ${finishReason})`);
  }

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

/** What toCorrectionError needs to know about the call. */
type CallInfo = { deadline: AbortSignal; noText: AbortSignal; firstTextMs?: number; ms: number };

/** Turns anything the SDK throws into one of our error codes. */
function toCorrectionError(error: unknown, call: CallInfo): CorrectionError {
  const after = `after ${call.ms} ms`;

  // No text arrived within firstTextMs, so the backup model takes over.
  if (call.noText.aborted && !call.deadline.aborted) {
    return new CorrectionError("AI_TIMEOUT", `No text from Gemini within ${call.firstTextMs} ms`);
  }
  // Our own deadline (DEADLINE_MS) stopped the request, or every try ran out
  // of time. The SDK's retry helper notes the number of the last try.
  if (call.deadline.aborted || (error instanceof Error && error.name === "AbortError")) {
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

/**
 * One line per answer, with metadata only: never the text or the key.
 * `first` is how long the first text took to arrive, and `ms` the whole answer.
 */
function logCall(answer: StreamedAnswer, call: { model: string; ms: number; chars: number }): void {
  const usage = answer.usage;
  console.info(
    [
      "[ai/gemini]",
      `model=${answer.modelVersion ?? call.model}`,
      `finish=${answer.finishReason ?? answer.blockReason ?? "none"}`,
      `in=${usage?.promptTokenCount ?? 0}`,
      `out=${usage?.candidatesTokenCount ?? 0}`,
      `thoughts=${usage?.thoughtsTokenCount ?? 0}`,
      `first=${answer.firstTextMs ?? "none"}`,
      `ms=${call.ms}`,
      `chars=${call.chars}`,
      `request=${answer.responseId ?? "unknown"}`,
    ].join(" "),
  );
}
