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
#   MARKETING_DEST    remote dir (default: /var/www/replen.dev)
#   DOCS_DEST         remote dir (default: /var/www/docs.replen.dev)
set -euo pipefail

REMOTE="${DEPLOY_HOST:-replen-host}"
MARKETING_SRC="${MARKETING_SRC:-$HOME/github/replen.dev}"
DOCS_SRC="${DOCS_SRC:-$HOME/github/replen-docs}"
MARKETING_DEST="${MARKETING_DEST:-/var/www/replen.dev}"
DOCS_DEST="${DOCS_DEST:-/var/www/docs.replen.dev}"

WHICH="${1:-both}"

rsync_site() {
  local src="$1" dest="$2" label="$3"
  echo "[$label] rsync $src → $REMOTE:$dest"
  rsync -az --delete \
    --exclude='.git/' \
    --exclude='.DS_Store' \
    --exclude='*.log' \
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
  both)
    rsync_site "$MARKETING_SRC" "$MARKETING_DEST" "marketing"
    rsync_site "$DOCS_SRC" "$DOCS_DEST" "docs"
    ;;
  *)
    echo "Usage: $0 [marketing|docs|both]" >&2
    exit 1
    ;;
esac

echo
echo "Done. nginx serves both from 127.0.0.1:8080 via Cloudflare Tunnel."
echo "  https://replen.dev"
echo "  https://docs.replen.dev"
