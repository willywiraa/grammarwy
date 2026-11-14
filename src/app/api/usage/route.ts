import { connection } from "next/server";
import { isMockMode } from "@/lib/ai";
import { readUsage } from "@/lib/limits";

/**
 * GET /api/usage
 *
 * Today's count, for the line under the button when the page opens:
 * `{ "usage": { "limit": 100, "remaining": 87, "resetAt": "…" } }`, or
 * `{ "usage": null }` when corrections aren't counted (no database, or mock
 * mode). After each correction, the page reads the count from the answer's
 * X-Daily-* headers instead.
 */
export async function GET(): Promise<Response> {
  // The count changes all the time, so this always runs when it is asked for,
  // never once at build time.
  await connection();
  const usage = isMockMode() ? null : await readUsage();
  return Response.json({ usage }, { headers: { "Cache-Control": "no-store" } });
}
