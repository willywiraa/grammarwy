/**
 * Waits for the given number of milliseconds.
 * It lives in its own file so tests can replace it and skip the waiting.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
