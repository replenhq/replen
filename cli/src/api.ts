// Thin fetch wrapper for CLI subcommands. The CLI hits the same /api/mcp/*
// routes the MCP server uses (same DIGEST_TOKEN authentication), so plain-
// shell users get parity with the in-Claude-Code experience.

import { readConfig, type Config } from "./config.js";

export async function loadConfigOrExit(): Promise<Config> {
  const cfg = await readConfig();
  if (!cfg) {
    console.error("Not signed in. Run `npx replen` first.");
    process.exit(1);
  }
  return cfg;
}

export async function apiGet<T = unknown>(
  cfg: Config,
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(cfg.base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    headers: { "x-digest-token": cfg.token, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T = unknown>(cfg: Config, path: string, body: unknown): Promise<T> {
  const res = await fetch(cfg.base + path, {
    method: "POST",
    headers: {
      "x-digest-token": cfg.token,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}
