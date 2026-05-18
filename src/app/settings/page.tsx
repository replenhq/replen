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
  // Determine whether each secret column has SOMETHING stored without
  // decrypting. Used to mask the inputs and show status badges.
  const primaryKeySet = !!(rawSettings?.llmPrimaryApiKey || rawSettings?.deepseekApiKey);
  const sensitiveKeySet = !!(rawSettings?.llmSensitiveApiKey || rawSettings?.anthropicApiKey);
  const s = rawSettings && {
    ...rawSettings,
    githubToken: rawSettings.githubToken ? "•••••" : null,
    githubWriteToken: rawSettings.githubWriteToken ? "•••••" : null,
    llmPrimaryApiKey: primaryKeySet ? "•••••" : null,
    llmSensitiveApiKey: sensitiveKeySet ? "•••••" : null,
    // webhookUrl is encrypted at rest (v2 envelope) — never render the cipher,
    // and the save handler treats an unchanged "•••••" submission as a no-op.
    webhookUrl: rawSettings.webhookUrl ? "•••••" : null,
  };
  const userRow = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).get();
  const sharedAllowed = !!userRow?.canUseSharedLlm;

  // When the user hasn't set their own LLM key but they're allowed to use the
  // shared one, surface "(using shared)" so they don't think the field is broken.
  const envHasPrimary = !!(process.env.LLM_PRIMARY_API_KEY ?? process.env.DEEPSEEK_API_KEY);
  const envHasSensitive = !!(process.env.LLM_SENSITIVE_API_KEY ?? process.env.ANTHROPIC_API_KEY);
  const primaryStatus = primaryKeySet
    ? "your own"
    : sharedAllowed && envHasPrimary
      ? "using shared (env)"
      : null;
  const sensitiveStatus = sensitiveKeySet
    ? "your own"
    : sharedAllowed && envHasSensitive
      ? "using shared (env)"
      : null;

  async function save(form: FormData) {
    "use server";
    const u = await requireUser();
    const existingPrev = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, u.id)).get();
    const newToken = (form.get("githubToken") as string || "").trim();
    const newPrimaryKey = (form.get("llmPrimaryApiKey") as string || "").trim();
    const newPrimaryBaseUrlRaw = (form.get("llmPrimaryBaseUrl") as string || "").trim();
    const newPrimaryModel = (form.get("llmPrimaryModel") as string || "").trim();
    const newSensitiveKey = (form.get("llmSensitiveApiKey") as string || "").trim();
    const newSensitiveBaseUrlRaw = (form.get("llmSensitiveBaseUrl") as string || "").trim();
    const newSensitiveModel = (form.get("llmSensitiveModel") as string || "").trim();
    const newSensitiveWire = (form.get("llmSensitiveWireFormat") as string || "").trim() || null;
    // Validate LLM base URLs the same way webhooks are validated: https-only,
    // no IP literals, no internal-zone suffixes. Rejected URLs preserve the
    // prior stored value rather than throwing — keeps the save UX forgiving.
    // The fetch-time check (resolveSafe in llm.ts) is the final gate against
    // DNS-rebinding into a private range.
    const validateLlmUrl = (raw: string, existing: string | null): string | null => {
      if (!raw) return existing;
      const v = validateWebhookUrl(raw);
      if (!v.ok) {
        console.warn(`[settings] LLM base URL rejected: ${v.error}`);
        return existing;
      }
      return v.url.toString();
    };
    const newPrimaryBaseUrl = validateLlmUrl(newPrimaryBaseUrlRaw, existingPrev?.llmPrimaryBaseUrl ?? null);
    const newSensitiveBaseUrl = validateLlmUrl(newSensitiveBaseUrlRaw, existingPrev?.llmSensitiveBaseUrl ?? null);
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
      // Generic LLM slot writes; legacy columns are nulled out only on
      // explicit re-entry of a key so the back-compat fallback in
      // resolveUserConfig keeps working for users who haven't touched the
      // form since the migration.
      llmPrimaryApiKey: newPrimaryKey
        ? await writeUserSecret(u.id, newPrimaryKey)
        : existingPrev?.llmPrimaryApiKey ?? null,
      llmPrimaryBaseUrl: newPrimaryBaseUrl,
      llmPrimaryModel: newPrimaryModel || existingPrev?.llmPrimaryModel || null,
      llmSensitiveApiKey: newSensitiveKey
        ? await writeUserSecret(u.id, newSensitiveKey)
        : existingPrev?.llmSensitiveApiKey ?? null,
      llmSensitiveBaseUrl: newSensitiveBaseUrl,
      llmSensitiveModel: newSensitiveModel || existingPrev?.llmSensitiveModel || null,
      llmSensitiveWireFormat: newSensitiveWire || existingPrev?.llmSensitiveWireFormat || null,
      // Extra doc paths (globs). Normalise: trim, drop empties, and refuse
      // any character that could escape the per-project root at glob-walk
      // time. The loader does its own path.resolve check, but defence in
      // depth — bad input rejected at save means it never reaches the FS.
      extraDocPaths: ((form.get("extraDocPaths") as string) || "")
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => {
          if (!s) return false;
          if (s.includes("..")) return false;
          if (s.startsWith("/") || s.startsWith("~")) return false;
          // Windows UNC, drive letters, NUL byte, backslash.
          if (/[\\\x00]/.test(s)) return false;
          if (/^[a-zA-Z]:/.test(s)) return false;
          return true;
        })
        .join(",") || null,
      // Legacy columns: preserve any existing values so users who haven't
      // re-entered keys since the schema migration still authenticate.
      deepseekApiKey: existingPrev?.deepseekApiKey ?? null,
      anthropicApiKey: existingPrev?.anthropicApiKey ?? null,
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
      webhookUrl: await (async () => {
        const raw = ((form.get("webhookUrl") as string) || "").trim();
        // Empty submission: preserve any existing encrypted value rather than
        // clearing — the input is masked on render so a blank field is the
        // "no change" signal, not an explicit unset. Use the dedicated clear
        // button (handled separately if added) for unset.
        if (!raw) return existingPrev?.webhookUrl ?? null;
        // The masked sentinel from the render path comes back unchanged
        // when the user didn't edit. Treat as no-op.
        if (raw === "•••••") return existingPrev?.webhookUrl ?? null;
        const v = validateWebhookUrl(raw);
        if (!v.ok) {
          console.warn(`[settings] webhook URL rejected: ${v.error}`);
          return existingPrev?.webhookUrl ?? null;
        }
        // Webhook URLs are bearer-equivalent for Slack/Discord; encrypt at
        // rest the same way PATs/LLM keys are (audit M1).
        return await writeUserSecret(u.id, v.url.toString());
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
    const now = new Date();
    // 90-day expiry stamped on every rotation. Forces re-issue after a
    // bounded window so a leaked token can't be used forever (audit H1).
    const expiresAt = new Date(now.getTime() + 90 * 24 * 3600 * 1000);
    const existing = await db.select({ id: schema.userSettings.id }).from(schema.userSettings).where(eq(schema.userSettings.userId, u.id)).get();
    if (existing) {
      await db.update(schema.userSettings)
        .set({
          ingestTokenHash: hash,
          ingestToken: null,
          ingestTokenExpiresAt: expiresAt,
          ingestTokenLastUsedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.userSettings.userId, u.id));
    } else {
      await db.insert(schema.userSettings).values({
        userId: u.id,
        ingestTokenHash: hash,
        ingestToken: null,
        ingestTokenExpiresAt: expiresAt,
        ingestTokenLastUsedAt: null,
        updatedAt: now,
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
        </Section>

        <Section title="LLM provider — primary slot (triage + most reasoning)">
          <p className="meta" style={{ margin: 0 }}>
            Any OpenAI-compatible endpoint. Set base URL + model to point at the provider of your choice (DeepSeek, OpenAI, Groq, Together, Fireworks, OpenRouter, a local llama.cpp / ollama server, etc.). Empty fields fall back to defaults.
          </p>
          <Field label="API key" name="llmPrimaryApiKey" value={s?.llmPrimaryApiKey ?? ""} type="password" placeholder="sk-…" statusBadge={primaryStatus} />
          <Field label="Base URL" name="llmPrimaryBaseUrl" value={rawSettings?.llmPrimaryBaseUrl ?? ""} type="url" placeholder="https://api.deepseek.com  (or  https://api.openai.com/v1  · https://api.groq.com/openai/v1  · https://openrouter.ai/api/v1)" />
          <Field label="Model name" name="llmPrimaryModel" value={rawSettings?.llmPrimaryModel ?? ""} placeholder="deepseek-v4-flash  (or  gpt-4o-mini  ·  llama-3.3-70b-versatile  ·  qwen2.5-coder:7b  …)" />
        </Section>

        <Section title="LLM provider — sensitive slot (only for high-sensitivity projects)">
          <p className="meta" style={{ margin: 0 }}>
            Used only on project_profiles flagged <code>high</code>. Leave blank if you don't have high-sensitivity projects.
          </p>
          <Field label="API key" name="llmSensitiveApiKey" value={s?.llmSensitiveApiKey ?? ""} type="password" placeholder="sk-ant-…" statusBadge={sensitiveStatus} />
          <Field label="Base URL" name="llmSensitiveBaseUrl" value={rawSettings?.llmSensitiveBaseUrl ?? ""} type="url" placeholder="https://api.anthropic.com" />
          <Field label="Model name" name="llmSensitiveModel" value={rawSettings?.llmSensitiveModel ?? ""} placeholder="claude-opus-4-7" />
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 13 }}>Wire format</span>
            <select name="llmSensitiveWireFormat" defaultValue={rawSettings?.llmSensitiveWireFormat ?? "anthropic"} style={{ padding: 6, maxWidth: 360 }}>
              <option value="anthropic">Anthropic /v1/messages (default)</option>
              <option value="openai-compatible">OpenAI-compatible /chat/completions</option>
            </select>
            <span className="meta">Pick OpenAI-compatible if your provider exposes that shape (e.g. a self-hosted model).</span>
          </label>
          <p className="meta" style={{ marginTop: 4 }}>
            {sharedAllowed
              ? "Admin has granted you fallback to shared LLM keys; leaving these blank still works. GitHub token is always BYO (any usage shows up under your GitHub account)."
              : "Provide your own keys (primary is required; sensitive only if you have projects flagged high-sensitivity). Ask admin to grant shared LLM access if you'd rather not pay."}
          </p>
        </Section>

        <Section title="Extra doc paths (optional)">
          <p className="meta" style={{ margin: 0 }}>
            Replen always reads each project's <code>README.md</code>, <code>CLAUDE.md</code>, and a manifest. Add globs here for extra files you want included (e.g. <code>SPEC.md</code>, <code>docs/architecture/*.md</code>). Patterns are relative to each project root. Capped at 5 matches per pattern, 20K chars per file.
          </p>
          <textarea
            name="extraDocPaths"
            defaultValue={(rawSettings?.extraDocPaths ?? "").split(",").join("\n")}
            placeholder={"e.g.\nSPEC.md\ndocs/architecture/*.md\ndocs/internal/**/*.md"}
            rows={4}
            style={{ padding: 6, fontFamily: "ui-monospace, monospace", fontSize: 13, width: "100%" }}
          />
          <p className="meta">
            One pattern per line (or comma-separated). See <a href="https://docs.replen.dev/project-docs.html" target="_blank" rel="noreferrer">the project-docs guide</a> for what makes a project's docs work well with replen, including a copy-pasteable <code>CLAUDE.md</code> template.
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
          <Field label="Webhook URL" name="webhookUrl" value={s?.webhookUrl ?? ""} type="text" placeholder="https://hooks.slack.com/services/…  or  https://discord.com/api/webhooks/…" />
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
          <>
            <p className="meta" style={{ marginTop: 8 }}>
              Token configured. The plaintext was shown once at generation/rotation and is not retrievable from this page — rotate below to mint a new one (the old one stops working immediately).
              {" "}Or use <code>npx replen</code> from your terminal to authorize a fresh device without exposing the token in a URL.
            </p>
            <p className="meta" style={{ marginTop: 4, fontSize: 12 }}>
              {(() => {
                const exp = rawSettings.ingestTokenExpiresAt;
                const lu = rawSettings.ingestTokenLastUsedAt;
                let lastUsedText = "never used";
                if (lu) {
                  const days = Math.floor((Date.now() - +lu) / 86400_000);
                  lastUsedText = days === 0 ? "used today" : days === 1 ? "last used yesterday" : `last used ${days} days ago`;
                }
                let expiryText = "";
                let expired = false;
                if (exp) {
                  const days = Math.ceil((+exp - Date.now()) / 86400_000);
                  if (days < 0) { expired = true; expiryText = "expired — re-authorize to use MCP"; }
                  else expiryText = `expires in ${days} days`;
                }
                return (
                  <>
                    {lastUsedText}
                    {expiryText && " · "}
                    {expired ? <strong style={{ color: "#c33" }}>{expiryText}</strong> : expiryText}
                  </>
                );
              })()}
            </p>
          </>
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
