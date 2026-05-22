// Plain-shell subcommands. Each one mirrors an MCP tool but renders for the
// terminal rather than returning JSON to an agent. `--json` flag on every
// command dumps raw JSON for piping/scripting.

import { apiGet, apiPost, loadConfigOrExit } from "./api.js";
import { configPath } from "./config.js";

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

// One-shot "is there anything new" check. Used in two modes:
//   1. interactive (`replen check-new`): always prints — useful for ad-hoc
//      "did anything land?" before opening Claude Code.
//   2. hook (`replen check-new --hook`): SILENT when nothing's new. Bounded
//      timeout (5s) so a slow API can't stall every Claude Code session
//      opening. Uses AbortController to actually cancel the in-flight fetch
//      on timeout — without that, an aborted hook would still let the server
//      finish + bump the cursor, "consuming" the matches without ever
//      surfacing them. Errors are swallowed and never fail the session.
//      Output is shaped so Claude Code's SessionStart-hook stdout injection
//      naturally surfaces the matches in the agent's opening context.
export async function runCheckNew(argv: string[]): Promise<void> {
  const hookMode = hasFlag(argv, "--hook");
  const json = hasFlag(argv, "--json");
  const repo = getFlag(argv, "--repo");

  // Hook mode runs on every Claude Code session for every user — including
  // users who installed Claude Code but never ran `npx replen`. Silent exit
  // (not the "Not signed in" prompt loadConfigOrExit prints) is required.
  const { readConfig } = await import("./config.js");
  const cfg = await readConfig();
  if (!cfg) {
    if (hookMode) return;
    console.error("Not signed in. Run `npx replen` first.");
    process.exit(1);
  }

  type CheckNewResp = {
    hasNew: boolean;
    count: number;
    scopedTo: string | null;
    since: string;
    matches?: Array<{
      matchId: number;
      repo: string | null;
      project: string;
      relevance: string;
      relevanceScore: number | null;
      effortBand: string | null;
      oneLine: string;
    }>;
  };

  const query: Record<string, string | undefined> = {};
  if (repo !== undefined) query.repo = repo;

  let r: CheckNewResp;
  try {
    if (hookMode) {
      // Direct fetch with AbortController so the timeout actually cancels
      // the request (apiGet has no signal). Without this, a "timed out"
      // hook would still let the server complete the call and bump the
      // cursor, silently consuming the matches.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const url = new URL(cfg.base + "/api/mcp/check-new");
        if (query.repo !== undefined) url.searchParams.set("repo", query.repo);
        const res = await fetch(url, {
          headers: { "x-digest-token": cfg.token, accept: "application/json" },
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        r = (await res.json()) as CheckNewResp;
      } finally {
        clearTimeout(timer);
      }
    } else {
      r = await apiGet<CheckNewResp>(cfg, "/api/mcp/check-new", query);
    }
  } catch (e) {
    if (hookMode) {
      // Silent failure: never disrupt a session for a non-critical signal.
      // Trace goes to a log so we can debug if needed.
      try {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(
          configPath().replace(/config\.json$/, "check-new-hook.log"),
          `${new Date().toISOString()} ${(e as Error).message ?? String(e)}\n`,
        );
      } catch {
        // intentionally ignore — diagnostic only
      }
      return;
    }
    handleApiError(e);
    return;
  }

  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (!r.hasNew) {
    if (!hookMode) {
      // Interactive: tell the user explicitly. In hook mode silence is the
      // correct response (calm-cadence principle).
      const scope = r.scopedTo ? ` for ${r.scopedTo}` : "";
      console.log(`No new actionable matches${scope} since you last engaged.`);
    }
    return;
  }

  // hasNew: print a tight block. Same shape in hook + interactive — Claude
  // Code's SessionStart hook injects stdout verbatim into the agent's
  // opening context, so the agent sees this and naturally surfaces it.
  const scope = r.scopedTo ?? "your projects";
  const banner = `Replen: ${r.count} new actionable match${r.count === 1 ? "" : "es"} for ${scope} since you last engaged.`;
  console.log(banner);
  console.log("");
  for (const m of r.matches ?? []) {
    const effort = m.effortBand ? ` · ${m.effortBand}` : "";
    const score = m.relevanceScore != null ? ` ${m.relevanceScore}` : "";
    const repoName = m.repo ?? "(no repo)";
    console.log(`  • ${repoName} (${m.relevance}${score}${effort})`);
    if (m.oneLine) console.log(`    ${m.oneLine}`);
  }
  console.log("");
  console.log("Call replen_today for the full writeups.");
}

// Watch for new matches in the background. Polls /api/mcp/today, diffs against
// the matchIds seen on the previous poll, prints anything new, and rings the
// terminal bell (\x07). First poll establishes a baseline — existing matches
// don't ring. Default interval 5 minutes (the pipeline runs daily by default,
// so polling tighter is pure overhead).
export async function runWatch(argv: string[]): Promise<void> {
  const cfg = await loadConfigOrExit();
  const json = hasFlag(argv, "--json");
  const noBell = hasFlag(argv, "--no-bell");
  const intervalSec = Math.max(30, Number(getFlag(argv, "--interval") ?? 300));
  const days = Number(getFlag(argv, "--days") ?? 2);
  const project = getFlag(argv, "--project");
  const relevance = getFlag(argv, "--relevance") ?? "high,medium";

  const seen = new Set<number>();
  let firstPass = true;

  if (!json) {
    const target = project ? ` · project=${project}` : "";
    console.log(`Watching for new ${relevance} matches${target} · poll every ${intervalSec}s · Ctrl-C to stop.`);
  }

  while (true) {
    let r: { days: number; count: number; matches: Match[] };
    try {
      r = await apiGet<{ days: number; count: number; matches: Match[] }>(cfg, "/api/mcp/today", {
        days,
        relevance,
        project,
      });
    } catch (e) {
      // Don't kill the watcher on a transient network blip — just log + retry.
      console.error(`✗ ${(e as Error).message ?? String(e)} (retrying in ${intervalSec}s)`);
      await sleep(intervalSec * 1000);
      continue;
    }

    const fresh: Match[] = [];
    for (const m of r.matches) {
      if (!seen.has(m.matchId)) {
        if (!firstPass) fresh.push(m);
        seen.add(m.matchId);
      }
    }

    if (json) {
      // Emit one JSON line per poll, regardless of new/no-new — easy to pipe.
      console.log(JSON.stringify({ ts: new Date().toISOString(), new: fresh.length, matches: fresh }));
    } else if (fresh.length > 0) {
      const stamp = new Date().toISOString().slice(11, 19);
      console.log(`\n[${stamp}] ${fresh.length} new:`);
      for (const m of fresh) renderMatchLine(m);
      if (!noBell) process.stdout.write("\x07");
    } else if (firstPass) {
      console.log(`Baseline: ${seen.size} match(es) already in feed; will alert on anything new.`);
    }

    firstPass = false;
    await sleep(intervalSec * 1000);
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
