import { db, schema } from "@/db/client";
import { desc, eq, gte, and, ne, inArray, notInArray, or, sql, isNull, isNotNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { createHandoff, runPipelineNow, setMatchFeedback, setMatchStatus, setPersonalNote } from "./actions";
import { requireUser } from "@/lib/auth/current-user";
import { sourceKind, sourceRank } from "@/lib/source-rank";
import { Icon } from "@/components/Icons";
import { LivePipelineProvider, LivePipelineChip, LivePipelineLog } from "@/components/LivePipelineStatus";
import { RefreshButton } from "@/components/RefreshButton";
import { InsightsStrip } from "@/components/InsightsStrip";
import { isDemoUser } from "@/lib/auth/demo-mode";
import { DemoMatchActions } from "@/components/DemoMatchActions";
import { DemoStreamerProvider, DemoStreamerButton, DemoStreamerLog } from "@/components/DemoStreamer";
import { SparseDocsCards, buildSparseProject, type SparseProject } from "@/components/SparseDocsCards";
import { assessDocSparsity } from "@/projects/self-improvement";
import { formatTimestampToMinute } from "@/lib/format-date";
import type { CSSProperties } from "react";

export const dynamic = "force-dynamic";

const DEFAULT_RELEVANCES = ["high", "medium", "general-awareness"];

export default async function Home({ searchParams }: { searchParams: Promise<{ rel?: string; days?: string; project?: string; discovery?: string; approach?: string }> }) {
  const user = await requireUser();
  // Send users without basic config to onboarding. Bypassed if they've ever
  // run a pipeline (returning visitor) - they might have just cleared their
  // settings temporarily.
  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, user.id)).get();
  const hasGithub = !!(settings?.githubToken || settings?.githubWriteToken);
  const hasLlm = !!(settings?.llmPrimaryApiKey || settings?.deepseekApiKey || settings?.anthropicApiKey || settings?.llmSensitiveApiKey);
  const everRan = await db
    .select({ id: schema.digestRuns.id })
    .from(schema.digestRuns)
    .where(eq(schema.digestRuns.userId, user.id))
    .get();
  // Onboarding gate: send to /welcome until the user has both keys + a
  // pipeline run on file. Email is no longer required (digest is opt-in
  // now; the dashboard is the primary surface).
  if (!everRan && (!hasGithub || !hasLlm)) {
    redirect("/welcome");
  }

  // Read last_viewed_at BEFORE updating it - anything newer is "new since
  // your last visit". Then stamp now-ish, so the next visit's banner only
  // covers what came in after this load.
  const userRow = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  const lastViewedAt = userRow?.lastViewedAt ?? null;
  await db.update(schema.users).set({ lastViewedAt: new Date() }).where(eq(schema.users.id, user.id));

  const sp = await searchParams;
  const relFilter = (sp.rel?.split(",").filter(Boolean) ?? DEFAULT_RELEVANCES) as string[];
  // 7d default — 2d was too narrow, frequently producing empty feeds for
  // anyone who only ran the pipeline yesterday.
  const days = Math.min(Math.max(parseInt(sp.days ?? "7", 10) || 7, 1), 30);
  const projectFilter = sp.project;
  const discoveryFilter = sp.discovery;
  const approachFilter = sp.approach;

  const since = new Date(Date.now() - days * 24 * 3600 * 1000);

  // Pre-fetch project ids the user has toggled off (excluded or
  // marked inactive) so we can hide any existing matches that point
  // at them. The pipeline already skips excluded projects from the
  // next run; this gates the feed view of HISTORICAL matches so
  // toggling a project off retroactively cleans up the dashboard.
  // _general / _unknown matches (project_id IS NULL) are not gated —
  // they aren't tied to any specific project.
  const hiddenProjects = await db
    .select({ id: schema.projectProfiles.id })
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, user.id),
      or(
        eq(schema.projectProfiles.included, false),
        eq(schema.projectProfiles.active, false),
      ),
    ));
  const hiddenProjectIds = hiddenProjects.map((p) => p.id);

  const conds = [
    eq(schema.matches.userId, user.id),
    gte(schema.matches.createdAt, since),
    ne(schema.matches.userStatus, "hidden"),
    isNull(schema.matches.archivedAt),
    inArray(schema.matches.relevance, relFilter),
  ];
  if (hiddenProjectIds.length > 0) {
    // Allow match through if its project is in the kept set OR if it has
    // no project (general-awareness / unmatched).
    conds.push(or(
      isNull(schema.matches.projectId),
      notInArray(schema.matches.projectId, hiddenProjectIds),
    )!);
  }
  if (projectFilter) {
    const p = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, user.id), eq(schema.projectProfiles.slug, projectFilter)))
      .get();
    if (p) conds.push(eq(schema.matches.projectId, p.id));
  }
  if (discoveryFilter) conds.push(eq(schema.matches.discoveryMode, discoveryFilter));
  if (approachFilter) conds.push(eq(schema.matches.integrationApproach, approachFilter));

  const matches = await db.select().from(schema.matches).where(and(...conds)).orderBy(desc(schema.matches.relevanceScore));
  // Batch-fetch repos + projects via IN(...) - avoids N+1 round-trips when a
  // run produces dozens of matches.
  const repoIds = [...new Set(matches.map((m) => m.repoId))];
  const projectIds = [...new Set(matches.map((m) => m.projectId).filter((x): x is number => !!x))];
  // For resurfaced rows, fetch the originating bookmark's createdAt so the
  // card can render "From your bookmarks — saved <date>".
  const resurfaceIds = [...new Set(matches.map((m) => m.resurfacedFromMatchId).filter((x): x is number => !!x))];
  const bookmarkDateById = new Map<number, Date>();
  if (resurfaceIds.length > 0) {
    const orig = await db
      .select({ id: schema.matches.id, createdAt: schema.matches.createdAt })
      .from(schema.matches)
      .where(inArray(schema.matches.id, resurfaceIds));
    for (const r of orig) bookmarkDateById.set(r.id, r.createdAt);
  }
  const repoMap = new Map<number, typeof schema.repos.$inferSelect>();
  if (repoIds.length > 0) {
    const rs = await db.select().from(schema.repos).where(inArray(schema.repos.id, repoIds));
    for (const r of rs) repoMap.set(r.id, r);
  }
  const projectMap = new Map<number, typeof schema.projectProfiles.$inferSelect>();
  if (projectIds.length > 0) {
    const ps = await db.select().from(schema.projectProfiles)
      .where(and(
        eq(schema.projectProfiles.userId, user.id),
        inArray(schema.projectProfiles.id, projectIds),
      ));
    for (const p of ps) projectMap.set(p.id, p);
  }
  // Find the source candidate for each repo so we can embed/link the original
  // post. Pick the highest-priority source per repo:
  //  tiktok > threads > reddit > hn > gh-trending.
  // Creator aliases let two handles (e.g. marc.caz on Threads, whitewhoadie on
  // TikTok) map to the same creator - if both surface the same repo, we pick
  // the higher-ranked source's post.
  const aliasRows = await db.select().from(schema.creatorAliases);
  const aliasMap = new Map<string, string>(); // "kind:value" → creator_key
  for (const a of aliasRows) aliasMap.set(`${a.kind}:${a.value.toLowerCase()}`, a.creatorKey);

  const candidateByRepoUrl = new Map<string, typeof schema.candidates.$inferSelect>();
  const repoUrls = [...repoMap.values()].map((r) => r.url);
  if (repoUrls.length > 0) {
    const cs = await db
      .select()
      .from(schema.candidates)
      .where(and(eq(schema.candidates.userId, user.id), inArray(schema.candidates.githubUrl, repoUrls)));
    // Sort: source-rank asc (lower = better), then postedAt desc (newer = better).
    // Creator aliases don't change this - they're collapsed implicitly: two
    // candidates from the same creator just both compete, and source-rank
    // picks the richer-media one.
    cs.sort((a, b) => {
      const ra = sourceRank(a.source);
      const rb = sourceRank(b.source);
      if (ra !== rb) return ra - rb;
      return (+b.postedAt! || 0) - (+a.postedAt! || 0);
    });
    for (const c of cs) {
      if (!c.githubUrl) continue;
      if (!candidateByRepoUrl.has(c.githubUrl)) candidateByRepoUrl.set(c.githubUrl, c);
    }
  }

  const counts = await db
    .select({ rel: schema.matches.relevance, c: sql<number>`count(*)` })
    .from(schema.matches)
    .where(and(eq(schema.matches.userId, user.id), gte(schema.matches.createdAt, since), ne(schema.matches.userStatus, "hidden")))
    .groupBy(schema.matches.relevance);
  const countMap = new Map(counts.map((r) => [r.rel, Number(r.c)]));

  // "N new since your last visit" banner - counts matches that arrived after
  // the previous lastViewedAt stamp. First-time visitors skip the banner
  // (lastViewedAt is null) since "new" would mean "everything", which is
  // noise rather than a signal.
  let newSinceVisit = 0;
  if (lastViewedAt) {
    const newRow = await db
      .select({ c: sql<number>`count(*)` })
      .from(schema.matches)
      .where(and(
        eq(schema.matches.userId, user.id),
        gte(schema.matches.createdAt, lastViewedAt),
        ne(schema.matches.userStatus, "hidden"),
      ))
      .get();
    newSinceVisit = Number(newRow?.c ?? 0);
  }

  // In-flight pipeline run for the refresh button. The action layer is the
  // authoritative gate; this just controls the visual state.
  const inFlightRun = await db
    .select({ id: schema.digestRuns.id, startedAt: schema.digestRuns.startedAt })
    .from(schema.digestRuns)
    .where(and(eq(schema.digestRuns.userId, user.id), isNull(schema.digestRuns.finishedAt)))
    .orderBy(desc(schema.digestRuns.id))
    .get();

  // Latest finished run — used both as the source for the terminal-failure
  // banner (when an LLM provider runs out of credits, etc.) and the "Last run"
  // timestamp shown beside the Refresh button so the user can tell how fresh
  // the feed is without checking /runs.
  const latestRun = await db
    .select({
      id: schema.digestRuns.id,
      pausedReason: schema.digestRuns.pausedReason,
      startedAt: schema.digestRuns.startedAt,
      finishedAt: schema.digestRuns.finishedAt,
      candidatesFound: schema.digestRuns.candidatesFound,
      matchesCreated: schema.digestRuns.matchesCreated,
    })
    .from(schema.digestRuns)
    .where(and(eq(schema.digestRuns.userId, user.id), isNotNull(schema.digestRuns.finishedAt)))
    .orderBy(desc(schema.digestRuns.id))
    .get();
  const quotaSlot = parseQuotaReason(latestRun?.pausedReason ?? null);
  const lastRunAt = latestRun?.finishedAt ?? null;

  // Audit chip seed: most recent run (in-flight wins over completed)
  // events so the chip surfaces on a fresh page load without waiting
  // for the first poll. Capped to the last 80 events — the streamer
  // ring-buffers in-memory anyway, this just hydrates a sensible
  // history window for the audit popup.
  const auditRun = inFlightRun
    ? { id: inFlightRun.id, startedAt: inFlightRun.startedAt, finishedAt: null as Date | null, candidatesFound: null as number | null, matchesCreated: null as number | null }
    : latestRun;
  const auditEvents = auditRun
    ? (await db
        .select({
          id: schema.pipelineEvents.id,
          kind: schema.pipelineEvents.kind,
          message: schema.pipelineEvents.message,
          createdAt: schema.pipelineEvents.createdAt,
        })
        .from(schema.pipelineEvents)
        .where(eq(schema.pipelineEvents.runId, auditRun.id))
        .orderBy(desc(schema.pipelineEvents.id))
        .limit(80)).reverse()
    : [];

  // Initiative #3: load synthesised insights for the same window as the
  // feed (last `days` days). Starred sort first, then newest unread. The
  // strip is hidden entirely when there are none.
  const insightsSince = new Date(Date.now() - days * 24 * 3600 * 1000);
  const insightRows = await db
    .select()
    .from(schema.matchInsights)
    .where(and(
      eq(schema.matchInsights.userId, user.id),
      gte(schema.matchInsights.createdAt, insightsSince),
      ne(schema.matchInsights.userStatus, "hidden"),
    ))
    .orderBy(
      sql`CASE ${schema.matchInsights.userStatus} WHEN 'starred' THEN 0 ELSE 1 END`,
      desc(schema.matchInsights.createdAt),
    );
  // Hydrate each insight's evidence (owner/name/project) by batch-loading
  // the cited matches. Keeps the strip cheap: one round-trip even when
  // there are many insights.
  const evidenceIds = [...new Set(
    insightRows.flatMap((i) => {
      try { return (JSON.parse(i.evidenceMatchIds) as number[]).filter((n) => Number.isFinite(n)); }
      catch { return [] as number[]; }
    }),
  )];
  const evidenceById = new Map<number, { id: number; repoOwner: string; repoName: string; projectSlug: string | null }>();
  if (evidenceIds.length > 0) {
    const evRows = await db
      .select({
        id: schema.matches.id,
        repoOwner: schema.repos.owner,
        repoName: schema.repos.name,
        projectId: schema.matches.projectId,
      })
      .from(schema.matches)
      .innerJoin(schema.repos, eq(schema.matches.repoId, schema.repos.id))
      .where(and(
        eq(schema.matches.userId, user.id),
        inArray(schema.matches.id, evidenceIds),
      ));
    // Map projectId -> slug from the projects already loaded above. But
    // projectMap is keyed off the *current feed window*, not insights —
    // an evidence match could be older than the current `days` filter,
    // so we resolve its slug from a fresh per-user lookup.
    const evidenceProjectIds = [...new Set(evRows.map((r) => r.projectId).filter((x): x is number => !!x))];
    const slugById = new Map<number, string>();
    if (evidenceProjectIds.length > 0) {
      const ps = await db
        .select({ id: schema.projectProfiles.id, slug: schema.projectProfiles.slug })
        .from(schema.projectProfiles)
        .where(and(
          eq(schema.projectProfiles.userId, user.id),
          inArray(schema.projectProfiles.id, evidenceProjectIds),
        ));
      for (const p of ps) slugById.set(p.id, p.slug);
    }
    for (const r of evRows) {
      evidenceById.set(r.id, {
        id: r.id,
        repoOwner: r.repoOwner,
        repoName: r.repoName,
        projectSlug: r.projectId ? slugById.get(r.projectId) ?? null : null,
      });
    }
  }
  // Sparse-docs feed cards: list every active+included project whose
  // README/CLAUDE.md combo is too thin to drive accurate matching, so
  // the user can issue a docs-improvement PR right from the feed instead
  // of having to remember to visit /projects after seeing the streamer
  // line scroll past. Same assessment the streamer uses; one query,
  // pure-CPU.
  const userActiveProjects = await db
    .select({
      id: schema.projectProfiles.id,
      slug: schema.projectProfiles.slug,
      name: schema.projectProfiles.name,
      readmeMd: schema.projectProfiles.readmeMd,
      claudeMd: schema.projectProfiles.claudeMd,
      githubFullName: schema.projectProfiles.githubFullName,
    })
    .from(schema.projectProfiles)
    .where(and(
      eq(schema.projectProfiles.userId, user.id),
      eq(schema.projectProfiles.active, true),
      eq(schema.projectProfiles.included, true),
    ));
  const sparseProjects: SparseProject[] = [];
  for (const p of userActiveProjects) {
    const a = assessDocSparsity({ readmeMd: p.readmeMd, claudeMd: p.claudeMd });
    if (a.sparse) sparseProjects.push(buildSparseProject(p, a.reasons));
  }
  sparseProjects.sort((a, b) => a.slug.localeCompare(b.slug));

  const insights = insightRows.map((i) => {
    let ids: number[] = [];
    try { ids = (JSON.parse(i.evidenceMatchIds) as number[]).filter((n) => Number.isFinite(n)); }
    catch { /* ignore */ }
    return {
      ...i,
      evidence: ids.map((id) => evidenceById.get(id)).filter((x): x is NonNullable<typeof x> => !!x),
    };
  });

  // Group matches by project slug - matches the email digest layout. Order
  // groups by max relevanceScore so the highest-conviction project goes first.
  const groups = new Map<string, typeof matches>();
  for (const m of matches) {
    const slug = m.projectId ? projectMap.get(m.projectId)?.slug ?? "_unknown" : "_general";
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug)!.push(m);
  }
  // Project-specific groups first, ordered by best score within the group.
  // _general (and _unknown) always pinned to the bottom - they're awareness,
  // not project-fit.
  const orderedGroups = [...groups.entries()].sort((a, b) => {
    const aGen = a[0] === "_general" || a[0] === "_unknown";
    const bGen = b[0] === "_general" || b[0] === "_unknown";
    if (aGen !== bGen) return aGen ? 1 : -1;
    const sa = Math.max(...a[1].map((m) => m.relevanceScore ?? 0));
    const sb = Math.max(...b[1].map((m) => m.relevanceScore ?? 0));
    return sb - sa;
  });

  const demoMode = isDemoUser(user);

  const feedBody = (
    <>
      <div className="feed-header">
        <h1 className="feed-title">
          What could you make better today<span style={{ color: "var(--amber)" }}>?</span>
        </h1>
        <div className="feed-header-actions">
          {demoMode ? (
            <DemoStreamerButton />
          ) : (
            <form action={runPipelineNow}>
              <RefreshButton inFlightAt={inFlightRun?.startedAt?.toISOString() ?? null} />
            </form>
          )}
          <div className="meta" style={{ fontSize: 12 }}>
            {lastRunAt
              ? `Last run: ${formatTimestampToMinute(lastRunAt)}`
              : "No runs yet"}
            {!demoMode && <LivePipelineChip />}
          </div>
        </div>
      </div>
      {demoMode && <DemoStreamerLog />}
      {!demoMode && <LivePipelineLog />}
      {quotaSlot && !inFlightRun && (
        <div
          role="alert"
          style={{
            margin: "12px 0",
            padding: "12px 16px",
            background: "rgba(255, 99, 99, 0.08)",
            border: "1px solid rgba(255, 99, 99, 0.35)",
            borderRadius: 10,
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <strong>{quotaSlot === "primary" ? "Primary" : "Sensitive"} LLM is out of credits.</strong>{" "}
          Your last run stopped because the provider returned an insufficient-balance response. Top up the API key&apos;s balance with your provider, or rotate to a different provider on <a href="/settings">/settings</a>, then hit <b>Refresh</b>.
        </div>
      )}
      {newSinceVisit > 0 && (
        <div style={{
          margin: "8px 0 12px", padding: "6px 12px",
          background: "var(--amber-soft)", border: "1px solid var(--amber-line)",
          borderRadius: 8, fontSize: 13, display: "inline-block", color: "var(--amber)",
        }}>
          {newSinceVisit} new {newSinceVisit === 1 ? "match" : "matches"} since your last visit
        </div>
      )}
      <SparseDocsCards projects={sparseProjects} />
      <InsightsStrip insights={insights} />
      <FilterBar
        relFilter={relFilter}
        days={days}
        projectFilter={projectFilter}
        discoveryFilter={discoveryFilter}
        approachFilter={approachFilter}
        countMap={countMap}
      />
      <p className="meta">{matches.length} matches shown · {orderedGroups.length} projects · window: last {days}d</p>
      {matches.length === 0 && (
        <p>No matches in this window. Try widening the day filter, or click <b>Refresh</b> above to run the pipeline now.</p>
      )}
      {orderedGroups.map(([slug, list]) => {
        const project = list[0].projectId ? projectMap.get(list[0].projectId) : null;
        // Initiative #1 visibility: show an "⚡ matched against current work"
        // pill on cards in projects whose activity probe is currently in the
        // "active" state. Tells the user that the reasoner had real
        // current-work context to grade against (not just the static README).
        const activityActive = (() => {
          if (!project?.activityJson) return false;
          try {
            const a = JSON.parse(project.activityJson) as { state?: string };
            return a.state === "active";
          } catch { return false; }
        })();
        const isGeneral = slug === "_general" || slug === "_unknown";
        // _general / _unknown rolled up into a collapsed details - these are
        // "keep on the radar" rather than today's actionable matches, so they
        // shouldn't dominate the visual weight of the page.
        const displaySlug = slug === "_general" ? "Future awareness · keep on the radar"
          : slug === "_unknown" ? "Unmatched"
          : slug;
        const inner = (
          <>
            {!isGeneral && (
              <h2 style={{ borderBottom: "1px solid #ccc4", paddingBottom: 4, marginBottom: 4 }}>
                <a href={`/?project=${slug}`} style={{ color: "inherit", textDecoration: "none" }}>{slug}</a>
                <span className="meta" style={{ marginLeft: 8, fontWeight: 400 }}>
                  {list.length} {list.length === 1 ? "match" : "matches"}
                  {project?.sensitivity === "high" && (
                    <> · <span style={{ display: "inline-flex", verticalAlign: "middle", marginRight: 2 }}><Icon name="shield" size={12} /></span>sensitive</>
                  )}
                </span>
              </h2>
            )}
            {list.map((m) => {
              const repo = repoMap.get(m.repoId);
              if (!repo) return null;
              const writeup = (m.writeupMd ?? "").split("\n\n- - -\n")[0]?.trim() || m.summary || "";
              const candidate = candidateByRepoUrl.get(repo.url);
              // Source attribution: prefer the denormalised match.sourceKind
              // (set at insert time), fall back to deriving it from the picked
              // candidate for rows from before the migration.
              const srcKind = m.sourceKind ?? (candidate ? sourceKind(candidate.source) : null);
              const isGA = m.relevance === "general-awareness";
              const isStarred = m.userStatus === "starred";
              const isBookmarked = m.userStatus === "bookmarked";
              const isSaved = isStarred || isBookmarked;
              const canHandoff = isStarred && !m.handoffPrUrl && !!project;
              const bookmarkDate = m.resurfacedFromMatchId ? bookmarkDateById.get(m.resurfacedFromMatchId) : null;
              return (
                <div className="match" key={m.id}>
                  <div className="match-head">
                    {/* Project tag FIRST so the user immediately sees which
                        of their projects this match relates to, before
                        the repo name. _general / _unknown groups don't get
                        a tag (slug isn't meaningful). */}
                    {project && (
                      <a
                        href={`/?project=${slug}`}
                        className="tag project-tag"
                        title={`Show only ${slug} matches`}
                      >
                        <Icon name="folder" /> {slug}
                      </a>
                    )}
                    {project && activityActive && (
                      <a
                        href={`/projects/${slug}`}
                        className="tag"
                        style={{ background: "var(--amber-soft)", color: "var(--amber)", borderColor: "var(--amber-line)", textDecoration: "none" }}
                        title="This project had live activity context (recent commits/PRs/TODOs) when the match was scored. The reasoner graded this repo against what you're currently building, not just the static README."
                      >
                        <Icon name="zap" /> vs current work
                      </a>
                    )}
                    <a className="repo" href={repo.url} target="_blank" rel="noreferrer">{repo.owner}/{repo.name}</a>
                    <span className={`tag ${m.relevance}`}>{m.relevance} {m.relevanceScore ?? ""}</span>
                    {m.discoveryMode === "re-checked" && bookmarkDate && (
                      <a
                        href="/?discovery=re-checked"
                        className="tag"
                        style={{ background: "#eef6ff", color: "#1d4ed8", textDecoration: "none" }}
                        title="Re-checked from your bookmarks. Click to show only re-checked matches."
                      >
                        Re-checked — saved {bookmarkDate.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                      </a>
                    )}
                    {m.discoveryMode === "discovered" && (
                      <a
                        href="/?discovery=discovered"
                        className="tag"
                        style={{ background: "#fff7ed", color: "#9a3412", textDecoration: "none" }}
                        title="Found via a broad-net feed (GitHub trending, HN, Reddit, etc.). Click to show only discovered matches."
                      >
                        Discovered
                      </a>
                    )}
                    {m.discoveryMode === "scouted" && m.matchedOutcome && (
                      <a
                        href="/?discovery=scouted"
                        className="tag"
                        style={{ background: "#ecfdf5", color: "#065f46", textDecoration: "none" }}
                        title="Surfaced by a niche GitHub search Replen ran for this project. Click to show only scouted matches."
                      >
                        Scouted
                      </a>
                    )}
                    {m.discoveryMode === "prune" && (
                      <a
                        href="/?discovery=prune"
                        className="tag"
                        style={{ background: "#fef2f2", color: "#991b1b", textDecoration: "none" }}
                        title="Flagged dependency: Replen detected this dep is stale, dead, or archived upstream. Click to show only prune suggestions."
                      >
                        🪓 Prune
                      </a>
                    )}
                    {/* For prune matches, show the target dep + action prominently so
                        the user can scan "drop moment" vs "replace moment with date-fns"
                        at a glance. This pill goes right after the Prune badge. */}
                    {m.discoveryMode === "prune" && m.prunedDepName && (
                      <span
                        className="tag"
                        style={{ background: "rgba(255,255,255,0.04)", color: "var(--dim)", fontFamily: "ui-monospace, monospace" }}
                        title={`Ecosystem: ${m.prunedDepEcosystem ?? "?"}${m.prunedDepVersion ? ` · constraint: ${m.prunedDepVersion}` : ""}`}
                      >
                        {m.prunedDepAction === "replace" ? "replace" : "drop"} <strong style={{ color: "var(--fg)" }}>{m.prunedDepName}</strong>
                      </span>
                    )}
                    {/* Suppress "via gh-targeted" — redundant with the Scouted pill.
                        For discovered/re-checked, the source (gh-trending / hn / tiktok / etc.) is
                        actually useful information so keep showing it. */}
                    {srcKind && srcKind !== "gh-targeted" && <span className="tag">via {srcKind}</span>}
                    {m.integrationApproach && m.integrationApproach !== "n/a" && (
                      <a
                        href={`/?approach=${m.integrationApproach}`}
                        className="tag"
                        style={{ ...integrationApproachStyle(m.integrationApproach), textDecoration: "none" }}
                        title={`${integrationApproachTitle(m.integrationApproach)} · Click to show only this approach.`}
                      >
                        {integrationApproachLabel(m.integrationApproach)}
                      </a>
                    )}
                    <span className="meta">{repo.stars ?? 0}★ · {repo.primaryLanguage ?? "?"} · {repo.license ?? "no license"}</span>
                  </div>
                  <div className="writeup">{writeup}</div>
                  {candidate && <SourcePost candidate={candidate} />}
                  <PersonalNote matchId={m.id} value={m.personalNote ?? ""} />
                  {demoMode ? (
                    <DemoMatchActions isGA={isGA} hasProject={!!project} />
                  ) : (
                  <div className="actions">
                    <>
                    {/* Primary path differs by relevance:
                          high/medium → "Star & open handoff PR"
                          general-awareness → "Bookmark for later" (no handoff;
                          the system will re-evaluate against your projects
                          every 20 days — see resurface logic). */}
                    {!isSaved && !isGA && (
                      <form className="inline" action={async () => { "use server"; await setMatchStatus(m.id, "starred"); }}>
                        <button className="primary" type="submit" title="Star to open a handoff PR in your project's repo">
                          <Icon name="star" /> Star &amp; open handoff PR
                        </button>
                      </form>
                    )}
                    {!isSaved && isGA && (
                      <form className="inline" action={async () => { "use server"; await setMatchStatus(m.id, "bookmarked"); }}>
                        <button className="primary" type="submit" title="Bookmark for later — Replen will re-check this against your projects every 20 days">
                          <Icon name="bookmark" /> Bookmark for later
                        </button>
                      </form>
                    )}
                    {canHandoff && (
                      <form className="inline" action={async () => { "use server"; await createHandoff(m.id); }}>
                        <button className="primary" type="submit" title={`Open a PR in this project's repo with handoff notes for ${repo.owner}/${repo.name}`}>
                          <Icon name="arrow-right" /> Open handoff PR
                        </button>
                      </form>
                    )}
                    {isSaved && (
                      <form className="inline" action={async () => { "use server"; await setMatchStatus(m.id, "unread"); }}>
                        <button type="submit" title={isBookmarked ? "Remove bookmark" : "Unstar"}>
                          <Icon name={isBookmarked ? "bookmark-fill" : "star-fill"} /> {isBookmarked ? "Bookmarked" : "Starred"}
                        </button>
                      </form>
                    )}
                    {m.handoffPrUrl && (
                      <a className="btn selected" href={m.handoffPrUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                        <Icon name="external" /> Handoff PR
                      </a>
                    )}
                    <form className="inline" action={async () => { "use server"; await setMatchFeedback(m.id, m.userFeedback === "good" ? "clear" : "good"); }}>
                      <button type="submit" className={m.userFeedback === "good" ? "selected" : ""} title="Useful (feeds source ranking)" aria-label="Useful">
                        <Icon name="thumbs-up" />
                      </button>
                    </form>
                    <form className="inline" action={async () => { "use server"; await setMatchFeedback(m.id, m.userFeedback === "bad" ? "clear" : "bad"); }}>
                      <button type="submit" className={m.userFeedback === "bad" ? "selected" : ""} title="Not useful (feeds source ranking)" aria-label="Not useful">
                        <Icon name="thumbs-down" />
                      </button>
                    </form>
                    <span className="spacer" />
                    <form className="inline" action={async () => { "use server"; await setMatchStatus(m.id, "hidden"); }}>
                      <button type="submit" className="ghost" title="Hide this match">
                        <Icon name="hide" /> Hide
                      </button>
                    </form>
                    </>
                  </div>
                  )}
                </div>
              );
            })}
          </>
        );
        return (
          <section key={slug} style={{ marginTop: 32 }}>
            {isGeneral ? (
              <details>
                <summary style={{ cursor: "pointer", padding: "6px 0", fontWeight: 600, fontSize: 16 }}>
                  {displaySlug}
                  <span className="meta" style={{ marginLeft: 8, fontWeight: 400 }}>
                    {list.length} {list.length === 1 ? "item" : "items"} · click to expand
                  </span>
                </summary>
                <div style={{ marginTop: 8 }}>{inner}</div>
              </details>
            ) : inner}
          </section>
        );
      })}
    </>
  );

  // In demo mode wrap with the streamer provider so the header button
  // and the log strip below share the same start/state. For the real
  // app wrap with LivePipelineProvider so the inline ⓘ chip in the
  // header and the audit log share polling + expand state.
  if (demoMode) {
    return <DemoStreamerProvider>{feedBody}</DemoStreamerProvider>;
  }
  return (
    <LivePipelineProvider
      // Key on the run id so React remounts (resets useState) when a
      // new run starts. The auditRun is in-flight if one exists, else
      // the most recent finished — the chip needs both shapes seeded.
      key={(inFlightRun?.id ?? latestRun?.id) ?? "idle"}
      initial={{
        inFlight: !!inFlightRun,
        runId: auditRun?.id,
        startedAt: auditRun?.startedAt?.toISOString(),
        finishedAt: auditRun?.finishedAt?.toISOString(),
        candidates: Number(auditRun?.candidatesFound ?? 0),
        matches: Number(auditRun?.matchesCreated ?? 0),
        events: auditEvents.map((e) => ({
          id: e.id,
          kind: e.kind as "fetch_start" | "fetch_done" | "scan" | "skip" | "triage_skip" | "reason" | "match" | "error",
          message: e.message,
          createdAt: e.createdAt.toISOString(),
        })),
      }}
    >
      {feedBody}
    </LivePipelineProvider>
  );
}

// pausedReason values used for quota failures look like `llm-quota:primary` or
// `llm-quota:sensitive`. Returns the slot name or null if this is some other
// kind of pause (cost-cap, no-candidates, etc.).
// integrationApproach badges give the user a one-glance read of HOW to extract
// value from a match — drop-in vs. cherry-pick vs. study-and-rebuild. The
// cleanroom-rebuild case is the one that's been historically under-served:
// when a repo's ideas are good but the code itself won't transfer, the user
// still wants to know it's worth a look.
function integrationApproachLabel(a: string | null): string {
  switch (a) {
    case "depend-on-it": return "🔌 Drop-in";
    case "cherry-pick": return "✂️ Cherry-pick";
    case "vendor": return "📦 Vendor";
    case "cleanroom-rebuild": return "💡 Rebuild in-house";
    default: return "";
  }
}
function integrationApproachTitle(a: string | null): string {
  switch (a) {
    case "depend-on-it": return "Import this repo directly — lightest touch integration";
    case "cherry-pick": return "Lift specific files / functions from this repo into your project";
    case "vendor": return "Copy the repo in-tree and adapt it as needed";
    case "cleanroom-rebuild": return "The IDEA is worth lifting — write your own version, no code transferred";
    default: return "";
  }
}
function integrationApproachStyle(a: string | null): CSSProperties {
  switch (a) {
    case "cleanroom-rebuild": return { background: "#fef3c7", color: "#92400e" };
    case "cherry-pick": return { background: "#ddd6fe", color: "#5b21b6" };
    case "depend-on-it": return { background: "#d1fae5", color: "#065f46" };
    case "vendor": return { background: "#e0e7ff", color: "#3730a3" };
    default: return {};
  }
}

function parseQuotaReason(reason: string | null): "primary" | "sensitive" | null {
  if (!reason) return null;
  if (reason.startsWith("llm-quota:primary")) return "primary";
  if (reason.startsWith("llm-quota:sensitive")) return "sensitive";
  return null;
}

function PersonalNote({ matchId, value }: { matchId: number; value: string }) {
  // Collapsed by default unless there's already a note - pinning it open when
  // there's content saves a click to remind yourself why you flagged it.
  return (
    <details open={!!value} style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, color: "#666", display: "flex", alignItems: "center", gap: 4 }}>
        <Icon name="pencil" size={12} />
        {value ? "note (saved)" : "add a personal note"}
      </summary>
      <form
        action={async (form: FormData) => {
          "use server";
          await setPersonalNote(matchId, (form.get("note") as string) ?? "");
        }}
        style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "flex-start" }}
      >
        <textarea
          name="note"
          defaultValue={value}
          rows={2}
          maxLength={2000}
          placeholder="e.g. revisit when we start the import-pipeline rewrite"
          style={{ flex: 1, padding: 6, fontSize: 13, fontFamily: "inherit" }}
        />
        <button type="submit" style={{ padding: "6px 12px", fontSize: 13 }}>save</button>
      </form>
    </details>
  );
}

function SourcePost({ candidate }: { candidate: typeof schema.candidates.$inferSelect }) {
  const src = candidate.source;
  // Threads embed - inline iframe.
  if (src.startsWith("threads:")) {
    const handle = src.slice("threads:".length);
    const code = candidate.url.match(/threads\.com\/(?:@[^/]+\/post|t)\/([A-Za-z0-9_-]+)/)?.[1] ?? candidate.sourceItemId;
    const embedUrl = `https://www.threads.com/t/${code}/embed`;
    return (
      <div style={{ marginTop: 10 }}>
        <p className="meta" style={{ margin: "0 0 6px" }}>
          source: threads · <a href={candidate.url} target="_blank" rel="noreferrer">@{handle}</a>
        </p>
        <iframe
          src={embedUrl}
          loading="lazy"
          // sandbox keeps the embed from navigating the parent or coercing
          // top-level navigation. allow-scripts/allow-same-origin are needed
          // for video playback; allow-popups lets "open original" links work.
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
          referrerPolicy="no-referrer-when-downgrade"
          allow="autoplay; encrypted-media; clipboard-write"
          allowFullScreen
          style={{ width: "100%", maxWidth: 540, height: 720, border: "1px solid #ccc4", borderRadius: 6, background: "#fff" }}
        />
      </div>
    );
  }
  // TikTok embed - same pattern, different aspect ratio (portrait video).
  if (src.startsWith("tiktok:")) {
    const handle = src.slice("tiktok:".length);
    const videoId = candidate.url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/)?.[1] ?? candidate.sourceItemId;
    const embedUrl = `https://www.tiktok.com/embed/v2/${videoId}`;
    return (
      <div style={{ marginTop: 10 }}>
        <p className="meta" style={{ margin: "0 0 6px" }}>
          source: tiktok · <a href={candidate.url} target="_blank" rel="noreferrer">@{handle}</a>
        </p>
        <iframe
          src={embedUrl}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
          referrerPolicy="no-referrer-when-downgrade"
          allow="autoplay; encrypted-media; clipboard-write"
          allowFullScreen
          style={{ width: "100%", maxWidth: 340, height: 740, border: "1px solid #ccc4", borderRadius: 6, background: "#000" }}
        />
      </div>
    );
  }
  // HN / Reddit / other - just a link.
  const label = src.startsWith("reddit:") ? `reddit · r/${src.slice("reddit:".length)}` : src;
  return (
    <p className="meta" style={{ marginTop: 8 }}>
      source: <a href={candidate.url} target="_blank" rel="noreferrer">{label}</a>
    </p>
  );
}

function FilterBar({ relFilter, days, projectFilter, discoveryFilter, approachFilter, countMap }: {
  relFilter: string[];
  days: number;
  projectFilter?: string;
  discoveryFilter?: string;
  approachFilter?: string;
  countMap: Map<string, number>;
}) {
  // "low" dropped — never a valid relevance value (high/medium/general-awareness only).
  const allRels = ["high", "medium", "general-awareness"] as const;
  // Build a URL with the current filters as a base, then merge overrides.
  // Empty-string in override clears the param.
  const make = (overrides: Record<string, string | string[]>) => {
    const qs = new URLSearchParams();
    qs.set("rel", relFilter.join(","));
    qs.set("days", String(days));
    if (projectFilter) qs.set("project", projectFilter);
    if (discoveryFilter) qs.set("discovery", discoveryFilter);
    if (approachFilter) qs.set("approach", approachFilter);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === "" || (Array.isArray(v) && v.length === 0)) qs.delete(k);
      else qs.set(k, Array.isArray(v) ? v.join(",") : v);
    }
    return `/?${qs.toString()}`;
  };
  const allRelsActive = allRels.every((r) => relFilter.includes(r));
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "8px 0 16px", fontSize: 13 }}>
      {allRels.map((r) => {
        // Solo-toggle: clicking a tier focuses on just that tier. Clicking
        // again clears the filter back to "all tiers shown". Much closer to
        // what users expect than the previous additive toggle.
        const isSolo = relFilter.length === 1 && relFilter[0] === r;
        const isActive = allRelsActive || isSolo;
        const next = isSolo ? [...allRels] : [r];
        return (
          <a
            key={r}
            href={make({ rel: next })}
            className={`tag ${r}`}
            style={{ opacity: isActive ? 1 : 0.4, textDecoration: "none" }}
            title={isSolo ? `Showing only ${r} — click to show all tiers` : `Show only ${r} matches`}
          >
            {r} ({countMap.get(r) ?? 0})
          </a>
        );
      })}
      {!allRelsActive && (
        <a href={make({ rel: [...allRels] })} className="meta" style={{ fontSize: 12, textDecoration: "underline", opacity: 0.7 }}>
          show all
        </a>
      )}

      <span style={{ marginLeft: "auto", opacity: 0.55, fontSize: 12 }}>last</span>
      <div style={{ display: "inline-flex", gap: 2, padding: 2, background: "rgba(0,0,0,0.25)", border: "1px solid var(--line-strong, rgba(255,255,255,0.1))", borderRadius: 999 }}>
        {[1, 2, 7, 30].map((d) => (
          <a
            key={d}
            href={make({ days: String(d) })}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              textDecoration: "none",
              fontSize: 12,
              fontWeight: d === days ? 600 : 400,
              background: d === days ? "var(--fg)" : "transparent",
              color: d === days ? "var(--bg)" : "inherit",
              transition: "background 0.15s",
            }}
            title={`Last ${d} day${d === 1 ? "" : "s"}`}
          >
            {d}d
          </a>
        ))}
      </div>

      {(projectFilter || discoveryFilter || approachFilter) && (
        <div style={{ flexBasis: "100%", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 2 }}>
          <span className="meta" style={{ fontSize: 12 }}>active filters:</span>
          {projectFilter && (
            <a href={make({ project: "" })} className="tag" style={{ textDecoration: "none" }}>
              project: {projectFilter} ✕
            </a>
          )}
          {discoveryFilter && (
            <a href={make({ discovery: "" })} className="tag" style={{ textDecoration: "none" }}>
              source: {discoveryFilter} ✕
            </a>
          )}
          {approachFilter && (
            <a href={make({ approach: "" })} className="tag" style={{ textDecoration: "none" }}>
              approach: {approachFilter} ✕
            </a>
          )}
        </div>
      )}
    </div>
  );
}
