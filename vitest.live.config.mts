import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Live tests: real corrections from Claude. They use
// your Claude plan (through Claude Code) or cost a little API money, so they
// run only on purpose: `npm run test:live`.
export default defineConfig({
  resolve: {
    // Keep these in step with vitest.config.mts.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./vitest.server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    // The settings from .env.local, read the way `next dev` reads them. A
    // variable already set in the terminal wins, so
    // `$env:ANTHROPIC_EFFORT="medium"` tries another effort level.
    env: loadEnv("development", process.cwd(), ["ANTHROPIC_", "AI_PROVIDER", "CLAUDE_CODE_PATH"]),
    // A correction of a long text can take a few minutes.
    testTimeout: 5 * 60_000,
  },
});
