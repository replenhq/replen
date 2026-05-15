import { fetchRepoMeta, fetchReadme, fetchContributorCount, fetchFileContent, type RepoMeta } from "./github-api";

export type SafetyReport = {
  meta: RepoMeta;
  readmeMd: string;
  readmeSha: string;
  ageDays: number;
  daysSincePush: number;
  contributorCount: number;
  starVelocity: number;
  postinstallHooks: string[];
  suspiciousPatterns: string[];
  secretsFound: boolean;
  riskLevel: "low" | "medium" | "high";
  notes: string[];
};

const SUSPICIOUS_RE: { name: string; re: RegExp }[] = [
  { name: "curl|bash", re: /curl\s+[^\n]*\|\s*(?:bash|sh)\b/i },
  { name: "wget|bash", re: /wget\s+[^\n]*\|\s*(?:bash|sh)\b/i },
  { name: "eval(atob(", re: /eval\s*\(\s*(?:atob|Buffer\.from|decodeURIComponent)/i },
  { name: "child_process w/ remote URL", re: /(?:exec|spawn)\s*\(\s*['"`][^'"`]*https?:\/\//i },
  { name: "ngrok / serveo tunnel", re: /\b(ngrok\.io|serveo\.net|loca\.lt)\b/i },
  { name: "hardcoded private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS secret-looking", re: /AKIA[0-9A-Z]{16}/ },
];

const SECRET_RE = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /sk-[a-zA-Z0-9]{32,}/,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/,
];

export async function scanRepo(owner: string, name: string): Promise<SafetyReport | null> {
  const meta = await fetchRepoMeta(owner, name);
  if (!meta) return null;

  const readme = (await fetchReadme(owner, name)) ?? { sha: "", md: "" };

  const now = Date.now();
  const ageDays = meta.createdAt ? Math.floor((now - +new Date(meta.createdAt)) / 86400_000) : 0;
  const daysSincePush = meta.pushedAt ? Math.floor((now - +new Date(meta.pushedAt)) / 86400_000) : 9999;
  const contributorCount = await fetchContributorCount(owner, name);
  const starVelocity = ageDays > 0 ? meta.stars / Math.max(ageDays, 1) : meta.stars;

  const notes: string[] = [];
  const postinstallHooks: string[] = [];
  const suspiciousPatterns: string[] = [];
  let secretsFound = false;

  const pkgJson = await fetchFileContent(owner, name, "package.json", meta.defaultBranch);
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
        const v = pkg.scripts?.[hook];
        if (v) postinstallHooks.push(`${hook}: ${v}`);
      }
    } catch {
      notes.push("package.json present but unparseable");
    }
  }

  const setupPy = await fetchFileContent(owner, name, "setup.py", meta.defaultBranch);
  if (setupPy && /class\s+\w+\s*\(\s*install\s*\)|cmdclass\s*=/i.test(setupPy)) {
    postinstallHooks.push("setup.py overrides install cmdclass");
  }

  const haystack = [readme.md, pkgJson, setupPy].filter(Boolean).join("\n");
  for (const p of SUSPICIOUS_RE) if (p.re.test(haystack)) suspiciousPatterns.push(p.name);
  for (const r of SECRET_RE) if (r.test(haystack)) { secretsFound = true; break; }

  let riskLevel: "low" | "medium" | "high" = "low";
  if (meta.archived) notes.push("repo is archived");
  if (meta.disabled) notes.push("repo is disabled");
  if (ageDays < 14 && meta.stars > 500) {
    notes.push(`unusually fast: ${meta.stars} stars in ${ageDays} days`);
    riskLevel = "medium";
  }
  if (contributorCount <= 1 && meta.stars > 100) {
    notes.push("single-contributor repo with notable stars");
    if (riskLevel === "low") riskLevel = "medium";
  }
  if (postinstallHooks.length) {
    notes.push(`has install/postinstall hooks (${postinstallHooks.length})`);
    if (riskLevel === "low") riskLevel = "medium";
  }
  if (suspiciousPatterns.length) {
    notes.push(`suspicious patterns: ${suspiciousPatterns.join(", ")}`);
    riskLevel = "high";
  }
  if (secretsFound) {
    notes.push("apparent secrets in tracked files");
    riskLevel = "high";
  }

  return {
    meta,
    readmeMd: readme.md,
    readmeSha: readme.sha,
    ageDays,
    daysSincePush,
    contributorCount,
    starVelocity,
    postinstallHooks,
    suspiciousPatterns,
    secretsFound,
    riskLevel,
    notes,
  };
}
