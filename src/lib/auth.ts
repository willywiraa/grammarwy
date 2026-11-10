// The site password (HTTP Basic Auth), checked by src/proxy.ts on every
// request. The browser shows its own login prompt,
// so the app needs no login page and no database.
import { createHash, timingSafeEqual } from "node:crypto";

export type Credentials = { user: string; password: string };

/** The settings this file reads. process.env fits; tests pass their own. */
export type AuthSettings = {
  BASIC_AUTH_USER?: string;
  BASIC_AUTH_PASSWORD?: string;
  NODE_ENV?: string;
};

/**
 * What to do with a request:
 * - "allow": the right username and password, or local development with no
 *   password set
 * - "ask": no password or a wrong one, so the browser shows its login prompt
 * - "not-configured": the password isn't set up, so every request is refused.
 *   This is the safe choice ("fail closed"): a missing setting on Vercel can
 *   never leave the site open to everyone.
 */
export type AccessDecision = "allow" | "ask" | "not-configured";

/** Decides whether a request may continue, from its Authorization header. */
export function decideAccess(
  authorization: string | null,
  settings: AuthSettings = process.env,
): AccessDecision {
  // Spaces at the start or end of a setting are ignored, so a stray space
  // pasted into Vercel's settings can't lock you out.
  const user = settings.BASIC_AUTH_USER?.trim() ?? "";
  const password = settings.BASIC_AUTH_PASSWORD?.trim() ?? "";

  if (user === "" && password === "") {
    // Only `npm run dev` on your own computer may skip the password.
    return settings.NODE_ENV === "development" ? "allow" : "not-configured";
  }
  if (user === "" || password === "") {
    // Only one of the two is set: a mistake, so stay closed.
    return "not-configured";
  }

  const given = parseBasicAuth(authorization);
  if (!given) return "ask";
  return credentialsMatch(given, { user, password }) ? "allow" : "ask";
}

/**
 * Reads "Basic <base64 of user:password>". Returns null for a missing or
 * malformed header. The password may contain colons; the username can't.
 */
export function parseBasicAuth(header: string | null): Credentials | null {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(header ?? "");
  if (!match) return null;
  // Browsers send UTF-8 when the login prompt asks for it (charset="UTF-8" in proxy.ts).
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * Compares both parts in constant time, so the response time never reveals
 * how much of a guess was right. Hashing first gives both sides the same
 * length, which timingSafeEqual needs, without revealing the real length.
 */
export function credentialsMatch(given: Credentials, expected: Credentials): boolean {
  // Both comparisons always run, so a wrong username takes as long as a wrong password.
  const userMatches = sameText(given.user, expected.user);
  const passwordMatches = sameText(given.password, expected.password);
  return userMatches && passwordMatches;
}

function sameText(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}
