import { db, schema } from "@/db/client";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin, requireUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

const KINDS = ["threads", "tiktok", "reddit", "rss", "other"] as const;

export default async function Sources() {
  const user = await requireUser();

  const myProposals = await db
    .select()
    .from(schema.proposedSources)
    .where(eq(schema.proposedSources.userId, user.id))
    .orderBy(desc(schema.proposedSources.createdAt));

  const curated = await db
    .select()
    .from(schema.curatedSources)
    .orderBy(schema.curatedSources.kind, schema.curatedSources.value);

  const mySettings = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, user.id))
    .get();

  const parseCSV = (s: string | null | undefined): string[] =>
    (s ?? "").split(/[,\s]+/).map((t) => t.trim().replace(/^@/, "")).filter(Boolean);

  const myThreadsHandles = parseCSV(mySettings?.threadsHandles);
  const myRedditSubs = parseCSV(mySettings?.redditSubs);
  const myTiktokHandles = parseCSV(mySettings?.tiktokHandles);

  async function submit(form: FormData) {
    "use server";
    const u = await requireUser();
    const kind = (form.get("kind") as string) ?? "threads";
    const value = ((form.get("value") as string) ?? "").trim().replace(/^@/, "");
    const note = ((form.get("note") as string) ?? "").trim() || null;
    if (!value) return;
    if (!KINDS.includes(kind as typeof KINDS[number])) return;
    await db.insert(schema.proposedSources).values({
      userId: u.id,
      kind,
      value,
      note,
      status: "pending",
      createdAt: new Date(),
    });
    revalidatePath("/sources");
  }

  async function addCurated(form: FormData) {
    "use server";
    const admin = await requireAdmin();
    const kind = (form.get("kind") as string) ?? "threads";
    const value = ((form.get("value") as string) ?? "").trim().replace(/^@/, "");
    const label = ((form.get("label") as string) ?? "").trim() || null;
    if (!value || !KINDS.includes(kind as typeof KINDS[number])) return;
    if (value.length > 200) return;
    await db
      .insert(schema.curatedSources)
      .values({ kind, value, label, addedByUserId: admin.id, createdAt: new Date() })
      .onConflictDoNothing({ target: [schema.curatedSources.kind, schema.curatedSources.value] });
    revalidatePath("/sources");
  }

  async function removeCurated(id: number) {
    "use server";
    await requireAdmin();
    if (!Number.isInteger(id) || id <= 0) return;
    await db.delete(schema.curatedSources).where(eq(schema.curatedSources.id, id));
    revalidatePath("/sources");
  }

  return (
    <>
      <h1>Sources</h1>
      <p className="meta">
        Every run fetches from the <b>curated (shared)</b> list plus your own <b>private</b> additions
        (configured on <a href="/settings">/settings</a>). Propose a new source below to ask the admin to add it
        to the shared list for everyone.
      </p>

      <h2 style={{ marginTop: 24 }}>Your effective list</h2>
      <EffectiveLists curated={curated} myThreads={myThreadsHandles} myReddit={myRedditSubs} myTiktok={myTiktokHandles} />

      {user.role !== "admin" && (
        <>
          <h2 style={{ marginTop: 32 }}>Propose a source</h2>
          <p className="meta">Goes to the admin queue. If approved, it joins the curated list for everyone.</p>
          <form action={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0", maxWidth: 720 }}>
            <select name="kind" defaultValue="threads" style={{ padding: 6 }}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input name="value" placeholder="e.g. github.awesome (threads) or LocalLLaMA (reddit)" required style={{ padding: 6, flex: "1 1 280px" }} />
            <input name="note" placeholder="optional note for the admin" style={{ padding: 6, flex: "1 1 200px" }} />
            <button type="submit">Submit</button>
          </form>

          <h2 style={{ marginTop: 32 }}>Your proposals</h2>
          {myProposals.length === 0 && <p className="meta">You haven't proposed anything yet.</p>}
          {myProposals.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Kind</th><th>Value</th><th>Status</th><th>Submitted</th><th>Admin note</th>
                </tr>
              </thead>
              <tbody>
                {myProposals.map((p) => (
                  <tr key={p.id}>
                    <td>{p.kind}</td>
                    <td><code>{p.value}</code></td>
                    <td>
                      <span className={`tag ${p.status === "approved" ? "high" : p.status === "rejected" ? "low" : "medium"}`}>{p.status}</span>
                    </td>
                    <td className="meta">{p.createdAt.toISOString().slice(0, 10)}</td>
                    <td className="meta">{p.adminNote ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {user.role === "admin" && (
        <AdminCuratedAdmin
          curated={curated}
          addCurated={addCurated}
          removeCurated={removeCurated}
        />
      )}

      {user.role === "admin" && <AdminCreatorAliases />}

      {user.role === "admin" && <AdminAllSources />}
    </>
  );
}

async function AdminCreatorAliases() {
  const aliases = await db
    .select()
    .from(schema.creatorAliases)
    .orderBy(schema.creatorAliases.creatorKey, schema.creatorAliases.kind);

  async function addAlias(form: FormData) {
    "use server";
    await requireAdmin();
    const kind = (form.get("kind") as string) ?? "";
    const value = ((form.get("value") as string) ?? "").trim().replace(/^@/, "");
    const creatorKey = ((form.get("creatorKey") as string) ?? "").trim().toLowerCase();
    if (!value || !creatorKey || !KINDS.includes(kind as typeof KINDS[number])) return;
    if (!/^[a-z0-9_-]{1,80}$/.test(creatorKey)) return;
    if (value.length > 200) return;
    await db
      .insert(schema.creatorAliases)
      .values({ kind, value, creatorKey, createdAt: new Date() })
      .onConflictDoNothing({ target: [schema.creatorAliases.kind, schema.creatorAliases.value] });
    revalidatePath("/sources");
  }

  async function removeAlias(id: number) {
    "use server";
    await requireAdmin();
    if (!Number.isInteger(id) || id <= 0) return;
    await db.delete(schema.creatorAliases).where(eq(schema.creatorAliases.id, id));
    revalidatePath("/sources");
  }

  // Group by creator_key for display.
  const byCreator = new Map<string, typeof aliases>();
  for (const a of aliases) {
    if (!byCreator.has(a.creatorKey)) byCreator.set(a.creatorKey, []);
    byCreator.get(a.creatorKey)!.push(a);
  }

  return (
    <>
      <h2 style={{ marginTop: 40 }}>Admin · creator linking</h2>
      <p className="meta">
        Link a TikTok handle to its Threads / Reddit counterpart so the same person posting on both
        platforms is treated as one creator. The dashboard ranks{" "}
        <b>tiktok &gt; threads &gt; reddit &gt; hn &gt; gh-trending</b>. If a project is found via both,
        the higher-ranked source's post (with video) is shown.
      </p>
      <form action={addAlias} style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0", maxWidth: 720 }}>
        <select name="kind" defaultValue="tiktok" style={{ padding: 6 }}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input name="value" placeholder="handle (e.g. whitewhoadie)" required style={{ padding: 6, flex: "1 1 220px" }} />
        <input name="creatorKey" placeholder="creator key (e.g. marc-caz)" required style={{ padding: 6, flex: "1 1 220px" }} />
        <button type="submit">Link</button>
      </form>
      {byCreator.size === 0 && <p className="meta">No aliases yet.</p>}
      {byCreator.size > 0 && (
        <table>
          <thead>
            <tr><th>Creator</th><th>Linked handles</th></tr>
          </thead>
          <tbody>
            {[...byCreator.entries()].map(([key, list]) => (
              <tr key={key}>
                <td><code>{key}</code></td>
                <td>
                  {list.map((a) => (
                    <span key={a.id} style={{ marginRight: 8, display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <code>{a.kind}/{a.value}</code>
                      <form className="inline" action={async () => { "use server"; await removeAlias(a.id); }}>
                        <button title="Unlink this handle" style={{ padding: "0 4px", fontSize: 11 }}>×</button>
                      </form>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function EffectiveLists({
  curated, myThreads, myReddit, myTiktok,
}: {
  curated: typeof schema.curatedSources.$inferSelect[];
  myThreads: string[];
  myReddit: string[];
  myTiktok: string[];
}) {
  const curThreads = curated.filter((c) => c.kind === "threads").map((c) => c.value);
  const curReddit = curated.filter((c) => c.kind === "reddit").map((c) => c.value);
  const curTiktok = curated.filter((c) => c.kind === "tiktok").map((c) => c.value);
  const curOther = curated.filter((c) => !["threads", "reddit", "tiktok"].includes(c.kind));

  const Pill = ({ kind, val, mine }: { kind: string; val: string; mine: boolean }) => (
    <code style={{
      marginRight: 6, marginBottom: 4, display: "inline-block",
      background: mine ? "#fff3cd" : "#cce5ff", color: "#1a1a1a",
      padding: "1px 6px", borderRadius: 4, fontSize: 12,
    }}>
      {kind === "reddit" ? "r/" : kind === "threads" || kind === "tiktok" ? "@" : ""}{val}
    </code>
  );

  const merge = (cur: string[], mine: string[]) => [
    ...cur.map((v) => ({ v, mine: false })),
    ...mine.filter((v) => !cur.includes(v)).map((v) => ({ v, mine: true })),
  ];
  const threads = merge(curThreads, myThreads);
  const reddit = merge(curReddit, myReddit);
  const tiktok = merge(curTiktok, myTiktok);

  return (
    <div style={{ marginTop: 8 }}>
      <p className="meta" style={{ margin: "8px 0" }}>
        <span style={{ background: "#cce5ff", color: "#1a1a1a", padding: "1px 6px", borderRadius: 4 }}>blue</span> = curated (shared) ·{" "}
        <span style={{ background: "#fff3cd", color: "#1a1a1a", padding: "1px 6px", borderRadius: 4 }}>yellow</span> = your private addition
      </p>
      <div style={{ marginTop: 8 }}>
        <b>Threads</b> ({threads.length}){threads.length === 0 && <span className="meta"> · none yet</span>}
        <div style={{ marginTop: 4 }}>
          {threads.map(({ v, mine }) => <Pill key={v} kind="threads" val={v} mine={mine} />)}
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <b>TikTok</b> ({tiktok.length}){tiktok.length === 0 && <span className="meta"> · none yet</span>}
        <div style={{ marginTop: 4 }}>
          {tiktok.map(({ v, mine }) => <Pill key={v} kind="tiktok" val={v} mine={mine} />)}
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <b>Reddit</b> ({reddit.length}){reddit.length === 0 && <span className="meta"> · none yet</span>}
        <div style={{ marginTop: 4 }}>
          {reddit.map(({ v, mine }) => <Pill key={v} kind="reddit" val={v} mine={mine} />)}
        </div>
      </div>
      {curOther.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <b>Other curated</b>
          <ul style={{ marginTop: 4 }}>
            {curOther.map((c) => (<li key={c.id}><span className="tag">{c.kind}</span> <code>{c.value}</code></li>))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AdminCuratedAdmin({
  curated, addCurated, removeCurated,
}: {
  curated: typeof schema.curatedSources.$inferSelect[];
  addCurated: (form: FormData) => Promise<void>;
  removeCurated: (id: number) => Promise<void>;
}) {
  return (
    <>
      <h2 style={{ marginTop: 40 }}>Admin · add to curated</h2>
      <p className="meta">Direct add (no proposal). Goes to every user's fetch immediately.</p>
      <form action={addCurated} style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0", maxWidth: 720 }}>
        <select name="kind" defaultValue="threads" style={{ padding: 6 }}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input name="value" placeholder="value (handle / subreddit / URL)" required style={{ padding: 6, flex: "1 1 280px" }} />
        <input name="label" placeholder="optional label" style={{ padding: 6, flex: "1 1 200px" }} />
        <button type="submit">Add</button>
      </form>
      <h2 style={{ marginTop: 24 }}>Admin · curated (manage)</h2>
      {curated.length === 0 && <p className="meta">Empty.</p>}
      {curated.length > 0 && (
        <table>
          <thead>
            <tr><th>Kind</th><th>Value</th><th>Label</th><th>Added</th><th></th></tr>
          </thead>
          <tbody>
            {curated.map((c) => (
              <tr key={c.id}>
                <td>{c.kind}</td>
                <td><code>{c.value}</code></td>
                <td className="meta">{c.label ?? ""}</td>
                <td className="meta">{c.createdAt.toISOString().slice(0, 10)}</td>
                <td>
                  <form className="inline" action={async () => { "use server"; await removeCurated(c.id); }}>
                    <button>remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

async function AdminAllSources() {
  const settings = await db
    .select({
      email: schema.users.email,
      threadsHandles: schema.userSettings.threadsHandles,
      tiktokHandles: schema.userSettings.tiktokHandles,
      redditSubs: schema.userSettings.redditSubs,
      enabled: schema.userSettings.enabled,
    })
    .from(schema.userSettings)
    .innerJoin(schema.users, eq(schema.userSettings.userId, schema.users.id))
    .orderBy(schema.users.email);

  const allProposals = await db
    .select({
      id: schema.proposedSources.id,
      kind: schema.proposedSources.kind,
      value: schema.proposedSources.value,
      status: schema.proposedSources.status,
      createdAt: schema.proposedSources.createdAt,
      note: schema.proposedSources.note,
      email: schema.users.email,
    })
    .from(schema.proposedSources)
    .innerJoin(schema.users, eq(schema.proposedSources.userId, schema.users.id))
    .orderBy(desc(schema.proposedSources.createdAt))
    .limit(200);

  const parseCSV = (s: string | null): string[] =>
    (s ?? "").split(/[,\s]+/).map((t) => t.trim().replace(/^@/, "")).filter(Boolean);

  return (
    <>
      <h2 style={{ marginTop: 40 }}>Admin · all users' private additions</h2>
      <p className="meta">From each user's /settings page.</p>
      {settings.length === 0 && <p className="meta">No user settings configured yet.</p>}
      {settings.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Enabled</th>
              <th>Threads</th>
              <th>TikTok</th>
              <th>Reddit</th>
            </tr>
          </thead>
          <tbody>
            {settings.map((s) => {
              const handles = parseCSV(s.threadsHandles);
              const tiks = parseCSV(s.tiktokHandles);
              const subs = parseCSV(s.redditSubs);
              return (
                <tr key={s.email}>
                  <td>{s.email}</td>
                  <td>{s.enabled ? "✓" : "-"}</td>
                  <td>{handles.length === 0 ? <span className="meta">none</span> : handles.map((h) => <code key={h} style={{ marginRight: 6 }}>@{h}</code>)}</td>
                  <td>{tiks.length === 0 ? <span className="meta">none</span> : tiks.map((t) => <code key={t} style={{ marginRight: 6 }}>@{t}</code>)}</td>
                  <td>{subs.length === 0 ? <span className="meta">none</span> : subs.map((r) => <code key={r} style={{ marginRight: 6 }}>r/{r}</code>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 40 }}>Admin · all proposals (recent 200)</h2>
      <p className="meta">Approve from <a href="/admin/proposals">/admin/proposals</a>.</p>
      {allProposals.length === 0 && <p className="meta">No proposals yet.</p>}
      {allProposals.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Kind</th>
              <th>Value</th>
              <th>Status</th>
              <th>Submitted</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {allProposals.map((p) => (
              <tr key={p.id}>
                <td>{p.email}</td>
                <td>{p.kind}</td>
                <td><code>{p.value}</code></td>
                <td><span className={`tag ${p.status === "approved" ? "high" : p.status === "rejected" ? "low" : "medium"}`}>{p.status}</span></td>
                <td className="meta">{p.createdAt.toISOString().slice(0, 10)}</td>
                <td className="meta">{p.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

void and;
