import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Keep these in step with vitest.live.config.mts.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The real "server-only" package throws outside Next.js's server build.
      "server-only": fileURLToPath(new URL("./vitest.server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Live tests call the real AI, which can cost money. They run only with
    // `npm run test:live` (vitest.live.config.mts).
    exclude: [...configDefaults.exclude, "src/**/*.live.test.{ts,tsx}"],
    // A safety net: these tests never see a real API key, even one set on
    // this computer, and never start the real Claude Code, so they can
    // never call an AI by mistake. Tests that need other values stub them.
    env: { ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", AI_PROVIDER: "anthropic-api", CLAUDE_CODE_PATH: "" },
  },
});
