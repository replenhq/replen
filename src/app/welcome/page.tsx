import { db, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { writeUserSecret } from "@/lib/user-secrets";
import { autoDetectAndStoreRepos } from "@/lib/github-repo-detect";
import { runPipelineForUser } from "@/scheduler/run-once";

export const dynamic = "force-dynamic";

// Onboarding wizard: walks new users from zero → first digest. Visible only
// while prerequisites are unmet. Each step shows the current state, the
// minimum action needed, and a "Next" button.
//
// Steps:
//   1. GitHub PAT (drives both pipeline lookups + auto-detect of project repos)
//   2. Delivery email + UTC hour
//   3. Confirm projects + curated sources to fetch
//   4. Kick off first pipeline run
export default async function Welcome({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const step = Math.max(1, Math.min(4, parseInt(sp.step ?? "1", 10) || 1));

  const settings = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, user.id)).get();
  const hasGithub = !!(settings?.githubToken || settings?.githubWriteToken);
  const hasEmail = !!settings?.emailToAddress;
  const detectedProjects = await db
    .select()
    .from(schema.projectProfiles)
    .where(and(eq(schema.projectProfiles.userId, user.id), eq(schema.projectProfiles.included, true)));
  const matchedProjects = detectedProjects.filter((p) => p.githubFullName);
  const curated = await db.select().from(schema.curatedSources);
  const hasRun = await db
    .select({ id: schema.digestRuns.id })
    .from(schema.digestRuns)
    .where(eq(schema.digestRuns.userId, user.id))
    .get();

  // Auto-skip past steps the user has already completed.
  if (step === 1 && hasGithub) redirect("/welcome?step=2");
  if (step === 2 && hasEmail) redirect("/welcome?step=3");
  if (step === 4 && hasRun) redirect("/");

  async function saveGithubToken(form: FormData) {
    "use server";
    const u = await requireUser();
    const token = ((form.get("githubToken") as string) ?? "").trim();
    if (!token) return;
    const existing = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, u.id)).get();
    const enc = await writeUserSecret(u.id, token);
    if (existing) {
      await db.update(schema.userSettings).set({ githubToken: enc, githubWriteToken: enc, updatedAt: new Date() }).where(eq(schema.userSettings.userId, u.id));
    } else {
      await db.insert(schema.userSettings).values({ userId: u.id, githubToken: enc, githubWriteToken: enc, enabled: true, cronHourUtc: 6, updatedAt: new Date() });
    }
    // Fire-and-forget auto-detect.
    void autoDetectAndStoreRepos(u.id, token).catch((e) => console.error("[welcome] auto-detect", e));
    revalidatePath("/welcome");
    redirect("/welcome?step=2");
  }

  async function saveDelivery(form: FormData) {
    "use server";
    const u = await requireUser();
    const email = ((form.get("emailToAddress") as string) ?? "").trim();
    const hour = Math.min(Math.max(parseInt((form.get("cronHourUtc") as string) ?? "6", 10) || 6, 0), 23);
    if (!email) return;
    await db.update(schema.userSettings).set({ emailToAddress: email, cronHourUtc: hour, enabled: true, updatedAt: new Date() }).where(eq(schema.userSettings.userId, u.id));
    revalidatePath("/welcome");
    redirect("/welcome?step=3");
  }

  async function startFirstRun() {
    "use server";
    const u = await requireUser();
    // Fire-and-forget; user lands on /runs to watch.
    void runPipelineForUser(u.id).catch((e) => console.error("[welcome] first run failed", e));
    redirect("/runs");
  }

  // We never echo the token plaintext back in onboarding. Presence is all we
  // need for the masked-display branch.
  const tokenForDisplay = settings?.githubToken ? "•••••" : null;

  return (
    <>
      <h1>Welcome to Replen</h1>
      <Stepper step={step} />
      {step === 1 && <Step1 onSave={saveGithubToken} currentToken={tokenForDisplay} />}
      {step === 2 && <Step2 onSave={saveDelivery} current={settings} />}
      {step === 3 && <Step3 projects={detectedProjects} matched={matchedProjects.length} curated={curated.length} />}
      {step === 4 && <Step4 onStart={startFirstRun} />}
    </>
  );
}

function Stepper({ step }: { step: number }) {
  const steps = ["GitHub", "Delivery", "Confirm", "First run"];
  return (
    <ol style={{ display: "flex", gap: 12, padding: 0, margin: "12px 0 24px", listStyle: "none", fontSize: 13 }}>
      {steps.map((s, i) => (
        <li key={s} style={{
          flex: 1, padding: "8px 12px", borderRadius: 6,
          border: "1px solid #ccc4",
          background: i + 1 === step ? "#111" : i + 1 < step ? "#a4d8a4" : "transparent",
          color: i + 1 === step ? "#fff" : i + 1 < step ? "#1a1a1a" : undefined,
          fontWeight: i + 1 === step ? 600 : 400,
        }}>
          {i + 1 < step ? "✓ " : `${i + 1}. `}{s}
        </li>
      ))}
    </ol>
  );
}

function Step1({ onSave, currentToken }: { onSave: (f: FormData) => Promise<void>; currentToken: string | null }) {
  return (
    <>
      <h2 style={{ marginTop: 0 }}>1. Connect GitHub</h2>
      <p>
        Replen reads your project READMEs to know what you're building, and (optionally) opens handoff PRs back to your repos when you star a match.
        One fine-grained PAT covers both.
      </p>
      <p className="meta">
        Required scopes: <code>Metadata: read</code>, <code>Contents: read &amp; write</code>, <code>Pull requests: read &amp; write</code>.
        Repository access: <b>All repositories</b>.
      </p>
      <p>
        <a
          href="https://github.com/settings/personal-access-tokens/new?name=replen&description=replen+pipeline+%2B+handoff+PRs"
          target="_blank"
          rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "#24292f", color: "#fff", textDecoration: "none", borderRadius: 6, fontSize: 13, fontWeight: 500 }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
          Create a PAT on GitHub
        </a>
      </p>
      <form action={onSave} style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          name="githubToken"
          type="password"
          placeholder={currentToken ? `••••${currentToken.slice(-4)}` : "github_pat_…"}
          required={!currentToken}
          style={{ padding: 8, flex: "1 1 320px", fontFamily: "ui-monospace, monospace" }}
        />
        <button type="submit" style={{ padding: "8px 18px" }}>Save &amp; auto-detect projects →</button>
      </form>
    </>
  );
}

function Step2({ onSave, current }: { onSave: (f: FormData) => Promise<void>; current: typeof schema.userSettings.$inferSelect | undefined }) {
  return (
    <>
      <h2 style={{ marginTop: 0 }}>2. Where should we send your morning research?</h2>
      <p>Your digest email lands here each morning. You can also browse it on the dashboard any time.</p>
      <form action={onSave} style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12, maxWidth: 480 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 13 }}>Email destination</span>
          <input name="emailToAddress" type="email" defaultValue={current?.emailToAddress ?? ""} required style={{ padding: 8 }} />
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          Run at hour (UTC):
          <input name="cronHourUtc" type="number" min={0} max={23} defaultValue={current?.cronHourUtc ?? 6} style={{ width: 60, padding: 4 }} />
          <span className="meta">e.g. 6 UTC = 7am BST in summer</span>
        </label>
        <button type="submit" style={{ padding: "8px 18px", alignSelf: "flex-start" }}>Save →</button>
      </form>
    </>
  );
}

function Step3({ projects, matched, curated }: { projects: typeof schema.projectProfiles.$inferSelect[]; matched: number; curated: number }) {
  return (
    <>
      <h2 style={{ marginTop: 0 }}>3. We discovered your projects</h2>
      <p>
        Replen scanned <a href="/projects">your project_profiles</a> and found <b>{projects.length}</b> active.
        {matched > 0 && <> Of those, <b>{matched}</b> are linked to GitHub repos (auto-detected).</>}
      </p>
      <ul style={{ fontSize: 13, lineHeight: 1.6 }}>
        {projects.slice(0, 12).map((p) => (
          <li key={p.id}>
            <code>{p.slug}</code>
            {p.sensitivity === "high" && <span className="tag" style={{ marginLeft: 6 }}>🔒 sensitive</span>}
            {p.githubFullName && <span className="meta"> · {p.githubFullName}</span>}
          </li>
        ))}
        {projects.length > 12 && <li className="meta">… and {projects.length - 12} more</li>}
      </ul>
      <p className="meta">
        Sources to fetch from: <b>{curated}</b> curated.{" "}
        Adjust either on <a href="/projects">/projects</a> and <a href="/sources">/sources</a> any time.
      </p>
      <p style={{ marginTop: 16 }}>
        <a href="/welcome?step=4" style={{ display: "inline-block", padding: "8px 18px", background: "#111", color: "#fff", borderRadius: 6, textDecoration: "none" }}>
          Looks right →
        </a>
      </p>
    </>
  );
}

function Step4({ onStart }: { onStart: () => Promise<void> }) {
  return (
    <>
      <h2 style={{ marginTop: 0 }}>4. Run your first digest</h2>
      <p>
        We'll fetch from your sources, score each new repo against your projects, and write up the ones that fit. Takes 5-10 minutes.
        You'll watch it on <a href="/runs">/runs</a>; matches appear on the dashboard as they're written.
      </p>
      <form action={onStart}>
        <button type="submit" style={{ padding: "10px 24px", background: "#111", color: "#fff", borderRadius: 6, fontSize: 14, fontWeight: 500 }}>
          Run my first digest →
        </button>
      </form>
      <p className="meta" style={{ marginTop: 16 }}>
        After this you can come back to <a href="/">the dashboard</a> any time. Your daily run will fire automatically at the UTC hour you set.
      </p>
    </>
  );
}
