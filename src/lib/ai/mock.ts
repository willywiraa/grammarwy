import { SAMPLE_ALREADY_CORRECT, SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { wait } from "@/lib/wait";

/** How long the mock pretends to think, in milliseconds. */
export const MOCK_DELAY_MS = 1000;
/** The pause for texts containing [slow], long enough to see the loading state. */
export const MOCK_SLOW_DELAY_MS = 6000;

/**
 * A pretend AI for development and tests. It needs no API key and costs nothing.
 * It always gives the same sample answer. Trigger words in the text simulate
 * the other cases:
 *
 * - `[correct]` the text needs no correction
 * - `[error]`   the AI service fails
 * - `[slow]`    the answer takes 6 seconds (combines with the others)
 * - `[invalid]` the answer has the wrong format
 *
 * Like a real AI answer, the result is `unknown` until our checks have looked at it.
 */
export async function getMockAnswer(text: string): Promise<unknown> {
  await wait(text.includes("[slow]") ? MOCK_SLOW_DELAY_MS : MOCK_DELAY_MS);

  if (text.includes("[error]")) {
    throw new Error("Simulated AI failure (mock [error] trigger)");
  }
  if (text.includes("[invalid]")) {
    // The wrong format: most fields are missing, and "explanations" isn't a list.
    return { correctedText: "Only one field.", explanations: "not a list" };
  }
  if (text.includes("[correct]")) {
    return SAMPLE_ALREADY_CORRECT.result;
  }
  return SAMPLE_WITH_FIXES.result;
}
