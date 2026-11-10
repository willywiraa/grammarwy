// @vitest-environment node
import { describe, expect, it } from "vitest";
import { credentialsMatch, decideAccess, parseBasicAuth, type AuthSettings } from "./auth";

// Made-up credentials for the tests only.
const SITE: AuthSettings = {
  BASIC_AUTH_USER: "will",
  BASIC_AUTH_PASSWORD: "correct horse battery staple",
  NODE_ENV: "production",
};

/** The header a browser sends after you type a username and password. */
function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

describe("decideAccess", () => {
  it("allows the right username and password", () => {
    expect(decideAccess(basic("will", "correct horse battery staple"), SITE)).toBe("allow");
  });

  it.each([
    ["a wrong username", basic("bill", "correct horse battery staple")],
    ["a wrong password", basic("will", "wrong")],
    ["the right password with a different case", basic("will", "Correct horse battery staple")],
    ["an empty username and password", basic("", "")],
    ["no header", null],
    ["another scheme", "Bearer abc123"],
    ["no colon in the decoded value", `Basic ${Buffer.from("willpassword").toString("base64")}`],
    ["characters that aren't base64", "Basic not*base64!"],
    ["only the word Basic", "Basic "],
  ])("asks for the password with %s", (_label, header) => {
    expect(decideAccess(header, SITE)).toBe("ask");
  });

  it("accepts a password that contains colons", () => {
    const site = { ...SITE, BASIC_AUTH_PASSWORD: "a:b:c" };
    expect(decideAccess(basic("will", "a:b:c"), site)).toBe("allow");
  });

  it("accepts a password with non-English letters (sent as UTF-8)", () => {
    const site = { ...SITE, BASIC_AUTH_PASSWORD: "Grüße-ñandú" };
    expect(decideAccess(basic("will", "Grüße-ñandú"), site)).toBe("allow");
  });

  it("reads the scheme name in any case", () => {
    const header = basic("will", "correct horse battery staple").replace("Basic", "basic");
    expect(decideAccess(header, SITE)).toBe("allow");
  });

  it("ignores spaces around the settings, but not in what you type", () => {
    const site = { ...SITE, BASIC_AUTH_USER: " will ", BASIC_AUTH_PASSWORD: " secret \n" };
    expect(decideAccess(basic("will", "secret"), site)).toBe("allow");
    expect(decideAccess(basic("will", " secret "), site)).toBe("ask");
  });

  describe("when the password isn't set up", () => {
    it("lets everything through in local development (npm run dev)", () => {
      expect(decideAccess(null, { NODE_ENV: "development" })).toBe("allow");
    });

    it.each(["production", "test", undefined])("refuses everything when NODE_ENV is %s", (nodeEnv) => {
      expect(decideAccess(null, { NODE_ENV: nodeEnv })).toBe("not-configured");
      expect(decideAccess(basic("anyone", "anything"), { NODE_ENV: nodeEnv })).toBe("not-configured");
    });

    it("treats settings that are only spaces as not set", () => {
      expect(decideAccess(null, { BASIC_AUTH_USER: " ", BASIC_AUTH_PASSWORD: "", NODE_ENV: "production" })).toBe(
        "not-configured",
      );
    });

    it.each([
      ["only the username", { BASIC_AUTH_USER: "will" }],
      ["only the password", { BASIC_AUTH_PASSWORD: "secret" }],
    ])("refuses everything with %s set, even in development", (_label, settings) => {
      expect(decideAccess(basic("will", "secret"), { ...settings, NODE_ENV: "development" })).toBe(
        "not-configured",
      );
    });
  });
});

describe("parseBasicAuth", () => {
  it("splits the username at the first colon", () => {
    expect(parseBasicAuth(basic("will", "p:w"))).toEqual({ user: "will", password: "p:w" });
  });

  it("returns null for a missing header", () => {
    expect(parseBasicAuth(null)).toBeNull();
  });
});

describe("credentialsMatch", () => {
  const expected = { user: "will", password: "secret" };

  it("needs both parts to match", () => {
    expect(credentialsMatch({ user: "will", password: "secret" }, expected)).toBe(true);
    expect(credentialsMatch({ user: "will", password: "secre" }, expected)).toBe(false);
    expect(credentialsMatch({ user: "wil", password: "secret" }, expected)).toBe(false);
    expect(credentialsMatch({ user: "will", password: "secret-and-more" }, expected)).toBe(false);
  });
});
