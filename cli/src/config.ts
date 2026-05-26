import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const CONFIG_DIR = join(homedir(), ".replen");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export type Config = {
  token: string;
  base: string;
  savedAt: string;
  /**
   * Project roots discovered (or explicitly chosen) on first install.
   * Persisted so future `npx replen sync-projects` runs skip the
   * inference dance. Empty / absent = use auto-detect each time.
   */
  projectRoots?: string[];
};

export async function readConfig(): Promise<Config | null> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === "string" && typeof parsed?.base === "string") {
      return parsed as Config;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeConfig(cfg: Config): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export function configPath() {
  return CONFIG_FILE;
}
