import { requireAdmin2fa } from "@/lib/admin/2fa";
import { promises as fsp } from "node:fs";
import path from "node:path";

// Admin-only "recent errors" viewer. Tails the systemd service log
// (web.log written by the service unit) and surfaces ERROR/WARN lines
// without needing SSH access.
//
// Reads the last N kilobytes from EOF so the page stays cheap even when
// the log file is hundreds of MB. Doesn't try to parse stack traces —
// just shows the matching lines with a small amount of surrounding
// context.
//
// Log file location is configurable via REPLEN_LOG_FILE (default:
// /var/log/replen/web.log on the production deploy). In dev, point it
// at .next/server/* or stub it out; the page degrades gracefully when
// the file is missing.

export const dynamic = "force-dynamic";

const LOG_FILE_RAW = process.env.REPLEN_LOG_FILE ?? "/var/log/replen/web.log";
// Resolve + containment-check in production. The env var is operator-set, not
// user-set, so this is defence-in-depth — but cheap insurance against a future
// path-traversal slip if the env ever gets pulled from somewhere less trusted.
const LOG_FILE_RESOLVED = path.resolve(LOG_FILE_RAW);
const LOG_FILE_ALLOWED =
  process.env.NODE_ENV !== "production" ||
  LOG_FILE_RESOLVED.startsWith("/var/log/") ||
  LOG_FILE_RESOLVED.startsWith("/tmp/");
const LOG_FILE = LOG_FILE_ALLOWED ? LOG_FILE_RESOLVED : null;
const TAIL_BYTES = 256 * 1024; // 256 KB
const MAX_LINES = 200;
const KEEP = /\[(error|warn)\]|\bError:|\bRangeError\b|\bTypeError\b|console\.error|console\.warn|^.{0,40}(error|warn)/i;

// Strip C0 control characters except \t. Defence-in-depth: even though React
// auto-escapes JSX text children (so a log line with HTML can't inject XSS),
// embedded \r / \x1b sequences can visually overwrite or recolour a row.
// Replace each control char with a centred-dot so the alignment of nearby
// rows stays predictable.
function sanitiseLine(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "·");
}

async function readTail(file: string): Promise<string | { error: string }> {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (e) {
    return { error: `cannot stat ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const offset = Math.max(0, stat.size - TAIL_BYTES);
  const length = Math.min(TAIL_BYTES, stat.size);
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    await fh.read(buf, 0, length, offset);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

type Entry = { ts: string; level: "error" | "warn" | "info"; line: string };

function parseLines(text: string): Entry[] {
  const out: Entry[] = [];
  const lines = text.split("\n");
  // Drop the first line if we tailed mid-line.
  const startIdx = text.startsWith("\n") ? 0 : 1;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 4) continue;
    if (!KEEP.test(line)) continue;
    const tsMatch = line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\.\dZ+-:]*)/);
    const lower = line.toLowerCase();
    const level: Entry["level"] = lower.includes("[error]") || lower.includes("error:")
      ? "error"
      : lower.includes("[warn]") || lower.includes("warn")
        ? "warn"
        : "info";
    out.push({ ts: tsMatch?.[1] ?? "", level, line: sanitiseLine(line.slice(0, 800)) });
  }
  // Newest first; cap.
  return out.reverse().slice(0, MAX_LINES);
}

export default async function AdminErrorsPage() {
  await requireAdmin2fa();
  if (!LOG_FILE) {
    return (
      <main style={{ maxWidth: 960, margin: "32px auto", padding: "0 16px" }}>
        <h1>Recent errors</h1>
        <p className="meta">Refusing to read <code>{LOG_FILE_RAW}</code>: outside the allow-list (<code>/var/log/</code> or <code>/tmp/</code>) in production. Set <code>REPLEN_LOG_FILE</code> to a path under those prefixes.</p>
      </main>
    );
  }
  const tail = await readTail(LOG_FILE);
  if (typeof tail !== "string") {
    return (
      <main style={{ maxWidth: 960, margin: "32px auto", padding: "0 16px" }}>
        <h1>Recent errors</h1>
        <p className="meta">Reading <code>{LOG_FILE}</code>:</p>
        <pre style={{ background: "var(--surface-1, #fff2f2)", padding: 12, borderRadius: 6 }}>{tail.error}</pre>
        <p className="meta">Set <code>REPLEN_LOG_FILE</code> if your log path differs. In dev there may be no file at all; this page is most useful on the prod VPS.</p>
      </main>
    );
  }
  const entries = parseLines(tail);
  return (
    <main style={{ maxWidth: 960, margin: "32px auto", padding: "0 16px" }}>
      <h1>Recent errors</h1>
      <p className="meta">
        Last {Math.round(TAIL_BYTES / 1024)} KB of <code>{path.basename(LOG_FILE)}</code> &middot; {entries.length} ERROR/WARN lines shown (newest first, capped at {MAX_LINES}).
      </p>
      {entries.length === 0 ? (
        <p>No recent errors or warnings. Good morning.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, fontFamily: "ui-monospace, SF Mono, Menlo, monospace" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border, #ddd)", whiteSpace: "nowrap" }}>When</th>
              <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border, #ddd)", whiteSpace: "nowrap" }}>Level</th>
              <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border, #ddd)" }}>Message</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} style={{ background: e.level === "error" ? "rgba(239,68,68,0.06)" : "transparent" }}>
                <td style={{ padding: "4px 8px", borderBottom: "1px solid var(--border, #eee)", color: "var(--faint, #888)", whiteSpace: "nowrap" }}>{e.ts || "—"}</td>
                <td style={{ padding: "4px 8px", borderBottom: "1px solid var(--border, #eee)", color: e.level === "error" ? "#b91c1c" : "#92400e", fontWeight: 600, textTransform: "uppercase", fontSize: 11 }}>{e.level}</td>
                <td style={{ padding: "4px 8px", borderBottom: "1px solid var(--border, #eee)", wordBreak: "break-word" }}>{e.line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="meta" style={{ marginTop: 16 }}>
        For a full live tail: <code>ssh &lt;your-vps&gt; &apos;sudo tail -f {LOG_FILE}&apos;</code>. For an alerted external view, point an uptime monitor at <code>/api/healthz</code> and a log shipper (e.g. BetterStack Logs) at the same file.
      </p>
    </main>
  );
}
