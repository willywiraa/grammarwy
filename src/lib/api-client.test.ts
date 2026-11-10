import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ERRORS } from "@/lib/api-errors";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { NETWORK_ERROR_MESSAGE, requestCorrection } from "./api-client";

// The tests replace the browser's fetch, so no real requests are sent.
const fetchMock = vi.fn<typeof fetch>();

/** Makes the pretend server answer with this body and status. */
function serverAnswers(body: string, status: number, contentType = "application/json") {
  fetchMock.mockResolvedValue(
    new Response(body, { status, headers: { "Content-Type": contentType } }),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestCorrection", () => {
  it("sends the text as JSON to /api/correct", async () => {
    serverAnswers(JSON.stringify(SAMPLE_WITH_FIXES.result), 200);

    await requestCorrection("He go to office.");

    expect(fetchMock).toHaveBeenCalledWith("/api/correct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "He go to office." }),
    });
  });

  it("returns the result from a successful answer", async () => {
    serverAnswers(JSON.stringify(SAMPLE_WITH_FIXES.result), 200);

    await expect(requestCorrection("He go to office.")).resolves.toEqual({
      ok: true,
      result: SAMPLE_WITH_FIXES.result,
    });
  });

  it("returns the server's own message from an error answer", async () => {
    const { message } = API_ERRORS.RATE_LIMITED;
    serverAnswers(JSON.stringify({ error: { code: "RATE_LIMITED", message } }), 429);

    await expect(requestCorrection("Hello")).resolves.toEqual({ ok: false, message });
  });

  it("returns the connection message when the server can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: NETWORK_ERROR_MESSAGE,
    });
  });

  it("returns a general message when the answer isn't JSON", async () => {
    serverAnswers("<html>Internal Server Error</html>", 500, "text/html");

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: API_ERRORS.AI_ERROR.message,
    });
  });

  it("returns the timeout message when the hosting service gives up waiting (504)", async () => {
    serverAnswers("An error occurred with your deployment", 504, "text/plain");

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: API_ERRORS.AI_TIMEOUT.message,
    });
  });

  it("returns a general message when an error answer has no message", async () => {
    serverAnswers(JSON.stringify({ something: "else" }), 500);

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: API_ERRORS.AI_ERROR.message,
    });
  });

  it("never shows a successful answer in the wrong format", async () => {
    serverAnswers(JSON.stringify({ correctedText: "Only one field." }), 200);

    await expect(requestCorrection("Hello")).resolves.toEqual({
      ok: false,
      message: API_ERRORS.AI_ERROR.message,
    });
  });
});
