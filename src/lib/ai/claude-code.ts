// Calls Claude through Claude Code, using the Claude subscription you are
// logged in with on this computer: no API key and no API bill.
// This only works on your own computer, because a hosting service like
// Vercel has no Claude Code and no login. There, the app uses the API key
// instead (lib/ai/claude.ts).
import "server-only";

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { DEADLINE_MS, DEFAULT_MODEL, readEffort, type Effort } from "@/lib/ai/claude";
import { buildUserMessage, SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { CorrectionError } from "@/lib/api-errors";
import { CorrectionResultSchema } from "@/lib/correction-schema";

// Our answer format as a JSON schema. Claude Code rejects the "$schema" line
// that Zod adds, so it is left out.
const answerSchema = z.toJSONSchema(CorrectionResultSchema);
delete answerSchema.$schema;
export const ANSWER_SCHEMA = JSON.stringify(answerSchema);

/** What Claude Code prints with --output-format json. Only the fields we read. */
type ClaudeCodeOutput = {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string | null;
  api_error_status?: number | null;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

type Run = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; spawnError?: NodeJS.ErrnoException };

/**
 * Asks Claude (through Claude Code) to correct a text and returns its answer
 * as parsed JSON, like askClaude does. Every failure is thrown as a
 * CorrectionError whose details never contain the user's text.
 */
export async function askClaudeCode(text: string): Promise<unknown> {
  const program = findClaudeCode();
  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  const effort = readEffort();
  const started = Date.now();

  const run = await runClaudeCode(program, buildArgs(model, effort), buildUserMessage(text));
  const ms = Date.now() - started;

  if (run.spawnError) {
    if (run.spawnError.code === "ENOENT") {
      throw new CorrectionError(
        "SERVER_CONFIG",
        `Claude Code wasn't found (${program}). Install it, or set CLAUDE_CODE_PATH`,
      );
    }
    throw new CorrectionError("AI_ERROR", `Couldn't start Claude Code: ${run.spawnError.code ?? "unknown error"}`);
  }
  if (run.timedOut) {
    throw new CorrectionError("AI_TIMEOUT", `No complete answer from Claude Code after ${ms} ms`);
  }

  const output = parseOutput(run.stdout);
  if (!output) {
    // Claude Code's own error messages are short and don't contain the text,
    // which goes in through stdin, never as an argument.
    const reason = run.stderr.trim().split("\n")[0]?.slice(0, 200) || "no message";
    throw new CorrectionError("AI_ERROR", `Claude Code exited with code ${run.exitCode} without an answer: ${reason}`);
  }

  logCall(output, { model, effort, ms, chars: text.length });
  return readAnswer(output);
}

/**
 * Where Claude Code is:
 * 1. CLAUDE_CODE_PATH, if you set it.
 * 2. Otherwise the newest copy that the Claude desktop app keeps on Windows.
 *    Its folder name changes with every update, so we look it up each time.
 * 3. Otherwise "claude", a standalone install found through PATH.
 */
export function findClaudeCode(): string {
  const configured = process.env.CLAUDE_CODE_PATH?.trim();
  if (configured) return configured;
  return findDesktopCopy() ?? "claude";
}

/** The desktop app keeps Claude Code in Claude-Data\<profile>\claude-code\<version>\<build>\claude.exe. */
function findDesktopCopy(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const copies: { version: number[]; path: string }[] = [];
  for (const profile of subfolders(join(localAppData, "Claude-Data"))) {
    const versionsDir = join(localAppData, "Claude-Data", profile, "claude-code");
    for (const version of subfolders(versionsDir)) {
      if (!/^\d+(\.\d+)*$/.test(version)) continue;
      for (const build of subfolders(join(versionsDir, version))) {
        const path = join(versionsDir, version, build, "claude.exe");
        if (existsSync(path)) copies.push({ version: version.split(".").map(Number), path });
      }
    }
  }
  copies.sort((a, b) => compareVersions(b.version, a.version));
  return copies[0]?.path ?? null;
}

function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The options, each with a reason:
 * - --tools "": no tools at all. A pasted text that says "run this command"
 *   can never make Claude Code read files or run anything.
 * - --safe-mode and --strict-mcp-config: none of your Claude Code
 *   customizations (CLAUDE.md, plugins, hooks, connected services) are loaded.
 * - --system-prompt: our editor prompt replaces Claude Code's own.
 * - --json-schema: the answer must match our format.
 * - --no-session-persistence: corrections aren't saved as sessions.
 */
export function buildArgs(model: string, effort: Effort): string[] {
  return [
    "--print",
    "--output-format", "json",
    "--json-schema", ANSWER_SCHEMA,
    "--system-prompt", SYSTEM_PROMPT,
    "--tools", "",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--model", model,
    "--effort", effort,
  ];
}

/**
 * Claude Code gets a copy of the server's environment without any ANTHROPIC_
 * or CLAUDE_CODE_ variables. Above all, this removes ANTHROPIC_API_KEY: with
 * it, Claude Code would bill the API instead of using your subscription.
 */
export function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("ANTHROPIC_") && !name.startsWith("CLAUDE_CODE_") && name !== "CLAUDECODE",
    ),
  ) as NodeJS.ProcessEnv;
}

/** Runs Claude Code once. The text goes in through stdin, never as an argument. */
function runClaudeCode(program: string, args: string[], input: string): Promise<Run> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (run: Omit<Run, "stdout" | "stderr" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...run });
    };

    const child = spawn(program, args, {
      // An empty folder, so Claude Code never sees this project's files.
      cwd: tmpdir(),
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, DEADLINE_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => finish({ exitCode: null, spawnError: error }));
    child.on("close", (exitCode: number | null) => finish({ exitCode }));
    // If Claude Code exits before reading the text, ignore the broken pipe;
    // the exit code and output tell us what happened.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function parseOutput(stdout: string): ClaudeCodeOutput | null {
  try {
    const output: unknown = JSON.parse(stdout);
    return typeof output === "object" && output !== null ? (output as ClaudeCodeOutput) : null;
  } catch {
    return null;
  }
}

/** Checks how Claude Code finished, then reads the JSON answer. */
function readAnswer(output: ClaudeCodeOutput): unknown {
  if (output.is_error || (output.subtype && output.subtype !== "success")) {
    throw errorFromOutput(output);
  }
  if (output.stop_reason === "refusal") {
    throw new CorrectionError("AI_REFUSED", "Claude declined the text");
  }
  if (output.stop_reason === "max_tokens") {
    throw new CorrectionError("AI_INCOMPLETE", "The answer was cut off (stop reason: max_tokens)");
  }

  if (typeof output.structured_output === "object" && output.structured_output !== null) {
    return output.structured_output;
  }
  const json = output.result ?? "";
  if (json.trim() === "") {
    throw new CorrectionError("AI_ERROR", "The answer had no text");
  }
  try {
    return JSON.parse(json);
  } catch {
    // Only the length: the answer contains the user's text.
    throw new CorrectionError("AI_ERROR", `The answer wasn't valid JSON (${json.length} characters)`);
  }
}

/**
 * When Claude Code reports an error, `result` holds its error message, not an
 * answer. Your plan's usage limit counts as "busy, try again later".
 */
function errorFromOutput(output: ClaudeCodeOutput): CorrectionError {
  const message = (output.result ?? "").slice(0, 200);
  const status = output.api_error_status ?? undefined;
  const details = `Claude Code error (${output.subtype ?? "unknown"}, status ${status ?? "none"}): ${message || "no message"}`;

  if (status === 429 || status === 529 || /usage limit|rate limit|overloaded/i.test(message)) {
    return new CorrectionError("RATE_LIMITED", details);
  }
  if (status === 401 || status === 403 || /log ?in|logged out|authenticat/i.test(message)) {
    return new CorrectionError("SERVER_CONFIG", details);
  }
  return new CorrectionError("AI_ERROR", details);
}

/** One line per answer, with metadata only: never the text. Same format as [ai/claude]. */
function logCall(
  output: ClaudeCodeOutput,
  call: { model: string; effort: Effort; ms: number; chars: number },
): void {
  const usage = output.usage ?? {};
  const input =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  console.info(
    [
      "[ai/claude-code]",
      `model=${call.model}`,
      `effort=${call.effort}`,
      `stop=${output.stop_reason ?? "unknown"}`,
      `in=${input}`,
      `out=${usage.output_tokens ?? 0}`,
      `ms=${call.ms}`,
      `chars=${call.chars}`,
      `turns=${output.num_turns ?? "unknown"}`,
    ].join(" "),
  );
}
