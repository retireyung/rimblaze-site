#!/usr/bin/env bash
# Live stats server for homeruns.com and rimblaze.com (DigitalOcean droplet, Ubuntu 24.04).
# Safe to run again at any time; it brings the server up to date with this repository.
#   curl -fsSL https://raw.githubusercontent.com/retireyung/rimblaze-site/main/server/setup.sh | sudo bash
#
# What it runs:
#   livestats.service      relay on 127.0.0.1:8080 (MLB + NBA feeds, cached) behind Caddy (HTTPS)
#   rimblaze-live.timer    RimBlaze live snapshot (scripts/build-live.mjs) every 45 seconds
#   rimblaze-pull.timer    pulls the latest rimblaze-site code every 15 minutes
set -euo pipefail
DOMAIN="${DOMAIN:-live.homeruns.com}"
REPO="https://github.com/retireyung/rimblaze-site.git"
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -qq
apt-get install -y -qq curl git ufw unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "== swap"
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile || true
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== user and code"
id livestats >/dev/null 2>&1 || useradd --system --home /opt/livestats --shell /usr/sbin/nologin livestats
mkdir -p /opt/livestats/rimblaze-live
if [ -d /opt/rimblaze/.git ]; then
  git -C /opt/rimblaze fetch -q --depth 1 origin main && git -C /opt/rimblaze reset -q --hard origin/main
else
  rm -rf /opt/rimblaze && git clone -q --depth 1 "$REPO" /opt/rimblaze
fi
git config --system --add safe.directory /opt/rimblaze 2>/dev/null || true
cp /opt/rimblaze/server/relay.cjs /opt/livestats/server.cjs
chown -R livestats:livestats /opt/livestats /opt/rimblaze

echo "== services"
cat > /etc/systemd/system/livestats.service <<'UNIT'
[Unit]
Description=Live stats relay (homeruns.com + rimblaze.com)
After=network-online.target
Wants=network-online.target
[Service]
User=livestats
Environment=PORT=8080
Environment=RB_LIVE_DIR=/opt/livestats/rimblaze-live
ExecStart=/usr/bin/node /opt/livestats/server.cjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=500M
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/rimblaze-live.service <<'UNIT'
[Unit]
Description=RimBlaze live snapshot
After=network-online.target
[Service]
Type=oneshot
User=livestats
WorkingDirectory=/opt/rimblaze
Environment=RB_LIVE_DIR=/opt/livestats/rimblaze-live
ExecStart=/usr/bin/node scripts/build-live.mjs
TimeoutStartSec=120
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/rimblaze /opt/livestats/rimblaze-live
ProtectHome=true
PrivateTmp=true
MemoryMax=400M
UNIT

cat > /etc/systemd/system/rimblaze-live.timer <<'UNIT'
[Unit]
Description=RimBlaze live snapshot every 45 seconds
[Timer]
OnBootSec=20s
OnUnitInactiveSec=45s
AccuracySec=5s
[Install]
WantedBy=timers.target
UNIT

cat > /etc/systemd/system/rimblaze-pull.service <<'UNIT'
[Unit]
Description=Update RimBlaze code and relay from GitHub
[Service]
Type=oneshot
ExecStart=/bin/bash -c 'cd /opt/rimblaze && sudo -u livestats git fetch -q --depth 1 origin main && sudo -u livestats git reset -q --hard origin/main && if ! cmp -s server/relay.cjs /opt/livestats/server.cjs; then cp server/relay.cjs /opt/livestats/server.cjs && chown livestats:livestats /opt/livestats/server.cjs && systemctl restart livestats; fi'
UNIT

cat > /etc/systemd/system/rimblaze-pull.timer <<'UNIT'
[Unit]
Description=Update RimBlaze code every 15 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	encode gzip zstd
	reverse_proxy 127.0.0.1:8080
}
CADDY

systemctl daemon-reload
systemctl enable -q --now livestats rimblaze-live.timer rimblaze-pull.timer
systemctl restart livestats
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "== firewall and security updates"
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh 2>/dev/null || true
echo 'APT::Periodic::Update-Package-Lists "1"; APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades

echo "== first snapshot"
systemctl start rimblaze-live.service || echo "(snapshot run failed; see: journalctl -u rimblaze-live)"
sleep 2
echo
echo "relay:    $(curl -s 127.0.0.1:8080/health)"
echo "rimblaze: $(curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:8080/rimblaze/live/index.json) (200 = live snapshot is being served)"
echo "nba cdn:  $(curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:8080/nba/liveData/scoreboard/todaysScoreboard_00.json)"
echo "mlb api:  $(curl -s -o /dev/null -w '%{http_code}' '127.0.0.1:8080/mlb/v1/teams?sportId=1')"
echo
echo "SETUP COMPLETE"
