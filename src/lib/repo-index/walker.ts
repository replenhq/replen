// File discovery for the candidate-OSS indexer.
//
// Walks a directory yielding files that match an extension filter, honouring
// any .gitignore at the root + a curated default-ignored-dirs list. Used by
// the indexer's build path; the directory it walks is typically a throwaway
// shallow clone of a public GitHub repo.
//
// Why we don't just use `tar` or read everything: candidate repos can be
// large (the bigger ones we index will be tens of thousands of files), and
// indexing test fixtures or vendored deps would pollute BM25 scores without
// adding signal. A conservative ignore policy keeps the corpus focused on
// the repo's actual source.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import ignore from "ignore";

// Directories we always skip, regardless of .gitignore. These are
// universal noise across language ecosystems. Trailing slashes match
// gitignore semantics.
const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "dist",
  "build",
  "target",
  ".eggs",
  "out",
  "coverage",
  ".coverage",
  ".gradle",
  // Replen-specific
  ".replen",
  "projects-mirror",
  "backups",
]);

// File extensions considered code worth indexing. Order doesn't matter; we
// match lowercase. Markdown and config files are deliberately excluded —
// the LLM already sees README + manifests via other paths.
export const DEFAULT_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Web / scripting
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py",
  ".rb", ".php",
  // Systems
  ".rs", ".go", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp",
  ".java", ".kt", ".scala", ".swift",
  // Other
  ".cs", ".fs",
  ".lua",
  ".sh", ".bash", ".zsh",
  ".sql",
  ".dart",
  ".elm", ".ex", ".exs",
  ".clj", ".cljs",
]);

const MAX_FILE_BYTES = 1_000_000; // 1MB — anything bigger is almost certainly a generated artefact.

export type WalkedFile = {
  /** Repo-relative path with forward slashes. Stable across runs and OSes. */
  relativePath: string;
  /** Absolute filesystem path. Throwaway after indexing finishes. */
  absolutePath: string;
  /** Lowercase extension including the dot (e.g. ".ts"). */
  extension: string;
};

export type WalkOpts = {
  /** Extra ignore patterns to apply on top of .gitignore + defaults. */
  extraIgnore?: string[];
  /** Restrict to these extensions; defaults to DEFAULT_CODE_EXTENSIONS. */
  extensions?: ReadonlySet<string>;
};

/**
 * Walk `root` and yield every code file that survives the ignore filter and
 * extension filter. Files larger than MAX_FILE_BYTES are skipped silently.
 * Paths in the returned tuples are always normalised to forward slashes so
 * downstream code (BM25 scoring, UI display) doesn't have to care about OS.
 */
export async function* walkRepo(
  root: string,
  opts: WalkOpts = {},
): AsyncGenerator<WalkedFile> {
  const extensions = opts.extensions ?? DEFAULT_CODE_EXTENSIONS;
  const ig = ignore();
  // Always-ignored directories. Add them as gitignore-style patterns so they
  // also cover nested cases (e.g. `vendor/some-dep/node_modules/`).
  for (const dir of DEFAULT_IGNORED_DIRS) ig.add(`${dir}/`);
  if (opts.extraIgnore?.length) ig.add(opts.extraIgnore);
  // Honour a .gitignore at the repo root if present. Nested .gitignore files
  // are deliberately NOT walked — the cost-benefit doesn't pay for the index
  // budget we'd save, and the root file is enough for ~95% of cases in
  // practice (most repos hoist their global ignores there).
  try {
    const text = await readFile(join(root, ".gitignore"), "utf8");
    ig.add(text);
  } catch {
    // No .gitignore — fine.
  }
  try {
    const text = await readFile(join(root, ".replenignore"), "utf8");
    ig.add(text);
  } catch {
    // No .replenignore — fine.
  }

  yield* walk(root, root, ig, extensions);
}

async function* walk(
  root: string,
  current: string,
  ig: ReturnType<typeof ignore>,
  extensions: ReadonlySet<string>,
): AsyncGenerator<WalkedFile> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // Don't follow symlinks — cycles + leakage.
    const absolutePath = join(current, entry.name);
    const relativePath = toPosixRel(root, absolutePath);
    // `ignore` expects directory paths to end in '/' to match dir patterns
    // like `node_modules/`. Files match without trailing slash.
    const checkPath = entry.isDirectory() ? `${relativePath}/` : relativePath;
    if (ig.ignores(checkPath)) continue;

    if (entry.isDirectory()) {
      yield* walk(root, absolutePath, ig, extensions);
      continue;
    }
    if (!entry.isFile()) continue;

    const extension = extractExtension(entry.name);
    if (!extensions.has(extension)) continue;

    let size: number;
    try {
      size = (await stat(absolutePath)).size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES) continue;
    if (size === 0) continue;

    yield { relativePath, absolutePath, extension };
  }
}

function extractExtension(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return ""; // dotfile or no extension — exclude
  return name.slice(i).toLowerCase();
}

function toPosixRel(root: string, absolute: string): string {
  return relative(root, absolute).split(/[\\/]+/).join("/");
}
