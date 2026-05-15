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
# The script never copies .env automatically — populate it manually on the
# server (chmod 600) so secrets aren't in any sync that includes your laptop.
#
set -euo pipefail

REMOTE="${DEPLOY_HOST:-replen-host}"
REMOTE_DIR="${DEPLOY_DIR:-/opt/replen}"
REMOTE_USER="${DEPLOY_USER:-ubuntu}"
SERVICE_PREFIX="${SERVICE_PREFIX:-replen}"
NGINX_SITE="${DEPLOY_NGINX_SITE:-replen.conf}"
NGINX_TEMPLATE="${DEPLOY_NGINX_TEMPLATE:-nginx-replen.conf}"
LOG_DIR="${DEPLOY_LOG_DIR:-/var/log/replen}"

WEB_SVC="${SERVICE_PREFIX}.service"
CRON_SVC="${SERVICE_PREFIX}-cron.service"

echo "[1/6] preparing remote dirs on ${REMOTE} (svc prefix: ${SERVICE_PREFIX}, dir: ${REMOTE_DIR})"
ssh "$REMOTE" "sudo mkdir -p $REMOTE_DIR $LOG_DIR && sudo chown $REMOTE_USER:$REMOTE_USER $REMOTE_DIR $LOG_DIR"

echo "[2/6] rsyncing repo (excluding heavy + secret paths)"
rsync -az --delete \
  --exclude node_modules --exclude .next --exclude data --exclude .git \
  --exclude 'mcp/node_modules' --exclude 'mcp/dist' \
  --exclude '*.log' --exclude '.env' \
  ./ "$REMOTE:$REMOTE_DIR/"

echo "[3/6] npm install + db migrate + build"
ssh "$REMOTE" "cd $REMOTE_DIR && npm install --no-audit --no-fund && npm run db:generate && npm run db:migrate && npm run build"

echo "[4/6] installing systemd units"
ssh "$REMOTE" "sudo cp $REMOTE_DIR/scripts/$WEB_SVC /etc/systemd/system/$WEB_SVC && sudo cp $REMOTE_DIR/scripts/$CRON_SVC /etc/systemd/system/$CRON_SVC && sudo systemctl daemon-reload"

echo "[5/6] installing nginx site"
ssh "$REMOTE" "sudo cp $REMOTE_DIR/scripts/$NGINX_TEMPLATE /etc/nginx/sites-available/$NGINX_SITE && sudo ln -sf /etc/nginx/sites-available/$NGINX_SITE /etc/nginx/sites-enabled/$NGINX_SITE && sudo nginx -t && sudo systemctl reload nginx"

echo "[6/6] enabling + restarting services"
ssh "$REMOTE" "sudo systemctl enable $WEB_SVC $CRON_SVC && sudo systemctl restart $WEB_SVC $CRON_SVC"

echo "[done] check with: ssh $REMOTE 'systemctl is-active $WEB_SVC $CRON_SVC'"
