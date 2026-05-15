import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { hashIngestToken } from "@/lib/crypto";
import { readUserSecret, writeUserSecret } from "@/lib/user-secrets";
import { autoDetectAndStoreRepos } from "@/lib/github-repo-detect";
import { archiveOldHidden } from "../actions";
import { randomBytes } from "crypto";
import { validateWebhookUrl } from "@/lib/url-guard";

export const dynamic = "force-dynamic";

// The settings page accepts ?newToken=<ing_…> for ONE render after rotation.
// The plaintext token lives only in the URL of the redirect that rotateIngestToken
// emits — it's read here, displayed once, and never persisted. Refreshing the
// page (or copy-pasting the URL elsewhere later) loses the token; that's the
// intended UX, paired with the hash-only at-rest model.
type Params = { searchParams: Promise<{ newToken?: string }> };

export default async function SettingsPage({ searchParams }: Params) {
  const sp = await searchParams;
  const justRotatedToken = typeof sp.newToken === "string" && /^ing_[A-Za-z0-9_-]{8,}$/.test(sp.newToken)
    ? sp.newToken
    : null;
  const user = await requireUser();
  const rawSettings = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, user.id))
    .get();
  // For the settings UI we only need to know WHETHER each secret is set, not
  // the plaintext - the form field is rendered as a masked password input and
  // we never echo the value back in any case. By only checking presence here
  // we avoid writing four secret_access_log decrypts on every settings page
  // render (which was the audit's "plaintext on every load" concern).
  const s = rawSettings && {
    ...rawSettings,
    githubToken: rawSettings.githubToken ? "•••••" : null,
    githubWriteToken: rawSettings.githubWriteToken ? "•••••" : null,
    deepseekApiKey: rawSettings.deepseekApiKey ? "•••••" : null,
    anthropicApiKey: rawSettings.anthropicApiKey ? "•••••" : null,
  };
  const userRow = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  const sharedAllowed = !!userRow?.canUseSharedLlm;

  // When the user hasn't set their own LLM key but they're allowed to use the
  // shared one, surface "(using shared)" so they don't think the field is broken.
  const envHasDeepseek = !!process.env.DEEPSEEK_API_KEY;
  const envHasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const deepseekStatus = s?.deepseekApiKey
    ? "your own"
    : sharedAllowed && envHasDeepseek
      ? "using shared (env)"
      : null;
  const anthropicStatus = s?.anthropicApiKey
    ? "your own"
    : sharedAllowed && envHasAnthropic
      ? "using shared (env)"
      : null;

  async function save(form: FormData) {
    "use server";
    const u = await requireUser();
    const existingPrev = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, u.id)).get();
    const newToken = (form.get("githubToken") as string || "").trim();
    const newDS = (form.get("deepseekApiKey") as string || "").trim();
    const newAN = (form.get("anthropicApiKey") as string || "").trim();
    // Single GitHub PAT: store the same encrypted value in both columns so
    // anything still reading `github_write_token` (older rows, future migrations)
    // keeps working without a code change.
    const encGithubToken = newToken
      ? await writeUserSecret(u.id, newToken)
      : existingPrev?.githubToken ?? existingPrev?.githubWriteToken ?? null;
    const values = {
      userId: u.id,
      githubToken: encGithubToken,
      githubWriteToken: encGithubToken,
      deepseekApiKey: newDS ? await writeUserSecret(u.id, newDS) : existingPrev?.deepseekApiKey ?? null,
      anthropicApiKey: newAN ? await writeUserSecret(u.id, newAN) : existingPrev?.anthropicApiKey ?? null,
      // Source handles are managed on /sources, not here. Preserve whatever's
      // already stored - anyone wanting per-user private overrides edits via
      // the DB or we add it back later.
      threadsHandles: existingPrev?.threadsHandles ?? null,
      tiktokHandles: existingPrev?.tiktokHandles ?? null,
      redditSubs: existingPrev?.redditSubs ?? null,
      emailToAddress: (form.get("emailToAddress") as string || "").trim() || null,
      enabled: form.get("enabled") === "on",
      cronHourUtc: Math.min(Math.max(parseInt((form.get("cronHourUtc") as string) || "6", 10) || 6, 0), 23),
      dailyCostCapUsd: Math.max(0, Number((form.get("dailyCostCapUsd") as string) || "5") || 5),
      webhookUrl: (() => {
        const raw = ((form.get("webhookUrl") as string) || "").trim();
        if (!raw) return null;
        const v = validateWebhookUrl(raw);
        if (!v.ok) {
          // We reject silently here (preserve previous value) rather than
          // throwing so the rest of the form save still applies. The user
          // can see the rejected URL is gone from the field next render.
          console.warn(`[settings] webhook URL rejected: ${v.error}`);
          return existingPrev?.webhookUrl ?? null;
        }
        return v.url.toString();
      })(),
      webhookKind: ((form.get("webhookKind") as string) || "generic"),
      // Preserve the existing ingest-token HASH. Plaintext ingest_token column
      // is migration-only and stays null on writes.
      ingestToken: null,
      ingestTokenHash: existingPrev?.ingestTokenHash ?? null,
      // Detected languages are owned by the re-detect action / PAT save below;
      // don't clobber them on a vanilla settings save.
      detectedLanguages: existingPrev?.detectedLanguages ?? null,
      updatedAt: new Date(),
    };
    if (existingPrev) {
      await db.update(schema.userSettings).set(values).where(eq(schema.userSettings.userId, u.id));
    } else {
      await db.insert(schema.userSettings).values(values);
    }
    // Kick off auto-detect of github_full_name in the background whenever a
    // fresh PAT is entered. The user can refresh /projects to see the result.
    if (newToken) {
      void autoDetectAndStoreRepos(u.id, newToken)
        .then((r) => console.log(`[settings] auto-detect filled ${r.filled}/${r.total} projects`))
        .catch((e) => console.error("[settings] auto-detect failed", e));
    }
    revalidatePath("/settings");
    revalidatePath("/projects");
  }

  async function redetectLanguages() {
    "use server";
    const u = await requireUser();
    const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, u.id)).get();
    const tokenStored = settings?.githubToken ?? null;
    let token: string | null = null;
    if (tokenStored) {
      try { token = await readUserSecret(u.id, "githubToken", tokenStored, "redetect-languages"); } catch { token = null; }
    }
    if (!token) return;
    try {
      const r = await autoDetectAndStoreRepos(u.id, token);
      console.log(`[settings] re-detect languages: ${r.languages.join(",")}`);
    } catch (e) {
      console.error("[settings] re-detect languages failed", e);
    }
    revalidatePath("/settings");
  }

  async function rotateIngestToken() {
    "use server";
    const u = await requireUser();
    const fresh = "ing_" + randomBytes(24).toString("base64url");
    const hash = hashIngestToken(fresh);
    const existing = await db.select({ id: schema.userSettings.id }).from(schema.userSettings).where(eq(schema.userSettings.userId, u.id)).get();
    if (existing) {
      await db.update(schema.userSettings)
        .set({ ingestTokenHash: hash, ingestToken: null, updatedAt: new Date() })
        .where(eq(schema.userSettings.userId, u.id));
    } else {
      await db.insert(schema.userSettings).values({
        userId: u.id,
        ingestTokenHash: hash,
        ingestToken: null,
        updatedAt: new Date(),
      });
    }
    revalidatePath("/settings");
    // Redirect with the freshly-minted plaintext in the URL. This is the one
    // and only chance for the user to copy it — the server stores only the
    // hash, so subsequent renders cannot reveal the plaintext again.
    redirect(`/settings?newToken=${encodeURIComponent(fresh)}#ingest`);
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="meta">
        Manage your sources on <a href="/sources">/sources</a>. Project sensitivity / model overrides on <a href="/projects">/projects</a>.
      </p>

      <form action={save} style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16, maxWidth: 640 }}>
        <Section title="Credentials (your own, never shared)">
          <Field label="GitHub PAT" name="githubToken" value={s?.githubToken ?? s?.githubWriteToken ?? ""} type="password" placeholder="github_pat_…" />
          <div style={{ background: "#0001", border: "1px solid #ccc4", borderRadius: 6, padding: 12, fontSize: 13, lineHeight: 1.55 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>One fine-grained PAT covers everything.</p>
            <p style={{ margin: "6px 0 10px", color: "#888" }}>
              Used for pipeline repo lookups (read) and the handoff-PR action (write).
              Click the button below. You'll need to set these on the GitHub page:
            </p>
            <table style={{ width: "auto", margin: 0, fontSize: 12 }}>
              <tbody>
                <tr>
                  <td style={{ padding: "2px 12px 2px 0", whiteSpace: "nowrap", color: "#888" }}>Repository access</td>
                  <td style={{ padding: 2 }}><b>All repositories</b> <span className="meta">(so auto-detect sees every project repo)</span></td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 12px 2px 0", whiteSpace: "nowrap", color: "#888" }}>Metadata</td>
                  <td style={{ padding: 2 }}><code>Read-only</code> <span className="meta">(set automatically)</span></td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 12px 2px 0", whiteSpace: "nowrap", color: "#888" }}>Contents</td>
                  <td style={{ padding: 2 }}><code>Read and write</code></td>
                </tr>
                <tr>
                  <td style={{ padding: "2px 12px 2px 0", whiteSpace: "nowrap", color: "#888" }}>Pull requests</td>
                  <td style={{ padding: 2 }}><code>Read and write</code></td>
                </tr>
              </tbody>
            </table>
            <a
              href="https://github.com/settings/personal-access-tokens/new?name=replen&description=replen+pipeline+%2B+handoff+PRs"
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                marginTop: 12,
                padding: "6px 12px",
                background: "#24292f",
                color: "#fff",
                textDecoration: "none",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                lineHeight: 1,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
              </svg>
              Create a PAT on GitHub
            </a>
          </div>
          <Field label="DeepSeek API key" name="deepseekApiKey" value={s?.deepseekApiKey ?? ""} type="password" placeholder="sk-…" statusBadge={deepseekStatus} />
          <Field label="Anthropic API key (required for high-sensitivity projects)" name="anthropicApiKey" value={s?.anthropicApiKey ?? ""} type="password" placeholder="sk-ant-…" statusBadge={anthropicStatus} />
          <p className="meta" style={{ marginTop: 4 }}>
            {sharedAllowed
              ? "Admin has granted you fallback to shared LLM keys; leaving DeepSeek/Anthropic blank still works. GitHub token is always BYO (any usage shows up under your GitHub account)."
              : "Provide your own DeepSeek key (and Anthropic if you mark any project high-sensitivity). Ask admin to grant shared LLM access if you'd rather not pay."}
          </p>
        </Section>

        <Section title="Detected stack (drives gh-trending slices)">
          <p className="meta" style={{ margin: 0 }}>
            We scan your own GitHub repos when you save a PAT and pick the top languages by repo size.
            The gh-trending fetcher pulls language-specific trending pages for these; most TikTok/Threads
            creators are just repackaging gh-trending, so this is the highest-signal source.
          </p>
          {rawSettings?.detectedLanguages ? (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {rawSettings.detectedLanguages.split(",").map((l) => (
                <span key={l} className="tag" style={{ background: "#eef", color: "#225" }}>{l}</span>
              ))}
            </div>
          ) : (
            <p className="meta" style={{ margin: 0 }}>None detected yet. Save a PAT above, then click re-detect.</p>
          )}
          <form action={redetectLanguages} style={{ marginTop: 4 }}>
            <button type="submit">Re-detect stack from GitHub</button>
          </form>
        </Section>

        <Section title="Delivery">
          <Field label="Email destination for your digest" name="emailToAddress" value={s?.emailToAddress ?? ""} type="email" placeholder="you@example.com" />
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" name="enabled" defaultChecked={s?.enabled !== false} /> nightly run enabled
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            Run at hour (UTC):
            <input type="number" name="cronHourUtc" min={0} max={23} defaultValue={s?.cronHourUtc ?? 6} style={{ width: 60, padding: 4 }} />
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            Daily cost cap (USD):
            <input type="number" name="dailyCostCapUsd" min={0} step={0.5} defaultValue={rawSettings?.dailyCostCapUsd ?? 5} style={{ width: 80, padding: 4 }} />
            <span className="meta">runs pause when 24h spend hits this · 0 disables</span>
          </label>
        </Section>

        <Section title="Real-time webhook (optional)">
          <Field label="Webhook URL" name="webhookUrl" value={rawSettings?.webhookUrl ?? ""} type="url" placeholder="https://hooks.slack.com/services/…  or  https://discord.com/api/webhooks/…" />
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13 }}>Format</span>
            <select name="webhookKind" defaultValue={rawSettings?.webhookKind ?? "generic"} style={{ padding: 6, maxWidth: 240 }}>
              <option value="slack">Slack (blocks)</option>
              <option value="discord">Discord (embeds)</option>
              <option value="generic">Generic JSON</option>
            </select>
          </label>
          <p className="meta">Fires after each run when there's at least one <code>relevance=high</code> match. Email still goes out separately.</p>
        </Section>

        <button type="submit" style={{ padding: "8px 16px", marginTop: 8, alignSelf: "flex-start" }}>Save settings</button>
      </form>

      <Section title="Ingest endpoint (for bookmarklets / browser extensions)">
        <p id="ingest" className="meta" style={{ margin: 0 }}>
          POST a URL to <code>/api/ingest</code> with header <code>x-ingest-token: &lt;your token&gt;</code> and body <code>{`{"url":"…"}`}</code>. Lands as a high-score candidate for the next run.
        </p>
        {justRotatedToken ? (
          <div style={{ marginTop: 8, padding: 12, background: "#fff8e1", border: "2px solid #f5b400", borderRadius: 6 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 700, color: "#8a6500" }}>
              🔑 Copy this token now. It will not be shown again.
            </p>
            <p className="meta" style={{ margin: "0 0 8px" }}>
              We store only the hash. Refreshing or leaving this page loses the plaintext; you would have to rotate again.
            </p>
            <code style={{ fontSize: 12, wordBreak: "break-all", display: "block", marginBottom: 12 }}>{justRotatedToken}</code>
            <details open style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>🔌 Connect Claude Code / Codex (MCP)</summary>
              <p className="meta" style={{ margin: "6px 0" }}>
                Paste this one-liner into your terminal. It writes the MCP server into <code>~/.claude.json</code> (with a backup). Then restart Claude Code.
              </p>
              <pre style={{ marginTop: 6, fontSize: 11, padding: 8, background: "#0d1117", color: "#e6edf3", borderRadius: 6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{mcpSetupCommand(justRotatedToken)}</pre>
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer", fontSize: 11, color: "#888" }}>raw JSON (hand-edit ~/.claude.json)</summary>
                <pre style={{ marginTop: 4, fontSize: 11, whiteSpace: "pre-wrap" }}>{mcpConfig(justRotatedToken)}</pre>
              </details>
            </details>
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 12 }}>Bookmarklet (drag to bookmark bar)</summary>
              <pre style={{ marginTop: 6, fontSize: 11, whiteSpace: "pre-wrap" }}>{bookmarklet(justRotatedToken)}</pre>
            </details>
          </div>
        ) : rawSettings?.ingestTokenHash ? (
          <p className="meta" style={{ marginTop: 8 }}>
            Token configured. The plaintext was shown once at generation/rotation and is not retrievable from this page — rotate below to mint a new one (the old one stops working immediately).
            {" "}Or use <code>npx replen</code> from your terminal to authorize a fresh device without exposing the token in a URL.
          </p>
        ) : (
          <p className="meta">No token yet. Generate one below, or use <code>npx replen</code>.</p>
        )}
        <form action={rotateIngestToken} style={{ marginTop: 6 }}>
          <button type="submit">{rawSettings?.ingestTokenHash ? "Rotate token" : "Generate token"}</button>
          {rawSettings?.ingestTokenHash && <span className="meta" style={{ marginLeft: 8 }}>old token stops working immediately</span>}
        </form>
      </Section>

      <Section title="Maintenance">
        <p className="meta" style={{ margin: 0 }}>
          Archive hidden matches older than 90 days. They stay in the DB (recoverable) but won't load on the dashboard.
        </p>
        <form action={async () => { "use server"; await archiveOldHidden(90); }} style={{ marginTop: 6 }}>
          <button type="submit">Archive hidden &gt; 90d</button>
        </form>
      </Section>

      <p className="meta" style={{ marginTop: 32 }}>
        Everything is kept: every fetched post lives in the <code>candidates</code> table; every writeup lives in <code>matches.writeup_md</code> permanently. Hidden matches stay in the DB, just filtered out of the dashboard.
      </p>
    </>
  );
}

function bookmarklet(token: string): string {
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3030";
  // javascript: URL that POSTs the current page's URL to /api/ingest. Single
  // line because some browsers strip newlines from bookmarklet hrefs.
  return `javascript:(async()=>{try{const r=await fetch('${base}/api/ingest',{method:'POST',headers:{'content-type':'application/json','x-ingest-token':'${token}'},body:JSON.stringify({url:location.href,title:document.title})});const j=await r.json();alert(j.ok?(j.deduped?'Already queued':'Queued for digest'):'Failed: '+(j.error||r.status));}catch(e){alert('Failed: '+e.message);}})();`;
}

function mcpConfig(token: string): string {
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3030";
  return JSON.stringify({
    mcpServers: {
      replen: {
        command: "replen-mcp",
        env: { DIGEST_BASE_URL: base, DIGEST_TOKEN: token },
      },
    },
  }, null, 2);
}

function mcpSetupCommand(token: string): string {
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3030";
  return `npx -y @replen/mcp setup --token=${token} --base=${base}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset style={{ border: "1px solid #ccc4", padding: 12 }}>
      <legend style={{ padding: "0 6px", fontSize: 13, fontWeight: 600 }}>{title}</legend>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </fieldset>
  );
}

function Field({ label, name, value, type = "text", placeholder, statusBadge }: {
  label: string; name: string; value: string; type?: string; placeholder?: string; statusBadge?: string | null;
}) {
  const isSecret = type === "password";
  const masked = isSecret && value ? `••••${value.slice(-4)}` : "";
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 13 }}>
        {label}
        {isSecret && value && <span className="meta"> (currently: {masked})</span>}
        {statusBadge && !value && <span className="meta"> ({statusBadge})</span>}
      </span>
      <input
        name={name}
        type={isSecret ? "password" : type}
        defaultValue={value}
        placeholder={placeholder}
        style={{ padding: 6, fontFamily: isSecret ? "monospace" : "inherit" }}
      />
    </label>
  );
}
