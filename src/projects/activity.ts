// Activity types only.
//
// The original module read git activity from a local filesystem mirror;
// after the GitHub-pull rebuild that probe lives in src/github/activity-via-api.ts
// (same ProjectActivity shape, sourced via the REST API). This file now
// only exports types so downstream consumers (activity-summary,
// activity-via-api, the activity-pill UI) keep importing from a stable
// location.

export type CommitRow = {
  sha: string;
  isoDate: string;
  subject: string;
};
export type ChangedFile = {
  path: string;
  changes: number;
};
export type TodoCluster = {
  dir: string;
  count: number;
  examples: string[];
};
export type OpenPR = {
  number: number;
  title: string;
  bodyExcerpt: string | null;
  branchHead: string | null;
  updatedAt: string | null;
};

export type ProjectActivity = {
  isGitRepo: boolean;
  headSha: string | null;
  branch: string | null;
  // Last 100 commits within the lookback window. Oldest last.
  commits: CommitRow[];
  // Top files by changes touched in the lookback window. Capped at 25.
  topChangedFiles: ChangedFile[];
  // TODO/FIXME clusters keyed by directory, sorted by count.
  todoClusters: TodoCluster[];
  // Open PRs (if github_full_name + token available). Cap 10.
  openPRs: OpenPR[];
  // Days since the most recent commit. Null when no commits at all.
  daysSinceLastCommit: number | null;
};
