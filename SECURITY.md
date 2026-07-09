# Security policy

Replen is a small open-source project run by a single maintainer. We take security seriously and aim to respond to reports within 72 hours.

## Reporting a vulnerability

Email **tech@replen.dev** with:

- A description of the issue
- Steps to reproduce
- Affected component (hosted `app.replen.dev`, self-host code, `npx replen` CLI, `@replen/mcp`)
- Whether the issue is already public (please default to "no" until we've had a chance to triage)

Please **do not** open public GitHub issues for security bugs. We'll coordinate disclosure once a fix is available.

## Scope

In scope:

- Server-side code in this repository
- `cli/` (npm `replen`)
- `mcp/` (npm `@replen/mcp`)
- The hosted dashboard at `app.replen.dev`

Out of scope:

- A compromised laptop: by design, anyone with shell access to a logged-in machine can read `~/.replen/config.json` and exfiltrate the ingest token. Local security is your responsibility.
- Self-hosted deployments operated outside our control. We document the recommended hardening below; you choose whether to follow it.
- Issues that require physical access to the server hosting `app.replen.dev`.

This policy covers the code in this repo and the hosted instance at `app.replen.dev`. Self-host is designed for **personal use**, not for re-hosting replen as a service for other people; the docs below assume you're running it for yourself.

## Threat model

What we explicitly defend against:

- **At-rest secret exposure via DB leak.** All user secrets (GitHub PAT, LLM API keys) are encrypted under a per-user Data Encryption Key (DEK), which is itself wrapped by a master KEK held in `ENCRYPTION_KEY`. See [docs/security/secrets.md](docs/security/secrets.md).
- **Ingest token replay.** Ingest tokens are stored as `sha256(token)` only; the plaintext lives in the user's CLI config and the one-time exchange-code response after authorize.
- **Per-user data isolation.** Every Drizzle query that crosses a `userId` boundary carries the `eq(userId, auth.userId)` clause, including secondary fetches of `project_profiles` after a `userId`-scoped `matches` lookup. This is what protects accounts on the hosted instance from seeing each other's data; solo self-host inherits it for free.
- **Origin-bypass via direct IP.** When `REQUIRE_CLOUDFLARE=1`, the origin rejects any request lacking the `cf-connecting-ip` header (and optionally an `x-replen-edge-secret` shared header set by a Cloudflare Transform Rule). The server IP must remain hidden.
- **CSRF on server actions.** Next.js's same-origin guard plus a strict CSP including `form-action 'self'` and `frame-ancestors 'none'`.
- **Prompt injection through scraped READMEs.** Untrusted content is wrapped in `<UNTRUSTED_…>` delimiters; the LLM is told to treat wrapped content as opaque data. Outputs are scanned for system-prompt leaks and URLs outside an allowlist (`github.com`, `*.githubusercontent.com`, etc.). On match, the writeup is discarded.
- **SSRF via webhook URLs.** User-supplied webhook URLs are validated syntactically (https-only, no IP literals, no `.local`/`.internal` suffixes) and again at fetch time via DNS resolution against private/loopback/link-local/multicast ranges. The resolved address is pinned through an undici dispatcher so a hostile resolver cannot DNS-rebind between validation and fetch.
- **SSRF + key exfil via user LLM base URL.** The Primary / Sensitive LLM base URLs accept the same SSRF gauntlet as webhooks (validate-on-save + resolve-and-pin-on-fetch). If the user overrides the base URL without supplying their own API key, we refuse to send the operator's shared env key — otherwise the user's chosen endpoint would receive a credential it shouldn't have.
- **Token in URL.** The CLI authorize flow uses a 2-minute one-time exchange code, not the long-lived ingest token, in browser-bound redirects.
- **Plain-text settings dumps.** The settings page shows `•••••` for each secret on every render and only emits the plaintext ingest token once (via a `?newToken=…` redirect param consumed on the next render).

No system is perfectly secure. Some defenses are layered mitigations rather than absolute guarantees, and a few depend on the integrity of upstream infrastructure. If you believe you have found a gap, please report it via the process above.

## Recommended self-host hardening

If you run replen for yourself on a public domain, set every flag below. Local-only setups (running on `localhost`, no inbound) can skip the Cloudflare and cookie-rotation rows.

### Required env vars

| Var | Required | Notes |
|---|---|---|
| `ENCRYPTION_KEY` | yes (production) | base64 of 32 random bytes. App refuses to boot without it in `NODE_ENV=production`. |
| `BOOTSTRAP_ADMIN_EMAIL` | yes | the verified email for your account. Only this email is granted access on first sign-in; nothing else will. Set it to the email you use with Firebase Auth. |
| `REQUIRE_CLOUDFLARE` | yes (`1`) if public | reject any request lacking `cf-connecting-ip`. Skip if you're only ever serving over `localhost`. |
| `CF_ORIGIN_SECRET` | recommended if public | pair with a Cloudflare Transform Rule that injects `x-replen-edge-secret: $secret` on every forwarded request. Defeats header spoofing by direct-IP attackers. |
| `COOKIE_SECRET_CURRENT` / `COOKIE_SECRET_PREVIOUS` | yes if public | 32+ random chars each. Rotate by promoting `CURRENT` → `PREVIOUS` and minting a new `CURRENT`. |
| `EMAIL_PROVIDER` + provider-specific creds | yes for email delivery | see `.env.example` |
| `PUBLIC_BASE_URL` | yes | used for outbound links + CLI auth callbacks. |
| `AUTH_COOKIE_DOMAIN` | **no — leave unset** | host-only session cookie by default. Setting `.example.com` sends the cookie to *every* subdomain; only do this when every sibling subdomain is first-party and equally trusted. |
| `SYNC_USER_ID` | yes if `SYNC_TOKEN` set | numeric `users.id` the laptop sync CLI is authorised to read. Other user_id values return 403 even with the right token. |

### Cloudflare configuration

1. **Tunnel.** Use `cloudflared` so the server has no public ports beyond SSH (and even SSH should be IP-allowlisted to your fixed-IP egress).
2. **Transform Rule** that injects `x-replen-edge-secret` on every request to `app.replen.dev`. The origin's middleware refuses any request lacking both this header (with the matching `CF_ORIGIN_SECRET` value) AND `cf-connecting-ip`.
3. **Authenticated Origin Pulls.** Not applicable when using cloudflared tunnel: the tunnel is outbound-only and there's no inbound TLS handshake on origin where AOP could attach. The Transform Rule + `REQUIRE_CLOUDFLARE=1` provides equivalent protection. Enable AOP only if you ever expose nginx on port 443 directly (i.e. abandon the tunnel architecture).
4. **WAF rules.** Block requests to `/api/cli-auth/exchange` from anywhere except known CDN-edge IPs (the exchange is server-to-server from the CLI's localhost, then through Cloudflare).
5. **Rate limiting.** A 50/min cap on `/login`, `/api/login`, `/api/cli-auth/exchange`, `/api/ingest`.

### Host hardening

- `ufw default deny incoming; ufw allow 22/tcp` — Cloudflare Tunnel handles 443 without exposing a port.
- Restrict SSH to publickey-only and 2FA.
- File mode 0600 on `.env`, `data/digest.sqlite`, and any backups.

### Optional hardening for stricter deployments

Beyond the baseline above, deployments with stricter requirements can:

- **Source `ENCRYPTION_KEY` from a cloud KMS or secrets manager** at boot rather than holding it in an environment file, so the master key is never written to disk. Bind the grant to the server's instance role.
- **Use a GitHub App instead of a personal access token** for per-repository scope and short-lived installation tokens.
- **Forward the secret-access log** to a write-only, append-only sink for tamper-evident archival.

## Forensic surface

When investigating a possible incident, useful queries:

```sql
-- decrypts in the last 24h, by reason
SELECT reason, COUNT(*) FROM secret_access_log
WHERE accessed_at > strftime('%s','now') - 86400
GROUP BY reason ORDER BY 2 DESC;

-- recent unsuccessful decrypts (likely a key mismatch or v2 cross-user attempt)
SELECT * FROM secret_access_log WHERE success = 0 ORDER BY accessed_at DESC LIMIT 50;

-- users with no pipeline runs but lots of settings-view decrypts (suspicious)
SELECT user_id, COUNT(*) FROM secret_access_log
WHERE reason = 'settings-view' AND accessed_at > strftime('%s','now') - 7*86400
GROUP BY user_id HAVING COUNT(*) > 50;
```

## Token-header conventions

The ingest token is accepted under either `x-ingest-token` (canonical) or
`x-digest-token` (legacy MCP-side name) on both `/api/ingest` and
`/api/mcp/*`. Pick `x-ingest-token` for new code; the alias may be removed
once the MCP package has been on a release that uses the canonical name for
≥ 6 months.

Neither endpoint emits `Access-Control-Allow-Origin: *`. The bookmarklet's
browser context bypasses CORS for its own fetch; the MCP server is a Node
process that doesn't go through a browser preflight at all. Browser
cross-origin calls therefore fail at preflight even with a stolen token —
the token check is defence in depth, not the only line.

## Security posture

Replen is built so that its most sensitive guarantees are enforced by architecture, not convention:

- **No server-side per-candidate reasoning.** The expensive per-candidate analysis runs inside your own AI tool's session, never on the server, so there is no server-side model call to inject into or run up a bill on.
- **Source code stays on your machine.** Out of the box the server sees repository identity, your curated tags, and aggregate signal only. The optional hosted code-grounding tier sends source to an embedding provider purely to turn it into numeric vectors, then discards it; only the vectors persist, never source at rest.
- **Credentials are protected at rest.** Access tokens are stored only as hashes and looked up by hash. Per-user secrets (GitHub tokens, webhook URLs, model keys) are encrypted with per-user keys wrapped by a master key, with the account identity bound into each record so ciphertexts cannot be transplanted between accounts.
- **Strong tenant isolation.** Every authenticated read and write is scoped to the authenticated account, and client-supplied identifiers are re-validated against that account before any change.
- **Anonymity on shared data.** The cross-user catalogue carries no account identity and no code. A capability term is shared only when it is a generic seed term or independently present for enough distinct accounts, and synthetic test accounts are excluded from these aggregates.
- **External content is data, not instructions.** Third-party repository content (READMEs, descriptions, file contents) is treated as untrusted data to evaluate, both in the server-side analysis and on the in-session triage path, so it cannot steer your agent.
- **Standard web defenses in depth.** Parameterized database access, validated and address-pinned outbound requests, a strict nonce-based content security policy, transport security, and secure signed session cookies are applied centrally.

The project is reviewed adversarially on a recurring basis. Findings are triaged by severity, material findings are resolved promptly, and remaining low-severity items are tracked as hardening. We do not publish exploit-enabling specifics; please report anything you find via the process above.

## Past audits

- 2026-06-29: full adversarial review covering the server, MCP server, CLI, every API endpoint, the prompt-injection / agent-trust boundary, cross-user privacy, secret handling, and infrastructure. All material findings were resolved; remaining low-severity items are tracked as hardening.
- 2026-05-15: full internal review with the same scope. All material findings were resolved; remaining low-severity items are tracked as hardening.
