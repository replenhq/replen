// Tokeniser for the candidate-OSS indexer.
//
// Two competing goals:
//   - Recall: split identifiers so a query like "user auth" matches a chunk
//     containing `getUserAuth` or `user_auth_token`.
//   - Precision: keep the original identifier as a single token so an exact
//     symbol query ("save_pretrained") finds chunks that contain it verbatim.
//
// Resolution: index BOTH the original token AND its sub-tokens. Storage is
// cheap; the inverted index grows by a constant factor (~2-3x) but the
// retrieval quality gain is large.
//
// Splitting rules:
//   - Lowercase everything.
//   - Split on every non-alphanumeric run.
//   - Then for each alphanumeric run, also emit camelCase / snake_case
//     sub-tokens.
//   - Drop empty results.
//   - Drop tokens of length 1 except digits (single letters carry no
//     useful signal; "i", "a", "x" appear in every chunk).

const MIN_TOKEN_LENGTH = 2;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  // First pass: split on non-alphanum to get word-level pieces (preserving
  // case so we can do camelCase splitting on the originals).
  const words = text.split(/[^\p{L}\p{N}]+/u);
  for (const word of words) {
    if (!word) continue;
    const lower = word.toLowerCase();
    if (lower.length >= MIN_TOKEN_LENGTH) out.push(lower);

    // Sub-tokens from camelCase / PascalCase boundaries.
    // "getUserAuth" → ["get", "user", "auth"]
    // "HTTPSConnection" → ["https", "connection"] (run of caps + following word)
    // Underscores were already split by the non-alphanum regex above so
    // "save_pretrained" → "save_pretrained" became ["save", "pretrained"]
    // and we add no further sub-tokens for those.
    for (const sub of splitCamel(word)) {
      const subLower = sub.toLowerCase();
      if (subLower.length >= MIN_TOKEN_LENGTH && subLower !== lower) out.push(subLower);
    }
  }
  return out;
}

// Heuristic camelCase splitter. Returns sub-tokens only when at least one
// case-boundary is found; otherwise returns []. Handles:
//   getUserAuth   → ["get", "User", "Auth"]
//   HTTPSConn     → ["HTTPS", "Conn"]
//   parseURL      → ["parse", "URL"]
//   alllower      → []
//   ALLUPPER      → []
function splitCamel(word: string): string[] {
  // Quick reject: no uppercase letters at all, nothing to split.
  if (!/[A-Z]/.test(word)) return [];
  const parts: string[] = [];
  let i = 0;
  while (i < word.length) {
    let j = i + 1;
    // Run of uppercase
    if (isUpper(word[i])) {
      while (j < word.length && isUpper(word[j])) j++;
      // If the next character is lowercase, the last uppercase letter
      // belongs to the next word (HTTPSConn → HTTPS + Conn, where "S" is
      // shared boundary). Walk back one char if we have at least two caps.
      if (j < word.length && isLower(word[j]) && j - i > 1) j--;
    } else {
      // Run of non-uppercase
      while (j < word.length && !isUpper(word[j])) j++;
    }
    parts.push(word.slice(i, j));
    i = j;
  }
  // If splitting produced exactly one part equal to the input, it wasn't
  // really camelCase (no boundaries crossed). Return nothing.
  if (parts.length <= 1) return [];
  return parts;
}

function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}
function isLower(c: string): boolean {
  return c >= "a" && c <= "z";
}
