// Shared markdown sanitiser. Run any LLM-derived prose through this before
// either persisting it or rendering it — that way no downstream path has to
// remember to sanitise on its own.
//
//   - Strips HTML tags entirely. GitHub's pipeline ignores them, but local
//     renderers (Claude Code, VSCode preview) and the email body do not.
//   - Defangs script-bearing URI schemes (javascript:, vbscript:, data:,
//     file:) by mangling the colon.
//   - Strips ASCII control characters except \n and \t.
//   - Strips zero-width / bidi-override / BOM code points used as
//     steganography or to spoof identifiers.

export function sanitizeMarkdown(input: string | null | undefined): string {
  if (!input) return "";
  let s = String(input);
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  s = s.replace(/\b(javascript|vbscript|data|file):/gi, "$1_:");
  // ASCII control chars (keep \n=0x0A and \t=0x09). Two ranges around them.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  // Zero-width / bidi-override / BOM
  s = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, "");
  return s;
}
