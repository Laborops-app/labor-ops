#!/bin/bash
# LaborOps - Lightsail first-boot script (Ubuntu 24.04).
# Paste this into the "Launch script" box when creating the instance, after replacing PUBLIC_KEY.
# It installs Docker, adds a small swap file, authorises the deploy key, and creates /opt/laborops/.env
# with freshly generated secrets. Progress log: /var/log/laborops-launch.log
set -euo pipefail
exec > /var/log/laborops-launch.log 2>&1

PUBLIC_KEY='PASTE-YOUR-DEPLOY-PUBLIC-KEY-HERE'
DOMAIN='demo.laborops.app'
APP_USER='ubuntu'

echo "== deploy key =="
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.ssh"
touch "/home/$APP_USER/.ssh/authorized_keys"
grep -qxF "$PUBLIC_KEY" "/home/$APP_USER/.ssh/authorized_keys" || echo "$PUBLIC_KEY" >> "/home/$APP_USER/.ssh/authorized_keys"
chown "$APP_USER:$APP_USER" "/home/$APP_USER/.ssh/authorized_keys"
chmod 600 "/home/$APP_USER/.ssh/authorized_keys"

echo "== swap (helps the web build on a small server) =="
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== docker =="
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl rsync openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker "$APP_USER"

echo "== app folder and secrets =="
install -d -o "$APP_USER" -g "$APP_USER" /opt/laborops
if [ ! -f /opt/laborops/.env ]; then
  cat > /opt/laborops/.env <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_DB_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
SEED_DEMO=true
DEMO_PASSWORD=LaborOps-Demo-1
ENV
  chown "$APP_USER:$APP_USER" /opt/laborops/.env
  chmod 600 /opt/laborops/.env
fi

touch /opt/laborops/.ready
echo "== done =="
