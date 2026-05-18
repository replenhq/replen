// Shallow-clone helper for the candidate-OSS indexer.
//
// Stage 4 needs the source of a candidate repo to verify it. We don't want to
// keep clones around — the BM25 index in SQLite is the persistent artefact,
// the working tree is throwaway. This helper:
//   - clones to an OS temp dir with depth=1, no tags, no submodules
//   - returns the path + a cleanup function
//   - times out after 60s so a hung clone doesn't stall the pipeline
//
// We rely on the `git` binary being on PATH (true on every dev box and the
// VPS). No libgit2 dep — git CLI is universally available, and we don't need
// anything beyond a one-shot fetch of HEAD.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLONE_TIMEOUT_MS = 60_000;
const MAX_CLONE_BYTES = 250 * 1024 * 1024; // 250MB — hard upper bound; aborts a giant repo before it eats disk.

export type ClonedRepo = {
  path: string;
  cleanup: () => Promise<void>;
};

/**
 * Shallow-clone github.com/<owner>/<name> into a temp directory. Returns the
 * absolute path to the working tree and a cleanup function. Caller MUST call
 * cleanup() in a finally block — clones live in /tmp and aren't garbage
 * collected on their own.
 *
 * Token is optional. Public repos clone without auth; private repos need a
 * token. We pass it via the URL form so we don't have to fiddle with git
 * credential helpers (which would leak across processes on a shared host).
 */
export async function shallowClone(
  owner: string,
  name: string,
  opts: { token?: string | null } = {},
): Promise<ClonedRepo> {
  const dir = await mkdtemp(join(tmpdir(), `replen-clone-${owner}-${name}-`));
  // Auth in the URL when present. Don't log this — token would land in the
  // child's stderr if git complains.
  const auth = opts.token ? `${opts.token}@` : "";
  const url = `https://${auth}github.com/${owner}/${name}.git`;

  const cleanup = async () => {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  };

  try {
    await runGit(
      ["clone", "--depth", "1", "--no-tags", "--no-recurse-submodules", "--single-branch", url, dir],
      { timeoutMs: CLONE_TIMEOUT_MS, maxBytes: MAX_CLONE_BYTES },
    );
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { path: dir, cleanup };
}

type GitOpts = { timeoutMs: number; maxBytes: number };

function runGit(args: string[], opts: GitOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    // GIT_TERMINAL_PROMPT=0 makes git fail fast on auth errors instead of
    // hanging waiting for a username on stdin. Critical when cloning private
    // repos with a bad token.
    const child = spawn("git", args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBytes = 0;
    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      // Keep last ~4KB of stderr for error reporting; bail if it spirals.
      if (stderrBuf.length < 4096) stderrBuf += chunk.toString("utf8");
      if (stderrBytes > opts.maxBytes) {
        child.kill("SIGKILL");
      }
    });
    child.stdout.on("data", () => { /* ignore */ });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args[0]} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} exited ${code}: ${stderrBuf.trim().slice(0, 500)}`));
    });
  });
}
