// Manifest parsing for prune detection (Initiative #2). Extracts the
// dependency list from each ecosystem's manifest file. Tight regex-based
// parsers rather than full TOML / lockfile parsing — we only need:
//   - dep name
//   - version constraint as written in the manifest
//   - dev vs runtime classification
//   - the host ecosystem (drives upstream-health lookup)
//
// We deliberately DO NOT parse lockfiles. Lockfiles have all transitive
// deps; we only care about direct ones the user can actually act on.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type DepEcosystem = "npm" | "python" | "cargo" | "go";
export type ProjectDep = {
  name: string;
  version: string; // raw constraint as written: "^1.0", ">=2.0,<3", "1.2.3"
  ecosystem: DepEcosystem;
  kind: "runtime" | "dev" | "build";
};

export type ManifestParseResult = {
  hasManifest: boolean;
  deps: ProjectDep[];
  // Which manifest files we read, for debugging / display.
  filesRead: string[];
};

// Defence-in-depth: cap the number of deps surfaced per project so a
// pathological monorepo can't OOM the prune-suggester. Real projects
// rarely have >200 direct deps.
const MAX_DEPS_PER_PROJECT = 200;

export async function parseManifests(projectPath: string): Promise<ManifestParseResult> {
  const allDeps: ProjectDep[] = [];
  const filesRead: string[] = [];

  // npm
  try {
    const buf = await readFile(join(projectPath, "package.json"), "utf8");
    const pkg = JSON.parse(buf) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      allDeps.push({ name, version, ecosystem: "npm", kind: "runtime" });
    }
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      allDeps.push({ name, version, ecosystem: "npm", kind: "dev" });
    }
    for (const [name, version] of Object.entries(pkg.peerDependencies ?? {})) {
      allDeps.push({ name, version, ecosystem: "npm", kind: "runtime" });
    }
    if (pkg.dependencies || pkg.devDependencies) filesRead.push("package.json");
  } catch { /* no package.json or unparseable; fine */ }

  // pyproject.toml — covers PEP 621, poetry, uv.
  try {
    const buf = await readFile(join(projectPath, "pyproject.toml"), "utf8");
    const pyDeps = parsePyprojectDeps(buf);
    allDeps.push(...pyDeps);
    if (pyDeps.length > 0) filesRead.push("pyproject.toml");
  } catch { /* no pyproject */ }

  // requirements.txt — older Python, still common
  try {
    const buf = await readFile(join(projectPath, "requirements.txt"), "utf8");
    const reqDeps = parseRequirementsTxt(buf);
    allDeps.push(...reqDeps);
    if (reqDeps.length > 0) filesRead.push("requirements.txt");
  } catch { /* not present */ }

  // Cargo.toml
  try {
    const buf = await readFile(join(projectPath, "Cargo.toml"), "utf8");
    const cargoDeps = parseCargoToml(buf);
    allDeps.push(...cargoDeps);
    if (cargoDeps.length > 0) filesRead.push("Cargo.toml");
  } catch { /* not present */ }

  // go.mod
  try {
    const buf = await readFile(join(projectPath, "go.mod"), "utf8");
    const goDeps = parseGoMod(buf);
    allDeps.push(...goDeps);
    if (goDeps.length > 0) filesRead.push("go.mod");
  } catch { /* not present */ }

  // Dedup by (ecosystem, name) — peerDependencies often duplicates
  // dependencies, requirements.txt might shadow pyproject.toml, etc.
  // Keep the first occurrence (manifest order is meaningful).
  const seen = new Set<string>();
  const deduped: ProjectDep[] = [];
  for (const d of allDeps) {
    const key = `${d.ecosystem}:${d.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(d);
    if (deduped.length >= MAX_DEPS_PER_PROJECT) break;
  }

  return {
    hasManifest: filesRead.length > 0,
    deps: deduped,
    filesRead,
  };
}

// Minimal pyproject.toml dep extractor. Handles the three common shapes
// without pulling a TOML lib:
//   1. PEP 621 array form:   project.dependencies = ["foo>=1.0", "bar"]
//   2. Poetry table form:    [tool.poetry.dependencies] foo = "^1.0"
//   3. UV table form:        [tool.uv.dependencies]
//   4. Optional/extras:      [project.optional-dependencies] dev = [...]
//
// Not parsing into a real TOML AST — just extracting dep names. For
// constraint strings we keep the raw value as written. Good enough for
// "look up this name in the package registry".
function parsePyprojectDeps(toml: string): ProjectDep[] {
  const deps: ProjectDep[] = [];

  // PEP 621 dependencies = ["pkg>=1", "another"]
  // The array can span multiple lines. Grab the contents between [ and ].
  const pep621Match = toml.match(/(?:^|\n)\s*dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (pep621Match) {
    for (const item of pep621Match[1].matchAll(/["']([^"']+)["']/g)) {
      const dep = parsePep508Spec(item[1]);
      if (dep) deps.push({ ...dep, ecosystem: "python", kind: "runtime" });
    }
  }

  // PEP 621 optional-dependencies = { extra = ["pkg"] } — treat all as dev
  // because optional means "not required for runtime".
  for (const m of toml.matchAll(/(?:^|\n)\s*optional-dependencies\s*=\s*\{([\s\S]*?)\}/g)) {
    for (const item of m[1].matchAll(/["']([^"']+)["']/g)) {
      const dep = parsePep508Spec(item[1]);
      if (dep) deps.push({ ...dep, ecosystem: "python", kind: "dev" });
    }
  }

  // Poetry-style table: [tool.poetry.dependencies] foo = "^1.0"
  // Section ends at the next [section] header or EOF.
  const sectionPatterns = [
    { re: /\[tool\.poetry\.dependencies\][\s\S]*?(?=\n\[|$)/, kind: "runtime" as const },
    { re: /\[tool\.poetry\.dev-dependencies\][\s\S]*?(?=\n\[|$)/, kind: "dev" as const },
    { re: /\[tool\.poetry\.group\.[^\]]+\.dependencies\][\s\S]*?(?=\n\[|$)/, kind: "dev" as const },
    { re: /\[tool\.uv\.dependencies\][\s\S]*?(?=\n\[|$)/, kind: "runtime" as const },
  ];
  for (const { re, kind } of sectionPatterns) {
    const m = toml.match(re);
    if (!m) continue;
    for (const line of m[0].split("\n")) {
      // "foo = "^1.0"" or "foo = { version = "^1.0", ... }"
      const kv = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=\s*(?:["']([^"']+)["']|\{)/);
      if (kv && kv[1] !== "python") {
        deps.push({ name: kv[1], version: kv[2] ?? "*", ecosystem: "python", kind });
      }
    }
  }

  return deps;
}

// requirements.txt: one line per dep, optional comment with `#`. Pip's
// real grammar (PEP 508) is rich (URLs, hashes, extras) but we just need
// names + version constraints.
function parseRequirementsTxt(text: string): ProjectDep[] {
  const deps: ProjectDep[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    // Skip -r, -e, --editable, URLs, etc. These aren't standard deps.
    if (line.startsWith("-") || line.includes("://")) continue;
    const dep = parsePep508Spec(line);
    if (dep) deps.push({ ...dep, ecosystem: "python", kind: "runtime" });
  }
  return deps;
}

// PEP 508 spec like "Django>=4.2,<5", "requests[security]>=2.0", "numpy".
// Extract name + version constraint. Returns {name, version} or null
// for unparseable lines.
function parsePep508Spec(spec: string): { name: string; version: string } | null {
  const m = spec.match(/^\s*([a-zA-Z0-9_.-]+(?:\[[^\]]+\])?)\s*([<>=!~]+\s*[^;]*)?/);
  if (!m) return null;
  // Strip the [extras] suffix from the name to get the canonical package name.
  const name = m[1].replace(/\[.+\]$/, "");
  const version = m[2] ? m[2].trim() : "*";
  return { name, version };
}

// Cargo.toml: [dependencies], [dev-dependencies], [build-dependencies].
// Each dep is either "foo = "1.0"" or "foo = { version = "1.0", ... }".
function parseCargoToml(toml: string): ProjectDep[] {
  const deps: ProjectDep[] = [];
  const sections = [
    { re: /\[dependencies\][\s\S]*?(?=\n\[|$)/, kind: "runtime" as const },
    { re: /\[dev-dependencies\][\s\S]*?(?=\n\[|$)/, kind: "dev" as const },
    { re: /\[build-dependencies\][\s\S]*?(?=\n\[|$)/, kind: "build" as const },
    // workspace-level deps
    { re: /\[workspace\.dependencies\][\s\S]*?(?=\n\[|$)/, kind: "runtime" as const },
  ];
  for (const { re, kind } of sections) {
    const m = toml.match(re);
    if (!m) continue;
    for (const line of m[0].split("\n")) {
      const kv = line.match(/^\s*([a-zA-Z0-9_-]+)\s*=\s*(?:["']([^"']+)["']|\{[^}]*version\s*=\s*["']([^"']+)["'][^}]*\}|\{)/);
      if (kv) {
        const version = kv[2] ?? kv[3] ?? "*";
        deps.push({ name: kv[1], version, ecosystem: "cargo", kind });
      }
    }
  }
  return deps;
}

// go.mod: top-level `require` block(s) or single-line `require <module>
// <version>`. Module names are full paths ("github.com/foo/bar").
function parseGoMod(text: string): ProjectDep[] {
  const deps: ProjectDep[] = [];
  // Block form:
  //   require (
  //     github.com/foo/bar v1.2.3
  //     github.com/baz/qux v0.1.0 // indirect
  //   )
  for (const block of text.matchAll(/require\s*\(([\s\S]*?)\)/g)) {
    for (const line of block[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      // Skip indirect deps — those are transitive, not user-actionable.
      if (trimmed.includes("// indirect")) continue;
      const m = trimmed.match(/^(\S+)\s+(\S+)/);
      if (m) deps.push({ name: m[1], version: m[2], ecosystem: "go", kind: "runtime" });
    }
  }
  // Single-line form: `require github.com/foo/bar v1.0.0`
  for (const m of text.matchAll(/^require\s+(\S+)\s+(\S+)\s*$/gm)) {
    deps.push({ name: m[1], version: m[2], ecosystem: "go", kind: "runtime" });
  }
  return deps;
}
