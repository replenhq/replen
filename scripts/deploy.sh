#!/usr/bin/env bash
# Deploy replen to a remote server via SSH + rsync. Run from the repo root.
#
# Configure once via env (or pass on the command line):
#   DEPLOY_HOST            SSH host alias (default: replen-host)
#   DEPLOY_DIR             remote install dir (default: /opt/replen)
#   DEPLOY_USER            remote user owning the dir (default: ubuntu)
#   DEPLOY_NGINX_SITE      filename in /etc/nginx/sites-* (default: replen.conf)
#   DEPLOY_LOG_DIR         remote log dir (default: /var/log/replen)
#
# The script never copies .env automatically - populate it manually on the
# server (chmod 600) so secrets aren't in any sync that includes your laptop.
#
set -euo pipefail

REMOTE="${DEPLOY_HOST:-replen-host}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/replen}"
REMOTE_USER="${DEPLOY_USER:-ubuntu}"
SERVICE_PREFIX="${SERVICE_PREFIX:-replen}"
NGINX_SITE="${DEPLOY_NGINX_SITE:-replen.conf}"
NGINX_TEMPLATE="${DEPLOY_NGINX_TEMPLATE:-nginx-replen.conf}"
# When set, the nginx template's $YOUR_DOMAIN placeholders get
# substituted with this value before being copied into sites-available
# on the remote. Leave empty if your template is already a literal
# config (no placeholders).
NGINX_DOMAIN="${DEPLOY_NGINX_DOMAIN:-}"
LOG_DIR="${DEPLOY_LOG_DIR:-/var/log/replen}"

WEB_SVC="${SERVICE_PREFIX}.service"
CRON_SVC="${SERVICE_PREFIX}-cron.service"

echo "[1/6] preparing remote dirs on ${REMOTE} (svc prefix: ${SERVICE_PREFIX}, dir: ${REMOTE_DIR})"
ssh "$REMOTE" "sudo mkdir -p $REMOTE_DIR $LOG_DIR && sudo chown $REMOTE_USER:$REMOTE_USER $REMOTE_DIR $LOG_DIR"

echo "[2/6] rsyncing repo (excluding heavy + secret paths)"
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude data --exclude .git \
  --exclude 'mcp/node_modules' --exclude 'mcp/dist' \
  --exclude 'projects-mirror' --exclude backups --exclude '.venv' \
  --exclude '*.log' --exclude '.env' \
  ./ "$REMOTE:$REMOTE_DIR/"

echo "[3/6] npm install + db migrate + build"
# db:generate intentionally NOT run on remote — migrations are committed
# to the repo. Running drizzle-kit generate against the live schema would
# emit an extra autogen migration whenever the remote snapshot drifts from
# main, which then races the committed migration of the same step number.
#
# `next build` (Next 16.x with turbopack) spawns page-data-collection workers
# that don't auto-load .env, so client.ts trips its ENCRYPTION_KEY assert
# even though systemd loads .env fine at runtime. Source .env explicitly into
# the build shell to give the workers the same env the running service has.
ssh "$REMOTE" "cd $REMOTE_DIR && npm install --no-audit --no-fund && npm run db:migrate && set -a && . ./.env && set +a && npm run build"

echo "[4/6] installing systemd units"
ssh "$REMOTE" "sudo cp $REMOTE_DIR/scripts/$WEB_SVC /etc/systemd/system/$WEB_SVC && sudo cp $REMOTE_DIR/scripts/$CRON_SVC /etc/systemd/system/$CRON_SVC && sudo systemctl daemon-reload"

echo "[5/6] installing nginx site"
# Build the final nginx config: copy template, optionally substitute
# $YOUR_DOMAIN placeholder if DEPLOY_NGINX_DOMAIN was set, then install
# + reload. The placeholder syntax in the public template is just a
# string; sed substitution leaves a literal hostname in the deployed
# config so nginx never tries to interpret $YOUR_DOMAIN as a variable.
if [ -n "$NGINX_DOMAIN" ]; then
  ssh "$REMOTE" "sudo sed 's|\$YOUR_DOMAIN|$NGINX_DOMAIN|g' $REMOTE_DIR/scripts/$NGINX_TEMPLATE | sudo tee /etc/nginx/sites-available/$NGINX_SITE > /dev/null && sudo ln -sf /etc/nginx/sites-available/$NGINX_SITE /etc/nginx/sites-enabled/$NGINX_SITE && sudo nginx -t && sudo systemctl reload nginx"
else
  ssh "$REMOTE" "sudo cp $REMOTE_DIR/scripts/$NGINX_TEMPLATE /etc/nginx/sites-available/$NGINX_SITE && sudo ln -sf /etc/nginx/sites-available/$NGINX_SITE /etc/nginx/sites-enabled/$NGINX_SITE && sudo nginx -t && sudo systemctl reload nginx"
fi

echo "[6/6] enabling + restarting services"
ssh "$REMOTE" "sudo systemctl enable $WEB_SVC $CRON_SVC && sudo systemctl restart $WEB_SVC $CRON_SVC"

echo "[done] check with: ssh $REMOTE 'systemctl is-active $WEB_SVC $CRON_SVC'"
