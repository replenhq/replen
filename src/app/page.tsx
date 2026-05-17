import { db, schema } from "@/db/client";
import { desc, eq, gte, and, ne, inArray, sql, isNull, isNotNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { createHandoff, runPipelineNow, setMatchFeedback, setMatchStatus, setPersonalNote } from "./actions";
import { requireUser } from "@/lib/auth/current-user";
import { sourceKind, sourceRank } from "@/lib/source-rank";
import { LocalTime } from "@/components/LocalTime";
import { Icon } from "@/components/Icons";
import { LivePipelineStatus } from "@/components/LivePipelineStatus";
import { RefreshButton } from "@/components/RefreshButton";
import { formatTimestampToMinute } from "@/lib/format-date";

export const dynamic = "force-dynamic";

const DEFAULT_RELEVANCES = ["high", "medium", "general-awareness"];

export default async function Home({ searchParams }: { searchParams: Promise<{ rel?: string; days?: string; project?: string }> }) {
  const user = await requireUser();
  // Send users without basic config to onboarding. Bypassed if they've ever
  // run a pipeline (returning visitor) - they might have just cleared their
  // settings temporarily.
  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, user.id)).get();
  const hasGithub = !!(settings?.githubToken || settings?.githubWriteToken);
  const hasEmail = !!settings?.emailToAddress;
  const everRan = await db
    .select({ id: schema.digestRuns.id })
    .from(schema.digestRuns)
    .where(eq(schema.digestRuns.userId, user.id))
    .get();
  if (!everRan && (!hasGithub || !hasEmail)) {
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
  const days = Math.min(Math.max(parseInt(sp.days ?? "2", 10) || 2, 1), 30);
  const projectFilter = sp.project;

  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const conds = [
    eq(schema.matches.userId, user.id),
    gte(schema.matches.createdAt, since),
    ne(schema.matches.userStatus, "hidden"),
    isNull(schema.matches.archivedAt),
    inArray(schema.matches.relevance, relFilter),
  ];
  if (projectFilter) {
    const p = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, user.id), eq(schema.projectProfiles.slug, projectFilter)))
      .get();
    if (p) conds.push(eq(schema.matches.projectId, p.id));
  }

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
    .select({ id: schema.digestRuns.id, pausedReason: schema.digestRuns.pausedReason, finishedAt: schema.digestRuns.finishedAt })
    .from(schema.digestRuns)
    .where(and(eq(schema.digestRuns.userId, user.id), isNotNull(schema.digestRuns.finishedAt)))
    .orderBy(desc(schema.digestRuns.id))
    .get();
  const quotaSlot = parseQuotaReason(latestRun?.pausedReason ?? null);
  const lastRunAt = latestRun?.finishedAt ?? null;

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

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <h1 style={{ margin: 0, flex: 1 }}>Your feed</h1>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <form action={runPipelineNow}>
            <RefreshButton inFlightAt={inFlightRun?.startedAt?.toISOString() ?? null} />
          </form>
          <div className="meta" style={{ fontSize: 12 }}>
            {lastRunAt
              ? `Last run: ${formatTimestampToMinute(lastRunAt)}`
              : "No runs yet"}
          </div>
        </div>
      </div>
      <LivePipelineStatus
        initial={{
          inFlight: !!inFlightRun,
          runId: inFlightRun?.id,
          startedAt: inFlightRun?.startedAt?.toISOString(),
          candidates: 0,
          matches: 0,
          events: [],
        }}
      />
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
      <FilterBar relFilter={relFilter} days={days} projectFilter={projectFilter} countMap={countMap} />
      <p className="meta">{matches.length} matches shown · {orderedGroups.length} projects · window: last {days}d</p>
      {matches.length === 0 && (
        <p>No matches in this window. Try widening the day filter, or click <b>Refresh</b> above to run the pipeline now.</p>
      )}
      {orderedGroups.map(([slug, list]) => {
        const project = list[0].projectId ? projectMap.get(list[0].projectId) : null;
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
                  {project?.sensitivity === "high" && " · 🔒 sensitive"}
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
                    <a className="repo" href={repo.url} target="_blank" rel="noreferrer">{repo.owner}/{repo.name}</a>
                    <span className={`tag ${m.relevance}`}>{m.relevance} {m.relevanceScore ?? ""}</span>
                    {m.discoveryMode === "bookmark" && bookmarkDate && (
                      <span className="tag" style={{ background: "#eef6ff", color: "#1d4ed8" }} title="Resurfaced from your bookmarks — Replen re-checks bookmarked repos against your projects every 20 days">
                        From your bookmarks — saved {bookmarkDate.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                      </span>
                    )}
                    {m.discoveryMode === "serendipity" && (
                      <span className="tag" style={{ background: "#fff7ed", color: "#9a3412" }} title="Surfaced by a broad-net feed (HN, reddit, trending, etc.) — not tied to a specific outcome you've stated">
                        Serendipity
                      </span>
                    )}
                    {m.discoveryMode === "targeted" && m.matchedOutcome && (
                      <span className="tag" style={{ background: "#ecfdf5", color: "#065f46" }} title="Matched a specific outcome you stated for this project">
                        Targeted
                      </span>
                    )}
                    {srcKind && <span className="tag">via {srcKind}</span>}
                    <span className="meta">{repo.stars ?? 0}★ · {repo.primaryLanguage ?? "?"} · {repo.license ?? "no license"}</span>
                  </div>
                  <div className="writeup">{writeup}</div>
                  {candidate && <SourcePost candidate={candidate} />}
                  <PersonalNote matchId={m.id} value={m.personalNote ?? ""} />
                  <div className="actions">
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
                  </div>
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
}

// pausedReason values used for quota failures look like `llm-quota:primary` or
// `llm-quota:sensitive`. Returns the slot name or null if this is some other
// kind of pause (cost-cap, no-candidates, etc.).
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
      <summary style={{ cursor: "pointer", fontSize: 12, color: "#666" }}>
        {value ? "📝 note (saved)" : "📝 add a personal note"}
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

function FilterBar({ relFilter, days, projectFilter, countMap }: {
  relFilter: string[]; days: number; projectFilter?: string; countMap: Map<string, number>;
}) {
  const allRels = ["high", "medium", "general-awareness", "low"] as const;
  const make = (rels: string[]) => {
    const qs = new URLSearchParams();
    qs.set("rel", rels.join(","));
    qs.set("days", String(days));
    if (projectFilter) qs.set("project", projectFilter);
    return `/?${qs.toString()}`;
  };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 16px", fontSize: 13 }}>
      {allRels.map((r) => {
        const active = relFilter.includes(r);
        const next = active ? relFilter.filter((x) => x !== r) : [...relFilter, r];
        return (
          <a key={r} href={make(next)} className={`tag ${r}`} style={{ opacity: active ? 1 : 0.4, textDecoration: "none" }}>
            {r} ({countMap.get(r) ?? 0})
          </a>
        );
      })}
      <span style={{ marginLeft: "auto", opacity: 0.6 }}>days:</span>
      {[1, 2, 7, 30].map((d) => (
        <a key={d} href={`/?rel=${relFilter.join(",")}&days=${d}${projectFilter ? "&project=" + projectFilter : ""}`}
           style={{ fontWeight: d === days ? 700 : 400, textDecoration: "none", color: "inherit" }}>
          {d}d
        </a>
      ))}
      {projectFilter && (
        <a href={make(relFilter)} style={{ marginLeft: 8 }}>
          clear project filter ({projectFilter}) ✕
        </a>
      )}
    </div>
  );
}
