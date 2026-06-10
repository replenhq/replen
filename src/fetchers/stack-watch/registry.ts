// Pattern A — "watch your stack". The registry maps the packages a project
// depends on to the upstream vendor whose releases/changelog you'd want to
// know about. A project that imports `next` should hear when Next.js ships a
// release; one that imports `viem` should hear about viem.
//
// v1 changelog source is the vendor's GitHub Releases (dependency-free, no new
// runtime deps, and most dev-tool + AI-SDK vendors publish there). Pure-SaaS
// vendors without a public releases repo (Stripe, Linear, Notion) are a
// follow-on that needs an RSS/HTML changelog adapter — deliberately out of v1
// so this ships real, not stubbed.
//
// Adding a vendor is data, not code: append an entry below. Keep `depNames`
// to the package names that actually appear in a manifest (lowercased match),
// and `githubRepo` to the canonical "owner/name" that cuts releases.

export type StackVendor = {
  id: string; // stable slug; used in source = `stack-watch:<id>`
  name: string; // display name
  depNames: string[]; // manifest package names that signal usage (lowercased match)
  githubRepo: string; // "owner/name" whose GitHub Releases are the changelog
  ecosystem: "npm" | "python" | "cargo" | "go" | "multi";
};

export const STACK_VENDORS: StackVendor[] = [
  // Frameworks / runtimes / build tools
  { id: "nextjs", name: "Next.js", depNames: ["next"], githubRepo: "vercel/next.js", ecosystem: "npm" },
  { id: "vite", name: "Vite", depNames: ["vite"], githubRepo: "vitejs/vite", ecosystem: "npm" },
  { id: "vitest", name: "Vitest", depNames: ["vitest"], githubRepo: "vitest-dev/vitest", ecosystem: "npm" },
  { id: "esbuild", name: "esbuild", depNames: ["esbuild"], githubRepo: "evanw/esbuild", ecosystem: "npm" },
  { id: "tsx", name: "tsx", depNames: ["tsx"], githubRepo: "privatenumber/tsx", ecosystem: "npm" },
  { id: "tailwindcss", name: "Tailwind CSS", depNames: ["tailwindcss"], githubRepo: "tailwindlabs/tailwindcss", ecosystem: "npm" },

  // Data / backend
  { id: "prisma", name: "Prisma", depNames: ["prisma", "@prisma/client"], githubRepo: "prisma/prisma", ecosystem: "npm" },
  { id: "drizzle", name: "Drizzle ORM", depNames: ["drizzle-orm", "drizzle-kit"], githubRepo: "drizzle-team/drizzle-orm", ecosystem: "npm" },
  { id: "supabase", name: "Supabase JS", depNames: ["@supabase/supabase-js"], githubRepo: "supabase/supabase-js", ecosystem: "npm" },
  { id: "tanstack-query", name: "TanStack Query", depNames: ["@tanstack/react-query"], githubRepo: "TanStack/query", ecosystem: "npm" },
  { id: "bullmq", name: "BullMQ", depNames: ["bullmq"], githubRepo: "taskforcesh/bullmq", ecosystem: "npm" },
  { id: "ioredis", name: "ioredis", depNames: ["ioredis"], githubRepo: "redis/ioredis", ecosystem: "npm" },
  { id: "zod", name: "Zod", depNames: ["zod"], githubRepo: "colinhacks/zod", ecosystem: "npm" },

  // Auth
  { id: "next-auth", name: "Auth.js / NextAuth", depNames: ["next-auth", "@auth/core", "@auth/prisma-adapter"], githubRepo: "nextauthjs/next-auth", ecosystem: "npm" },

  // AI SDKs
  { id: "openai", name: "OpenAI SDK", depNames: ["openai"], githubRepo: "openai/openai-node", ecosystem: "npm" },
  { id: "anthropic", name: "Anthropic SDK", depNames: ["@anthropic-ai/sdk"], githubRepo: "anthropics/anthropic-sdk-typescript", ecosystem: "npm" },

  // Web3 / crypto
  { id: "viem", name: "viem", depNames: ["viem"], githubRepo: "wevm/viem", ecosystem: "npm" },
  { id: "wagmi", name: "wagmi", depNames: ["wagmi", "@wagmi/core", "@wagmi/connectors"], githubRepo: "wevm/wagmi", ecosystem: "npm" },
  { id: "ethers", name: "ethers.js", depNames: ["ethers"], githubRepo: "ethers-io/ethers.js", ecosystem: "npm" },
  { id: "solana-web3", name: "Solana web3.js", depNames: ["@solana/web3.js"], githubRepo: "solana-labs/solana-web3.js", ecosystem: "npm" },

  // ── Python / PyPI ──────────────────────────────────────────────────────
  // Dep names are the pip package (lowercased — the route + tech-summary parse
  // both lowercase). Kept to unambiguous Python names (not common npm packages)
  // to avoid cross-ecosystem mismatches. GitHub Releases back all of these.
  { id: "ccxt", name: "CCXT", depNames: ["ccxt"], githubRepo: "ccxt/ccxt", ecosystem: "python" },
  { id: "python-binance", name: "python-binance", depNames: ["python-binance"], githubRepo: "sammchardy/python-binance", ecosystem: "python" },
  { id: "pybit", name: "pybit (Bybit)", depNames: ["pybit"], githubRepo: "bybit-exchange/pybit", ecosystem: "python" },
  { id: "pandas", name: "pandas", depNames: ["pandas"], githubRepo: "pandas-dev/pandas", ecosystem: "python" },
  { id: "numpy", name: "NumPy", depNames: ["numpy"], githubRepo: "numpy/numpy", ecosystem: "python" },
  { id: "scipy", name: "SciPy", depNames: ["scipy"], githubRepo: "scipy/scipy", ecosystem: "python" },
  { id: "polars", name: "Polars", depNames: ["polars"], githubRepo: "pola-rs/polars", ecosystem: "python" },
  { id: "sqlalchemy", name: "SQLAlchemy", depNames: ["sqlalchemy"], githubRepo: "sqlalchemy/sqlalchemy", ecosystem: "python" },
  { id: "fastapi", name: "FastAPI", depNames: ["fastapi"], githubRepo: "fastapi/fastapi", ecosystem: "python" },
  { id: "pydantic", name: "Pydantic", depNames: ["pydantic"], githubRepo: "pydantic/pydantic", ecosystem: "python" },
  { id: "httpx", name: "HTTPX", depNames: ["httpx"], githubRepo: "encode/httpx", ecosystem: "python" },
  { id: "aiohttp", name: "aiohttp", depNames: ["aiohttp"], githubRepo: "aio-libs/aiohttp", ecosystem: "python" },
  { id: "django", name: "Django", depNames: ["django"], githubRepo: "django/django", ecosystem: "python" },
  { id: "flask", name: "Flask", depNames: ["flask"], githubRepo: "pallets/flask", ecosystem: "python" },
  { id: "celery", name: "Celery", depNames: ["celery"], githubRepo: "celery/celery", ecosystem: "python" },
  { id: "scikit-learn", name: "scikit-learn", depNames: ["scikit-learn"], githubRepo: "scikit-learn/scikit-learn", ecosystem: "python" },
  { id: "pytorch", name: "PyTorch", depNames: ["torch"], githubRepo: "pytorch/pytorch", ecosystem: "python" },
  { id: "transformers", name: "Transformers", depNames: ["transformers"], githubRepo: "huggingface/transformers", ecosystem: "python" },
  { id: "langchain", name: "LangChain", depNames: ["langchain", "langchain-core"], githubRepo: "langchain-ai/langchain", ecosystem: "python" },
  { id: "duckdb", name: "DuckDB", depNames: ["duckdb"], githubRepo: "duckdb/duckdb", ecosystem: "python" },
  { id: "ruff", name: "Ruff", depNames: ["ruff"], githubRepo: "astral-sh/ruff", ecosystem: "python" },
  { id: "uv", name: "uv", depNames: ["uv"], githubRepo: "astral-sh/uv", ecosystem: "python" },
];

// depName (lowercased) -> vendor, for O(1) matching.
const byDep = new Map<string, StackVendor>();
for (const v of STACK_VENDORS) {
  for (const d of v.depNames) byDep.set(d.toLowerCase(), v);
}

export function vendorForDep(dep: string): StackVendor | undefined {
  return byDep.get(dep.trim().toLowerCase());
}

// Distinct vendors a dependency set uses.
export function vendorsForDeps(deps: Iterable<string>): StackVendor[] {
  const seen = new Map<string, StackVendor>();
  for (const d of deps) {
    const v = vendorForDep(d);
    if (v) seen.set(v.id, v);
  }
  return [...seen.values()];
}

// Parse the dependency list out of a project's tech_summary, which summarize.ts
// formats as "<lang> project: <name>; deps: a, b, c\ntop-level: ...". Returns a
// lowercased set. Best-effort: returns empty when the summary lacks a deps line.
export function parseTechSummaryDeps(techSummary: string | null): Set<string> {
  const out = new Set<string>();
  if (!techSummary) return out;
  const m = techSummary.match(/deps:\s*([^\n]+)/i);
  if (!m) return out;
  for (const raw of m[1].split(",")) {
    const d = raw.trim().toLowerCase();
    if (d) out.add(d);
  }
  return out;
}

// Dependency names out of the agent-reported dep_versions map ({name: version},
// see /api/projects/versions). The tech_summary deps line only ever existed for
// Node projects, so for Python/Rust/Go repos THIS is the authoritative "already
// a dependency" source. Includes runtime keys (node, python, …) — excluding a
// candidate named after your runtime is correct, not collateral.
export function parseDepVersionNames(depVersions: string | null): Set<string> {
  const out = new Set<string>();
  if (!depVersions) return out;
  try {
    const obj = JSON.parse(depVersions) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) {
        const d = k.trim().toLowerCase();
        if (d) out.add(d);
      }
    }
  } catch { /* malformed JSON — treat as no report */ }
  return out;
}
