// Plain-shell subcommands. Each one mirrors an MCP tool but renders for the
// terminal rather than returning JSON to an agent. `--json` flag on every
// command dumps raw JSON for piping/scripting.

import { apiGet, apiPost, loadConfigOrExit } from "./api.js";

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0 || i === argv.length - 1) return undefined;
  return argv[i + 1];
}

// Trigger a fresh pipeline run. Returns immediately; user can `replen progress`
// to watch. Rate-limited at 60s on the server side.
export async function runRun(argv: string[]): Promise<void> {
  const cfg = await loadConfigOrExit();
  const json = hasFlag(argv, "--json");
  try {
    const r = await apiPost<{ ok: boolean; status: string; reason?: string; runId?: number }>(
      cfg,
      "/api/mcp/run-now",
      {},
    );
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (r.ok) {
      console.log("✓ Pipeline started. Tail progress with `replen progress`.");
    } else if (r.status === "in_flight") {
      console.log(`A run is already in flight (run #${r.runId}). Tail it with \`replen progress\`.`);
    } else if (r.status === "rate_limited") {
      console.log(`Rate-limited: ${r.reason}. Try again in a minute.`);
    } else {
      console.log(`✗ ${r.reason ?? "unknown error"}`);
    }
  } catch (e) {
    handleApiError(e);
  }
}

// Tail live pipeline progress. Polls /api/mcp/status with ?since=<id> until
// the run finishes, printing each event as it arrives. Exits 0 on completion.
export async function runProgress(argv: string[]): Promise<void> {
  const cfg = await loadConfigOrExit();
  const json = hasFlag(argv, "--json");
  type Event = { id: number; kind: string; message: string };
  type Status = {
    inFlight: boolean;
    runId?: number;
    candidates?: number;
    matches?: number;
    phase?: string;
    pausedReason?: string | null;
    events?: Event[];
  };

  let since = 0;
  let firstTick = true;
  // 2.5s matches the in-app live log poll cadence.
  while (true) {
    let status: Status;
    try {
      status = await apiGet<Status>(cfg, "/api/mcp/status", since ? { since } : undefined);
    } catch (e) {
      handleApiError(e);
      return;
    }
    if (json) {
      console.log(JSON.stringify(status));
    } else {
      if (firstTick) {
        const phase = status.phase ?? "unknown";
        const tag = status.inFlight ? `running · phase=${phase}` : "idle";
        const counts = `${status.candidates ?? 0} candidates · ${status.matches ?? 0} matches`;
        console.log(`Run #${status.runId ?? "?"} · ${tag} · ${counts}`);
        firstTick = false;
      }
      for (const ev of status.events ?? []) {
        console.log(`${marker(ev.kind)} ${ev.message}`);
        if (ev.id > since) since = ev.id;
      }
    }
    if (!status.inFlight) {
      if (!json) {
        const quota = parseQuotaReason(status.pausedReason ?? null);
        if (quota) {
          console.log("");
          console.log(`✗ ${quota === "primary" ? "Primary" : "Sensitive"} LLM is out of credits.`);
          console.log("  Top up your API key's balance, or rotate to a different provider on /settings.");
          process.exitCode = 1;
        } else {
          console.log(`— done · ${status.matches ?? 0} matches · run #${status.runId ?? "?"}`);
        }
      }
      return;
    }
    await sleep(2500);
  }
}

// What landed in the last N days. Defaults: 2 days, high+medium relevance.
export async function runFeed(argv: string[]): Promise<void> {
  const cfg = await loadConfigOrExit();
  const json = hasFlag(argv, "--json");
  const days = Number(getFlag(argv, "--days") ?? 2);
  const project = getFlag(argv, "--project");
  const relevance = getFlag(argv, "--relevance") ?? "high,medium";
  try {
    const r = await apiGet<{ days: number; count: number; matches: Match[] }>(cfg, "/api/mcp/today", {
      days,
      relevance,
      project,
    });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (r.count === 0) {
      console.log(`No matches in the last ${r.days} day(s).`);
      return;
    }
    console.log(`${r.count} matches · last ${r.days} day(s):`);
    for (const m of r.matches) renderMatchLine(m);
  } catch (e) {
    handleApiError(e);
  }
}

// Full-text search across the user's match history.
export async function runSearch(argv: string[]): Promise<void> {
  const cfg = await loadConfigOrExit();
  const json = hasFlag(argv, "--json");
  const q = argv.filter((a) => !a.startsWith("--")).slice(1).join(" ").trim();
  if (q.length < 2) {
    console.error("Usage: replen search <query>");
    process.exit(1);
  }
  try {
    const r = await apiGet<{ count: number; matches: Match[] }>(cfg, "/api/mcp/search", { q });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (!r.matches?.length) {
      console.log(`No results for "${q}".`);
      return;
    }
    console.log(`${r.count ?? r.matches.length} results for "${q}":`);
    for (const m of r.matches) renderMatchLine(m);
  } catch (e) {
    handleApiError(e);
  }
}

// Starred matches + their handoff PR status (awaiting / open-pr / merged).
export async function runStarred(argv: string[]): Promise<void> {
  const cfg = await loadConfigOrExit();
  const json = hasFlag(argv, "--json");
  try {
    const r = await apiGet<{ count?: number; matches: Match[] }>(cfg, "/api/mcp/starred");
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (!r.matches?.length) {
      console.log("No starred matches.");
      return;
    }
    console.log(`${r.matches.length} starred:`);
    for (const m of r.matches) renderMatchLine(m, { showHandoff: true });
  } catch (e) {
    handleApiError(e);
  }
}

// Open a handoff PR for a starred match in the matched project's own repo.
export async function runHandoff(argv: string[]): Promise<void> {
  const cfg = await loadConfigOrExit();
  const json = hasFlag(argv, "--json");
  const idStr = argv.filter((a) => !a.startsWith("--"))[1];
  const matchId = idStr ? parseInt(idStr, 10) : NaN;
  if (!Number.isInteger(matchId) || matchId <= 0) {
    console.error("Usage: replen handoff <matchId>");
    process.exit(1);
  }
  try {
    const r = await apiPost<{ ok: boolean; prUrl?: string; reason?: string }>(
      cfg,
      "/api/mcp/handoff",
      { matchId },
    );
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (r.ok && r.prUrl) {
      console.log(`✓ Opened handoff PR: ${r.prUrl}`);
    } else {
      console.log(`✗ ${r.reason ?? "unknown error"}`);
      process.exitCode = 1;
    }
  } catch (e) {
    handleApiError(e);
  }
}

type Match = {
  matchId: number;
  repo: string | null;
  url: string | null;
  project: string;
  relevance: string;
  relevanceScore: number | null;
  stars: number | null;
  language: string | null;
  license: string | null;
  summary: string;
  sourceKind: string;
  starred?: boolean;
  handoffPrUrl?: string | null;
};

function renderMatchLine(m: Match, opts: { showHandoff?: boolean } = {}): void {
  const score = m.relevanceScore != null ? `· ${m.relevanceScore}` : "";
  const stars = m.stars != null ? `· ${m.stars}★` : "";
  const lic = m.license ? `· ${m.license}` : "";
  const star = m.starred ? "★" : " ";
  const handoff = opts.showHandoff && m.handoffPrUrl ? `\n      PR: ${m.handoffPrUrl}` : "";
  const repo = m.repo ?? "(no repo)";
  console.log(`  ${star} #${m.matchId} ${repo} → ${m.project} · ${m.relevance}${score}${stars}${lic}${handoff}`);
}

function parseQuotaReason(reason: string | null): "primary" | "sensitive" | null {
  if (!reason) return null;
  if (reason.startsWith("llm-quota:primary")) return "primary";
  if (reason.startsWith("llm-quota:sensitive")) return "sensitive";
  return null;
}

function marker(kind: string): string {
  switch (kind) {
    case "match":
      return "✓";
    case "skip":
    case "triage_skip":
      return "·";
    case "error":
      return "✗";
    case "fetch_start":
    case "fetch_done":
      return "↓";
    case "reason":
      return "?";
    case "scan":
    default:
      return "›";
  }
}

function handleApiError(e: unknown): void {
  console.error(`✗ ${(e as Error).message ?? String(e)}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
