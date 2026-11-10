// Calls Claude through the Anthropic API, with an API key.
// This is the connection for Vercel. On your own computer, the app can use
// your Claude subscription instead (lib/ai/claude-code.ts).
// "server-only" makes the build fail if browser code ever imports this file,
// so the API key can never end up in the page.
import "server-only";

import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

import { buildUserMessage, SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { CorrectionError, type ApiErrorCode } from "@/lib/api-errors";
import { CorrectionResultSchema } from "@/lib/correction-schema";

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Anthropic's API. The key is only ever sent here. */
export const ANTHROPIC_API_URL = "https://api.anthropic.com";

/** The effort levels the API accepts. Lower effort means less thinking: faster and cheaper. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: Effort = "low";

/** Room for thinking plus four versions of a 5,000-character text and the explanations. */
export const MAX_TOKENS = 16_000;

/**
 * The longest one correction may take, the automatic retry included. It stays
 * under Vercel's 300-second limit, so you get our friendly timeout message
 * instead of the hosting service's error page.
 */
export const DEADLINE_MS = 240_000;

/** If the safety filter wrongly declines a text, Anthropic retries it on a suitable backup model. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// The JSON schema that makes Claude answer in exactly our shape, built once
// from our Zod schema. We send only `type` and `schema`, without the helper's
// `parse` function: with it, the SDK would parse the answer itself and throw a
// generic error on a cut-off answer, hiding the stop reason we check first.
const zodFormat = betaZodOutputFormat(CorrectionResultSchema);
const OUTPUT_FORMAT = { type: zodFormat.type, schema: zodFormat.schema };

type ClaudeMessage = Anthropic.Beta.BetaMessage;

/**
 * Asks Claude to correct a text and returns its answer as parsed JSON. The
 * answer is `unknown` until `checkAnswer` (lib/ai/index.ts) has checked it.
 * Every failure is thrown as a CorrectionError whose details never contain
 * the user's text or the API key.
 */
export async function askClaude(text: string): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new CorrectionError("SERVER_CONFIG", "ANTHROPIC_API_KEY is not set");
  }
  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  const effort = readEffort();

  const client = new Anthropic({
    apiKey,
    // Pinned so environment variables can't change them: the SDK would
    // otherwise read ANTHROPIC_BASE_URL (sending the key elsewhere) and
    // ANTHROPIC_LOG (whose debug level logs requests, including the text).
    baseURL: ANTHROPIC_API_URL,
    logLevel: "warn",
    // One automatic retry for temporary problems (429, 5xx, network).
    maxRetries: 1,
  });
  const started = Date.now();

  let message: ClaudeMessage;
  let requestId: string | null | undefined;
  try {
    // Streaming keeps a long answer from hitting HTTP timeouts.
    // finalMessage() collects the whole answer.
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(text) }],
        output_config: { effort, format: OUTPUT_FORMAT },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      },
      { signal: AbortSignal.timeout(DEADLINE_MS) },
    );
    message = await stream.finalMessage();
    requestId = stream.request_id;
  } catch (error) {
    throw toCorrectionError(error, Date.now() - started);
  }

  logCall(message, { effort, ms: Date.now() - started, chars: text.length, requestId });
  return readAnswer(message);
}

/**
 * ANTHROPIC_EFFORT is optional. A value the API wouldn't accept is reported clearly.
 * Claude Code (lib/ai/claude-code.ts) uses the same setting.
 */
export function readEffort(): Effort {
  const value = process.env.ANTHROPIC_EFFORT?.trim() || DEFAULT_EFFORT;
  const effort = EFFORT_LEVELS.find((level) => level === value);
  if (!effort) {
    throw new CorrectionError(
      "SERVER_CONFIG",
      `ANTHROPIC_EFFORT must be one of: ${EFFORT_LEVELS.join(", ")}`,
    );
  }
  return effort;
}

/** Checks why Claude stopped, then reads its JSON answer. */
function readAnswer(message: ClaudeMessage): unknown {
  if (message.stop_reason === "refusal") {
    // Only the category is logged. The explanation could describe the text.
    const category = message.stop_details?.category ?? "none";
    throw new CorrectionError("AI_REFUSED", `Claude declined the text (category: ${category})`);
  }
  if (
    message.stop_reason === "max_tokens" ||
    message.stop_reason === "model_context_window_exceeded"
  ) {
    throw new CorrectionError(
      "AI_INCOMPLETE",
      `The answer was cut off (stop reason: ${message.stop_reason})`,
    );
  }

  // After a fallback, the answer can arrive in several text blocks, so join them in order.
  const json = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
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
function toCorrectionError(error: unknown, ms: number): CorrectionError {
  const after = `after ${ms} ms`;

  // APIUserAbortError: our own deadline (DEADLINE_MS) stopped the request.
  if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
    return new CorrectionError("AI_TIMEOUT", `No complete answer from Claude ${after}`);
  }
  if (error instanceof APIConnectionError) {
    return new CorrectionError("AI_ERROR", `Couldn't connect to the Anthropic API ${after}`);
  }
  if (error instanceof APIError) {
    const summary = [
      `Anthropic API error ${error.status ?? "during the answer"}`,
      error.type,
      error.apiMessage,
      `request ${error.requestID ?? "unknown"}`,
      after,
    ]
      .filter(Boolean)
      .join(", ");
    return new CorrectionError(codeForApiError(error), summary);
  }
  // Other SDK errors have fixed messages, such as "request ended without sending any chunks".
  const reason = error instanceof AnthropicError ? error.message.slice(0, 200) : "unknown error";
  return new CorrectionError("AI_ERROR", `Unexpected error while calling Claude ${after}: ${reason}`);
}

/**
 * Errors with an HTTP status are mapped by status. An error that arrives in the
 * middle of the answer has no status, so its `type` is used instead.
 */
function codeForApiError({ status, type }: APIError): ApiErrorCode {
  // 529 means Anthropic is overloaded; "busy, try again in a moment" fits it too.
  if (status === 429 || status === 529 || type === "rate_limit_error" || type === "overloaded_error") {
    return "RATE_LIMITED";
  }
  if (status === 408 || status === 504 || type === "timeout_error") {
    return "AI_TIMEOUT";
  }
  // Wrong key, model name or settings, no credits left, or the spend limit was reached.
  if (status !== undefined && status >= 400 && status < 500) {
    return "SERVER_CONFIG";
  }
  return "AI_ERROR";
}

/** One line per answer, with metadata only: never the text or the key. */
function logCall(
  message: ClaudeMessage,
  call: { effort: Effort; ms: number; chars: number; requestId: string | null | undefined },
): void {
  const { usage } = message;
  // A "fallback_message" entry means a backup model wrote the answer.
  const fallback = usage.iterations?.some((entry) => entry.type === "fallback_message") ?? false;
  console.info(
    [
      "[ai/claude]",
      `model=${message.model}`,
      `effort=${call.effort}`,
      `stop=${message.stop_reason}`,
      `in=${usage.input_tokens}`,
      `out=${usage.output_tokens}`,
      `ms=${call.ms}`,
      `chars=${call.chars}`,
      `fallback=${fallback ? "yes" : "no"}`,
      `request=${call.requestId ?? "unknown"}`,
    ].join(" "),
  );
}
