import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve `@` to the Replen repo's `src` so the suite imports the REAL
// crypto module (@/lib/crypto). Adjust REPLEN_SRC if the config lives
// somewhere other than the repo root.
const repoSrc = process.env.REPLEN_SRC ?? path.resolve(here, "src");

export default defineConfig({
  resolve: { alias: { "@": repoSrc } },
  test: {
    environment: "node",
    include: ["**/*.property.test.ts", "tests/**/*.test.ts"],
    // getMasterKey() reads this at call time; NODE_ENV during vitest is
    // "test", so the all-zero guard doesn't apply, but use a real 32-byte
    // key anyway. 32 bytes base64 == "0123456789abcdef0123456789abcdef".
    env: { ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" },
  },
});
