#!/usr/bin/env bash
# Rsync the replen.dev marketing site and the replen-docs docs site to the
# VPS, where nginx serves them on 127.0.0.1:8080 behind the Cloudflare
# Tunnel (Host-header-routed). No build step - both are static.
#
# Usage:
#   bash scripts/deploy-static.sh             # both sites
#   bash scripts/deploy-static.sh marketing   # just the marketing site
#   bash scripts/deploy-static.sh docs        # just the docs site
#
# Configure via env (set DEPLOY_HOST to your SSH alias, e.g. in ~/.ssh/config):
#   DEPLOY_HOST       SSH alias (default: replen-host)
#   MARKETING_SRC     local dir for marketing site (default: ~/github/replen.dev)
#   DOCS_SRC          local dir for docs site (default: ~/github/replen-docs)
#   STATUS_SRC        local dir for status site (default: ~/github/replen-status)
#   MARKETING_DEST    remote dir (default: /var/www/replen.dev)
#   DOCS_DEST         remote dir (default: /var/www/docs.replen.dev)
#   STATUS_DEST       remote dir (default: /var/www/status.replen.dev)
set -euo pipefail

REMOTE="${DEPLOY_HOST:-replen-host}"
MARKETING_SRC="${MARKETING_SRC:-$HOME/github/replen.dev}"
DOCS_SRC="${DOCS_SRC:-$HOME/github/replen-docs}"
STATUS_SRC="${STATUS_SRC:-$HOME/github/replen-status}"
MARKETING_DEST="${MARKETING_DEST:-/var/www/replen.dev}"
DOCS_DEST="${DOCS_DEST:-/var/www/docs.replen.dev}"
STATUS_DEST="${STATUS_DEST:-/var/www/status.replen.dev}"

WHICH="${1:-both}"

rsync_site() {
  local src="$1" dest="$2" label="$3"
  echo "[$label] rsync $src → $REMOTE:$dest"
  rsync -az --delete \
    --exclude='.git/' \
    --exclude='.DS_Store' \
    --exclude='*.log' \
    --exclude='AGENTS.md' \
    --exclude='CLAUDE.md' \
    --exclude='GEMINI.md' \
    --exclude='.env' \
    --exclude='.env.*' \
    "$src/" "$REMOTE:$dest/"
  echo "[$label] done"
}

case "$WHICH" in
  marketing)
    rsync_site "$MARKETING_SRC" "$MARKETING_DEST" "marketing"
    ;;
  docs)
    rsync_site "$DOCS_SRC" "$DOCS_DEST" "docs"
    ;;
  status)
    rsync_site "$STATUS_SRC" "$STATUS_DEST" "status"
    ;;
  both)
    rsync_site "$MARKETING_SRC" "$MARKETING_DEST" "marketing"
    rsync_site "$DOCS_SRC" "$DOCS_DEST" "docs"
    [ -d "$STATUS_SRC" ] && rsync_site "$STATUS_SRC" "$STATUS_DEST" "status" || true
    ;;
  *)
    echo "Usage: $0 [marketing|docs|status|both]" >&2
    exit 1
    ;;
esac

echo
echo "Done. nginx serves these from 127.0.0.1:8080 via Cloudflare Tunnel."
echo "  https://replen.dev"
echo "  https://docs.replen.dev"
echo "  https://status.replen.dev   (needs the nginx vhost + tunnel route + DNS, see scripts/status-subdomain-setup.md)"
