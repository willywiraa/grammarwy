import { askClaude, DEADLINE_MS } from "@/lib/ai/claude";
import { askClaudeCode } from "@/lib/ai/claude-code";
import { askGemini, GEMINI_FIRST_TEXT_MS, readGeminiModels } from "@/lib/ai/gemini";
import { getMockAnswer } from "@/lib/ai/mock";
import { CorrectionError } from "@/lib/api-errors";
import { CorrectionResultSchema, type CorrectionResult } from "@/lib/correction-schema";

/** The most explanations we show. The prompt asks for at most this many, and we enforce it. */
export const MAX_EXPLANATIONS = 6;

/** The three ways to reach an AI. */
export const AI_PROVIDERS = ["claude-code", "anthropic-api", "gemini"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** The function that asks each connection. */
const ASK: Record<AiProvider, (text: string) => Promise<unknown>> = {
  "claude-code": askClaudeCode,
  "anthropic-api": askClaude,
  gemini: askGemini,
};

/**
 * What getCorrection reports while it works, so the page can show the answer
 * as it is written. Only Gemini writes in pieces. The other connections, and
 * mock mode, only return the final result.
 */
export type CorrectionProgress = {
  /** Gets each new piece of the answer's JSON as soon as the AI writes it. */
  onText?: (piece: string) => void;
  /** The text written so far is dropped, because the backup model starts again. */
  onRestart?: () => void;
};

/**
 * Corrects a text. It asks the AI, or the mock when USE_MOCK_AI=true, and
 * checks the answer before returning it. Throws a CorrectionError on failure.
 */
export async function getCorrection(
  text: string,
  progress: CorrectionProgress = {},
): Promise<CorrectionResult> {
  if (process.env.USE_MOCK_AI === "true") {
    return checkAnswer(await getMockAnswer(text), text);
  }
  const provider = readProvider();
  if (provider === "gemini") {
    return correctWithGemini(text, progress);
  }
  const answer = await ASK[provider](text);
  return checkAnswer(answer, text);
}

/**
 * Asks the main Gemini model. If it fails for any reason (an error, the daily
 * limit, no answer in time, or an answer that fails checkAnswer), the backup
 * model gets the same text. Both share one deadline, so the whole correction
 * still ends within DEADLINE_MS.
 *
 * With a backup ready, the main model gets one try, and must start writing
 * within GEMINI_FIRST_TEXT_MS. A stuck request then costs seconds, not minutes.
 */
async function correctWithGemini(
  text: string,
  { onText, onRestart }: CorrectionProgress,
): Promise<CorrectionResult> {
  const { primary, fallback } = readGeminiModels();
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const quick = fallback ? { tries: 1, firstTextMs: GEMINI_FIRST_TEXT_MS } : {};
  try {
    return checkAnswer(await askGemini(text, { model: primary, deadline, onText, ...quick }), text);
  } catch (error) {
    if (!fallback || deadline.aborted) throw error;
    // Only the error code and details, which never contain the text.
    const reason = error instanceof CorrectionError ? `${error.code}: ${error.message}` : "unknown error";
    console.warn(`[ai] ${primary} failed (${reason}); asking ${fallback}`);
    onRestart?.();
    return checkAnswer(await askGemini(text, { model: fallback, deadline, onText }), text);
  }
}

/**
 * Which connection to use. AI_PROVIDER picks one. Without it:
 * 1. An Anthropic API key means the Anthropic API.
 * 2. Otherwise a Gemini API key means Gemini.
 * 3. Otherwise, on Vercel (which sets VERCEL=1), it is Gemini too, because
 *    Claude Code isn't there. That way the log says the key is missing, which
 *    is the real problem.
 * 4. Otherwise Claude Code, with the Claude subscription on your own computer.
 */
export function readProvider(): AiProvider {
  const value = process.env.AI_PROVIDER?.trim();
  if (!value) {
    if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic-api";
    if (process.env.GEMINI_API_KEY?.trim() || process.env.VERCEL) return "gemini";
    return "claude-code";
  }
  const provider = AI_PROVIDERS.find((name) => name === value);
  if (!provider) {
    throw new CorrectionError("SERVER_CONFIG", `AI_PROVIDER must be one of: ${AI_PROVIDERS.join(", ")}`);
  }
  return provider;
}

/**
 * Checks an AI answer before we use it:
 * 1. It must match the schema. Extra fields the AI adds are dropped.
 * 2. If the text was already correct, the corrected version is the original
 *    text, unchanged, and there are no explanations. That way a correct text
 *    is never quietly rewritten.
 * 3. None of the four versions may be empty.
 * 4. An answer that says it fixed mistakes but returns the text unchanged is
 *    rejected. Without explanations, it simply means the text was correct.
 * 5. An answer that lost all the line breaks of the text is rejected, because
 *    the greeting, the text and the sign-off would run together.
 * 6. An explanation whose corrected wording isn't in the corrected text is
 *    left out: it describes a fix that wasn't made.
 * 7. Only the first 6 explanations are kept.
 * A rejected answer from the main Gemini model goes to the backup model.
 */
export function checkAnswer(answer: unknown, originalText: string): CorrectionResult {
  const parsed = CorrectionResultSchema.safeParse(answer);
  if (!parsed.success) {
    // Only field names and problem types go to the log, never the text itself.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "(answer)"}: ${issue.code}`)
      .join("; ");
    throw new CorrectionError("AI_ERROR", `The AI answer didn't match the schema (${problems})`);
  }

  let result = parsed.data;
  if (result.alreadyCorrect) {
    result = { ...result, correctedText: originalText, explanations: [] };
  }

  const versions = [
    result.correctedText,
    result.professionalVersion,
    result.naturalVersion,
    result.conciseVersion,
  ];
  if (versions.some((version) => version.trim() === "")) {
    throw new CorrectionError("AI_ERROR", "The AI answer has an empty version");
  }

  if (!result.alreadyCorrect && sameText(result.correctedText, originalText)) {
    if (result.explanations.length > 0) {
      throw new CorrectionError("AI_ERROR", "The AI answer explains fixes but returned the text unchanged");
    }
    result = { ...result, alreadyCorrect: true, correctedText: originalText };
  }

  if (originalText.trim().includes("\n") && !result.correctedText.trim().includes("\n")) {
    throw new CorrectionError("AI_ERROR", "The AI answer lost the line breaks of the text");
  }

  const corrected = normalize(result.correctedText);
  const explanations = result.explanations.filter((item) =>
    quotedPieces(item.corrected).every((piece) => corrected.includes(normalize(piece))),
  );

  return { ...result, explanations: explanations.slice(0, MAX_EXPLANATIONS) };
}

/** Two texts that differ at most in spacing and quote style. */
function sameText(a: string, b: string): boolean {
  return normalize(a, true) === normalize(b, true);
}

/** One space for every run of spaces and line breaks, straight quotes and dashes, and, unless keepCase, lower case. */
function normalize(text: string, keepCase = false): string {
  const value = text
    .replace(/[‘’]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return keepCase ? value : value.toLowerCase();
}

/**
 * The pieces of an explanation's quote. Several quoted places are joined with
 * "…", "...", commas, semicolons or " / ", for example "He goes … and checks".
 * Pieces shorter than 2 characters are ignored, so a removed word ("") passes.
 */
function quotedPieces(quote: string): string[] {
  return quote
    .split(/…|\.\.\.|[,;]| \/ /)
    .map((piece) => piece.trim().replace(/^["'‘’“”]+|["'‘’“”.!?:]+$/g, "").trim())
    .filter((piece) => piece.length >= 2);
}
