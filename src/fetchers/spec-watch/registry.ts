// Pattern B — "watch what regulates your code". Where Pattern A watches the
// vendors you depend on, this watches the STANDARDS your code implements:
// token/EIP standards, JS language proposals, browser API changes. A project
// that imports viem/ethers/wagmi has a stake in new ERCs; one that targets the
// browser has a stake in a Chrome deprecation.
//
// The match primitive is the same as Pattern A's — a candidate carries the
// dependency-name signals that imply "this project cares about this standard",
// and the inventory route intersects them with the scoped project's deps to
// decide it's a true stake match (bypasses the relevance floor, sorts to top).
//
// Adding a source is data + a per-kind adapter (see ./sources.ts). v1 covers
// EIPs, ERCs, TC39 proposals (GitHub-commit-backed) and Chrome Platform Status
// (JSON API). WebKit/Firefox status + W3C/IETF RSS are the documented next
// sources, same shape.

export type SpecKind = "eip" | "tc39" | "browser";

export type SpecSource = {
  id: string; // stable slug; used in source = `spec-watch:<id>`
  name: string;
  kind: SpecKind;
  // Manifest package names (lowercased) whose presence means a project has a
  // stake in this standard. The route intersects these with project deps.
  depSignals: string[];
  // Language tokens (lowercased) that also imply a stake — carried for the
  // skill's context and future per-project language matching.
  langSignals: string[];
  // GitHub "owner/name" backing the standard (commit-backed kinds). null for
  // pure-API sources like Chrome Status.
  githubRepo: string | null;
};

export const SPEC_SOURCES: SpecSource[] = [
  {
    id: "ercs",
    name: "Ethereum ERCs",
    kind: "eip",
    depSignals: ["ethers", "viem", "wagmi", "@wagmi/core", "@wagmi/connectors", "@openzeppelin/contracts", "web3"],
    langSignals: ["solidity"],
    githubRepo: "ethereum/ERCs",
  },
  {
    id: "eips",
    name: "Ethereum EIPs",
    kind: "eip",
    depSignals: ["ethers", "viem", "wagmi", "@wagmi/core", "@solana/web3.js", "web3", "hardhat", "@nomicfoundation/hardhat-toolbox"],
    langSignals: ["solidity"],
    githubRepo: "ethereum/EIPs",
  },
  {
    id: "tc39",
    name: "TC39 (JS language proposals)",
    kind: "tc39",
    depSignals: ["typescript", "react", "next", "vite", "@types/node", "esbuild", "tsx"],
    langSignals: ["javascript", "typescript"],
    githubRepo: "tc39/proposals",
  },
  {
    id: "chrome-status",
    name: "Chrome Platform Status",
    kind: "browser",
    depSignals: ["react", "next", "vite", "@types/react", "react-dom", "tailwindcss", "vue", "svelte"],
    langSignals: ["javascript", "typescript"],
    githubRepo: null,
  },
];

// All distinct dep signals across every source, lowercased — lets a caller
// cheaply pre-check whether a project has ANY spec stake before doing work.
const allDepSignals = new Set<string>();
for (const s of SPEC_SOURCES) for (const d of s.depSignals) allDepSignals.add(d.toLowerCase());

// Which spec sources a project's dependency set has a stake in.
export function specSourcesForDeps(deps: Set<string>): SpecSource[] {
  if (deps.size === 0) return [];
  const out: SpecSource[] = [];
  for (const s of SPEC_SOURCES) {
    if (s.depSignals.some((d) => deps.has(d.toLowerCase()))) out.push(s);
  }
  return out;
}

export function hasAnySpecStake(deps: Set<string>): boolean {
  for (const d of deps) if (allDepSignals.has(d)) return true;
  return false;
}
