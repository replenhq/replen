import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { apiGet, apiPost, type ApiConfig } from "./api.js";

// Tool definitions and dispatch. The MCP SDK's low-level Server handles JSON-
// RPC; we just declare a list and a switch.
//
// Naming: every tool is prefixed `replen_` so callers can guess them
// (`replen_today`, `replen_run`, ...). The 0.1.x prefix was `digest_`; that
// was a leftover from the project's original name and was renamed in 0.2.0.
//
// Design notes:
//  - `replen_analyze` deliberately returns raw signals (readme, stars, your
//    projects) instead of running our LLM analyzer. The point of MCP is that
//    the *caller's* Claude session has the open codebase loaded, so it'll
//    judge fit better than our stale pipeline can.
//  - All write operations require an explicit `matchId`. There's no "open
//    handoff PR for the repo I just analysed"; agents should fetch the
//    match list, pick the right id, and act on that, to avoid surprises.

type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  handler: (cfg: ApiConfig, args: Record<string, unknown>) => Promise<string>;
};

// Resolve the `repo` filter for a tool call:
//   - explicit `repo` arg wins
//   - empty string ("") explicitly opts out of repo-scoping
//   - undefined falls back to cfg.defaultRepo (the cwd-detected one)
// Returns undefined when no filter should be applied (so apiGet skips the
// query param entirely).
function resolveRepo(args: Record<string, unknown>, cfg: ApiConfig): string | undefined {
  if (typeof args.repo === "string") {
    return args.repo === "" ? undefined : args.repo;
  }
  return cfg.defaultRepo ?? undefined;
}

const REPO_PARAM_DESCRIPTION =
  "GitHub 'owner/name' to scope results to. Defaults to the repo this MCP was spawned in (detected from `git remote get-url origin`). Pass an empty string '' to override the default and see matches across all your projects.";

const TOOLS: Tool[] = [
  {
    name: "replen_help",
    description: "List every replen MCP tool available in this session with one-line descriptions and example invocations. Call this when the user types /replen or asks 'what can replen do' / 'what commands do I have'.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const lines = [
        "Replen MCP — available tools:",
        "",
        "  Skill-mode (current — in-session matching with subscription tokens):",
        "    replen_match            Pulls today's candidate inventory scoped to the cwd repo so YOU triage each one against the local codebase. Returns candidates + metadata. You produce the writeups; no API key used.",
        "    replen_record_triage    Record your per-candidate verdict (adopt / port / skip / defer) after you triage one in replen_match. Powers the Activity feed.",
        "    replen_state            Record a user action (starred / hidden / handed_off / surfaced) on a candidate.",
        "    replen_check_new Session-start check: is there anything new + actionable? Cheap, terse, silent when nothing's new.",
        "",
        "  Legacy hosted-tier (still works for users in subscription_tier='hosted'; in skill-mode these return empty/stale data):",
        "    replen_today     LLM-scored matches from the last N days. In skill-mode use replen_match instead.",
        "    replen_search    Full-text search across hosted-tier match history.",
        "    replen_starred   Starred hosted-tier matches with handoff-PR status.",
        "    replen_feedback  Record good / bad / clear / star / unstar / hide on a hosted-tier match.",
        "    replen_run       Trigger a fresh hosted pipeline run. Rate-limited (1 per 60s).",
        "    replen_status    Live progress of the current/most-recent hosted run.",
        "",
        "  Shared (work in both tiers):",
        "    replen_analyze   Pull raw README + repo meta + your project profiles for one repo. Use as evidence-gathering inside replen_match.",
        "    replen_handoff   Open a handoff PR in the matched project's own repo. Server-side because git writes need credentials we don't carry locally.",
        "",
        "Common flow (skill-mode):",
        "  • Triage today: replen_match → analyse each candidate against local code → present writeups → replen_state per user action.",
      ];
      return lines.join("\n");
    },
  },
  {
    name: "replen_match",
    description:
      "Skill-mode entry point. Pulls today's candidate inventory scoped to the cwd repo. " +
      "\n\n" +
      "RESPONSE FORMAT — IMPORTANT:\n" +
      "The response has two sections, separated by a divider:\n" +
      "  1. USER-FACING MESSAGE (the first section, between two `===` lines): a pre-formatted footnote string. " +
      "If this section is non-empty, you MUST relay it VERBATIM at the end of your response to the user, " +
      "on a new paragraph after answering their original question. This is the calm-cadence surface; " +
      "the user sees it and decides whether to ask for the full triage. Do NOT reword, summarise, or skip it. " +
      "If this section is empty (just `(none)`), say nothing about Replen — silence is correct, " +
      "the inventory has nothing for this repo right now.\n" +
      "  2. DATA (the JSON below the divider): the structured candidate list with metadata + cosine scores + whyShortlisted lines. " +
      "Use these for the in-session triage if the user accepts the 'Want me to triage them?' offer. Don't show this raw to the user.\n" +
      "\n" +
      "TRIAGE PROTOCOL (only when the user accepts):\n" +
      "  1. For each candidate, WebFetch the candidate's README + grep the user's source for related code (under src/, lib/, app/ — skip node_modules, dist, .next).\n" +
      "  2. Form a verdict: 'adopt' (drop-in fit), 'port' (idea worth copying, runtime mismatched), 'skip' (worse than what they have, or wrong runtime). Score 0-100. Effort: 'quick' (<1d), 'moderate' (1-3d), 'deep' (1+w).\n" +
      "  3. Compose a writeup with concrete file-level impact references — name actual files the candidate replaces or improves.\n" +
      "  4. Present writeups to the user, ask which to star / hide / handoff / skip, call replen_state for each action.\n" +
      "Cap on real-life triage: 5 candidates max per session. " +
      "Scoped by default to the repo this MCP was spawned in. Pass repo='' to see the global firehose across all the user's projects.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: REPO_PARAM_DESCRIPTION },
        limit: { type: "number", minimum: 1, maximum: 20, default: 5, description: "Max candidates to return. Default 5." },
        days: { type: "number", minimum: 1, maximum: 365, description: "Days of inventory to consider. OMIT to let the server pick the right window automatically — a wide first-run window (months) for a brand-new user, then ~a week for established users. Only pass this to force a specific window." },
      },
    },
    handler: async (cfg, args) => {
      const parsed = z.object({
        repo: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(5),
        days: z.number().int().min(1).max(365).optional(),
      }).parse(args);
      const data = await apiGet(cfg, "/api/inventory/today", {
        repo: resolveRepo(args, cfg),
        limit: parsed.limit,
        // Omitted when the caller didn't pass days → server applies its
        // adaptive lookback (first-run months, then ~week). apiGet drops
        // undefined query params.
        days: parsed.days,
      }) as { displayText?: string | null; [k: string]: unknown };

      // Two-section response: prominent USER-FACING MESSAGE block first
      // (the agent MUST relay this verbatim per the tool description),
      // then the structured JSON below for the triage protocol. This
      // makes the surfacing path data-driven instead of relying on
      // CLAUDE.md instruction adherence (which has proven unreliable).
      const display = (typeof data.displayText === "string" && data.displayText) ? data.displayText : "(none)";
      return [
        "=== USER-FACING MESSAGE (relay this verbatim at end of your response; skip if `(none)`) ===",
        display,
        "=== END USER-FACING MESSAGE ===",
        "",
        "=== DATA (for triage; don't show raw to user) ===",
        JSON.stringify(data, null, 2),
      ].join("\n");
    },
  },
  {
    name: "replen_state",
    description:
      "Record a user action on a Replen candidate. Call AFTER you've presented writeups via replen_match and the user has chosen what to do with each one. " +
      "Statuses:\n" +
      "  - 'starred'    user wants to come back to this; never re-surface\n" +
      "  - 'hidden'     user dismissed it; never re-surface\n" +
      "  - 'handed_off' user wants a handoff PR opened (use replen_handoff to actually open the PR, then call this with the resulting PR url)\n" +
      "  - 'surfaced'   the closing 'I showed this, user neither stared nor hid' bookend; call once per candidate you presented, even skips. Lets the inventory deprioritise without locking out.\n" +
      "Idempotent — repeating bumps action_at without duplicating rows.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name of the candidate repo" },
        repoId: { type: "number", description: "Alternative to repo — the candidate's repoId from replen_match output" },
        projectId: { type: "number", description: "Optional project profile id from replen_match's candidates[].projectMatch context. Omit for global state." },
        status: { type: "string", enum: ["starred", "hidden", "handed_off", "surfaced"] },
        handoffPrUrl: { type: "string", description: "PR url if status=handed_off" },
        userNote: { type: "string", description: "User's optional note attached to the action" },
      },
      required: ["status"],
    },
    handler: async (cfg, args) => {
      const parsed = z.object({
        repo: z.string().optional(),
        repoId: z.number().int().positive().optional(),
        projectId: z.number().int().positive().nullable().optional(),
        status: z.enum(["starred", "hidden", "handed_off", "surfaced"]),
        handoffPrUrl: z.string().url().optional(),
        userNote: z.string().max(2000).optional(),
      }).parse(args);
      if (!parsed.repo && parsed.repoId === undefined) {
        throw new Error("must specify repo (owner/name) or repoId");
      }
      const data = await apiPost(cfg, "/api/state", parsed);
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_record_triage",
    description:
      "Record your per-candidate triage decision back to Replen. Call ONCE per candidate during the replen_match loop, AFTER you've formed your verdict but BEFORE / alongside presenting the writeup to the user. " +
      "Captures the agent's view of each candidate (adopt / port / skip / defer) with score + effort + reasoning. Distinct from replen_state, which captures the USER's action (star / hide / handoff). Both surface on the Activity feed at the user's dashboard. " +
      "Append-only: re-calling for the same repo creates another event row, useful if you re-evaluate later. " +
      "Voice: oneLine should be 1 sentence the user might read in a feed (\"Drops in for annotations.py — 30 min\"). writeup is the full reasoning (up to 16 KB).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name of the candidate repo" },
        repoId: { type: "number", description: "Alternative to repo — repoId from replen_match output" },
        project: { type: "string", description: "Project slug this verdict was made against. Omit for global verdicts." },
        projectId: { type: "number", description: "Alternative to project — project profile id." },
        verdict: { type: "string", enum: ["adopt", "port", "skip", "defer"], description: "Your structured call. adopt = drop-in fit; port = idea worth copying, runtime mismatched; skip = worse than current or wrong fit; defer = revisit later." },
        score: { type: "number", minimum: 0, maximum: 100, description: "Agent-assigned relevance score 0-100. Optional." },
        effortBand: { type: "string", enum: ["quick", "moderate", "deep"], description: "quick (<1d), moderate (1-3d), deep (1+w). Optional." },
        oneLine: { type: "string", maxLength: 280, description: "1-sentence summary for the Activity feed." },
        writeup: { type: "string", description: "Optional full reasoning. Up to 16 KB. No user source code." },
        sessionId: { type: "string", description: "Opaque per-Claude-Code-session id to cluster events. Use the same value across all replen_record_triage calls in one session." },
      },
      required: ["verdict"],
    },
    handler: async (cfg, args) => {
      const parsed = z.object({
        repo: z.string().optional(),
        repoId: z.number().int().positive().optional(),
        project: z.string().optional(),
        projectId: z.number().int().positive().nullable().optional(),
        verdict: z.enum(["adopt", "port", "skip", "defer"]),
        score: z.number().min(0).max(100).optional(),
        effortBand: z.enum(["quick", "moderate", "deep"]).optional(),
        oneLine: z.string().max(280).optional(),
        writeup: z.string().max(16 * 1024).optional(),
        sessionId: z.string().max(128).optional(),
      }).parse(args);
      if (!parsed.repo && parsed.repoId === undefined) {
        throw new Error("must specify repo (owner/name) or repoId");
      }
      const data = await apiPost(cfg, "/api/triage", parsed);
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_set_tags",
    description:
      "Set the domain tags on one of the user's registered Replen projects. " +
      "Use this during ONBOARDING (and any time the project's focus changes) to give the matcher domain context — " +
      "tags sharpen matching and matter MOST for a freshly-registered project that has no embedding yet, which would " +
      "otherwise fall back to language-only matching and surface noise. " +
      "DERIVE the tags from the project's actual code + docs, not generic guesses — e.g. for a Python crypto " +
      "market-making bot: [\"crypto\",\"trading\",\"market-making\",\"ccxt\",\"quant\",\"backtesting\"]. " +
      "Do NOT tell the user to set tags on the web — set them here. Replaces the project's current tag list.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name of the project repo (owner-tolerant — resolves even if the org drifted)" },
        repoId: { type: "number", description: "Alternative to repo — the project's id" },
        tags: { type: "array", items: { type: "string" }, description: "Domain tags. Lowercased + deduped server-side; max 30 kept." },
      },
      required: ["tags"],
    },
    handler: async (cfg, args) => {
      const parsed = z.object({
        repo: z.string().optional(),
        repoId: z.number().int().positive().optional(),
        tags: z.array(z.string()).max(50),
      }).parse(args);
      if (!parsed.repo && parsed.repoId === undefined) {
        throw new Error("must specify repo (owner/name) or repoId");
      }
      const data = await apiPost(cfg, "/api/projects/tags", parsed);
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_set_capabilities",
    description:
      "Set the TECHNICAL CAPABILITIES of a Replen project from what you read in its code. Use this during ONBOARDING " +
      "to give the matcher its query vectors WITHOUT waiting for the server to infer them on the next scheduled run — " +
      "matching works immediately. Capabilities are short, GitHub-searchable tech terms describing what the project " +
      "DOES at the tech level (not its UI features, not its domain): e.g. for a defense CV pipeline " +
      "[\"computer vision\",\"object detection\",\"satellite imagery\",\"geospatial mapping\"]; for a crypto bot " +
      "[\"crypto exchange\",\"market data\",\"backtesting\",\"technical analysis\"]. DERIVE them from the actual " +
      "imports/deps and code, not generic guesses. The server merges in dependency-derived capabilities and builds " +
      "the facet vectors right away. Distinct from replen_set_tags (broad domain labels); capabilities drive faceted " +
      "matching + the shared catalogue. Replaces the project's current capability set.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name of the project repo (owner-tolerant)" },
        repoId: { type: "number", description: "Alternative to repo — the project's id" },
        capabilities: { type: "array", items: { type: "string" }, description: "Short tech-capability terms (1-4 words each). Cleaned + deduped server-side." },
      },
      required: ["capabilities"],
    },
    handler: async (cfg, args) => {
      const parsed = z.object({
        repo: z.string().optional(),
        repoId: z.number().int().positive().optional(),
        capabilities: z.array(z.string()).max(40),
      }).parse(args);
      if (!parsed.repo && parsed.repoId === undefined) {
        throw new Error("must specify repo (owner/name) or repoId");
      }
      const data = await apiPost(cfg, "/api/projects/capabilities", parsed);
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_check_new",
    description:
      "Check if any new, actionable (high or medium relevance) replen matches landed since the user last engaged with replen — across the dashboard, the email digest, or a prior MCP session. " +
      "Call this ONCE at the start of every session, before asking the user what they want to work on. " +
      "Scoped by default to the repo this MCP was spawned in (the repo's full_name matched against the user's project profiles). Pass repo='' to check the user's entire feed. " +
      "If hasNew is true: mention the count + repos in 1-2 lines to the user, then ask if they want details (which they get via replen_today). " +
      "If hasNew is false: say NOTHING — do not tell the user 'no new replen matches', that is noise. Silence is the correct response. " +
      "Cheap (~50ms, one tiny DB query). Bumps an internal cursor so the next call only sees what's new after this one.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: REPO_PARAM_DESCRIPTION },
      },
    },
    handler: async (cfg, args) => {
      const parsed = z.object({ repo: z.string().optional() }).parse(args);
      void parsed; // resolveRepo reads args.repo directly so default-repo resolution works.
      const data = await apiGet(cfg, "/api/mcp/check-new", { repo: resolveRepo(args, cfg) });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_today",
    description: "List matches from replen, the AI that asks 'can we do this better?' on your codebase. Returns repos surfaced in the last N days, scored against your project profiles with an adopt/port/skip verdict. By default, scopes to matches whose handoff target is the repo this MCP was spawned in — pass repo='' to see everything.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", minimum: 1, maximum: 30, default: 2, description: "Days back to include" },
        relevance: { type: "array", items: { type: "string", enum: ["high", "medium", "general-awareness", "low"] }, description: "Filter to specific relevance levels. Default: high+medium." },
        project: { type: "string", description: "Limit to one project slug" },
        repo: { type: "string", description: REPO_PARAM_DESCRIPTION },
      },
    },
    handler: async (cfg, args) => {
      const parsed = z.object({
        days: z.number().min(1).max(30).default(2),
        relevance: z.array(z.string()).optional(),
        project: z.string().optional(),
        repo: z.string().optional(),
      }).parse(args);
      const data = await apiGet<{ matches: unknown[]; count: number }>(cfg, "/api/mcp/today", {
        days: parsed.days,
        relevance: parsed.relevance?.join(","),
        project: parsed.project,
        repo: resolveRepo(args, cfg),
      });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_search",
    description: "Full-text search across your replen history (writeups, repo metadata, personal notes). Use when the user asks about a repo / topic they've seen before but doesn't remember when. Scoped to the current repo by default; pass repo='' for global search.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query (min 2 chars)" },
        repo: { type: "string", description: REPO_PARAM_DESCRIPTION },
      },
      required: ["q"],
    },
    handler: async (cfg, args) => {
      const { q } = z.object({ q: z.string().min(2) }).parse(args);
      const data = await apiGet(cfg, "/api/mcp/search", { q, repo: resolveRepo(args, cfg) });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_starred",
    description: "List starred matches with handoff status (awaiting / open-pr / integrated). Scoped by default to the repo this MCP was spawned in — i.e. matches whose handoff PR target is this repo. Pass repo='' to see everything you've starred across all projects.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: REPO_PARAM_DESCRIPTION },
      },
    },
    handler: async (cfg, args) => {
      const data = await apiGet(cfg, "/api/mcp/starred", { repo: resolveRepo(args, cfg) });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_analyze",
    description:
      "Pull raw signals (README, GitHub metadata, your project profiles) for a specific repo so you can judge fit against the codebase you have open. " +
      "Returns: repo meta, README markdown, the user's project techSummaries, plus any existing match writeup. " +
      "Does NOT run the replen LLM pipeline; that's intentional, you have more context than it does.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "GitHub owner / org" },
        name: { type: "string", description: "Repo name (no .git suffix)" },
      },
      required: ["owner", "name"],
    },
    handler: async (cfg, args) => {
      const { owner, name } = z.object({ owner: z.string(), name: z.string() }).parse(args);
      const data = await apiPost(cfg, "/api/mcp/analyze", { owner, name });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_handoff",
    description:
      "Open a handoff PR in the user's own project repo, adding .digest/handoffs/<repo>-<date>.md describing why the matched OSS surfaced and prompting the agent to evaluate it. " +
      "Requires the match to be starred and the project's github_full_name to be set on /projects. " +
      "After this, you can clone the project, check out the new branch, read the handoff, and start integrating.",
    inputSchema: {
      type: "object",
      properties: { matchId: { type: "number", description: "Match ID from replen_today / replen_starred" } },
      required: ["matchId"],
    },
    handler: async (cfg, args) => {
      const { matchId } = z.object({ matchId: z.number().int().positive() }).parse(args);
      const data = await apiPost(cfg, "/api/mcp/handoff", { matchId });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_run",
    description:
      "Trigger a fresh replen pipeline run for the authenticated user. Same as the web app's refresh button: fetches new candidates, scores them against your project profiles, and writes matches. " +
      "Returns immediately with status='started'; use replen_status to watch progress. " +
      "Rate-limited: returns status='in_flight' (409) if a run is already going, or status='rate_limited' (429) if one finished < 60s ago.",
    inputSchema: { type: "object", properties: {} },
    handler: async (cfg) => {
      const data = await apiPost(cfg, "/api/mcp/run-now", {});
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_status",
    description:
      "Live status of the user's current or most-recent replen pipeline run. Returns inFlight, runId, candidates/matches counts, phase (fetching/scoring/writing/done), pausedReason (when a run stopped early), and a tail of pipeline events. " +
      "When pausedReason starts with 'llm-quota:', the user's LLM provider returned an out-of-credits response; tell the user to top up their API key or switch providers on /settings — do NOT call replen_run again. " +
      "Pass since=<event_id> to fetch only new events for incremental polling. Use after replen_run to wait for results.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Last event id already seen; returns only newer events. Omit on first call." },
      },
    },
    handler: async (cfg, args) => {
      const { since } = z.object({ since: z.number().int().nonnegative().optional() }).parse(args);
      const data = await apiGet(cfg, "/api/mcp/status", { since });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_feedback",
    description:
      "Record feedback / status on a match. Actions: 'good' / 'bad' (feeds source ranking; chronically-bad sources sink), 'clear' (undo good/bad), 'star' / 'unstar' / 'hide'. " +
      "Use 'good' when the user finds a match genuinely useful; 'bad' when it was off-topic. This trains which sources earn future LLM cycles.",
    inputSchema: {
      type: "object",
      properties: {
        matchId: { type: "number" },
        action: { type: "string", enum: ["good", "bad", "clear", "star", "unstar", "hide"] },
      },
      required: ["matchId", "action"],
    },
    handler: async (cfg, args) => {
      const parsed = z.object({
        matchId: z.number().int().positive(),
        action: z.enum(["good", "bad", "clear", "star", "unstar", "hide"]),
      }).parse(args);
      const data = await apiPost(cfg, "/api/mcp/feedback", parsed);
      return JSON.stringify(data, null, 2);
    },
  },
];

export function registerTools(server: Server, cfg: ApiConfig) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
    try {
      const text = await tool.handler(cfg, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });
}
