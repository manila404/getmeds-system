#!/usr/bin/env bash
#
# Provision a fresh Ubuntu VM (Oracle Cloud Always Free, or any VPS) to run
# the Getmeds backend. Idempotent — safe to re-run after fixing something.
#
#   sudo DOMAIN=getmeds-api.duckdns.org EMAIL=you@getmeds.ph bash oracle-setup.sh
#
# What it does, in order:
#   1. Packages: Node 22, nginx, certbot, build tools, git
#   2. Opens ports 80/443 in the LOCAL firewall (see the note below — this is
#      the step everyone misses on Oracle and it costs an afternoon)
#   3. Creates a `getmeds` service user and clones the repo
#   4. Installs dependencies and runs the migration
#   5. systemd unit, so the process restarts on crash and on reboot
#   6. nginx reverse proxy in front of it, then a Let's Encrypt certificate
#   7. A nightly verified backup via cron
#
# It does NOT create .env — secrets are not in git and must not be. The script
# stops and tells you what to do when it gets there.
set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
REPO="${REPO:-https://github.com/manila404/getmeds-system.git}"
BRANCH="${BRANCH:-main}"
APP_USER="${APP_USER:-getmeds}"
APP_HOME="/opt/getmeds"
APP_DIR="$APP_HOME/getmeds-system/getmeds-backend"
PORT="${PORT:-4000}"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
if [[ -z "$DOMAIN" ]]; then echo "DOMAIN is required (e.g. getmeds-api.duckdns.org)"; exit 1; fi

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1/7  Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git nginx python3 build-essential ca-certificates iptables-persistent >/dev/null
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

say "2/7  Firewall"
# Oracle's Ubuntu images ship an iptables INPUT chain that DROPs everything
# except SSH. Opening the ports in the OCI console's Security List is only
# half the job — the packet still dies on the instance itself, and the symptom
# is a connection that hangs rather than one that is refused, which sends
# people looking at nginx for hours. Both layers are required.
for p in 80 443; do
  if ! iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 6 -p tcp --dport "$p" -j ACCEPT
  fi
done
netfilter-persistent save >/dev/null 2>&1 || true
echo "ports 80/443 accepted locally — now also open them in the OCI Security List"

say "3/7  Service user and code"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_HOME"
chown "$APP_USER:$APP_USER" "$APP_HOME"
if [[ -d "$APP_HOME/getmeds-system/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_HOME/getmeds-system" fetch --quiet origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_HOME/getmeds-system" reset --hard --quiet "origin/$BRANCH"
else
  sudo -u "$APP_USER" git clone --quiet --branch "$BRANCH" "$REPO" "$APP_HOME/getmeds-system"
fi

say "4/7  Dependencies"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --silent 2>/dev/null || sudo -u "$APP_USER" npm install --omit=dev --silent

if [[ ! -f "$APP_DIR/.env" ]]; then
  cat <<EOF

  ------------------------------------------------------------------
  STOP. There is no .env yet, and it must not come from git.

  Create it now, then re-run this script:

     sudo -u $APP_USER cp $APP_DIR/.env.example $APP_DIR/.env
     sudo -u $APP_USER nano $APP_DIR/.env

  It needs, at minimum:

     NODE_ENV=production
     PORT=$PORT
     ZOHO_MODE=live
     ZOHO_ORG_ID=714292728
     ZOHO_ALLOWED_ORG_IDS=714292728
     ZOHO_CLIENT_ID=...          (copy from your laptop's .env)
     ZOHO_CLIENT_SECRET=...
     ZOHO_REFRESH_TOKEN=...
     CORS_ALLOWED_ORIGINS=https://getmeds-system.vercel.app

  Then generate the two secrets ON THIS MACHINE — do not reuse the
  laptop's, and do not paste them into chat:

     cd $APP_DIR && sudo -u $APP_USER npm run secrets:init

  Copy the webhook secret it prints into Zoho's X-Zoho-Webhook-Token
  header on every Workflow Rule.
  ------------------------------------------------------------------

EOF
  exit 1
fi

say "5/7  Migrate"
sudo -u "$APP_USER" npm run migrate

say "6/7  systemd"
cat > /etc/systemd/system/getmeds-api.service <<EOF
[Unit]
Description=Getmeds Order API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
# The app reads .env itself via dotenv; NODE_ENV is set here too so that a
# mistake in .env cannot quietly leave the process in development mode, where
# the webhook accepts unauthenticated callers.
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=getmeds-api

# A single instance, deliberately. zohoAutoSyncService's overlap guard and the
# salesperson cache are both in-memory and per-process: a second instance means two sync loops walking the same orders
# and double the Zoho API budget.

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now getmeds-api
sleep 3
systemctl is-active --quiet getmeds-api && echo "service is up" || { journalctl -u getmeds-api -n 40 --no-pager; exit 1; }

say "7/7  nginx + TLS"
cat > /etc/nginx/sites-available/getmeds <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    # Zoho posts webhooks here; keep the body limit generous enough for a
    # workflow payload but not unbounded.
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/getmeds /etc/nginx/sites-enabled/getmeds
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

if [[ -n "$EMAIL" ]]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || \
    echo "certbot failed — check that $DOMAIN resolves to this VM's public IP, then re-run"
else
  echo "EMAIL not set, skipping TLS. Zoho requires HTTPS: re-run with EMAIL=you@getmeds.ph"
fi

say "Nightly backup"
cat > /etc/cron.d/getmeds-backup <<EOF
# Verified online backup at 02:15 daily. Output goes to syslog; a failure
# exits non-zero so cron reports it.
15 2 * * * $APP_USER cd $APP_DIR && /usr/bin/npm run backup -- --quiet >> /var/log/getmeds-backup.log 2>&1
EOF

say "Done"
cat <<EOF

  API:     https://$DOMAIN/api/health
  Logs:    journalctl -u getmeds-api -f
  Restart: systemctl restart getmeds-api
  Deploy:  cd $APP_HOME/getmeds-system && sudo -u $APP_USER git pull && \\
           cd getmeds-backend && sudo -u $APP_USER npm ci --omit=dev && \\
           sudo -u $APP_USER npm run migrate && systemctl restart getmeds-api

  Still to do, in this order:
    1. Open 80/443 in the OCI Console -> Networking -> Security List
    2. Point $DOMAIN at this VM's public IP
    3. Set VITE_API_URL=https://$DOMAIN in Vercel, then REDEPLOY
       (Vite bakes it in at build time — a settings change alone does nothing)
    4. Point Zoho's webhooks at https://$DOMAIN/api/webhooks/zoho
       with the X-Zoho-Webhook-Token header
    5. Create the real user accounts. Do NOT run npm run seed — it creates
       six accounts with the password demo123, including admin.
    6. Log in as admin and run Full Resync to pull customers and products

EOF
