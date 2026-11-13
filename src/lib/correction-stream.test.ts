import { describe, expect, it } from "vitest";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";
import { readPartialAnswer } from "./correction-stream";

const RESULT = SAMPLE_WITH_FIXES.result;
const JSON_ANSWER = JSON.stringify(RESULT);
const BACKSLASH = "\\";

describe("readPartialAnswer", () => {
  it("reads the versions written so far", () => {
    expect(readPartialAnswer('{"correctedText": "He goes to the off')).toEqual({
      correctedText: "He goes to the off",
    });
    expect(readPartialAnswer('{"correctedText": "Done.", "professionalVersion": "')).toEqual({
      correctedText: "Done.",
      professionalVersion: "",
    });
  });

  it("reads the four versions of a complete answer, and nothing else", () => {
    expect(readPartialAnswer(JSON_ANSWER)).toEqual({
      correctedText: RESULT.correctedText,
      professionalVersion: RESULT.professionalVersion,
      naturalVersion: RESULT.naturalVersion,
      conciseVersion: RESULT.conciseVersion,
    });
  });

  it("returns an empty answer before the first version starts", () => {
    expect(readPartialAnswer("{")).toEqual({});
    expect(readPartialAnswer('{"correctedText": ')).toEqual({});
  });

  it("returns null when nothing can be read yet", () => {
    expect(readPartialAnswer("")).toBeNull();
    expect(readPartialAnswer("   ")).toBeNull();
    expect(readPartialAnswer("[1, 2")).toBeNull();
  });

  it("never takes back text: every longer piece of the answer gives the same text or more", () => {
    let previous = "";
    for (let end = 1; end <= JSON_ANSWER.length; end++) {
      const text = readPartialAnswer(JSON_ANSWER.slice(0, end))?.correctedText ?? "";
      expect(text.startsWith(previous)).toBe(true);
      previous = text;
    }
    expect(previous).toBe(RESULT.correctedText);
  });

  it("leaves out half an escaped character or emoji until the rest arrives", () => {
    const start = '{"correctedText": "a';
    expect(readPartialAnswer(`${start}${BACKSLASH}`)).toEqual({ correctedText: "a" });
    expect(readPartialAnswer(`${start}${BACKSLASH}u00`)).toEqual({ correctedText: "a" });
    expect(readPartialAnswer(`${start}${BACKSLASH}ud83d`)).toEqual({ correctedText: "a" });
    expect(readPartialAnswer(`${start}${BACKSLASH}ud83d${BACKSLASH}ude0a"}`)).toEqual({
      correctedText: "a\u{1F60A}",
    });
  });

  it("ignores a version that isn't text", () => {
    expect(readPartialAnswer('{"correctedText": 42, "conciseVersion": "Short."}')).toEqual({
      conciseVersion: "Short.",
    });
  });
});
