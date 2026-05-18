#!/usr/bin/env bash
# Operator-specific deploy wrapper — example.
#
# Copy this to `scripts/deploy-<your-host>.local.sh` (anything matching
# *.local.sh is gitignored) and fill in the values for your VPS. Run it
# from the repo root; it just forwards to ./scripts/deploy.sh with your
# host-specific defaults set as env vars.
#
# Required:
#   DEPLOY_HOST            SSH host alias for your VPS
#   DEPLOY_DIR             /opt/replen (or wherever you install)
#   SERVICE_PREFIX         systemd unit prefix (default: replen)
#   DEPLOY_NGINX_SITE      filename in /etc/nginx/sites-available/
#   DEPLOY_NGINX_TEMPLATE  one of scripts/nginx-*.conf
#   DEPLOY_LOG_DIR         /var/log/replen (or wherever)
#
# The host-specific wrapper stays out of git so internal hostnames /
# public DNS names don't ride along when the repo is mirrored public.

set -euo pipefail
DEPLOY_HOST=your-vps-alias \
DEPLOY_DIR=/opt/replen \
DEPLOY_USER=ubuntu \
SERVICE_PREFIX=replen \
DEPLOY_NGINX_SITE=replen.your-domain.com \
DEPLOY_NGINX_TEMPLATE=nginx-replen.conf \
DEPLOY_LOG_DIR=/var/log/replen \
exec ./scripts/deploy.sh "$@"
