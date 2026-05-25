// Wraps discoverProjects() (local FS walk) + POST /api/projects/bulk
// (server-side upsert) so it can be invoked both during the initial
// `npx replen` flow and as a standalone `npx replen sync-projects`
// command for ongoing use (after cloning new repos).

import { discoverProjects, type DiscoveredProject } from "./discover-projects.js";

type BulkResponse = {
  ok?: boolean;
  created?: number;
  updated?: number;
  total?: number;
  error?: string;
};

export async function syncDiscoveredProjects({
  token,
  base,
}: { token: string; base: string }): Promise<{
  discovered: number;
  created: number;
  updated: number;
}> {
  const projects = discoverProjects();
  if (projects.length === 0) {
    console.log("  · no git repos found under ~/github/, ~/code/, ~/projects/ — skipping project registration");
    return { discovered: 0, created: 0, updated: 0 };
  }

  // Show the user what we found before sending. Three examples is
  // enough context; full list lives in the API call.
  console.log(`  ✓ Found ${projects.length} git repo(s) with GitHub remotes:`);
  for (const p of projects.slice(0, 3)) {
    const sampleTags = p.tags.slice(0, 4).join(", ") || "(no auto-tags)";
    console.log(`    • ${p.githubFullName}  →  tags: ${sampleTags}`);
  }
  if (projects.length > 3) console.log(`    … and ${projects.length - 3} more`);

  const payload = {
    projects: projects.map((p) => ({
      slug: p.slug,
      githubFullName: p.githubFullName,
      name: p.name,
      tags: p.tags,
      primaryLanguage: p.primaryLanguage ?? undefined,
    })),
  };

  let res: Response;
  try {
    res = await fetch(`${base}/api/projects/bulk`, {
      method: "POST",
      headers: {
        "x-digest-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn(`  ✗ Failed to reach ${base}/api/projects/bulk: ${(e as Error).message}`);
    console.warn(`    Skipping project registration. Run \`npx replen sync-projects\` later to retry.`);
    return { discovered: projects.length, created: 0, updated: 0 };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`  ✗ Project registration failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    return { discovered: projects.length, created: 0, updated: 0 };
  }
  const body = (await res.json()) as BulkResponse;
  const created = body.created ?? 0;
  const updated = body.updated ?? 0;
  if (created > 0 || updated > 0) {
    const parts: string[] = [];
    if (created > 0) parts.push(`${created} new`);
    if (updated > 0) parts.push(`${updated} updated`);
    console.log(`  ✓ Registered with Replen: ${parts.join(", ")}`);
  } else {
    console.log(`  · All ${projects.length} projects already up to date with Replen`);
  }
  return { discovered: projects.length, created, updated };
}

// Returns just the discovered list without sending. Useful for the
// CLI's `replen list-projects` subcommand (preview mode).
export function previewDiscovery(): DiscoveredProject[] {
  return discoverProjects();
}
