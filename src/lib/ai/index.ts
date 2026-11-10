import { askClaude } from "@/lib/ai/claude";
import { askClaudeCode } from "@/lib/ai/claude-code";
import { getMockAnswer } from "@/lib/ai/mock";
import { CorrectionError } from "@/lib/api-errors";
import { CorrectionResultSchema, type CorrectionResult } from "@/lib/correction-schema";

/** The most explanations we show. The prompt asks for at most this many, and we enforce it. */
export const MAX_EXPLANATIONS = 6;

/** The two ways to reach Claude. */
export const AI_PROVIDERS = ["claude-code", "anthropic-api"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * Corrects a text. It asks Claude, or the mock when USE_MOCK_AI=true, and
 * checks the answer before returning it. Throws a CorrectionError on failure.
 */
export async function getCorrection(text: string): Promise<CorrectionResult> {
  if (process.env.USE_MOCK_AI === "true") {
    return checkAnswer(await getMockAnswer(text), text);
  }
  const answer = readProvider() === "claude-code" ? await askClaudeCode(text) : await askClaude(text);
  return checkAnswer(answer, text);
}

/**
 * Which connection to use. AI_PROVIDER picks one. Without it, an API key
 * means the Anthropic API (Vercel), and no key means Claude Code with your
 * subscription (your own computer). On Vercel (which sets VERCEL=1) it is
 * the API even without a key, because Claude Code isn't there. That way the
 * log says the key is missing, which is the real problem.
 */
export function readProvider(): AiProvider {
  const value = process.env.AI_PROVIDER?.trim();
  if (!value) {
    const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
    return hasKey || process.env.VERCEL ? "anthropic-api" : "claude-code";
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
 * 4. Only the first 6 explanations are kept.
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

  return { ...result, explanations: result.explanations.slice(0, MAX_EXPLANATIONS) };
}
