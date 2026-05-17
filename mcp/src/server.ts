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

const TOOLS: Tool[] = [
  {
    name: "replen_help",
    description: "List every replen MCP tool available in this session with one-line descriptions and example invocations. Call this when the user types /replen or asks 'what can replen do' / 'what commands do I have'.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const lines = [
        "Replen MCP — available tools:",
        "",
        "  replen_today      List matches from the last N days (default 2). Filter by relevance / project.",
        "  replen_search     Full-text search across all your prior matches.",
        "  replen_starred    Starred matches with handoff-PR status (awaiting / open-pr / merged).",
        "  replen_analyze    Pull raw README + repo meta + your project profiles for one repo.",
        "  replen_handoff    Open a handoff PR in the matched project's own repo (requires matchId).",
        "  replen_feedback   Record good / bad / clear / star / unstar / hide on a match.",
        "  replen_run        Trigger a fresh pipeline run. Rate-limited (1 per 60s).",
        "  replen_status     Live progress of the current/most-recent run + event tail.",
        "",
        "Common flows:",
        "  • Morning triage:    'use replen to triage today'  (or /replen-triage)",
        "  • Fresh refresh:     replen_run, then poll replen_status until done, then replen_today",
        "  • Quick brief:       replen_analyze({ owner, name })",
        "  • Open handoff PR:   replen_handoff({ matchId })",
      ];
      return lines.join("\n");
    },
  },
  {
    name: "replen_today",
    description: "List matches from replen, the AI that asks 'can we do this better?' on your codebase. Returns repos surfaced in the last N days, scored against your project profiles with an adopt/port/skip verdict. Use this to answer 'what could make my project sharper today' or 'anything for <project-name> this week'.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", minimum: 1, maximum: 30, default: 2, description: "Days back to include" },
        relevance: { type: "array", items: { type: "string", enum: ["high", "medium", "general-awareness", "low"] }, description: "Filter to specific relevance levels. Default: high+medium." },
        project: { type: "string", description: "Limit to one project slug" },
      },
    },
    handler: async (cfg, args) => {
      const parsed = z.object({
        days: z.number().min(1).max(30).default(2),
        relevance: z.array(z.string()).optional(),
        project: z.string().optional(),
      }).parse(args);
      const data = await apiGet<{ matches: unknown[]; count: number }>(cfg, "/api/mcp/today", {
        days: parsed.days,
        relevance: parsed.relevance?.join(","),
        project: parsed.project,
      });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_search",
    description: "Full-text search across your replen history (writeups, repo metadata, personal notes). Use when the user asks about a repo / topic they've seen before but doesn't remember when.",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", description: "Search query (min 2 chars)" } },
      required: ["q"],
    },
    handler: async (cfg, args) => {
      const { q } = z.object({ q: z.string().min(2) }).parse(args);
      const data = await apiGet(cfg, "/api/mcp/search", { q });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "replen_starred",
    description: "List all starred matches with their handoff status (awaiting / open-pr / integrated). Use to triage what to integrate next.",
    inputSchema: { type: "object", properties: {} },
    handler: async (cfg) => {
      const data = await apiGet(cfg, "/api/mcp/starred");
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
