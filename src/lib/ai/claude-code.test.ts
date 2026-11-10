// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { DEADLINE_MS } from "@/lib/ai/claude";
import { SYSTEM_PROMPT } from "@/lib/ai/prompt";
import type { ApiErrorCode } from "@/lib/api-errors";
import { SAMPLE_WITH_FIXES } from "@/lib/sample-results";

// A fake Claude Code: the tests decide what it prints and how it exits.
const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fake.spawn }));

import { ANSWER_SCHEMA, askClaudeCode, findClaudeCode } from "./claude-code";

const TEXT = "He go to office every days.";
const ANSWER = SAMPLE_WITH_FIXES.result;
const PROGRAM = "C:\\Tools\\claude.exe";

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => void };

/** What the fake received: the arguments, options and the text sent through stdin. */
let calls: { program: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv }; stdin: string }[];

/** Makes the fake print `stdout` (and `stderr`) and exit with `code`. */
function claudeCodePrints(stdout: string, code = 0, stderr = "") {
  fake.spawn.mockImplementation((program: string, args: string[], options) => {
    const child = createChild(program, args, options);
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", code);
    });
    return child;
  });
}

function createChild(program: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit("close", null));
  });
  const call = { program, args, options, stdin: "" };
  child.stdin.on("data", (chunk: Buffer) => (call.stdin += chunk.toString()));
  calls.push(call);
  return child;
}

/** Claude Code's JSON output for a finished answer. */
function success(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(ANSWER),
    stop_reason: "tool_use",
    api_error_status: null,
    num_turns: 2,
    usage: { input_tokens: 2, cache_creation_input_tokens: 1411, cache_read_input_tokens: 0, output_tokens: 432 },
    ...overrides,
  });
}

function correctionError(code: ApiErrorCode) {
  return expect.objectContaining({ name: "CorrectionError", code });
}

async function failureMessage(): Promise<string> {
  try {
    await askClaudeCode(TEXT);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected askClaudeCode to fail");
}

function argAfter(flag: string): string | undefined {
  const args = calls[0].args;
  return args[args.indexOf(flag) + 1];
}

let consoleInfo: MockInstance<typeof console.info>;

beforeEach(() => {
  calls = [];
  fake.spawn.mockReset();
  vi.stubEnv("CLAUDE_CODE_PATH", PROGRAM);
  consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  consoleInfo.mockRestore();
});

describe("askClaudeCode: the request", () => {
  it("returns the parsed answer", async () => {
    claudeCodePrints(success());
    await expect(askClaudeCode(TEXT)).resolves.toEqual(ANSWER);
  });

  it("prefers structured_output when Claude Code provides it", async () => {
    claudeCodePrints(success({ result: "", structured_output: ANSWER }));
    await expect(askClaudeCode(TEXT)).resolves.toEqual(ANSWER);
  });

  it("sends the text through stdin, never as an argument", async () => {
    claudeCodePrints(success());
    await askClaudeCode(TEXT);

    expect(calls[0].program).toBe(PROGRAM);
    expect(calls[0].stdin).toBe(`<text>\n${TEXT}\n</text>`);
    expect(calls[0].args.some((arg) => arg.includes(TEXT))).toBe(false);
  });

  it("turns all tools and customizations off and uses our prompt, format, model and effort", async () => {
    claudeCodePrints(success());
    await askClaudeCode(TEXT);

    const { args } = calls[0];
    expect(args).toContain("--print");
    expect(argAfter("--tools")).toBe("");
    expect(args).toEqual(expect.arrayContaining(["--safe-mode", "--strict-mcp-config", "--no-session-persistence"]));
    expect(argAfter("--output-format")).toBe("json");
    expect(argAfter("--system-prompt")).toBe(SYSTEM_PROMPT);
    expect(argAfter("--json-schema")).toBe(ANSWER_SCHEMA);
    expect(argAfter("--model")).toBe("claude-opus-5-5");
    expect(argAfter("--effort")).toBe("low");
  });

  it("sends a schema without the $schema line that Claude Code rejects", () => {
    const schema = JSON.parse(ANSWER_SCHEMA);
    expect(schema).not.toHaveProperty("$schema");
    expect(schema.required).toEqual(
      expect.arrayContaining(["correctedText", "professionalVersion", "naturalVersion", "conciseVersion", "explanations", "alreadyCorrect"]),
    );
  });

  it("uses ANTHROPIC_MODEL and ANTHROPIC_EFFORT when set", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    vi.stubEnv("ANTHROPIC_EFFORT", "medium");
    claudeCodePrints(success());
    await askClaudeCode(TEXT);

    expect(argAfter("--model")).toBe("claude-sonnet-5-5");
    expect(argAfter("--effort")).toBe("medium");
  });

  it("runs in the temp folder, without the API key or other Claude settings", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-not-be-passed");
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://localhost:1234");
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "desktop");
    vi.stubEnv("CLAUDECODE", "1");
    claudeCodePrints(success());
    await askClaudeCode(TEXT);

    const { cwd, env } = calls[0].options;
    expect(cwd).toBe(tmpdir());
    expect(Object.keys(env).filter((name) => /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$)/.test(name))).toEqual([]);
    expect(env.PATH ?? env.Path).toBeDefined(); // the rest of the environment is kept
  });

  it("rejects an invalid effort before starting Claude Code", async () => {
    vi.stubEnv("ANTHROPIC_EFFORT", "turbo");
    await expect(askClaudeCode(TEXT)).rejects.toThrow(correctionError("SERVER_CONFIG"));
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});

describe("askClaudeCode: problems", () => {
  it("reports a missing Claude Code as SERVER_CONFIG", async () => {
    fake.spawn.mockImplementation((program: string, args: string[], options) => {
      const child = createChild(program, args, options);
      setImmediate(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
      return child;
    });
    await expect(askClaudeCode(TEXT)).rejects.toThrow(correctionError("SERVER_CONFIG"));
  });

  it("stops Claude Code after the deadline with AI_TIMEOUT", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let child: FakeChild | undefined;
    fake.spawn.mockImplementation((program: string, args: string[], options) => {
      child = createChild(program, args, options);
      return child;
    });

    const answer = expect(askClaudeCode(TEXT)).rejects.toThrow(correctionError("AI_TIMEOUT"));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);

    await answer;
    expect(child?.kill).toHaveBeenCalled();
  });

  it.each([
    ["the plan's usage limit", { result: "Claude AI usage limit reached", api_error_status: null }, "RATE_LIMITED"],
    ["a 429", { result: "Too many requests", api_error_status: 429 }, "RATE_LIMITED"],
    ["not being logged in", { result: "Not logged in · Please run /login", api_error_status: null }, "SERVER_CONFIG"],
    ["a 401", { result: "Invalid credentials", api_error_status: 401 }, "SERVER_CONFIG"],
    ["any other error", { result: "Something broke", api_error_status: 500 }, "AI_ERROR"],
  ] as const)("maps %s to %s", async (_label, fields, code) => {
    claudeCodePrints(success({ is_error: true, subtype: "error_during_execution", ...fields }), 1);
    await expect(askClaudeCode(TEXT)).rejects.toThrow(correctionError(code));
  });

  it("maps a refusal to AI_REFUSED", async () => {
    claudeCodePrints(success({ stop_reason: "refusal", result: "" }));
    await expect(askClaudeCode(TEXT)).rejects.toThrow(correctionError("AI_REFUSED"));
  });

  it("maps a cut-off answer to AI_INCOMPLETE", async () => {
    claudeCodePrints(success({ stop_reason: "max_tokens" }));
    await expect(askClaudeCode(TEXT)).rejects.toThrow(correctionError("AI_INCOMPLETE"));
  });

  it("reports an exit without JSON as AI_ERROR, with Claude Code's message", async () => {
    claudeCodePrints("", 1, "[claude-code:unrecognized_model] {\"model\":\"nope\"}\nmore");
    await expect(askClaudeCode(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
    expect(await failureMessage()).toContain("unrecognized_model");
  });

  it("reports an answer that isn't JSON as AI_ERROR, without quoting it", async () => {
    claudeCodePrints(success({ result: `Sure! ${TEXT}` }));
    const message = await failureMessage();
    expect(message).toContain("wasn't valid JSON");
    expect(message).not.toContain(TEXT);
  });

  it("reports an empty answer as AI_ERROR", async () => {
    claudeCodePrints(success({ result: "  " }));
    await expect(askClaudeCode(TEXT)).rejects.toThrow(correctionError("AI_ERROR"));
  });
});

describe("askClaudeCode: logging", () => {
  it("logs one line of metadata, without the text", async () => {
    claudeCodePrints(success());
    await askClaudeCode(TEXT);

    expect(consoleInfo).toHaveBeenCalledTimes(1);
    const line = String(consoleInfo.mock.calls[0][0]);
    expect(line).toMatch(
      /^\[ai\/claude-code\] model=claude-opus-5-5 effort=low stop=tool_use in=1413 out=432 ms=\d+ chars=27 turns=2$/,
    );
    expect(line).not.toContain(TEXT);
  });
});

describe("findClaudeCode", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "find-claude-code-"));
    vi.stubEnv("CLAUDE_CODE_PATH", "");
    vi.stubEnv("LOCALAPPDATA", folder);
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  function addCopy(version: string, build = "abc123") {
    const dir = join(folder, "Claude-Data", "claude_profile", "claude-code", version, build);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude.exe"), "");
    return join(dir, "claude.exe");
  }

  it("uses CLAUDE_CODE_PATH when it is set", () => {
    addCopy("2.1.317");
    vi.stubEnv("CLAUDE_CODE_PATH", " D:\\claude.exe ");
    expect(findClaudeCode()).toBe("D:\\claude.exe");
  });

  it("finds the desktop app's newest copy, comparing versions as numbers", () => {
    addCopy("2.1.99");
    const newest = addCopy("2.1.317");
    addCopy("2.1.309");
    expect(findClaudeCode()).toBe(newest);
  });

  it("skips version folders without claude.exe", () => {
    const working = addCopy("2.1.309");
    mkdirSync(join(folder, "Claude-Data", "claude_profile", "claude-code", "2.1.400", "empty"), { recursive: true });
    expect(findClaudeCode()).toBe(working);
  });

  it("falls back to `claude` on PATH when there is no desktop copy", () => {
    expect(findClaudeCode()).toBe("claude");
  });
});
