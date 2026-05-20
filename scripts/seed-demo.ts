// Seed-demo: wipes the demo user's data and re-creates it from fixed
// fixtures so /demo always shows the same polished snapshot regardless
// of when a visitor lands. Idempotent — running it twice is a no-op
// past the wipe.
//
// Run via:
//   npm exec tsx scripts/seed-demo.ts
//
// Reseed cadence: manually whenever the fixtures change, OR scheduled
// nightly via a systemd timer / cron so the "Last run" timestamp is
// always recent on /demo.

import { db, schema } from "../src/db/client";
import { and, eq, sql } from "drizzle-orm";
import { DEMO_USER_EMAIL } from "../src/lib/auth/demo-mode";

async function main() {
  console.log(`[seed-demo] wiping + reseeding demo user (${DEMO_USER_EMAIL})…`);

  // Find or create the demo user row.
  let demo = await db.select().from(schema.users).where(eq(schema.users.email, DEMO_USER_EMAIL)).get();
  if (!demo) {
    await db.insert(schema.users).values({
      firebaseUid: `demo:${DEMO_USER_EMAIL}`,
      email: DEMO_USER_EMAIL,
      displayName: "Replen Demo",
      role: "user",
      status: "active",
      canUseSharedLlm: false,
      createdAt: new Date(),
    });
    demo = await db.select().from(schema.users).where(eq(schema.users.email, DEMO_USER_EMAIL)).get();
    if (!demo) throw new Error("failed to insert demo user");
    console.log(`[seed-demo] created demo user id=${demo.id}`);
  } else {
    console.log(`[seed-demo] reusing demo user id=${demo.id}`);
  }

  // Wipe everything tied to this user. Cascades on DB schema FK
  // (users → projectProfiles + matches + matchInsights + digestRuns)
  // handle deletion automatically when we delete the user; we keep the
  // user row and clear its data manually instead so the cookie session
  // keeps resolving.
  await db.delete(schema.matchInsights).where(eq(schema.matchInsights.userId, demo.id));
  await db.delete(schema.matches).where(eq(schema.matches.userId, demo.id));
  await db.delete(schema.digestRuns).where(eq(schema.digestRuns.userId, demo.id));
  await db.delete(schema.projectProfiles).where(eq(schema.projectProfiles.userId, demo.id));

  // ── Fixtures ─────────────────────────────────────────────────────

  // Three demo projects with different shapes:
  //   sandbox-nextapp  — Next.js app (web). Healthy docs.
  //   sightline        — Python CV/ML. Healthy docs.
  //   tech-news-site   — Sparse docs (intentional, drives a docs-PR card).
  const now = new Date();
  const projectInserts = [
    {
      slug: "sandbox-nextapp",
      name: "sandbox-nextapp",
      path: "github:replenhq/sandbox-nextapp",
      readmeMd: "# Sandbox Next App\n\nDashboard for partner-API ingestion + admin tooling. Built on Next.js 15, drizzle, Firebase Auth, Tailwind.\n\nKey capabilities: ingestion of partner data feeds (HTTP webhooks + batch CSV), admin CRUD for partner accounts, audit log of every external call. Outcomes the team cares about: faster onboarding flow for new partners (sub-1-day vs. current 3-day manual), tighter audit-log coverage, and a UI that non-engineering ops staff can use without training.\n\nTech stack: TypeScript, Next.js 15 (App Router), Drizzle ORM + Postgres, Firebase Auth (next-firebase-auth-edge), Tailwind, Vercel.\n\nConstraints: data residency in EU only; no third-party processors outside the allowlist.\n",
      claudeMd: "# CLAUDE.md\n\nWhen working on this project, prefer the existing patterns in `src/components/` and `src/db/`. The drizzle schema is the source of truth — migrations live in `drizzle/migrations/`.\n\nActive priorities this sprint:\n- partner-onboarding wizard rework\n- richer audit log filtering (per-partner, per-action)\n- replace ad-hoc CSV parser with a typed schema\n",
      githubFullName: "replenhq/sandbox-nextapp",
      sensitivity: "low",
    },
    {
      slug: "sightline",
      name: "sightline",
      path: "github:replenhq/sightline",
      readmeMd: "# Sightline\n\nReal-time object detection + tracking on CCTV streams for warehouse safety. PyTorch model behind a FastAPI service; results stream to a small dashboard.\n\nKey capabilities: per-camera inference @ 25 FPS on a single T4, tracker handoff across overlapping cameras, alert routing on PPE-missing + zone-incursion events. Outcomes: cut PPE-violation review time from hours to minutes, push 1-shot alerts to ops Slack, retain raw frames for 30 days for audit.\n\nTech stack: Python 3.12, PyTorch, FastAPI, OpenCV, Redis (alert queue), ClickHouse (event log).\n\nConstraints: data stays on-prem (warehouse network), inference must run on the floor without round-trip to cloud.\n",
      claudeMd: "# CLAUDE.md\n\nModel weights live in `models/` (LFS). Don't commit weights; reference by sha256.\n\nActive priorities:\n- multi-camera tracker hand-off (overlap zones)\n- PPE detection class refinement (helmet, vest, gloves)\n- alert latency budget: <2s end-to-end\n",
      githubFullName: "replenhq/sightline",
      sensitivity: "low",
    },
    {
      slug: "tech-news-site",
      name: "tech-news-site",
      path: "github:replenhq/tech-news-site",
      readmeMd: "Async HTTP ingestion for partner APIs.",
      claudeMd: null,
      githubFullName: "replenhq/tech-news-site",
      sensitivity: "low",
    },
  ];

  const insertedProjects: Record<string, number> = {};
  for (const p of projectInserts) {
    const profile = `${p.readmeMd ?? ""}\n---\n${p.claudeMd ?? ""}`;
    await db.insert(schema.projectProfiles).values({
      userId: demo.id,
      slug: p.slug,
      path: p.path,
      name: p.name,
      readmeMd: p.readmeMd,
      claudeMd: p.claudeMd,
      techSummary: null,
      profileHash: hashString(profile),
      active: true,
      included: true,
      sensitivity: p.sensitivity,
      githubFullName: p.githubFullName,
      updatedAt: now,
      // Mark activity_json as "active" so the "vs current work" pill
      // lights up on demo cards — that's a key visual feature visitors
      // should see.
      activityJson: p.slug === "tech-news-site" ? null : JSON.stringify({
        summary: `Active work on ${p.name}: routine merges to main, ongoing feature work.`,
        themes: ["active-development"],
        topFiles: ["src/app/page.tsx", "src/db/schema.ts"],
        state: "active",
        daysSinceLastCommit: 1,
        generatedAt: now.toISOString(),
        promptVersion: "v1",
      }),
      activityGeneratedAt: p.slug === "tech-news-site" ? null : now,
      activityHeadSha: p.slug === "tech-news-site" ? null : "demo0000000000000000000000000000000000",
    });
    // CRITICAL: scope the lookup to the demo user. Slug alone is not
    // unique across users — without the userId filter the seed picks
    // up another user's project of the same slug, and matches written
    // against THAT project ID render as "_unknown" on the demo dashboard
    // because projectMap on / is also userId-scoped.
    const row = await db.select({ id: schema.projectProfiles.id }).from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, demo.id),
        eq(schema.projectProfiles.slug, p.slug),
      )).get();
    if (row) insertedProjects[p.slug] = row.id;
  }
  console.log(`[seed-demo] created ${Object.keys(insertedProjects).length} projects`);

  // ── Repos + matches ─────────────────────────────────────────────

  // Sample candidate repos referenced by the matches. Insert minimal
  // rows so the foreign keys + display fields resolve on render.
  const sampleRepos = [
    { owner: "tanstack", name: "query", url: "https://github.com/tanstack/query", description: "Powerful asynchronous state management, server-state utilities and data fetching for the web.", stars: 42000, primaryLanguage: "TypeScript", license: "MIT" },
    { owner: "drizzle-team", name: "drizzle-zod", url: "https://github.com/drizzle-team/drizzle-zod", description: "Generate Zod schemas from Drizzle ORM models.", stars: 4500, primaryLanguage: "TypeScript", license: "Apache-2.0" },
    { owner: "ultralytics", name: "yolov8", url: "https://github.com/ultralytics/yolov8", description: "State-of-the-art YOLOv8 object detection and tracking framework.", stars: 28000, primaryLanguage: "Python", license: "AGPL-3.0" },
    { owner: "obss", name: "sahi", url: "https://github.com/obss/sahi", description: "Sliced inference for handling large images in object detection.", stars: 5200, primaryLanguage: "Python", license: "MIT" },
    { owner: "abetlen", name: "llama-cpp-python", url: "https://github.com/abetlen/llama-cpp-python", description: "Python bindings for llama.cpp.", stars: 9500, primaryLanguage: "Python", license: "MIT" },
    { owner: "rendora", name: "rendora", url: "https://github.com/rendora/rendora", description: "Dynamic renderer for SPA SEO with HTTP cache.", stars: 1900, primaryLanguage: "Go", license: "Apache-2.0" },
  ];
  const repoIds: Record<string, number> = {};
  for (const r of sampleRepos) {
    await db.insert(schema.repos).values({
      owner: r.owner,
      name: r.name,
      url: r.url,
      description: r.description,
      stars: r.stars,
      primaryLanguage: r.primaryLanguage,
      license: r.license,
      pushedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      firstSeenAt: now,
      lastSeenAt: now,
    }).onConflictDoNothing();
    const row = await db.select({ id: schema.repos.id }).from(schema.repos)
      .where(sql`${schema.repos.owner} = ${r.owner} AND ${schema.repos.name} = ${r.name}`).get();
    if (row) repoIds[`${r.owner}/${r.name}`] = row.id;
  }

  // One synthetic digest run so /runs and the "Last run" label render.
  const runStartedAt = new Date(now.getTime() - 30 * 60 * 1000);
  const runFinishedAt = new Date(now.getTime() - 26 * 60 * 1000);
  await db.insert(schema.digestRuns).values({
    userId: demo.id,
    startedAt: runStartedAt,
    finishedAt: runFinishedAt,
    candidatesFound: 42,
    matchesCreated: 4,
    emailSent: false,
    costUsd: 0.18,
  });
  const runRow = await db.select({ id: schema.digestRuns.id })
    .from(schema.digestRuns)
    .where(eq(schema.digestRuns.userId, demo.id))
    .orderBy(sql`${schema.digestRuns.id} desc`)
    .limit(1)
    .get();
  const runId = runRow?.id ?? 0;

  // Matches: mix of tiers, projects, and integration approaches.
  // Writeups mirror production density — repo described, specific fit
  // for the project naming actual files, smallest viable first slice
  // with time estimate.
  const matches = [
    {
      repo: "tanstack/query",
      projectSlug: "sandbox-nextapp",
      relevance: "high",
      relevanceScore: 88,
      summary: "Async-state + server-cache toolkit for React apps. Replaces ad-hoc useEffect+fetch patterns with declarative queries, automatic refetch on focus / reconnect / interval, and a built-in devtools panel. MIT-licensed, 42k stars, weekly releases.",
      whyUseful: "sandbox-nextapp has 12 manual fetch sites in src/app/admin/* tied to local component state, none sharing a cache. The partner-onboarding wizard on your sprint is exactly the workload TanStack Query is built for: optimistic create on step 3, rollback if the server rejects, and immediate cache invalidation so the partner list on step 4 reflects the new row without a refetch round-trip.",
      suggestedUse: "Migrate partner CRUD pages first; one queryKey per resource, useMutation for writes with cache invalidation.",
      integrationApproach: "depend-on-it",
      risks: "Adds a peer dependency + a new mental model the team has to learn. Devtools panel must be tree-shaken / guarded out of production builds (one extra config line).",
      discoveryMode: "scouted",
      matchedOutcome: "faster partner onboarding wizard with optimistic updates",
      writeupMd: `TanStack Query is the React-server-state library that retired the "useEffect + fetch + useState" pattern across the ecosystem. 42k stars, MIT, actively maintained by Tanner Linsley and a small core team; weekly releases. The core idea is small: every query has a key, the cache is shared, and stale-while-revalidate happens automatically. The library does the boring parts — request dedup, focus refetch, retry with backoff, optimistic updates with rollback, devtools — so your component code stays declarative.

For *sandbox-nextapp* specifically, there are 3 concrete plug points where it earns its place. Listed in increasing ambition:

1. **Replace the 12 manual fetch + useState sites in src/app/admin/partners/.** Each page today has a \`useEffect\` that fires \`fetch('/api/partners/...')\`, stores the response in \`useState\`, and re-fetches on every component remount. TanStack Query collapses this to \`useQuery({ queryKey: ['partners', id], queryFn: ... })\` with automatic cache reuse across the partner list, partner detail, and the audit-log drawer. ~2 hours per page, ~1 day total.

2. **Wire the partner-onboarding wizard's optimistic flow.** Step 3 of the wizard is "create the partner", step 4 is "configure the data feed against that partner". Today step 4 has to wait for step 3's server response before its form can populate. \`useMutation\` with \`onMutate: optimisticUpdate\` lets step 4 render immediately against the cached optimistic row, and rolls back cleanly if step 3 actually fails. This is the single highest-leverage change for the onboarding-speed need on your sprint.

3. **Centralise the audit-log polling.** \`AuditLog.tsx\` does \`setInterval(fetchAuditLog, 5000)\` today; TanStack Query's \`refetchInterval\` does the same with proper cleanup, focus-pause, and automatic retry — and lets you share the same query across multiple components without N polling timers.

Smallest viable first slice: migrate \`src/app/admin/partners/page.tsx\` (the list page) to \`useQuery\` in one PR. That alone validates the integration shape against your existing API routes, brings in the QueryClientProvider + devtools setup, and gives you a working pattern to point at when migrating the rest. Half a day including testing. (1) and (3) follow naturally after; (2) — the optimistic-wizard payoff — wants a focused second PR with the optimistic + rollback patterns deliberately tested.`,
    },
    {
      repo: "drizzle-team/drizzle-zod",
      projectSlug: "sandbox-nextapp",
      relevance: "medium",
      relevanceScore: 72,
      summary: "Generates Zod schemas directly from Drizzle ORM models so input validation and the DB shape can't drift. Same authors as Drizzle itself; 4.5k stars, Apache-2.0, ~weekly release cadence with the rest of the Drizzle ecosystem.",
      whyUseful: "sandbox-nextapp hand-writes Zod schemas in src/lib/validators/ today, and they've already drifted from two of your recent migrations (the partner.feedKind enum changed, the partner.allowedDomains went from text to text[]; neither was reflected in the validators). Generating from drizzle schemas means the validator changes the moment the migration lands. Zero ongoing maintenance.",
      suggestedUse: "Replace src/lib/validators/partner.ts with createInsertSchema(partners) and createSelectSchema(partners). Audit the remaining validators after.",
      integrationApproach: "drop-in",
      risks: "Generated schemas use Drizzle's defaults for nullability, optionality and refinements — anything you'd hand-tuned (e.g. 'name must be 3-50 chars') needs the .extend() call to layer back on top. Half-day audit pass on the remaining validators.",
      discoveryMode: "scouted",
      matchedOutcome: "validators that stay in sync with the schema",
      writeupMd: `drizzle-zod is a small focused utility from the Drizzle team: feed it a Drizzle table, get back a Zod schema. \`createInsertSchema(partners)\` produces a schema validated against the columns your DB actually has, with the nullability and types Drizzle inferred from your migrations. 4.5k stars, Apache-2.0, same release cadence as Drizzle core, ~7 contributors, last push within a week. Boring in the best way.

For *sandbox-nextapp*, the immediate value is closing the validator-drift gap. You write your validators by hand in \`src/lib/validators/\` today, and a quick read shows they're already out of sync:

- \`partner.ts\` validates \`feedKind: z.enum(['rest', 'graphql', 'rss'])\` but migration \`0024_partner_kafka_feed.sql\` added \`'kafka'\` as a fourth enum value
- \`partner.ts\` validates \`allowedDomains: z.string().array()\` but migration \`0026_partner_domain_normalisation.sql\` changed the column to a Postgres \`text[]\` with a CHECK constraint enforcing lowercase + no trailing slashes
- \`audit.ts\` validates \`actorId: z.number()\` but \`actor_id\` is nullable in the \`audits\` table (system events have no actor)

For each of these, the hand-written validator is wrong, and there's no test catching it because validators are tested in isolation, not against the live schema. drizzle-zod fixes this by tying validation generation to the Drizzle source of truth.

The migration is straightforward. Replace each validator with a \`createInsertSchema\` / \`createSelectSchema\` call, then \`.extend({ /* custom refinements */ })\` to add back the constraints that aren't expressible in Drizzle directly (e.g. "name must be 3-50 chars", "domain must be a valid hostname"). Most of your validators have 1-3 such refinements; the rest is pure generation.

Smallest viable first slice: convert \`src/lib/validators/partner.ts\` in one PR — that's the partner-onboarding-wizard input validator and the most critical one to get right. ~1 hour of code, ~1 hour of running the wizard against the new schema to catch the refinement edge cases. After that, the remaining validators can be batched in a single follow-up PR.`,
    },
    {
      repo: "ultralytics/yolov8",
      projectSlug: "sightline",
      relevance: "high",
      relevanceScore: 92,
      summary: "Production object detection + tracking framework. Built-in multi-object trackers (ByteTrack + BoT-SORT), ONNX / TensorRT / CoreML export, a stable Python API. 28k stars, AGPL-3.0 (Enterprise license available). Active: ~6 PRs merged this week.",
      whyUseful: "sightline runs an in-house wrapper around YOLOv5 today (src/inference/wrap_v5.py), with hand-rolled ByteTrack code in src/inference/track.py that doesn't handle camera-overlap zones — the exact gap on your sprint. YOLOv8 ships tracker-handoff-across-cameras out of the box, plus the ONNX export you'd need to keep inference on the T4 budget.",
      suggestedUse: "Migrate models/ to YOLOv8 weights, replace src/inference/track.py + wrap_v5.py with ultralytics.YOLO(...).track(persist=True), verify FPS holds.",
      integrationApproach: "depend-on-it",
      risks: "AGPL-3.0 — keep an eye on warehouse-deployed binaries. Ultralytics Enterprise dual-license is the path if AGPL is incompatible with how you ship inference to customer sites. The other licensing path is to keep the model + inference on a server boundary (already true for sightline) and avoid linking the AGPL surface into client-side code.",
      discoveryMode: "scouted",
      matchedOutcome: "multi-camera tracker handoff in overlap zones",
      writeupMd: `Ultralytics YOLOv8 is the current production-default object detector. The original YOLO architecture, rewritten as a clean Python framework with a stable API (\`from ultralytics import YOLO; m = YOLO('yolov8n.pt'); results = m.track(source, persist=True)\`). 28k stars, AGPL-3.0 with an Enterprise license for closed-source deployment. Active: ~6 PRs merged this week, 200+ contributors, last release tag was a fortnight ago.

The single biggest production-grade win over YOLOv5 — which sightline runs today — is the tracker. v8 ships \`ByteTrack\` and \`BoT-SORT\` directly in the framework, with \`persist=True\` keeping IDs stable across frames AND across overlapping camera sources. That solves the *exact* problem on your sprint: when warehouse cameras 4 and 5 cover an overlapping zone, a worker walking from one camera into the other should keep the same track ID. Today's \`src/inference/track.py\` runs ByteTrack independently per camera and re-IDs from scratch at overlap boundaries.

For *sightline* specifically, there are 3 concrete plug points:

1. **Drop-in replacement for src/inference/wrap_v5.py.** Your wrapper is ~280 lines around \`torch.hub.load('ultralytics/yolov5', ...)\`. YOLOv8's \`YOLO()\` class gives the same surface plus dynamic batching, ONNX export, and tracker integration. One file deleted, one import. ~2 hours including a smoke test on the test video set.

2. **Replace src/inference/track.py with model.track(persist=True).** This is the load-bearing change — kills ~600 lines of hand-rolled ByteTrack + the camera-overlap re-ID logic that's been on your bug list for two sprints. \`persist=True\` keeps IDs stable; for cross-camera handoff, group cameras by overlap zone and feed them as a batch source so the tracker sees them as one stream. ~1 day to wire up + a half-day to verify against the multi-camera regression set.

3. **Export to ONNX for the T4.** \`model.export(format='onnx', dynamic=True)\` produces a quantised graph; ONNX Runtime + TensorRT EP on the T4 typically hits ~30+ FPS on 1080p with the small model, comfortably above your 25 FPS budget. Today you run torch eager mode and burn maybe 30% of frame time on Python overhead.

Smallest viable first slice: (1) above. Migrate the wrapper without touching the tracker. That alone validates the YOLOv8 install + weight load + inference numerics against your existing test set, and lets (2) and (3) follow as clean focused PRs. ~3 hours of work; rollback is one git revert.

License note: AGPL-3.0 is fine for sightline's current deployment shape (server-side inference, warehouse-network only — the AGPL "network use" clause doesn't apply because customers don't interact with the model directly). If the deployment model ever changes to ship inference to a customer's edge, Ultralytics Enterprise ($) is the dual-license path.`,
    },
    {
      repo: "obss/sahi",
      projectSlug: "sightline",
      relevance: "medium",
      relevanceScore: 65,
      summary: "Sliced inference for large images: breaks frames into overlapping tiles, runs detection per-tile, merges with NMS across slice boundaries. Works as an adapter on top of YOLOv8 / YOLO-NAS / MMDetection. MIT, 5.3k stars, 30+ contributors, last push a few days ago.",
      whyUseful: "sightline's 4K warehouse cameras feed YOLO at a downsampled 1280×720 today (src/inference/preprocess.py), losing small-object recall — including the case-study you've flagged: missed dropped-PPE detections at the back of the frame. SAHI keeps full resolution by slicing, and the cross-slice NMS handles the case where a worker straddles two slices without double-counting.",
      suggestedUse: "Adapter in src/inference/sliced.py wrapping the YOLO model with sahi.predict.get_sliced_prediction. Benchmark recall on the 4K test set vs. current downsampled pipeline.",
      integrationApproach: "cherry-pick",
      risks: "Per-frame latency goes up roughly linearly with slice count (~4-9 tiles for 4K). If your latency budget is already at the edge of 40 ms / frame, run SAHI on a sampled subset only (every Nth frame, or only when a low-confidence detection triggers a re-check at full resolution). The cross-slice NMS is robust; the main caveat is tuning slice-overlap (default 0.2 is usually fine).",
      discoveryMode: "scouted",
      matchedOutcome: "small-object recall on high-res cameras",
      writeupMd: `SAHI (Slicing-Aided Hyper-Inference) is a focused adapter library: instead of downsampling a 4K frame to feed a 1280×720 detector, it tiles the frame into overlapping slices, runs the detector per-slice, and merges the results with cross-slice non-max-suppression. The merge logic handles the awkward case where an object spans two tiles — without it, the same worker would get two detections at slice boundaries. 5.3k stars, MIT, 30+ contributors, last push within days.

For *sightline*, the gap this fills is real. Your camera feeds are 4K (3840×2160) but \`src/inference/preprocess.py\` downsamples to 1280×720 before YOLO. That's a 9× reduction in effective area per object, which is fine for full-body workers but eats small-object recall — exactly the failure mode in the "missed dropped-PPE at the back of the frame" issue you've been tracking. SAHI lets you keep the 4K resolution end-to-end without exploding the input shape to the detector.

There are 2 concrete plug points:

1. **Add src/inference/sliced.py as a parallel inference path.** Mirror the existing \`predict()\` interface but with \`sahi.predict.get_sliced_prediction(image, detection_model=..., slice_height=1280, slice_width=1280, overlap_height_ratio=0.2, overlap_width_ratio=0.2)\`. Keep the original \`predict()\` for the cases where downsampling is fine (mid-frame workers); route 4K-edge zones through the sliced path. ~1 day to wire + half-day to tune slice size on the test set.

2. **Confidence-triggered re-run.** Cheaper than running sliced inference on every frame: when the main YOLO pass returns a low-confidence detection in a high-density region (warehouse aisle ends, dock bays), trigger a sliced re-pass on the bounding region only. SAHI supports per-region inference natively. This gets you the recall lift without the constant latency cost.

Smallest viable first slice: implement (1) above on a fixed 3×3 slice grid with 0.2 overlap, no confidence trigger, run on a held-out 4K test set, measure recall + latency delta. Half-day. If the recall lift is real (it typically is, in the 5-15 percentage-point range on small objects), (2) follows as the production-shape integration.

Risk note: per-frame latency scales linearly with slice count. On 4K with a 3×3 grid that's 9× the detector calls — manageable on the T4 with the small YOLOv8 model, possibly not with the larger variants. Benchmark before committing.`,
    },
    {
      repo: "abetlen/llama-cpp-python",
      projectSlug: null,
      relevance: "general-awareness",
      relevanceScore: 30,
      summary: "Python bindings for llama.cpp — run quantised local LLMs (GGUF format) from Python without a sidecar service or Docker. 9.5k stars, MIT, well-maintained, OpenAI-compatible server mode built in.",
      whyUseful: "Not a fit for any current project, but worth knowing for the case where on-prem LLM inference matters. sightline's warehouse-network constraint (no cloud round-trip allowed) makes this the obvious tool the day you add an event-captioning / shift-summary feature there.",
      suggestedUse: "Bookmark. No current project needs it. Re-check next time a project tags a sensitivity-high feature that benefits from on-device generation.",
      integrationApproach: "n/a",
      risks: "None — bookmarked for future, no action taken now.",
      discoveryMode: "discovered",
      matchedOutcome: null,
      writeupMd: `Python bindings for the llama.cpp inference engine. Lets you load a GGUF-quantised model (LLaMA-3, Mistral, Qwen, etc.) and call \`Llama(...).create_completion(...)\` directly from Python — no subprocess, no Docker, no API server. Ships with an OpenAI-compatible HTTP server mode (\`python -m llama_cpp.server\`) for the case where you want a drop-in replacement for \`OPENAI_BASE_URL\`. 9.5k stars, MIT, last release within the month.

No current project needs this — none of sandbox-nextapp / sightline / tech-news-site does on-device LLM work today. Filing it as keep-on-radar for two specific futures:

- **sightline event captioning.** The day you add "summarise this 30-second clip of a near-miss incident" as a feature, that LLM call can't go to OpenAI / Anthropic per the warehouse-network constraint. llama-cpp-python on the existing T4 or a small CPU-only instance handles a 7B model at usable throughput.
- **tech-news-site partner-fed summarisation.** If the partner APIs ever push payloads that need on-the-fly summarisation and you don't want to pay per-token, a local Mistral or Phi-3-small model is the natural shape.

Nothing to do now. Bookmark and Replen will re-check this against your projects every 20 days; the day a new feature's intent fits, this surfaces again with \`re-checked\` instead of \`discovered\`.`,
    },
    {
      repo: "rendora/rendora",
      projectSlug: null,
      relevance: "general-awareness",
      relevanceScore: 32,
      summary: "Go-based dynamic renderer for SPA SEO. Sits in front of a SPA, detects bot user-agents, serves pre-rendered HTML for them and the live SPA for everyone else. 1.9k stars, Apache-2.0, slower-paced maintenance (last push ~2 months ago).",
      whyUseful: "None of your current projects ships an SPA where SEO is load-bearing; sandbox-nextapp is SSR-by-default Next.js so the bot path is already covered. Keeping on radar for the day a future marketing or content site lands.",
      suggestedUse: "Bookmark. Read the architecture doc if you have 10 minutes; the user-agent + cache layering pattern is good background for any future SSR-vs-SPA decision.",
      integrationApproach: "n/a",
      risks: "None — keep-on-radar, no action.",
      discoveryMode: "discovered",
      matchedOutcome: null,
      writeupMd: `Rendora is a small Go service that acts as a "dynamic rendering" gateway for single-page apps: it sniffs bot user-agents (Googlebot, Bingbot, social-media link previewers), spawns a headless Chromium to pre-render the page, caches the HTML, and serves it to the bot while letting real users hit the live SPA. The pattern Google itself recommended pre-Lighthouse-mobile and a lot of larger SPAs still use behind the scenes. 1.9k stars, Apache-2.0, last push ~2 months ago so maintenance is slow but not dead.

Not relevant to any current project. sandbox-nextapp is Next.js with SSR-by-default; sightline doesn't ship a user-facing site; tech-news-site is partner-facing API ingestion not a public web surface. Bookmarking because:

- If a future project ships a Vite / Astro / Remix-with-CSR / pure-React-SPA site that needs to rank in search results, dynamic rendering is one of three approaches (the others: full SSR with a framework that supports it; ISR with a sitemap-driven prerender cron) and Rendora's architecture is a clean reference.
- The read-once + cache-with-purge pattern in Rendora's \`pkg/cache\` is a useful concrete example for any "fetch-on-demand expensive resource and serve cached" need, not just SEO.

Nothing to do. Bookmark and let the re-check loop surface it if a project intent ever fits.`,
    },
  ];

  // Insert matches and capture the auto-assigned IDs keyed by repo
  // string so the insights step below can reference them by name. Used
  // to be hardcoded [1,2,3,4] which only worked when the demo user was
  // the only matches inserter and the table was empty.
  const insertedMatchIds: Record<string, number> = {};
  for (const m of matches) {
    const repoId = repoIds[m.repo];
    if (!repoId) continue;
    const projectId = m.projectSlug ? insertedProjects[m.projectSlug] : null;
    const inserted = await db.insert(schema.matches).values({
      userId: demo.id,
      repoId,
      projectId,
      runId,
      relevance: m.relevance,
      relevanceScore: m.relevanceScore,
      summary: m.summary,
      whyUseful: m.whyUseful,
      suggestedUse: m.suggestedUse,
      integrationApproach: m.integrationApproach,
      risks: m.risks,
      writeupMd: m.writeupMd,
      userStatus: "unread",
      createdAt: now,
      sourceKind: m.discoveryMode === "scouted" ? "gh-targeted" : "gh-trending",
      discoveryMode: m.discoveryMode,
      matchedOutcome: m.matchedOutcome,
      matchedOutcomeSource: m.matchedOutcome ? "inferred" : null,
      matchedOutcomeConfidence: m.matchedOutcome ? "medium" : null,
    }).returning({ id: schema.matches.id });
    if (inserted[0]) insertedMatchIds[m.repo] = inserted[0].id;
  }
  console.log(`[seed-demo] created ${matches.length} matches`);

  // ── Insights ────────────────────────────────────────────────────

  const insights = [
    {
      kind: "topic",
      title: "Production CV inference cluster: retire YOLOv5 wrapper + lift small-object recall",
      bodyMd: `Two of this week's matches for *sightline* cluster around a single theme: production-grade CV inference. ultralytics/yolov8 and obss/sahi are both about getting the inference stack from "works on our test bench" to "works on the warehouse floor at 4K", and they happen to plug into adjacent layers — YOLOv8 is the detector swap, SAHI is the sliced-inference wrapper on top.

The cluster matters because both ask you to touch the same area of the codebase (\`src/inference/\`), and there's a natural sequencing: YOLOv8 first, then SAHI. Reversing the order means tying SAHI to the legacy YOLOv5 API and then having to redo the wiring when v8 lands.

What you're actually solving across both:

1. **Multi-camera tracker handoff** (the high-priority gap from your sprint plan). YOLOv8's \`model.track(persist=True)\` solves this directly; the \`obss/sahi\` match doesn't touch trackers.
2. **Small-object recall at full resolution.** Today \`src/inference/preprocess.py\` downsamples 4K to 1280×720 before YOLO. That's the root cause of the "missed dropped-PPE at the back of the frame" issue in your bug list. SAHI lets you keep 4K end-to-end via tiled inference; YOLOv8 alone won't fix this.
3. **Operational ergonomics.** v8's ONNX export is a real win for the T4 budget; v5's torch-eager path leaves ~30% of frame time on the table.

The shape of the rollout: one PR for the YOLOv8 wrapper swap (replace \`wrap_v5.py\` only, keep the existing tracker for now) → one PR for the tracker migration to \`model.track(persist=True)\` with cross-camera ID stability → one PR adding \`sliced.py\` and routing 4K-edge zones through it. Each PR is reverteable in isolation; combined they cover both sprint goals.`,
      evidenceRepos: ["ultralytics/yolov8", "obss/sahi"],
      primaryProjectSlug: "sightline",
      themes: ["computer-vision", "multi-camera", "production-inference"],
    },
    {
      kind: "approach",
      title: "Two additive integrations queued for sandbox-nextapp — neither asks you to rewrite",
      bodyMd: `Two of this week's matches for *sandbox-nextapp* are \`drop-in\` / \`depend-on-it\` (tanstack/query + drizzle-team/drizzle-zod). Rare to see a cluster this clean — both are additive layers, neither asks you to restructure existing code, and both target work that's already on your sprint.

The combined story: **drizzle-zod gives you validators that can't drift from the schema; TanStack Query gives you the cache + optimistic-update flow the partner-onboarding wizard needs.** Open them as two separate PRs, drizzle-zod first.

Why drizzle-zod first: it's lower blast radius (touches only \`src/lib/validators/\`), it fixes 3 already-broken validators (the partner.feedKind enum drift, the allowedDomains[] type drift, the audit.actorId nullability drift), and it sets up the validation surface that TanStack Query's mutations will use as input contracts. Half a day to migrate + audit the remaining validators.

Then TanStack Query as a separate PR: bring in QueryClientProvider, devtools, migrate \`src/app/admin/partners/page.tsx\` first as the proof case, then expand to the rest of \`/admin\`. The optimistic-wizard payoff sits in step 2 — once the list page is on TanStack Query, the partner-onboarding wizard's "step 3 creates, step 4 immediately renders against optimistic cache" pattern becomes one extra \`onMutate\` callback rather than a state-machine rewrite.

Neither match is a framework adoption — TanStack Query lives in a few hooks, drizzle-zod replaces one helper file. Both can be retired with a single revert if they don't pan out. That's why they're \`drop-in\` and \`depend-on\` rather than \`cleanroom-rebuild\`: the cost of saying yes is low, the cost of saying no later is also low.`,
      evidenceRepos: ["tanstack/query", "drizzle-team/drizzle-zod"],
      primaryProjectSlug: "sandbox-nextapp",
      themes: ["nextjs", "type-safety", "state-management"],
    },
  ];

  for (const i of insights) {
    // Resolve evidenceRepos → actual match IDs assigned during insert.
    // Skips any repo that didn't insert (defence — keeps the insight
    // valid even if a sample-repo or match config was reshuffled).
    const evidenceMatchIds = i.evidenceRepos
      .map((repo) => insertedMatchIds[repo])
      .filter((id): id is number => typeof id === "number");
    await db.insert(schema.matchInsights).values({
      userId: demo.id,
      runId,
      kind: i.kind,
      title: i.title,
      bodyMd: i.bodyMd,
      evidenceMatchIds: JSON.stringify(evidenceMatchIds),
      primaryProjectSlug: i.primaryProjectSlug,
      themes: JSON.stringify(i.themes),
      userStatus: "unread",
      createdAt: now,
    });
  }
  console.log(`[seed-demo] created ${insights.length} insights`);

  console.log("[seed-demo] done.");
}

function hashString(s: string): string {
  // Lightweight deterministic hash — not crypto, just a stable
  // fingerprint for profileHash. Matches what the production loader
  // produces semantically (a hex string that changes when content
  // changes).
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return `demo${Math.abs(h).toString(16)}`;
}

main().catch((e) => {
  console.error("[seed-demo] failed:", e);
  process.exit(1);
});
