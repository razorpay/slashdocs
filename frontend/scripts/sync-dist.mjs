import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, "..");

// Each Vite build goes to the Go package that embeds it: the app to the
// server, and the `slashdocs local` app to the CLI.
const targets = {
  dist: "../api/internal/server/frontend_dist",
  "dist-local": "../cli/internal/cli/local_dist",
};

for (const [from, to] of Object.entries(targets)) {
  const src = join(frontendRoot, from);
  const dest = resolve(frontendRoot, to);
  const assetDest = join(dest, "assets");

  if (!existsSync(src)) {
    throw new Error(`missing frontend dist directory: ${src}`);
  }

  mkdirSync(assetDest, { recursive: true });

  for (const entry of readdirSync(dest)) {
    if (entry === ".gitkeep" || entry === "assets") continue;
    rmSync(join(dest, entry), { recursive: true, force: true });
  }

  for (const entry of readdirSync(assetDest)) {
    if (entry === ".gitkeep") continue;
    rmSync(join(assetDest, entry), { recursive: true, force: true });
  }

  cpSync(src, dest, { recursive: true });
}
