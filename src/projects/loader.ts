import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { db, schema } from "../db/client";
import { and, eq } from "drizzle-orm";

export type LocalProject = {
  slug: string;
  path: string;
  name: string;
  readmeMd: string | null;
  claudeMd: string | null;
  techSummary: string | null;
  profileHash: string;
  active: boolean;
  included?: boolean;
  sensitivity?: "low" | "high";
  llmProvider?: "auto" | "deepseek" | "anthropic";
};

const DOC_NAMES = [
  // Conventional readmes first
  "README.md", "Readme.md", "readme.md", "README.MD",
  // Architectural / design docs
  "SPEC.md", "Spec.md", "spec.md",
  "DESIGN.md", "design.md",
  "ARCHITECTURE.md", "Architecture.md", "architecture.md",
  // Plans / roadmaps (lowest priority — used only if nothing else)
  "PRODUCT_PLAN.md", "PLAN.md", "plan.md",
  "roadmap.md", "ROADMAP.md", "Roadmap.md",
  "ACTION-PLAN.md", "ACTION_PLAN.md", "action-plan.md",
  "AUDIT.md", "AUDIT-REPORT.md", "FULL-AUDIT-REPORT.md",
  "NOTES.md", "OVERVIEW.md",
];
const CLAUDE_NAMES = ["CLAUDE.md", "Claude.md", "claude.md"];
const MANIFEST_NAMES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "requirements.txt"];

export async function discoverLocalProjects(root: string): Promise<LocalProject[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const out: LocalProject[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    const path = join(root, e.name);
    const docMd = await readFirstExisting(path, DOC_NAMES);
    const claudeMd = await readFirstExisting(path, CLAUDE_NAMES);
    const techSummary = await summarizeTech(path);
    // Discover the project if we have ANY of: a doc file, a CLAUDE.md, or a manifest.
    const hasManifest = await anyExists(path, MANIFEST_NAMES);
    if (!docMd && !claudeMd && !hasManifest) continue;
    const profile = `${docMd ?? ""}\n---\n${claudeMd ?? ""}\n---\n${techSummary ?? ""}`;
    const profileHash = createHash("sha1").update(profile).digest("hex");
    out.push({
      slug: e.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""),
      path,
      name: e.name,
      readmeMd: docMd,
      claudeMd,
      techSummary,
      profileHash,
      active: claudeMd !== null,
    });
  }
  return out;
}

async function readFirstExisting(dir: string, names: string[]): Promise<string | null> {
  for (const n of names) {
    try {
      const buf = await readFile(join(dir, n), "utf8");
      return buf.slice(0, 20_000);
    } catch {}
  }
  return null;
}

async function anyExists(dir: string, names: string[]): Promise<boolean> {
  for (const n of names) {
    try {
      await readFile(join(dir, n), "utf8");
      return true;
    } catch {}
  }
  return false;
}

async function summarizeTech(dir: string): Promise<string> {
  const parts: string[] = [];
  const pkg = await tryReadJson(join(dir, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    parts.push(`node project: ${pkg.name ?? "?"}; deps: ${Object.keys(deps).slice(0, 30).join(", ")}`);
  }
  const py = await tryRead(join(dir, "pyproject.toml"));
  if (py) parts.push("python project (pyproject.toml present)");
  const cargo = await tryRead(join(dir, "Cargo.toml"));
  if (cargo) parts.push("rust project (Cargo.toml present)");
  const goMod = await tryRead(join(dir, "go.mod"));
  if (goMod) parts.push("go project (go.mod present)");
  try {
    const top = await readdir(dir);
    const interesting = top.filter((n) => ["src", "app", "lib", "server", "client", "api"].includes(n));
    if (interesting.length) parts.push(`top-level: ${interesting.join(", ")}`);
  } catch {}
  return parts.join("\n");
}

async function tryRead(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function tryReadJson(p: string): Promise<any | null> {
  const s = await tryRead(p);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function upsertProjects(projects: LocalProject[], userId: number) {
  const now = new Date();
  for (const p of projects) {
    const existing = await db
      .select()
      .from(schema.projectProfiles)
      .where(and(eq(schema.projectProfiles.userId, userId), eq(schema.projectProfiles.slug, p.slug)))
      .get();
    if (existing) {
      if (existing.profileHash !== p.profileHash || existing.active !== p.active) {
        // NOTE: included + sensitivity are user-managed via the dashboard.
        // The loader never overwrites them.
        await db
          .update(schema.projectProfiles)
          .set({
            path: p.path,
            name: p.name,
            readmeMd: p.readmeMd,
            claudeMd: p.claudeMd,
            techSummary: p.techSummary,
            profileHash: p.profileHash,
            active: p.active,
            updatedAt: now,
          })
          .where(eq(schema.projectProfiles.id, existing.id));
      }
    } else {
      // New project: default included=true, sensitivity=low. User can adjust.
      const defaultSensitivity = p.slug.startsWith("acme-") ? "high" : "low";
      await db.insert(schema.projectProfiles).values({
        userId,
        slug: p.slug,
        path: p.path,
        name: p.name,
        readmeMd: p.readmeMd,
        claudeMd: p.claudeMd,
        techSummary: p.techSummary,
        profileHash: p.profileHash,
        active: p.active,
        included: true,
        sensitivity: defaultSensitivity,
        updatedAt: now,
      });
    }
  }
}
