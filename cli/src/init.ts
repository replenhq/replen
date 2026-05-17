import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { writeConfig, configPath } from "./config.js";
import { setupMcp } from "./mcp-setup.js";

// Default web app URL. Override with REPLEN_BASE for self-host.
const DEFAULT_BASE = process.env.REPLEN_BASE || "https://app.replen.dev";

// Range for the local callback listener. Anything in 1024-65535 works.
const PORT_MIN = 38000;
const PORT_MAX = 39000;

function pickPort(): number {
  return PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
}

function openBrowser(url: string): void {
  const cmd =
    platform() === "darwin" ? "open"
    : platform() === "win32" ? "start"
    : "xdg-open";
  // Detach. We don't care about its exit.
  const proc = spawn(cmd, [url], { stdio: "ignore", detached: true });
  proc.on("error", () => {
    // Fail silently. We print the URL anyway as fallback.
  });
  proc.unref();
}

type CallbackResult = { code: string };

function waitForCallback(port: number, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Defence in depth against DNS rebinding: only accept requests whose
      // Host header matches the loopback bind. Modern browsers (Chrome ≥ M94)
      // already block public-DNS hostnames from rebinding to RFC1918, but an
      // explicit check costs nothing.
      const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      const reqHost = (req.headers.host ?? "").toLowerCase();
      if (!expectedHosts.has(reqHost)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad host");
        return;
      }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("missing code/state");
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("state mismatch");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      // Give the response a tick to flush before we shut down the listener.
      setTimeout(() => server.close(), 100);
      resolve({ code });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");

    // 5-minute timeout. Browser closed, user wandered off, etc.
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for browser callback (5 min)."));
    }, 5 * 60 * 1000);
    server.on("close", () => clearTimeout(timeout));
  });
}

async function exchangeCode(base: string, code: string, state: string): Promise<{ token: string; base: string }> {
  const res = await fetch(`${base}/api/cli-auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, state }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string; base?: string; error?: string };
  if (!res.ok || !body.ok || !body.token) {
    throw new Error(`Exchange failed: ${body.error ?? `HTTP ${res.status}`}`);
  }
  return { token: body.token, base: body.base || base };
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>replen: authorized</title>
<style>
  body { font: 15px system-ui, -apple-system, sans-serif; max-width: 480px;
         margin: 80px auto; padding: 0 24px; color: #111; line-height: 1.55; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #555; margin: 8px 0; }
  .ok { color: #16a34a; font-weight: 600; }
</style></head>
<body>
  <h1><span class="ok">✓</span> Authorized</h1>
  <p>The replen CLI is now connected to your account.</p>
  <p>You can close this tab and head back to your terminal. The CLI is finishing setup.</p>
</body></html>`;

export async function runInit(): Promise<void> {
  const state = randomBytes(32).toString("hex");
  const port = pickPort();
  const base = DEFAULT_BASE;
  const authUrl = `${base}/cli-auth?port=${port}&state=${state}`;

  console.log("");
  console.log("  Opening your browser to sign in to replen…");
  console.log("");
  console.log(`  If it doesn't open automatically, visit:`);
  console.log(`    ${authUrl}`);
  console.log("");
  console.log("  (Waiting for browser callback on http://127.0.0.1:" + port + "…)");
  console.log("");

  openBrowser(authUrl);

  let cb: CallbackResult;
  try {
    cb = await waitForCallback(port, state);
  } catch (e: unknown) {
    console.error("  ✗ " + ((e as Error)?.message ?? String(e)));
    process.exit(1);
  }

  let exchange: { token: string; base: string };
  try {
    exchange = await exchangeCode(base, cb.code, state);
  } catch (e: unknown) {
    console.error("  ✗ " + ((e as Error)?.message ?? String(e)));
    process.exit(1);
  }

  await writeConfig({
    token: exchange.token,
    base: exchange.base,
    savedAt: new Date().toISOString(),
  });
  console.log(`  ✓ Saved auth to ${configPath()}`);

  await setupMcp(exchange.token, exchange.base);

  console.log("");
  console.log("  All set. Restart Claude Code (or Codex) and try:");
  console.log("    /replen-triage      → runs the morning triage protocol");
  console.log("    use replen to replen_today → pulls today's matches");
  console.log("");
  console.log(`  Dashboard: ${exchange.base}`);
  console.log("");
}
