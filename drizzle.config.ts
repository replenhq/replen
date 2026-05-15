import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DIGEST_DB_PATH ?? "./data/digest.sqlite" },
} satisfies Config;
