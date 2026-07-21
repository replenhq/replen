// Plain-shell subcommands. Each one mirrors an MCP tool but renders for the
// terminal rather than returning JSON to an agent. `--json` flag on every
// command dumps raw JSON for piping/scripting.

import { readdirSync, existsSync } from "node:fs";
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

  // Hook mode surfaces the repo-scoped SKILL inventory directly — the good data
  // (semantic + dependency / spec / health matches, with the relevance floor +
  // cool-off applied server-side), using the server's pre-formatted footnote.
  // It deliberately skips the legacy hosted `check-new` below, which returns
  // generic, un-scoped, high-star matches that aren't useful to skill-tier
  // users. Output is injected into the agent's opening context by Claude Code's
  // SessionStart-hook stdout injection; the framing nudges the agent to relay
  // it verbatim (final surfacing is still the model's call).
  if (hookMode && !json) {
    const cwdRepo = await detectCwdRepo();
    if (!cwdRepo) {
      // No git remote → Replen can't scope this project. If the cwd looks like
      // a real project (has source / a manifest), nudge the user to set it up;
      // otherwise stay silent (don't nag in /tmp or a random dir). Surfacing is
      // the model's call, but the explicit framing maximises it.
      if (looksLikeProject()) {
        console.log("[Replen] This project has no git remote, so Replen can't scope or match against it. Mention to the user, briefly, as a footnote: 'By the way — this project isn't set up with Replen yet (no git remote), so I can't surface matches for it. Want me to scope it — init git, create the repo, write the docs, and add tags?'");
      }
      return;
    }
    // Auto-register newly-appeared repos (identity only — owner/name +
    // manifest tags, no code, no LLM) in parallel with the inventory fetch.
    // Both are bounded and best-effort; neither may slow or disrupt session
    // open. When there's nothing new (the common case) auto-register returns
    // near-instantly, adding no wall-clock over the inventory call alone.
    const { autoRegisterNewRepos } = await import("./auto-register.js");
    const [, inv] = await Promise.all([
      autoRegisterNewRepos({ token: cfg.token, base: cfg.base }).catch(() => undefined),
      fetchInventoryStatus(cfg, cwdRepo),
    ]);
    if (inv?.displayText) {
      console.log("[Replen] Relay the following line to the user, verbatim, as a footnote at the very end of your first reply:");
      console.log(inv.displayText);
    }
    // LAYER 2: keep this install current with no manual re-run. Best-effort,
    // silent, and completely off the user's critical path (a failure here can
    // never break session open or the working install).
    await selfMaintain(inv?.latestCliVersion ?? null);
    return;
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
      return;
    }
    // Hook mode + hasNew=false: fall back to inventory state. check-new
    // is cursor-based and goes silent the moment ANY prior call (including
    // our own validation probes or a previous session) bumped the cursor
    // past existing matches. That's right behaviour for "did anything
    // change?", wrong for "should I tell the agent there's a queue worth
    // surfacing?" — the user might never have seen these candidates.
    //
    // Resolve the cwd's GitHub remote, query the inventory scoped to it,
    // and print a one-line status if anything's there. Output goes
    // verbatim into the agent's opening context via Claude Code's
    // SessionStart-hook stdout injection.
    const cwdRepo = await detectCwdRepo();
    if (!cwdRepo) return; // not in a git repo, or no GitHub remote — silent
    try {
      const inv = await fetchInventoryStatus(cfg, cwdRepo);
      if (inv && inv.count > 0) {
        const top = inv.topRepo ? ` Top: ${inv.topRepo}${inv.topSimilarity ? ` (~${inv.topSimilarity}% match)` : ""}.` : "";
        console.log(`Replen has ${inv.count} candidate${inv.count === 1 ? "" : "s"} queued for ${cwdRepo}.${top} Run /replen for full triage.`);
      }
    } catch {
      // Inventory query failed — silent, never disrupt a session.
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
  console.log("Open /replen (replen_match) for the full writeups.");
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

// Resolve the cwd's git origin remote into a GitHub owner/name, if the
// remote is a GitHub URL (HTTPS, standard SSH, or a multi-account SSH
// alias like github-personal). Returns null if not in a git repo or the
// remote isn't GitHub. Used by the SessionStart hook to scope inventory
// queries to the project the user just opened Claude Code in.
async function detectCwdRepo(): Promise<string | null> {
  try {
    const { execSync } = await import("node:child_process");
    const url = execSync("git remote get-url origin", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 1500,
    }).trim();
    const m = url.match(/(?:github\.com|github-[a-z0-9_-]+)[:/]([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
    if (!m) return null;
    return `${m[1]}/${m[2]}`;
  } catch {
    return null;
  }
}

// Cheap heuristic: does the cwd look like a real project worth nudging the user
// to scope with Replen? True when there's a recognised manifest, a src/lib/app
// dir, or a couple of source files. Keeps the "no git — want to scope?" prompt
// from firing in /tmp, $HOME, or an empty directory.
function looksLikeProject(): boolean {
  try {
    const manifests = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", "pubspec.yaml"];
    if (manifests.some((m) => existsSync(m))) return true;
    if (["src", "lib", "app", "cmd", "pkg"].some((d) => existsSync(d))) return true;
    const codeExt = /\.(ts|tsx|js|jsx|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|swift|kt|scala|sol|ex|clj)$/i;
    let codeFiles = 0;
    for (const e of readdirSync(".", { withFileTypes: true })) {
      if (e.isFile() && codeExt.test(e.name)) codeFiles++;
      if (codeFiles >= 2) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Query the inventory for the cwd's repo and return a compact status
// suitable for the hook one-liner. We deliberately don't pull the full
// candidate writeups here — the hook output goes into the agent's
// opening context, and a flood of detail there would crowd out the
// user's actual task. Just enough to tell the agent "there's queue
// worth surfacing; the user can ask for the triage."
type InventoryHookStatus = {
  count: number;
  topRepo: string | null;
  topSimilarity: number | null;
  displayText: string | null;
  latestCliVersion: string | null;
};
async function fetchInventoryStatus(
  cfg: { token: string; base: string },
  repo: string,
): Promise<InventoryHookStatus | null> {
  // Hook mode is on the session-open critical path; cap latency hard.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const url = new URL(cfg.base + "/api/inventory/today");
    url.searchParams.set("repo", repo);
    url.searchParams.set("limit", "5");
    url.searchParams.set("days", "14");
    const res = await fetch(url, {
      headers: { "x-digest-token": cfg.token, accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      displayText?: string | null;
      candidates?: Array<{ repo?: string; whyShortlisted?: string }>;
      latestCliVersion?: string | null;
    };
    const cands = data.candidates ?? [];
    const displayText = (typeof data.displayText === "string" && data.displayText) ? data.displayText : null;
    const latestCliVersion = (typeof data.latestCliVersion === "string" && data.latestCliVersion) ? data.latestCliVersion : null;
    // Surface even with ZERO candidates when the server sent a displayText:
    // notably the onboard-on-first-visit offer for a registered-but-unprofiled
    // repo (needsOnboarding), which has no candidates yet but IS the line to
    // relay. Also keep the object alive when only the self-update version signal
    // is present, so the hook can still self-update on a quiet session.
    if (cands.length === 0 && !displayText && !latestCliVersion) return null;
    const top = cands[0];
    // Pull the cosine % out of whyShortlisted if present
    // (format: "...; semantic similarity: 58%").
    const simMatch = top?.whyShortlisted?.match(/semantic similarity:\s*(\d+)%/);
    return {
      count: cands.length,
      topRepo: top?.repo ?? null,
      topSimilarity: simMatch ? Number(simMatch[1]) : null,
      // The server's pre-formatted, pattern-aware footnote ("By the way, a
      // dependency you use just shipped: …" / "… N candidates queued …" / the
      // onboard offer).
      displayText,
      latestCliVersion,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Forward-only semver compare (x.y.z; any prerelease suffix is ignored). True
// only when `a` is strictly greater than `b`.
export function isSemverGreater(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// LAYER 2: keep a 1.6.x+ install current with NO manual re-run.
//  (a) Refresh the global instruction files to THIS CLI's version, but only when
//      the user already opted into them (never CREATE them silently in a hook).
//  (b) When the server reports a newer published CLI, silently re-pin to it:
//      forward-only, throttled to once a day, detached, and fail-safe. The hook
//      runs as `npx replen@<oldVersion>`, so re-pinning in-process would re-pin
//      the SAME stale version; going through the registry (@latest) is what
//      fetches the new binary and rewrites the pin for the NEXT session.
// Every step is best-effort and swallows its own errors: nothing here may break
// session open or the working install.
async function selfMaintain(latestCliVersion: string | null): Promise<void> {
  // (a) idempotent global-instruction refresh (update-only, opt-in gated).
  try {
    const { existsSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    if (existsSync(join(homedir(), ".claude", "rules", "replen.md"))) {
      const { injectGlobalInstructions } = await import("./inject-instruction.js");
      injectGlobalInstructions();
    }
  } catch { /* best-effort */ }

  // (b) forward-only, throttled, detached self-update.
  try {
    if (!latestCliVersion) return;
    if (process.env.REPLEN_NO_SELFUPDATE) return; // kill-switch for a self-modifying path
    const { cliVersion } = await import("./mcp-setup.js");
    const local = cliVersion();
    if (local === "latest" || !isSemverGreater(latestCliVersion, local)) return;

    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
    const dir = join(homedir(), ".replen");
    const marker = join(dir, "last-selfupdate");
    try {
      const last = Number(readFileSync(marker, "utf8").trim());
      if (Number.isFinite(last) && Date.now() - last < 24 * 60 * 60 * 1000) return; // throttled
    } catch { /* no marker yet: proceed */ }
    // Stamp BEFORE spawning so a crash can't cause a retry storm.
    try { mkdirSync(dir, { recursive: true }); writeFileSync(marker, String(Date.now())); } catch { /* best-effort */ }

    const { spawn } = await import("node:child_process");
    const child = spawn("npx", ["--yes", "replen@latest", "mcp", "setup"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => { /* never surface */ });
    child.unref();
  } catch { /* a failed self-update leaves the working install intact */ }
}

// `replen atlas` — write your knowledge graph as an owned, Obsidian-compatible
// markdown vault to ~/.replen/atlas/. Fetches the rendered files from the server
// (one source of truth) and writes them locally; you own and can open them.
export async function runAtlas(argv: string[]): Promise<void> {
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join, dirname, resolve, sep } = await import("node:path");
  const { homedir } = await import("node:os");
  const cfg = await loadConfigOrExit();
  const dir = getFlag(argv, "--out") ?? join(homedir(), ".replen", "atlas");
  const data = await apiGet<{ count: number; files: Array<{ path: string; content: string }> }>(cfg, "/api/graph/atlas");
  if (!data.files?.length) {
    console.log("No Atlas yet — run /replen-onboard and a pipeline run first so the graph has something to map.");
    return;
  }
  // Fresh write: clear the managed subdirs, then write.
  for (const sub of ["projects", "capabilities", "candidates", "themes"]) {
    try { rmSync(join(dir, sub), { recursive: true, force: true }); } catch { /* */ }
  }
  // f.path is server-controlled: refuse any path that escapes the atlas dir
  // (e.g. "../../.zshrc"). Mirrors the guard in mcp/src/atlas-sync.ts.
  const root = resolve(dir);
  for (const f of data.files) {
    const full = resolve(dir, f.path);
    if (full !== root && !full.startsWith(root + sep)) continue; // path traversal guard
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
  }
  if (hasFlag(argv, "--json")) { console.log(JSON.stringify({ dir, count: data.files.length })); return; }
  console.log(`Atlas: ${data.files.length} tiles written → ${dir}`);
  console.log(`Open ${dir} in Obsidian (or any markdown editor) — the tiles stitch into the graph view of your projects, capabilities, and decisions.`);
}
