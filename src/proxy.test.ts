// @vitest-environment node
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ERRORS } from "@/lib/api-errors";
import { config, proxy, REALM } from "./proxy";

// Made-up credentials for the tests only.
const USER = "will";
const PASSWORD = "correct horse battery staple";

function request(path: string, authorization?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: authorization ? { authorization } : {},
  });
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

/** NextResponse.next() marks a request that may continue with this header. */
function continues(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  consoleError.mockRestore();
});

describe("proxy with the password set", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BASIC_AUTH_USER", USER);
    vi.stubEnv("BASIC_AUTH_PASSWORD", PASSWORD);
  });

  it("lets the page and the API through with the right password", () => {
    expect(continues(proxy(request("/", basic(USER, PASSWORD))))).toBe(true);
    expect(continues(proxy(request("/api/correct", basic(USER, PASSWORD))))).toBe(true);
  });

  it.each([
    ["no password", undefined],
    ["a wrong password", basic(USER, "wrong")],
  ])("asks for the password on the page with %s", async (_label, authorization) => {
    const response = proxy(request("/", authorization));

    expect(continues(response)).toBe(false);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(`Basic realm="${REALM}", charset="UTF-8"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(API_ERRORS.UNAUTHORIZED.message);
  });

  it("answers the API without a password with our JSON error", async () => {
    const response = proxy(request("/api/correct"));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: API_ERRORS.UNAUTHORIZED.message },
    });
  });

  it("logs nothing for a wrong password", () => {
    proxy(request("/", basic(USER, "wrong")));
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("proxy without the password set", () => {
  it("lets everything through in local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BASIC_AUTH_USER", "");
    vi.stubEnv("BASIC_AUTH_PASSWORD", "");

    expect(continues(proxy(request("/")))).toBe(true);
  });

  it("refuses everything in production, without a login prompt, and logs why", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BASIC_AUTH_USER", "");
    vi.stubEnv("BASIC_AUTH_PASSWORD", "");

    const page = proxy(request("/", basic(USER, PASSWORD)));
    const api = proxy(request("/api/correct", basic(USER, PASSWORD)));

    expect(page.status).toBe(503);
    expect(page.headers.get("www-authenticate")).toBeNull();
    expect(await page.text()).toBe(API_ERRORS.SITE_NOT_CONFIGURED.message);
    expect(api.status).toBe(503);
    expect((await api.json()).error.code).toBe("SITE_NOT_CONFIGURED");
    expect(String(consoleError.mock.calls[0][0])).toContain("BASIC_AUTH_PASSWORD");
  });
});

describe("which requests the proxy checks", () => {
  it.each(["/", "/api/correct", "/some/unknown/page", "/robots.txt"])("checks %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });

  it.each(["/_next/static/chunks/main.js", "/_next/image?url=%2Flogo.png&w=64&q=75", "/favicon.ico"])(
    "skips the static file %s",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    },
  );
});
