// Install the bundled `replen-match` skill into Claude Code's
// ~/.claude/skills/ tree so users can invoke it via `/replen-match`
// (or by saying "use replen / triage today / what's new from replen").
//
// Idempotent: re-running setup overwrites the skill in place. The
// skill is the source of truth in Replen's npm package; users
// shouldn't be hand-editing the installed copy because it'll be
// clobbered on next `npx replen mcp setup`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved at runtime: the published package's bundled extras dir.
// __dirname-equivalent for ESM. dist/ lives at <package>/dist/, so the
// extras dir is one level up + "extras".
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_ROOT = join(SELF_DIR, "..", "extras", "skills");

// Claude Code reads skills from ~/.claude/skills/<name>/SKILL.md. Other
// MCP hosts (Codex, Cursor) don't have a skills concept yet; they
// follow the MCP tool's description instead. The CLAUDE.md instruction
// shipped by `replen project-init` is the cross-host fallback.
const CLAUDE_SKILLS_ROOT = join(homedir(), ".claude", "skills");

type SkillSpec = {
  name: string;
  // Relative path under bundled skills root (e.g. "replen-match/SKILL.md")
  // and under ~/.claude/skills/ (mirrored).
  files: string[];
};

const SKILLS: SkillSpec[] = [
  {
    name: "replen-match",
    files: ["replen-match/SKILL.md"],
  },
];

export function installSkills(): void {
  if (!existsSync(BUNDLED_SKILLS_ROOT)) {
    // Bundle missing — running from a source tree without the
    // extras/ dir, or a corrupt install. Skip rather than crash; the
    // skill is a nice-to-have not a hard requirement (the MCP tool
    // surface covers all hosts).
    console.warn(`  · skills bundle not found at ${BUNDLED_SKILLS_ROOT}; skipping skill install`);
    return;
  }
  mkdirSync(CLAUDE_SKILLS_ROOT, { recursive: true });
  let installed = 0;
  for (const skill of SKILLS) {
    for (const rel of skill.files) {
      const src = join(BUNDLED_SKILLS_ROOT, rel);
      const dst = join(CLAUDE_SKILLS_ROOT, rel);
      if (!existsSync(src)) {
        console.warn(`  · missing in bundle: ${rel}`);
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      const body = readFileSync(src);
      writeFileSync(dst, body);
      installed++;
    }
    console.log(`  ✓ Installed skill: ${skill.name} → ~/.claude/skills/${skill.name}/`);
  }
  if (installed === 0) {
    console.warn(`  · no skill files installed (bundle present but empty)`);
  }
}
