// Thin fetch wrapper. Every call carries the x-digest-token header so the
// server can identify the user. Errors bubble as Error so MCP tool wrappers
// can translate them to readable messages.

import { createRequire } from "node:module";

// This package's version, sent on every request as `x-replen-client` so the
// server can tell a stale npx-cached build to refresh. Resolved from our own
// package.json (always shipped); falls back to "0.0.0" if unreadable.
let MCP_VERSION = "0.0.0";
try {
  MCP_VERSION = (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "0.0.0";
} catch { /* keep default */ }
const CLIENT_ID = `mcp@${MCP_VERSION}`;

export type ApiConfig = {
  baseUrl: string;
  token: string;
  // GitHub "owner/name" detected from the MCP's spawn directory (best effort).
  // Tools that accept a `repo` filter default to this when the caller doesn't
  // override it. Null when we're not in a recognisable GitHub repo.
  defaultRepo: string | null;
};

export async function apiGet<T = unknown>(cfg: ApiConfig, path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(cfg.baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: { "x-digest-token": cfg.token, "x-replen-client": CLIENT_ID, accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T = unknown>(cfg: ApiConfig, path: string, body: unknown): Promise<T> {
  const res = await fetch(cfg.baseUrl + path, {
    method: "POST",
    headers: { "x-digest-token": cfg.token, "x-replen-client": CLIENT_ID, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}
