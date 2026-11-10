import { describe, expect, it } from "vitest";
import { API_ERRORS } from "@/lib/api-errors";
import { checkText, MAX_INPUT_LENGTH } from "./validation";

describe("checkText", () => {
  it("accepts normal text and passes it on exactly as written", () => {
    const text = "  He go to office.\n\nThanks,\nAlex\n";
    expect(checkText(text)).toEqual({ ok: true, text });
  });

  it("rejects empty text with a friendly message", () => {
    expect(checkText("")).toEqual({
      ok: false,
      code: "EMPTY_TEXT",
      message: "Please enter some text to correct.",
    });
  });

  it("treats text with only spaces, tabs and line breaks as empty", () => {
    expect(checkText("  \n\t \r\n ")).toMatchObject({ ok: false, code: "EMPTY_TEXT" });
  });

  it("accepts exactly 5,000 characters", () => {
    expect(MAX_INPUT_LENGTH).toBe(5000);
    expect(checkText("a".repeat(5000))).toMatchObject({ ok: true });
  });

  it("rejects 5,001 characters", () => {
    expect(checkText("a".repeat(5001))).toEqual({
      ok: false,
      code: "TEXT_TOO_LONG",
      message: API_ERRORS.TEXT_TOO_LONG.message,
    });
  });

  it("counts spaces and line breaks toward the limit, like the counter on the page", () => {
    expect(checkText("a".repeat(4999) + "\n\n")).toMatchObject({ code: "TEXT_TOO_LONG" });
  });

  it.each([
    ["nothing (undefined)", undefined],
    ["null", null],
    ["a number", 42],
    ["true or false", true],
    ["a list", ["Hello"]],
    ["an object", { text: "Hello" }],
  ])("rejects a value that isn't text: %s", (_label, value) => {
    expect(checkText(value)).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("states the real limit in the too-long message", () => {
    expect(API_ERRORS.TEXT_TOO_LONG.message).toContain(MAX_INPUT_LENGTH.toLocaleString("en-US"));
  });
});
