// Skill-tier demo seeder. Wipes the demo user's state on the fork DB
// and re-creates it from fixed fixtures so /demo always shows the same
// polished snapshot regardless of when a visitor lands.
//
// Run via:
//   npm exec tsx scripts/seed-demo-skill.ts
//
// Distinct from scripts/seed-demo.ts (hosted-tier) — that populates
// the `matches` + `digestRuns` tables for the legacy LLM-scored UI.
// This one populates user_match_state + triage_events for the new
// Activity-led /demo.
//
// Idempotent — re-run any time the fixtures change.

import { db, schema } from "../src/db/client";
import { and, eq } from "drizzle-orm";
import { DEMO_USER_EMAIL } from "../src/lib/auth/demo-mode";

async function main() {
  console.log(`[seed-demo-skill] reseeding demo user (${DEMO_USER_EMAIL})…`);

  // Find or create the demo user.
  let demo = await db.select().from(schema.users).where(eq(schema.users.email, DEMO_USER_EMAIL)).get();
  if (!demo) {
    await db.insert(schema.users).values({
      firebaseUid: `demo:${DEMO_USER_EMAIL}`,
      email: DEMO_USER_EMAIL,
      displayName: "Replen Demo",
      role: "user",
      status: "active",
      canUseSharedLlm: false,
      createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
    });
    demo = await db.select().from(schema.users).where(eq(schema.users.email, DEMO_USER_EMAIL)).get();
    if (!demo) throw new Error("failed to insert demo user");
    console.log(`[seed-demo-skill] created demo user id=${demo.id}`);
  } else {
    console.log(`[seed-demo-skill] reusing demo user id=${demo.id}`);
  }

  // Ensure user_settings exists with subscriptionTier=skill. The
  // updatedAt column is NOT NULL on the schema and Drizzle won't
  // auto-default it, so we set it explicitly on both branches.
  const settingsRow = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, demo.id)).get();
  if (!settingsRow) {
    await db.insert(schema.userSettings).values({
      userId: demo.id,
      filterMode: "tags",
      subscriptionTier: "skill",
      updatedAt: new Date(),
    });
  } else {
    await db.update(schema.userSettings).set({
      filterMode: "tags",
      subscriptionTier: "skill",
      updatedAt: new Date(),
    }).where(eq(schema.userSettings.userId, demo.id));
  }

  // Wipe demo user's existing state (idempotent reseed).
  await db.delete(schema.triageEvents).where(eq(schema.triageEvents.userId, demo.id));
  await db.delete(schema.userMatchState).where(eq(schema.userMatchState.userId, demo.id));
  await db.delete(schema.projectProfiles).where(eq(schema.projectProfiles.userId, demo.id));
  console.log(`[seed-demo-skill] wiped existing demo state`);

  // ── Projects ──────────────────────────────────────────────────────
  // Three demo projects representing different shapes the agent
  // triages against.
  const now = new Date();
  const projects = [
    {
      slug: "sandbox-nextapp",
      name: "sandbox-nextapp",
      githubFullName: "replenhq/sandbox-nextapp",
      tags: JSON.stringify(["typescript", "next.js", "react", "vercel"]),
    },
    {
      slug: "sightline",
      name: "sightline",
      githubFullName: "replenhq/sightline",
      tags: JSON.stringify(["python", "computer-vision", "pytorch"]),
    },
    {
      slug: "tech-news-site",
      name: "tech-news-site",
      githubFullName: "replenhq/tech-news-site",
      tags: JSON.stringify(["typescript", "next.js", "feeds"]),
    },
  ];

  const projectIds: Record<string, number> = {};
  for (const p of projects) {
    await db.insert(schema.projectProfiles).values({
      userId: demo.id,
      slug: p.slug,
      name: p.name,
      path: `github:${p.githubFullName}`,
      githubFullName: p.githubFullName,
      profileHash: "demo-seeded",
      active: true,
      tags: p.tags,
      updatedAt: now,
    });
    const row = await db.select().from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, demo.id), eq(schema.projectProfiles.slug, p.slug)))
      .get();
    if (!row) throw new Error(`failed to insert demo project ${p.slug}`);
    projectIds[p.slug] = row.id;
  }
  console.log(`[seed-demo-skill] inserted ${projects.length} demo projects`);

  // ── Candidate repos ───────────────────────────────────────────────
  // The OSS repos the agent triaged. Reused across user_match_state
  // and triage_events. We upsert into `repos` (the global repo table)
  // — these may already exist on the fork DB from real fetcher runs.
  const candidateRepos = [
    { owner: "kvnang", name: "workers-og", stars: 8420, description: "Open Graph image generation on Cloudflare Workers / Vercel Edge." },
    { owner: "roboflow", name: "supervision", stars: 38700, description: "Reusable computer-vision building blocks." },
    { owner: "tj", name: "n", stars: 19200, description: "Interactively manage your Node.js versions." },
    { owner: "antoine-coulon", name: "skott", stars: 1340, description: "Detect circular deps, dead code, unused imports." },
    { owner: "garrytan", name: "gstack", stars: 100728, description: "Garry Tan's Claude Code config bundle." },
    { owner: "vercel", name: "turbo", stars: 28100, description: "High-performance build system for JavaScript/TypeScript." },
  ];

  const repoIds: Record<string, number> = {};
  for (const r of candidateRepos) {
    let existing = await db.select().from(schema.repos)
      .where(and(eq(schema.repos.owner, r.owner), eq(schema.repos.name, r.name)))
      .get();
    if (!existing) {
      await db.insert(schema.repos).values({
        owner: r.owner,
        name: r.name,
        url: `https://github.com/${r.owner}/${r.name}`,
        stars: r.stars,
        description: r.description,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      existing = await db.select().from(schema.repos)
        .where(and(eq(schema.repos.owner, r.owner), eq(schema.repos.name, r.name)))
        .get();
    }
    if (!existing) throw new Error(`failed to ensure repo ${r.owner}/${r.name}`);
    repoIds[`${r.owner}/${r.name}`] = existing.id;
  }

  // ── Triage events (agent decisions) ───────────────────────────────
  // Spread across the last ~10 days to feel like a real timeline.
  const day = 24 * 3600 * 1000;
  const triageRows = [
    {
      repo: "kvnang/workers-og",
      project: "tech-news-site",
      verdict: "adopt",
      score: 87,
      effortBand: "quick",
      oneLine: "Drops in for lib/social/imageRenderer.ts — ~30 min including a smoke test.",
      sessionId: "demo-session-1",
      ageDays: 1.5,
    },
    {
      repo: "roboflow/supervision",
      project: "sightline",
      verdict: "adopt",
      score: 92,
      effortBand: "quick",
      oneLine: "Replaces hand-rolled annotations.py (~180 LoC) with one import + ByteTrack upstream.",
      sessionId: "demo-session-2",
      ageDays: 3.2,
    },
    {
      repo: "tj/n",
      project: "sandbox-nextapp",
      verdict: "skip",
      score: 18,
      effortBand: "quick",
      oneLine: "Useful tool but unrelated to this project's runtime. Mention as awareness.",
      sessionId: "demo-session-3",
      ageDays: 5.1,
    },
    {
      repo: "antoine-coulon/skott",
      project: "sandbox-nextapp",
      verdict: "port",
      score: 64,
      effortBand: "moderate",
      oneLine: "Their circular-dep algorithm is what scripts/check-cycles.ts tries; copy the AST walk.",
      sessionId: "demo-session-3",
      ageDays: 5.1,
    },
    {
      repo: "garrytan/gstack",
      project: null,
      verdict: "skip",
      score: 12,
      effortBand: "deep",
      oneLine: "Claude Code config bundle — useful as inspiration but not drop-in for any project.",
      sessionId: "demo-session-4",
      ageDays: 7.4,
    },
    {
      repo: "vercel/turbo",
      project: "sandbox-nextapp",
      verdict: "defer",
      score: 41,
      effortBand: "deep",
      oneLine: "Worth revisiting once the project has 5+ packages. Single-package projects don't benefit.",
      sessionId: "demo-session-5",
      ageDays: 9.0,
    },
  ];

  for (const t of triageRows) {
    await db.insert(schema.triageEvents).values({
      userId: demo.id,
      repoId: repoIds[t.repo],
      projectId: t.project ? projectIds[t.project] : null,
      verdict: t.verdict,
      score: t.score,
      effortBand: t.effortBand,
      oneLine: t.oneLine,
      sessionId: t.sessionId,
      createdAt: new Date(now.getTime() - t.ageDays * day),
    });
  }
  console.log(`[seed-demo-skill] inserted ${triageRows.length} triage events`);

  // ── User actions ──────────────────────────────────────────────────
  // The demo user "actioned" some of the agent's adopt verdicts —
  // shows the full loop on the timeline.
  const userActions = [
    {
      repo: "kvnang/workers-og",
      project: "tech-news-site",
      status: "starred",
      ageDays: 1.4,
    },
    {
      repo: "kvnang/workers-og",
      project: "tech-news-site",
      status: "handed_off",
      handoffPrUrl: "https://github.com/replenhq/tech-news-site/pull/42",
      ageDays: 1.3,
    },
    {
      repo: "roboflow/supervision",
      project: "sightline",
      status: "starred",
      ageDays: 3.0,
    },
    {
      repo: "tj/n",
      project: "sandbox-nextapp",
      status: "hidden",
      ageDays: 5.0,
    },
  ];

  for (const a of userActions) {
    const surfacedAt = new Date(now.getTime() - (a.ageDays + 0.1) * day);
    const actionAt = new Date(now.getTime() - a.ageDays * day);
    await db.insert(schema.userMatchState).values({
      userId: demo.id,
      repoId: repoIds[a.repo],
      projectId: a.project ? projectIds[a.project] : null,
      status: a.status,
      surfacedAt,
      actionAt,
      handoffPrUrl: a.handoffPrUrl ?? null,
    });
  }
  console.log(`[seed-demo-skill] inserted ${userActions.length} user-action events`);

  console.log(`[seed-demo-skill] done.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
