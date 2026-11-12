import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// `vite build --mode cli` builds the `slashdocs local` app. The CLI embeds it
// and serves it under /_/, so the paths of local documents stay free.
const cli = {
  base: "/_/",
  build: { outDir: "dist-local", rollupOptions: { input: "local.html" } },
};

export default defineConfig(({ mode }) => ({
  ...(mode === "cli" && cli),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {},
  test: {
    // Bridge tests live in tests/, because every file under bridge/ is part of
    // the bridge source hash.
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    restoreMocks: true,
  },
}));
