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

- A compromised user laptop: by design, anyone with shell access to a logged-in machine can read `~/.replen/config.json` and exfiltrate the user's ingest token, plus read the AES-encrypted material on `~/.claude.json`. Local security is the user's responsibility.
- Self-hosted deployments operated outside our control. We document the recommended hardening below; you choose whether to follow it.
- Issues that require physical access to the VPS hosting `app.replen.dev`.

## Threat model

What we explicitly defend against:

- **At-rest secret exposure via DB leak.** All user secrets (GitHub PAT, LLM API keys) are encrypted under a per-user Data Encryption Key (DEK), which is itself wrapped by a master KEK held in `ENCRYPTION_KEY`. See [docs/security/secrets.md](docs/security/secrets.md).
- **Ingest token replay.** Ingest tokens are stored as `sha256(token)` only; the plaintext lives in the user's CLI config and the one-time exchange-code response after authorize.
- **Cross-tenant data access.** Every Drizzle query that crosses a `userId` boundary carries the `eq(userId, auth.userId)` clause, including secondary fetches of `project_profiles` after a `userId`-scoped `matches` lookup.
- **Origin-bypass via direct IP.** When `REQUIRE_CLOUDFLARE=1`, the origin rejects any request lacking the `cf-connecting-ip` header (and optionally an `x-cf-origin-secret` shared header set by a Cloudflare Transform Rule). The VPS IP must remain hidden.
- **CSRF on server actions.** Next.js's same-origin guard plus a strict CSP including `form-action 'self'` and `frame-ancestors 'none'`.
- **Prompt injection through scraped READMEs.** Untrusted content is wrapped in `<UNTRUSTED_…>` delimiters; the LLM is told to treat wrapped content as opaque data. Outputs are scanned for system-prompt leaks and URLs outside an allowlist (`github.com`, `*.githubusercontent.com`, etc.). On match, the writeup is discarded.
- **SSRF via webhook URLs.** User-supplied webhook URLs are validated syntactically (https-only, no IP literals, no `.local`/`.internal` suffixes) and again at fetch time via DNS resolution against private/loopback/link-local/multicast ranges.
- **Token in URL.** The CLI authorize flow uses a 2-minute one-time exchange code, not the long-lived ingest token, in browser-bound redirects.
- **Plain-text settings dumps.** The settings page shows `•••••` for each secret on every render and only emits the plaintext ingest token once (via a `?newToken=…` redirect param consumed on the next render).

What we explicitly don't defend against (yet):

- A malicious user with an active session in the same tenant. Replen is multi-tenant by row-level filtering; a tenant with admin-granted access can see other admin actions but not other users' data.
- A backdoored Cloudflare account. Origin pulls authenticated by Cloudflare's origin CA (recommended) reduce but don't eliminate this.
- LLM-level prompt injection that produces grammatically-correct prose with only allowlisted URLs. The denylist + URL allowlist + system prompt are mitigations, not guarantees.

## Recommended deployment hardening

Production deployments should set every flag below.

### Required env vars

| Var | Required | Notes |
|---|---|---|
| `ENCRYPTION_KEY` | yes (production) | base64 of 32 random bytes. App refuses to boot without it in `NODE_ENV=production`. |
| `BOOTSTRAP_ADMIN_EMAIL` | yes | only the verified email matching this string is granted `admin` on first sign-in. Without this, no admin can be created by sign-up. |
| `REQUIRE_CLOUDFLARE` | yes (`1`) | reject any request lacking `cf-connecting-ip`. |
| `CF_ORIGIN_SECRET` | recommended | pair with a Cloudflare Transform Rule that injects `x-cf-origin-secret: $secret` on every forwarded request. Defeats header spoofing by direct-IP attackers. |
| `COOKIE_SECRET_CURRENT` / `COOKIE_SECRET_PREVIOUS` | yes | 32+ random chars each. Rotate by promoting `CURRENT` → `PREVIOUS` and minting a new `CURRENT`. |
| `SES_SMTP_*` / `EMAIL_FROM_ADDRESS` | yes for email delivery | |
| `PUBLIC_BASE_URL` | yes | used for outbound links + CLI auth callbacks. |

### Cloudflare configuration

1. **Tunnel.** Use `cloudflared` so the VPS has no public ports beyond SSH (and even SSH should be IP-allowlisted to your fixed-IP egress).
2. **Authenticated Origin Pulls.** Enable for the zone and require `ssl_verify_client on` in nginx. Forces Cloudflare's client cert on every request — direct-IP scans land on a 400.
3. **WAF rules.** Block requests to `/api/cli-auth/exchange` from anywhere except known CDN-edge IPs (the exchange is server-to-server from the CLI's localhost, then through Cloudflare).
4. **Rate limiting.** A 50/min cap on `/login`, `/api/login`, `/api/cli-auth/exchange`, `/api/ingest`.

### VPS hardening

- `ufw default deny incoming; ufw allow 22/tcp` — Cloudflare Tunnel handles 443 without exposing a port.
- Restrict SSH to publickey-only and 2FA.
- File mode 0600 on `.env`, `data/digest.sqlite`, and any backups.

### Future work

These hardening steps are documented but not yet implemented in this codebase:

- **AWS Secrets Manager / Cloud KMS for `ENCRYPTION_KEY`.** Today the master KEK lives in the `.env` file on the VPS. Pulling it from a managed KMS at boot (with the IAM grant tied to the VPS instance role) removes the key from disk entirely.
- **Replace user-scope GitHub PATs with a GitHub App.** Today the recommended PAT scope is `Contents: write` + `Pull requests: write` across **all** of the user's repositories. A GitHub App installation can scope per-repo and uses 1-hour installation tokens. See `docs/security/github-app-migration.md` (planned).
- **Audit-log forwarding.** `secret_access_log` is read locally only. Forward to a write-only log sink for tamper-evident archival.

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

## Past audits

- 2026-05-15: full internal audit. 2 critical + 5 high + 7 medium findings, all addressed in commits dated 2026-05-15 through 2026-05-16. See git log for the granular changes.
