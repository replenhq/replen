// Shared HTML / href escaping for all email templates. Keep these in one
// place so the "every interpolated value passes through one of these" rule
// stays auditable.

export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, "&#96;");
}

// Stricter helper for href values. Only http(s) and in-page fragments are
// allowed; anything else (javascript:, data:, vbscript:, file:) collapses to
// an inert `#`. Use this for every `<a href="${...}">` in an email template.
export function escapeHref(s: string): string {
  const t = String(s ?? "").trim();
  if (t.startsWith("#")) return escapeAttr(t);
  try {
    const u = new URL(t);
    if (u.protocol === "http:" || u.protocol === "https:") return escapeAttr(u.toString());
  } catch {
    // fall through
  }
  return "#";
}
