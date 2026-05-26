import { db, schema } from "@/db/client";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDemoUser } from "@/lib/auth/demo-mode";
import { requireWritableUser } from "@/lib/auth/demo-mode";
import { hashIngestToken } from "@/lib/crypto";
import { writeUserSecret } from "@/lib/user-secrets";
import { autoDetectAndStoreRepos } from "@/lib/github-repo-detect";
import { archiveOldHidden } from "@/app/actions";
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
  const user = await getDemoUser();
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

  // Running cost summary: sum the cost of finished runs in the last 7
  // days + the most recent single run's cost so the user can see both
  // their weekly burn and what one run costs them today. The cost cap
  // gates 24h spend; the 7-day view gives them a wider operational
  // picture without a separate /costs page.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const weekCostRow = await db
    .select({ total: sql<number>`coalesce(sum(${schema.digestRuns.costUsd}), 0)` })
    .from(schema.digestRuns)
    .where(and(
      eq(schema.digestRuns.userId, user.id),
      gte(schema.digestRuns.startedAt, sevenDaysAgo),
      isNotNull(schema.digestRuns.finishedAt),
    ))
    .get();
  const weekCostUsd = Number(weekCostRow?.total ?? 0);
  const lastRunCost = await db
    .select({ cost: schema.digestRuns.costUsd, finishedAt: schema.digestRuns.finishedAt })
    .from(schema.digestRuns)
    .where(and(
      eq(schema.digestRuns.userId, user.id),
      isNotNull(schema.digestRuns.finishedAt),
    ))
    .orderBy(sql`${schema.digestRuns.id} desc`)
    .limit(1)
    .get();

  // Which provider the user is currently using (best-effort guess from
  // base URL or legacy column). Used to pre-select the radio in the
  // AI Provider section.
  const currentProvider: "deepseek" | "openai" | "anthropic" | "custom" | null = (() => {
    const base = (rawSettings?.llmPrimaryBaseUrl ?? "").toLowerCase();
    if (base.includes("deepseek")) return "deepseek";
    if (base.includes("openai.com")) return "openai";
    if (rawSettings?.deepseekApiKey) return "deepseek";
    if (rawSettings?.llmSensitiveBaseUrl?.includes("anthropic")) return "anthropic";
    if (rawSettings?.anthropicApiKey) return "anthropic";
    if (rawSettings?.llmPrimaryApiKey || rawSettings?.llmSensitiveApiKey) return "custom";
    return null;
  })();

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
    const u = await requireWritableUser();
    const existingPrev = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, u.id)).get();
    const newToken = (form.get("githubToken") as string || "").trim();
    const provider = ((form.get("provider") as string) || "").toLowerCase();
    const newPrimaryKey = (form.get("llmPrimaryApiKey") as string || "").trim();
    let newPrimaryBaseUrlRaw = (form.get("llmPrimaryBaseUrl") as string || "").trim();
    let newPrimaryModel = (form.get("llmPrimaryModel") as string || "").trim();
    const newSensitiveKey = (form.get("llmSensitiveApiKey") as string || "").trim();
    const newSensitiveBaseUrlRaw = (form.get("llmSensitiveBaseUrl") as string || "").trim();
    const newSensitiveModel = (form.get("llmSensitiveModel") as string || "").trim();
    const newSensitiveWire = (form.get("llmSensitiveWireFormat") as string || "").trim() || null;
    // If the user picked a known provider in the radio and didn't
    // override the base URL / model in the advanced section, fill in
    // the canonical defaults so they don't have to think about it.
    // "custom" preserves whatever's already stored.
    if (provider === "deepseek") {
      if (!newPrimaryBaseUrlRaw) newPrimaryBaseUrlRaw = "https://api.deepseek.com";
      if (!newPrimaryModel) newPrimaryModel = "deepseek-chat";
    } else if (provider === "openai") {
      if (!newPrimaryBaseUrlRaw) newPrimaryBaseUrlRaw = "https://api.openai.com/v1";
      if (!newPrimaryModel) newPrimaryModel = "gpt-4o-mini";
    }
    // If the user picked "anthropic" in the primary-slot radio, route
    // the entered key into the sensitive slot instead — that's where
    // Anthropic's wire format actually works.
    const anthropicAsPrimaryKey = provider === "anthropic" ? newPrimaryKey : "";
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
    // For Anthropic-as-primary, the key goes into the sensitive slot
    // with Anthropic wire format. Also set legacy anthropicApiKey for
    // the fallback chain in resolveUserConfig.
    const anthropicSensitiveKey = anthropicAsPrimaryKey
      ? await writeUserSecret(u.id, anthropicAsPrimaryKey)
      : (newSensitiveKey ? await writeUserSecret(u.id, newSensitiveKey) : existingPrev?.llmSensitiveApiKey ?? null);

    const values = {
      userId: u.id,
      githubToken: encGithubToken,
      githubWriteToken: encGithubToken,
      // Generic LLM slot writes; legacy columns are nulled out only on
      // explicit re-entry of a key so the back-compat fallback in
      // resolveUserConfig keeps working for users who haven't touched
      // the form since the migration. When the radio selects
      // "anthropic", the primary-slot key field actually routes to
      // the sensitive slot (Anthropic-only wire format) — handled
      // above via anthropicAsPrimaryKey.
      llmPrimaryApiKey: provider === "anthropic"
        ? existingPrev?.llmPrimaryApiKey ?? null  // don't put Anthropic in primary
        : newPrimaryKey
          ? await writeUserSecret(u.id, newPrimaryKey)
          : existingPrev?.llmPrimaryApiKey ?? null,
      llmPrimaryBaseUrl: newPrimaryBaseUrl,
      llmPrimaryModel: newPrimaryModel || existingPrev?.llmPrimaryModel || null,
      llmSensitiveApiKey: anthropicSensitiveKey,
      llmSensitiveBaseUrl: provider === "anthropic" && !newSensitiveBaseUrl
        ? "https://api.anthropic.com"
        : newSensitiveBaseUrl,
      llmSensitiveModel: provider === "anthropic" && !newSensitiveModel
        ? "claude-sonnet-4-6"
        : (newSensitiveModel || existingPrev?.llmSensitiveModel || null),
      llmSensitiveWireFormat: provider === "anthropic"
        ? "anthropic"
        : (newSensitiveWire || existingPrev?.llmSensitiveWireFormat || null),
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

  async function rotateIngestToken() {
    "use server";
    const u = await requireWritableUser();
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
          ingestTokenExpiresAt: expiresAt,
          ingestTokenLastUsedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.userSettings.userId, u.id));
    } else {
      await db.insert(schema.userSettings).values({
        userId: u.id,
        ingestTokenHash: hash,
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
        Account: <strong>{user.email}</strong>. Repo-level overrides (sensitivity, model picker) live on <a href="/demo/projects">/projects</a>.
      </p>

      <form action={save} style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16, maxWidth: 640 }}>

        {/* ── Section 1: AI provider ───────────────────────────────── */}
        <Section title="AI provider">
          <p style={settingsHelp}>
            Replen makes around 50 small AI calls per run. You pay the provider directly with your own key. DeepSeek is the cheapest by far and works just as well for most projects.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <ProviderOption
              value="deepseek"
              currentProvider={currentProvider}
              hasKey={!!rawSettings?.llmPrimaryApiKey || !!rawSettings?.deepseekApiKey}
              label="DeepSeek"
              tag="Recommended"
              cost="~$0.27 / million tokens"
              keyLink="https://platform.deepseek.com/api_keys"
              keyLinkLabel="Get a DeepSeek API key →"
            />
            <ProviderOption
              value="openai"
              currentProvider={currentProvider}
              hasKey={false}
              label="OpenAI"
              cost="~$5+ / million tokens"
              keyLink="https://platform.openai.com/api-keys"
              keyLinkLabel="Get an OpenAI API key →"
            />
            <ProviderOption
              value="anthropic"
              currentProvider={currentProvider}
              hasKey={!!rawSettings?.llmSensitiveApiKey || !!rawSettings?.anthropicApiKey}
              label="Anthropic Claude"
              tag="For sensitive projects"
              cost="~$3-15 / million tokens"
              keyLink="https://console.anthropic.com/settings/keys"
              keyLinkLabel="Get an Anthropic API key →"
            />
            <ProviderOption
              value="custom"
              currentProvider={currentProvider}
              hasKey={false}
              label="Custom / self-hosted"
              cost="Any OpenAI-compatible endpoint"
              keyLink=""
              keyLinkLabel=""
            />
          </div>
          <Field
            label="API key (leave blank to keep the current one)"
            name="llmPrimaryApiKey"
            value={s?.llmPrimaryApiKey ?? ""}
            type="password"
            placeholder="sk-…"
            statusBadge={primaryStatus}
          />
          <details style={{ marginTop: 4 }}>
            <summary style={settingsAdvancedSummary}>Advanced: custom base URL / model name</summary>
            <Field label="Base URL" name="llmPrimaryBaseUrl" value={rawSettings?.llmPrimaryBaseUrl ?? ""} type="url" placeholder="https://api.deepseek.com  (or any OpenAI-compatible endpoint)" />
            <Field label="Model" name="llmPrimaryModel" value={rawSettings?.llmPrimaryModel ?? ""} placeholder="deepseek-chat  ·  gpt-4o-mini  ·  llama-3.3-70b-versatile" />
          </details>
        </Section>

        {/* ── Section 2: GitHub access ─────────────────────────────── */}
        <Section title="GitHub access">
          <p style={settingsHelp}>
            Replen reads your project README + CLAUDE.md + recent commits via your GitHub PAT. Same token opens docs-improvement PRs into your repos when needed.
          </p>
          {s?.githubToken
            ? <StatusLine ok label="Token saved" />
            : <StatusLine ok={false} label="No token yet — paste one below" />}
          <a
            href="https://github.com/settings/personal-access-tokens/new?name=replen&description=Replen+pipeline+%2B+docs+PRs"
            target="_blank"
            rel="noreferrer"
            style={settingsExternalBtn}
          >
            <GithubIconSmall /> Create a PAT on GitHub →
          </a>
          <p style={{ ...settingsHelp, fontSize: 12, marginTop: 6 }}>
            On the GitHub page set <b>Repository access: All repositories</b> and these permissions:{" "}
            <code>Contents: Read &amp; write</code>, <code>Pull requests: Read &amp; write</code>,{" "}
            <code>Metadata: Read</code>.
          </p>
          <Field
            label="Paste new token (leave blank to keep the current one)"
            name="githubToken"
            value={s?.githubToken ?? s?.githubWriteToken ?? ""}
            type="password"
            placeholder="github_pat_…"
          />
        </Section>

        {/* ── Section 3: Sensitive projects (collapsed) ────────────── */}
        <details style={settingsAdvancedDetails}>
          <summary style={settingsSectionSummary}>
            Sensitive projects (separate provider slot)
            {sensitiveKeySet && <span style={settingsBadge}>configured</span>}
          </summary>
          <div style={{ padding: "12px 16px" }}>
            <p style={settingsHelp}>
              Some projects you mark as &ldquo;high sensitivity&rdquo; on <a href="/demo/projects">/projects</a> route through this separate slot &mdash; useful if you want a different provider, region, or self-hosted endpoint for that traffic. Any provider works; pick the wire format your endpoint speaks. Leave blank if no projects need it.
            </p>
            <Field label="API key" name="llmSensitiveApiKey" value={s?.llmSensitiveApiKey ?? ""} type="password" placeholder="sk-…" statusBadge={sensitiveStatus} />
            <Field label="Base URL" name="llmSensitiveBaseUrl" value={rawSettings?.llmSensitiveBaseUrl ?? ""} type="url" placeholder="https://api.your-provider.com" />
            <Field label="Model" name="llmSensitiveModel" value={rawSettings?.llmSensitiveModel ?? ""} placeholder="provider-model-id" />
            <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
              <span style={{ fontSize: 13 }}>Wire format</span>
              <select name="llmSensitiveWireFormat" defaultValue={rawSettings?.llmSensitiveWireFormat ?? "anthropic"} style={{ padding: 6, maxWidth: 360 }}>
                <option value="anthropic">Anthropic /v1/messages</option>
                <option value="openai-compatible">OpenAI-compatible /chat/completions</option>
              </select>
            </label>
            {sharedAllowed && (
              <p style={settingsHelp}>
                You have admin-granted fallback to shared LLM keys; leaving these blank works.
              </p>
            )}
          </div>
        </details>

        {/* ── Section 4: Email digest ──────────────────────────────── */}
        <Section title="Email digest (optional)">
          <p style={settingsHelp}>
            Send the daily summary to your inbox. The dashboard is the primary surface; email is a useful nudge but not required.
          </p>
          <Field label="Email destination" name="emailToAddress" value={s?.emailToAddress ?? ""} type="email" placeholder="you@example.com" />
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <input type="checkbox" name="enabled" defaultChecked={s?.enabled !== false} /> Automatic daily run
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            Run at (24h, UTC):
            <input type="number" name="cronHourUtc" min={0} max={23} defaultValue={s?.cronHourUtc ?? 6} style={{ width: 60, padding: 4 }} />
            <span style={settingsHint}>e.g. 06 = 6am UTC daily</span>
          </label>
        </Section>

        {/* ── Section 5: Costs ─────────────────────────────────────── */}
        <Section title="Costs">
          <div style={{ display: "flex", gap: 24, marginBottom: 12, flexWrap: "wrap" }}>
            <CostStat label="Last 7 days" value={`$${weekCostUsd.toFixed(2)}`} />
            <CostStat
              label="Last run"
              value={lastRunCost?.cost ? `$${Number(lastRunCost.cost).toFixed(2)}` : "—"}
            />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            Daily cost cap:
            <span style={{ fontSize: 13 }}>$</span>
            <input type="number" name="dailyCostCapUsd" min={0} step={0.5} defaultValue={rawSettings?.dailyCostCapUsd ?? 5} style={{ width: 80, padding: 4 }} />
            <span style={settingsHint}>Run pauses when 24h spend hits this. 0 = no cap.</span>
          </label>
        </Section>

        {/* ── Section 6: Advanced (collapsed) ──────────────────────── */}
        <details style={settingsAdvancedDetails}>
          <summary style={settingsSectionSummary}>Advanced</summary>
          <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 }}>

            <div>
              <h3 style={settingsSubHeader}>Extra doc paths</h3>
              <p style={settingsHelp}>
                Replen always reads each project&rsquo;s <code>README.md</code>, <code>CLAUDE.md</code>, and <code>.specify/</code>. Add globs here for extra files (e.g. <code>SPEC.md</code>, <code>docs/architecture/*.md</code>). Capped at 5 matches per pattern, 20K chars per file.
              </p>
              <textarea
                name="extraDocPaths"
                defaultValue={(rawSettings?.extraDocPaths ?? "").split(",").join("\n")}
                placeholder={"e.g.\nSPEC.md\ndocs/architecture/*.md\ndocs/internal/**/*.md"}
                rows={4}
                style={{ padding: 6, fontFamily: "ui-monospace, monospace", fontSize: 13, width: "100%" }}
              />
            </div>

            <div>
              <h3 style={settingsSubHeader}>Detected languages</h3>
              <p style={settingsHelp}>
                Drives the gh-trending fetcher&rsquo;s per-language slices. Updates when you save a new PAT.
              </p>
              {rawSettings?.detectedLanguages ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                  {rawSettings.detectedLanguages.split(",").map((l) => (
                    <span key={l} className="tag" style={{ background: "var(--surface-2)", color: "var(--fg)" }}>{l}</span>
                  ))}
                </div>
              ) : (
                <p style={settingsHelp}>None detected yet.</p>
              )}
            </div>

            <div>
              <h3 style={settingsSubHeader}>Real-time webhook</h3>
              <p style={settingsHelp}>
                Slack / Discord / generic JSON. Fires after each run when at least one <code>high</code>-relevance match is found.
              </p>
              <Field label="Webhook URL" name="webhookUrl" value={s?.webhookUrl ?? ""} type="text" placeholder="https://hooks.slack.com/services/…  or  https://discord.com/api/webhooks/…" />
              <label style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                <span style={{ fontSize: 13 }}>Format</span>
                <select name="webhookKind" defaultValue={rawSettings?.webhookKind ?? "generic"} style={{ padding: 6, maxWidth: 240 }}>
                  <option value="slack">Slack (blocks)</option>
                  <option value="discord">Discord (embeds)</option>
                  <option value="generic">Generic JSON</option>
                </select>
              </label>
            </div>
          </div>
        </details>

        <button type="submit" className="primary" style={{ padding: "10px 18px", marginTop: 8, alignSelf: "flex-start" }}>Save settings</button>
      </form>

      <details style={{ ...settingsAdvancedDetails, maxWidth: 640, marginTop: 8 }}>
        <summary style={settingsSectionSummary}>
          Bookmarklet / MCP token
          {rawSettings?.ingestTokenHash && <span style={settingsBadge}>configured</span>}
        </summary>
        <div style={{ padding: "12px 16px" }}>
        <p id="ingest" style={settingsHelp}>
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
        </div>
      </details>

      <details style={{ ...settingsAdvancedDetails, maxWidth: 640, marginTop: 8 }}>
        <summary style={settingsSectionSummary}>Maintenance</summary>
        <div style={{ padding: "12px 16px" }}>
          <p style={settingsHelp}>
            Archive hidden matches older than 90 days. They stay in the DB (recoverable) but won&rsquo;t load on the dashboard. Everything else (fetched candidates, all writeups including hidden ones) is kept permanently — Replen never deletes your data unless you ask.
          </p>
          <form action={async () => { "use server"; await archiveOldHidden(90); }} style={{ marginTop: 6 }}>
            <button type="submit">Archive hidden &gt; 90d</button>
          </form>
        </div>
      </details>

      {/* ── Danger zone ──────────────────────────────────────────── */}
      <section style={{ maxWidth: 640, marginTop: 32, padding: "16px 18px", border: "1px solid rgba(255, 99, 99, 0.35)", borderRadius: 12, background: "rgba(255, 99, 99, 0.04)" }}>
        <h2 style={{ fontSize: 15, color: "#ff8a8a", margin: "0 0 8px" }}>Danger zone</h2>
        <p style={{ ...settingsHelp, color: "var(--dim)", marginBottom: 12 }}>
          To delete your account and all data (project profiles, matches, insights, runs, secrets) permanently, email{" "}
          <a href="mailto:support@replen.dev?subject=Delete%20my%20Replen%20account">support@replen.dev</a>{" "}
          from the address registered to this account. We&rsquo;ll delete within 7 days and confirm by email.
        </p>
        <p style={{ ...settingsHelp, color: "var(--faint)", fontSize: 11, marginBottom: 0 }}>
          A self-serve delete button is on the roadmap. We&rsquo;re routing it through email-confirm for now so the action is auditable.
        </p>
      </section>
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
    <section style={{
      padding: "18px 20px",
      border: "1px solid var(--line, #ccc4)",
      borderRadius: 12,
      background: "var(--surface-1, transparent)",
    }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px", color: "var(--fg)" }}>{title}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}

function StatusLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 10px", borderRadius: 999,
      fontSize: 12, fontWeight: 500,
      background: ok ? "var(--green-soft, rgba(111,206,130,0.13))" : "var(--surface-2, rgba(255,255,255,0.07))",
      color: ok ? "var(--green, #6fce82)" : "var(--dim, #9d9a93)",
      border: `1px solid ${ok ? "var(--green-line, rgba(111,206,130,0.28))" : "var(--line)"}`,
      width: "fit-content",
    }}>
      {ok ? "✓" : "○"} {label}
    </div>
  );
}

function CostStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--faint, #66645e)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: "var(--fg)" }}>{value}</div>
    </div>
  );
}

function ProviderOption({
  value, currentProvider, hasKey, label, tag, cost, keyLink, keyLinkLabel,
}: {
  value: "deepseek" | "openai" | "anthropic" | "custom";
  currentProvider: "deepseek" | "openai" | "anthropic" | "custom" | null;
  hasKey: boolean;
  label: string;
  tag?: string;
  cost: string;
  keyLink: string;
  keyLinkLabel: string;
}) {
  const isCurrent = currentProvider === value;
  return (
    <label style={{
      display: "flex", flexDirection: "column", gap: 4,
      padding: "10px 12px",
      border: `1px solid ${isCurrent ? "var(--amber-line, rgba(255,200,87,0.4))" : "var(--line, #ccc4)"}`,
      borderRadius: 8,
      cursor: "pointer",
      background: isCurrent ? "var(--amber-soft, rgba(255,200,87,0.08))" : "var(--surface-1, transparent)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="radio" name="provider" value={value} defaultChecked={isCurrent || (currentProvider === null && value === "deepseek")} />
        <span style={{ fontWeight: 600 }}>{label}</span>
        {tag && (
          <span style={settingsBadge}>{tag}</span>
        )}
        {hasKey && (
          <span style={{ ...settingsBadge, background: "var(--green-soft)", color: "var(--green)", borderColor: "var(--green-line)" }}>
            ✓ key saved
          </span>
        )}
        <span className="meta" style={{ marginLeft: "auto", fontSize: 12 }}>{cost}</span>
      </div>
      {keyLink && (
        <a href={keyLink} target="_blank" rel="noreferrer" style={{
          fontSize: 12, color: "var(--amber, #ffc857)", textDecoration: "none", marginLeft: 24,
        }}>
          {keyLinkLabel}
        </a>
      )}
    </label>
  );
}

function GithubIconSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor" style={{ marginRight: 6 }}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
    </svg>
  );
}

const settingsHelp: React.CSSProperties = {
  color: "var(--dim, #666)",
  fontSize: 13,
  lineHeight: 1.55,
  margin: "0 0 8px",
};

const settingsHint: React.CSSProperties = {
  color: "var(--faint, #888)",
  fontSize: 12,
};

const settingsSubHeader: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  margin: "0 0 6px",
  color: "var(--fg)",
};

const settingsExternalBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "6px 12px",
  background: "#24292f",
  color: "#fff",
  textDecoration: "none",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  alignSelf: "flex-start",
};

const settingsAdvancedDetails: React.CSSProperties = {
  border: "1px solid var(--line, #ccc4)",
  borderRadius: 12,
  background: "var(--surface-1, transparent)",
};

const settingsSectionSummary: React.CSSProperties = {
  cursor: "pointer",
  padding: "14px 18px",
  fontSize: 15,
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  gap: 8,
  userSelect: "none",
};

const settingsAdvancedSummary: React.CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  color: "var(--dim, #888)",
  marginBottom: 6,
};

const settingsBadge: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  background: "var(--amber-soft, rgba(255,200,87,0.13))",
  color: "var(--amber, #ffc857)",
  border: "1px solid var(--amber-line, rgba(255,200,87,0.38))",
  borderRadius: 999,
  padding: "1px 8px",
  letterSpacing: "0.02em",
};

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
