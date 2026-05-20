import { db, schema } from "@/db/client";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { requireWritableUser } from "@/lib/auth/demo-mode";
import { writeUserSecret } from "@/lib/user-secrets";
import { autoDetectAndStoreRepos } from "@/lib/github-repo-detect";
import { startPipelineForUser } from "@/scheduler/run-once";

export const dynamic = "force-dynamic";

// One-page onboarding. The user lands here after signup (Google/GitHub
// OAuth or email magic link). They paste a GitHub PAT and an LLM API
// key on a single form. Server action validates both, saves, kicks off
// the first pipeline run, and redirects to / where the live streamer
// shows progress and matches appear as they land.
//
// Anything optional (email digest, sensitive-slot LLM for acme-style
// projects, daily cost cap, sources beyond GitHub) lives on /settings.
// The goal here is "30 seconds to first run".

export default async function Welcome({ searchParams }: { searchParams: Promise<{ err?: string; returnTo?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const err = sp.err;
  // returnTo lets callers (cli-auth, marketing, integrations) ask
  // /welcome to land the user back on a specific URL after first run
  // kicks off. Validated to a same-origin path-only string so the open
  // redirect surface is closed.
  const returnTo = isSafeReturnTo(sp.returnTo ?? "") ? sp.returnTo! : null;
  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, user.id)).get();
  const hasGithub = !!(settings?.githubToken || settings?.githubWriteToken);
  const hasLlm = !!(settings?.llmPrimaryApiKey || settings?.deepseekApiKey || settings?.anthropicApiKey || settings?.llmSensitiveApiKey);
  const hasRun = await db
    .select({ id: schema.digestRuns.id })
    .from(schema.digestRuns)
    .where(eq(schema.digestRuns.userId, user.id))
    .get();
  // Already set up: jump straight to returnTo (e.g. back to /cli-auth)
  // or the feed if no returnTo was provided.
  if (hasGithub && hasLlm && hasRun) redirect(returnTo ?? "/");

  return (
    <main style={{ maxWidth: 600, margin: "60px auto", padding: "0 20px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Welcome to Replen</h1>
      <p style={{ color: "var(--dim, #666)", lineHeight: 1.6, marginBottom: 32 }}>
        Two keys and you&rsquo;re running. Paste them here, click the button,
        watch your first digest build itself. No email signup, no waiting
        until tomorrow.
      </p>

      {err === "github" && (
        <div role="alert" style={errorBox}>
          That GitHub PAT didn&rsquo;t work. Check it has the right repository access + permissions, then paste it again. (Tokens copy-paste cleanly — if there are stray spaces or it&rsquo;s already been revoked, GitHub returns 401.)
        </div>
      )}
      {err === "llm" && (
        <div role="alert" style={errorBox}>
          That AI provider key didn&rsquo;t authenticate. Make sure you copied the key for the provider you selected (DeepSeek / OpenAI / Anthropic), and that the key has access to use the model.
        </div>
      )}

      <form action={saveOnboarding}>
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
        <Section
          number={1}
          title="Connect GitHub"
          subtitle="Replen reads your project READMEs and recent commits to know what you're building. One token covers both reading + opening doc PRs back to your repos."
        >
          <a
            href="https://github.com/settings/personal-access-tokens/new?name=replen&description=Replen+digest+pipeline"
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "8px 14px", fontSize: 13, fontWeight: 500,
              background: "#24292f", color: "#fff",
              textDecoration: "none", borderRadius: 6,
              marginBottom: 8,
            }}
          >
            <GithubIcon /> Create a PAT on GitHub →
          </a>
          <p style={{ fontSize: 12, color: "var(--dim, #888)", margin: "6px 0 10px", lineHeight: 1.5 }}>
            When the GitHub page opens, set <b>Repository access: All repositories</b> and these permissions:{" "}
            <code>Contents: Read &amp; write</code>, <code>Pull requests: Read &amp; write</code>,{" "}
            <code>Metadata: Read</code>. Then click <b>Generate token</b> and paste it below.
          </p>
          <input
            name="githubToken"
            type="password"
            placeholder="github_pat_…"
            required={!hasGithub}
            defaultValue=""
            autoComplete="off"
            spellCheck={false}
            style={inputStyle}
          />
          {hasGithub && (
            <p className="meta" style={{ marginTop: 6 }}>Already saved — leave empty to keep the current one.</p>
          )}
        </Section>

        <Section
          number={2}
          title="Pick an AI provider"
          subtitle="Replen runs ~50 LLM calls per pipeline run. DeepSeek is the cheapest by a wide margin and works just as well for most matches."
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <ProviderOption
              value="deepseek"
              defaultChecked
              label="DeepSeek"
              tag="Recommended · cheapest"
              cost="~$0.27 / million tokens"
              keyLink="https://platform.deepseek.com/api_keys"
              keyLinkLabel="Get a DeepSeek API key →"
            />
            <ProviderOption
              value="openai"
              label="OpenAI"
              cost="~$5+ / million tokens"
              keyLink="https://platform.openai.com/api-keys"
              keyLinkLabel="Get an OpenAI API key →"
            />
            <ProviderOption
              value="anthropic"
              label="Anthropic Claude"
              tag="For sensitive projects"
              cost="~$3-15 / million tokens"
              keyLink="https://console.anthropic.com/settings/keys"
              keyLinkLabel="Get an Anthropic API key →"
            />
          </div>
          <input
            name="llmApiKey"
            type="password"
            placeholder="sk-…"
            required={!hasLlm}
            defaultValue=""
            autoComplete="off"
            spellCheck={false}
            style={{ ...inputStyle, marginTop: 14 }}
          />
          {hasLlm && (
            <p className="meta" style={{ marginTop: 6 }}>Already saved — leave empty to keep the current one.</p>
          )}
          <p style={{ fontSize: 12, color: "var(--dim, #888)", marginTop: 10, lineHeight: 1.5 }}>
            You can add additional providers later on <a href="/settings">/settings</a>. Anthropic is also used as the &ldquo;sensitive&rdquo; slot for projects you mark as high-sensitivity on <a href="/projects">/projects</a>.
          </p>
        </Section>

        <button type="submit" className="primary" style={primaryBtn}>
          Save and start my first digest →
        </button>

        <p style={{ fontSize: 12, color: "var(--faint, #888)", marginTop: 16, lineHeight: 1.5, textAlign: "center" }}>
          Your first run takes 5-10 minutes and costs $0.10-$0.50 on your provider depending on how many repos you have. You can stop or cap costs any time on /settings.
        </p>
      </form>
    </main>
  );
}

async function saveOnboarding(form: FormData) {
  "use server";
  const u = await requireWritableUser();
  const githubToken = ((form.get("githubToken") as string) ?? "").trim();
  const llmApiKey = ((form.get("llmApiKey") as string) ?? "").trim();
  const provider = ((form.get("provider") as string) ?? "deepseek").toLowerCase();
  const returnToRaw = ((form.get("returnTo") as string) ?? "").trim();
  const returnTo = isSafeReturnTo(returnToRaw) ? returnToRaw : null;

  // Validate against the provider's own API. If either fails, surface
  // an error inline rather than saving a broken config. We do these in
  // parallel; total time is ~1-2s.
  const existing = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, u.id)).get();
  const wantGithubSave = !!githubToken;
  const wantLlmSave = !!llmApiKey;

  if (wantGithubSave) {
    const ok = await validateGithubToken(githubToken);
    if (!ok) {
      // Push an error back via redirect (next.js doesn't make
      // returning errors from server actions easy without a client
      // component; this is the simplest fail mode that doesn't lose
      // the user's other input). Encode the failure as a query param.
      redirect("/welcome?err=github");
    }
  }

  if (wantLlmSave) {
    const ok = await validateLlmKey(provider, llmApiKey);
    if (!ok) {
      redirect("/welcome?err=llm");
    }
  }

  // Encrypt + write.
  const updates: Partial<typeof schema.userSettings.$inferInsert> = {};
  if (wantGithubSave) {
    const enc = await writeUserSecret(u.id, githubToken);
    updates.githubToken = enc;
    updates.githubWriteToken = enc;
  }
  if (wantLlmSave) {
    const enc = await writeUserSecret(u.id, llmApiKey);
    if (provider === "anthropic") {
      // Anthropic routes through the sensitive slot (wire format is
      // /v1/messages). User-config falls back missing primary →
      // anthropic, so reasoning calls for low-sensitivity projects
      // will use Anthropic too if it's the only key set.
      updates.llmSensitiveApiKey = enc;
      updates.llmSensitiveBaseUrl = "https://api.anthropic.com";
      updates.llmSensitiveModel = "claude-sonnet-4-6";
      updates.llmSensitiveWireFormat = "anthropic";
      updates.anthropicApiKey = enc; // legacy mirror for fallback
    } else {
      // DeepSeek / OpenAI use the OpenAI-compatible primary slot.
      updates.llmPrimaryApiKey = enc;
      if (provider === "deepseek") {
        updates.llmPrimaryBaseUrl = "https://api.deepseek.com";
        updates.llmPrimaryModel = "deepseek-chat";
        updates.deepseekApiKey = enc; // legacy mirror for fallback
      } else if (provider === "openai") {
        updates.llmPrimaryBaseUrl = "https://api.openai.com/v1";
        updates.llmPrimaryModel = "gpt-4o-mini";
      }
    }
  }

  updates.updatedAt = new Date();
  if (existing) {
    await db.update(schema.userSettings).set(updates).where(eq(schema.userSettings.userId, u.id));
  } else {
    await db.insert(schema.userSettings).values({
      userId: u.id,
      enabled: true,
      cronHourUtc: 6,
      ...updates,
      updatedAt: new Date(),
    });
  }

  // Fire-and-forget repo detection. The pipeline runs after this and
  // will iterate whatever project_profiles rows exist by then.
  if (wantGithubSave) {
    void autoDetectAndStoreRepos(u.id, githubToken).catch((e) => console.error("[welcome] auto-detect", e));
  }
  // Kick off the first pipeline run. startPipelineForUser is fire-and-
  // forget and returns once the digest_runs row exists, so the live
  // streamer on / picks it up immediately.
  void startPipelineForUser(u.id).catch((e) => console.error("[welcome] first run failed", e));

  revalidatePath("/");
  redirect(returnTo ?? "/");
}

// Same-origin path-only check. Refuses any URL with a scheme, host,
// protocol-relative double-slash, or anything that isn't a clean
// relative path. Closes the open-redirect class of bugs that come
// with a naive returnTo. Acceptable shapes: "/foo", "/foo?q=1",
// "/foo?q=1#bar".
function isSafeReturnTo(raw: string): boolean {
  if (!raw) return false;
  if (raw.length > 512) return false;
  if (!raw.startsWith("/")) return false;
  if (raw.startsWith("//")) return false;
  // Allow chars typical of an internal URL path/query/hash.
  if (!/^\/[A-Za-z0-9/\-._~%?=&#+:,()@!$;*'[\]]*$/.test(raw)) return false;
  return true;
}

async function validateGithubToken(token: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "replen-onboarding",
      },
    });
    return res.ok;
  } catch { return false; }
}

async function validateLlmKey(provider: string, key: string): Promise<boolean> {
  const base = provider === "deepseek" ? "https://api.deepseek.com"
    : provider === "openai" ? "https://api.openai.com/v1"
    : provider === "anthropic" ? "https://api.anthropic.com"
    : null;
  if (!base) return false;
  try {
    if (provider === "anthropic") {
      // Anthropic doesn't expose /v1/models without auth; smallest
      // valid call is a 1-token messages POST. We use HEAD on /v1/models
      // which Anthropic accepts and only requires auth.
      const res = await fetch(`${base}/v1/models`, {
        method: "GET",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      return res.ok || res.status === 200;
    }
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
    return res.ok;
  } catch { return false; }
}

// ── Sub-components ────────────────────────────────────────────────────

function Section({
  number, title, subtitle, children,
}: {
  number: number; title: string; subtitle: string; children: React.ReactNode;
}) {
  return (
    <section style={{
      padding: "20px 22px",
      border: "1px solid var(--line, #ccc4)",
      borderRadius: 12,
      marginBottom: 18,
      background: "var(--surface-1, transparent)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span style={{
          fontSize: 12, fontWeight: 700, color: "var(--amber, #ffc857)",
          background: "var(--amber-soft, rgba(255,200,87,0.13))",
          border: "1px solid var(--amber-line, rgba(255,200,87,0.38))",
          borderRadius: 999, padding: "2px 9px", letterSpacing: "0.04em",
        }}>
          STEP {number}
        </span>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>{title}</h2>
      </div>
      <p style={{ color: "var(--dim, #666)", fontSize: 13.5, lineHeight: 1.55, margin: "0 0 14px" }}>
        {subtitle}
      </p>
      {children}
    </section>
  );
}

function ProviderOption({
  value, label, tag, cost, keyLink, keyLinkLabel, defaultChecked,
}: {
  value: string;
  label: string;
  tag?: string;
  cost: string;
  keyLink: string;
  keyLinkLabel: string;
  defaultChecked?: boolean;
}) {
  return (
    <label style={{
      display: "flex", flexDirection: "column", gap: 4,
      padding: "10px 12px", border: "1px solid var(--line, #ccc4)",
      borderRadius: 8, cursor: "pointer", background: "var(--surface-1, transparent)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="radio" name="provider" value={value} defaultChecked={defaultChecked} />
        <span style={{ fontWeight: 600 }}>{label}</span>
        {tag && (
          <span style={{
            fontSize: 11, color: "var(--amber, #ffc857)",
            background: "var(--amber-soft, rgba(255,200,87,0.13))",
            border: "1px solid var(--amber-line, rgba(255,200,87,0.38))",
            borderRadius: 999, padding: "1px 7px",
          }}>
            {tag}
          </span>
        )}
        <span className="meta" style={{ marginLeft: "auto", fontSize: 12 }}>{cost}</span>
      </div>
      <a href={keyLink} target="_blank" rel="noreferrer" style={{
        fontSize: 12, color: "var(--amber, #ffc857)", textDecoration: "none", marginLeft: 24,
      }}>
        {keyLinkLabel}
      </a>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: 14,
  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
  background: "rgba(0, 0, 0, 0.25)",
  border: "1px solid var(--line-strong, #ccc)",
  borderRadius: 6,
  color: "var(--fg, #ece9e2)",
  boxSizing: "border-box",
};

const errorBox: React.CSSProperties = {
  padding: "10px 14px",
  marginBottom: 16,
  border: "1px solid rgba(255, 99, 99, 0.35)",
  background: "rgba(255, 99, 99, 0.08)",
  borderRadius: 8,
  fontSize: 13,
  lineHeight: 1.5,
  color: "#ff8a8a",
};

const primaryBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "14px 24px",
  fontSize: 15,
  fontWeight: 600,
  textAlign: "center",
};

function GithubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor" style={{ marginRight: 6 }}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
    </svg>
  );
}
