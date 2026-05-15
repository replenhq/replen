import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { apiGet, apiPost, type ApiConfig } from "./api.js";

// Tool definitions and dispatch. The MCP SDK's low-level Server handles JSON-
// RPC; we just declare a list and a switch.
//
// Design notes:
//  - `digest_analyze_repo` deliberately returns raw signals (readme, stars,
//    your projects) instead of running our LLM analyzer. The point of MCP
//    is that the *caller's* Claude session has the open codebase loaded,
//    so it'll judge fit better than our stale pipeline can.
//  - All write operations require an explicit `matchId`. There's no "open
//    handoff PR for the repo I just analysed" — agents should fetch the
//    match list, pick the right id, and act on that, to avoid surprises.

type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  handler: (cfg: ApiConfig, args: Record<string, unknown>) => Promise<string>;
};

const TOOLS: Tool[] = [
  {
    name: "digest_today",
    description: "List OSS matches from your daily digest pipeline. Returns repos that surfaced in the last N days, scored against your project profiles. Use this to answer 'what's new today' or 'anything for <project-name> this week'.",
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
    name: "digest_search",
    description: "Full-text search across your digest history (writeups, repo metadata, personal notes). Use when the user asks about a repo / topic they've seen before but doesn't remember when.",
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
    name: "digest_starred",
    description: "List all starred matches with their handoff status (awaiting / open-pr / integrated). Use to triage what to integrate next.",
    inputSchema: { type: "object", properties: {} },
    handler: async (cfg) => {
      const data = await apiGet(cfg, "/api/mcp/starred");
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "digest_analyze_repo",
    description:
      "Pull raw signals (README, GitHub metadata, your project profiles) for a specific repo so you can judge fit against the codebase you have open. " +
      "Returns: repo meta, README markdown, the user's project techSummaries, plus any existing match writeup. " +
      "Does NOT run the digest LLM pipeline — that's intentional, you have more context than it does.",
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
    name: "digest_create_handoff",
    description:
      "Open a handoff PR in the user's own project repo, adding .digest/handoffs/<repo>-<date>.md describing why the matched OSS surfaced and prompting the agent to evaluate it. " +
      "Requires the match to be starred and the project's github_full_name to be set on /projects. " +
      "After this, you can clone the project, check out the new branch, read the handoff, and start integrating.",
    inputSchema: {
      type: "object",
      properties: { matchId: { type: "number", description: "Match ID from digest_today / digest_starred" } },
      required: ["matchId"],
    },
    handler: async (cfg, args) => {
      const { matchId } = z.object({ matchId: z.number().int().positive() }).parse(args);
      const data = await apiPost(cfg, "/api/mcp/handoff", { matchId });
      return JSON.stringify(data, null, 2);
    },
  },
  {
    name: "digest_feedback",
    description:
      "Record feedback / status on a match. Actions: 'good' / 'bad' (feeds source ranking — chronically-bad sources sink), 'clear' (undo good/bad), 'star' / 'unstar' / 'hide'. " +
      "Use 'good' when the user finds a match genuinely useful; 'bad' when it was off-topic — this trains which sources earn future LLM cycles.",
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
