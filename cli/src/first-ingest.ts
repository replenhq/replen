// First-time ingest streamer used by `npx replen` after install.
//
// Triggers a pipeline run and tails progress until the discovered pool
// is ready (event signal: `fetch_done` with "Discovered pool" message,
// or candidates count crosses 0). Then exits cleanly. Stages 1+2 and
// the scouted-pool fetcher continue server-side in the background;
// the user can do `npx replen progress` later if they want to watch
// the rest, or just open Claude Code and the agent will find whatever
// landed.
//
// Why exit early instead of waiting for full pipeline completion: a
// fresh install with 30+ projects can take 5-10 min for Stage 1+2
// per-project LLM work to finish. The user shouldn't sit at a blank
// terminal — they want to know "is there something I can look at now?"
// and the answer becomes yes once the discovered pool lands (typically
// 30-60s in).
//
// Tolerant of rate-limit and in-flight responses; never fails the
// install flow on its own — worst case prints a "you can run
// `npx replen progress` later" hint and returns.

import { apiGet, apiPost } from "./api.js";
import type { Config } from "./config.js";

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

type TriggerResponse = {
  ok: boolean;
  status: string;
  reason?: string;
  runId?: number;
};

const POLL_INTERVAL_MS = 2500;
// Absolute cap on how long we sit in the streamer. Discovered pool
// usually lands inside 60s but giving generous headroom for slow
// fetcher tails. If we hit this, we exit with a hint rather than
// blocking the install flow.
const MAX_WAIT_MS = 180_000;

export async function runFirstIngest(cfg: Config): Promise<void> {
  console.log("");
  console.log("  Pulling first batch of candidates from your sources…");
  console.log("  (This takes about a minute. You can `^C` here — ingest continues server-side.)");
  console.log("");

  // Step 1: trigger a run. Tolerant of in-flight / rate-limit.
  let triggered: TriggerResponse | null = null;
  try {
    triggered = await apiPost<TriggerResponse>(cfg, "/api/mcp/run-now", {});
  } catch (e) {
    // Surface but don't fail install — the cron scheduler will pick
    // up the new projects on its next tick.
    console.log(`  · Couldn't trigger an immediate run (${(e as Error).message.slice(0, 80)}).`);
    console.log(`    The cron scheduler will catch up shortly. Open Claude Code in a tracked repo`);
    console.log(`    in a few minutes and the agent will mention any new matches.`);
    return;
  }

  if (!triggered.ok && triggered.status !== "in_flight") {
    console.log(`  · Run not started: ${triggered.reason ?? triggered.status}`);
    console.log(`    The next scheduled run will pick up the new projects.`);
    return;
  }

  // Step 2: poll status, print events, exit when discovered pool ready.
  let since = 0;
  let firstTick = true;
  let lastCandidates = 0;
  let startedAt = Date.now();
  let discoveredReadyAnnounced = false;

  while (true) {
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      console.log("");
      console.log("  · Ingest still going — exiting the streamer so you're not blocked.");
      console.log("    Run `npx replen progress` to keep watching, or just open Claude Code.");
      return;
    }

    let status: Status;
    try {
      status = await apiGet<Status>(cfg, "/api/mcp/status", since ? { since } : undefined);
    } catch (e) {
      console.log(`  · Lost connection to status endpoint: ${(e as Error).message.slice(0, 80)}`);
      console.log(`    Ingest still running. Open Claude Code shortly to see matches.`);
      return;
    }

    if (firstTick) {
      const phase = status.phase ?? "starting";
      console.log(`  Run #${status.runId ?? "?"} · ${status.inFlight ? `running · phase=${phase}` : "idle"}`);
      firstTick = false;
    }

    for (const ev of status.events ?? []) {
      console.log(`  ${marker(ev.kind)} ${ev.message}`);
      if (ev.id > since) since = ev.id;
      // The Phase-1 completion signal: pipeline emits a `fetch_done`
      // event whose message starts with "Discovered pool:". Once we
      // see that, the discovered candidates are persisted and visible
      // to replen_match.
      if (
        ev.kind === "fetch_done" &&
        ev.message.startsWith("Discovered pool:") &&
        !discoveredReadyAnnounced
      ) {
        discoveredReadyAnnounced = true;
        // Don't exit immediately — let the next poll catch any inline
        // events so the user sees a coherent end state, then bail.
      }
    }

    // Fallback signal: if candidates count crossed 0, the discovered
    // pool is functionally ready even if the event ordering didn't
    // emit the expected marker. Belt + suspenders.
    if (!discoveredReadyAnnounced && (status.candidates ?? 0) > lastCandidates && (status.candidates ?? 0) > 0) {
      discoveredReadyAnnounced = true;
    }
    lastCandidates = status.candidates ?? lastCandidates;

    // If the whole pipeline already finished (e.g. existing user with
    // cached vectors — runs end fast), exit cleanly.
    if (!status.inFlight) {
      console.log("");
      console.log(`  ✓ Ingest complete · ${status.candidates ?? 0} candidate(s) in inventory.`);
      return;
    }

    // If discovered pool is ready, exit and let the rest run server-
    // side. Stage 1+2 + scouted pool take much longer; no point making
    // the user watch them.
    if (discoveredReadyAnnounced) {
      console.log("");
      console.log(`  ✓ First candidates ready (${status.candidates ?? "?"} so far).`);
      console.log(`    Per-project relevance refinement continues in the background.`);
      console.log(`    Run \`npx replen progress\` later to watch, or just open Claude Code.`);
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function marker(kind: string): string {
  switch (kind) {
    case "fetch_start":
    case "fetch_done":
      return "›";
    case "scan":
      return "·";
    case "match":
      return "✓";
    case "skip":
      return "·";
    case "error":
      return "✗";
    default:
      return "·";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
