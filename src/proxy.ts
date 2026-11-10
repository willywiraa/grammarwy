// The password gate: Next.js runs this before every page and API request
// It uses HTTP Basic Auth, so the browser asks for
// the username and password with its own login prompt.
import { NextResponse, type NextRequest } from "next/server";
import { API_ERRORS, type ApiErrorCode } from "@/lib/api-errors";
import { decideAccess } from "@/lib/auth";

/** The name the browser's login prompt shows. */
export const REALM = "Grammarwy";

export function proxy(request: NextRequest): Response {
  const decision = decideAccess(request.headers.get("authorization"));
  if (decision === "allow") {
    return NextResponse.next();
  }

  if (decision === "not-configured") {
    // Only the server log says why, so strangers learn nothing about the setup.
    console.error(
      "[proxy] The site password isn't set up. Set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD. Every request is refused until then.",
    );
    return refuse(request, "SITE_NOT_CONFIGURED");
  }

  // The WWW-Authenticate header makes the browser show its login prompt.
  // charset="UTF-8" asks it to send non-English characters as UTF-8.
  return refuse(request, "UNAUTHORIZED", {
    "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
  });
}

/**
 * The API gets our usual JSON error, so the page can show its message.
 * Pages get the same message as plain text, which the browser shows if you
 * close the login prompt.
 */
function refuse(request: NextRequest, code: ApiErrorCode, headers: Record<string, string> = {}): Response {
  const { status, message } = API_ERRORS[code];
  const init = { status, headers: { "Cache-Control": "no-store", ...headers } };
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return Response.json({ error: { code, message } }, init);
  }
  return new Response(message, init);
}

export const config = {
  // Every request except Next.js's static files (JavaScript, CSS, fonts and
  // optimized images, none of which contain anything private) and the
  // browser's automatic favicon request.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
