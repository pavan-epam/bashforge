#!/usr/bin/env bash
# =============================================================================
# ec2-app-setup.sh  —  Bootstrap EC2-1 (App Server: Frontend + Backend + Redis)
# Run as ubuntu user: bash ec2-app-setup.sh
# =============================================================================
set -euo pipefail
LOGFILE="/home/ubuntu/setup-app.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo "============================================================"
echo " BashForge App EC2 Setup  —  $(date)"
echo "============================================================"

# ── 1. System packages ────────────────────────────────────────────
echo "[1/10] Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    git \
    unzip \
    jq \
    htop \
    ncdu \
    ufw \
    certbot \
    python3-certbot-nginx \
    nginx

# ── 2. Docker ─────────────────────────────────────────────────────
echo "[2/10] Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
        sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) \
        signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] \
        https://download.docker.com/linux/ubuntu \
        $(lsb_release -cs) stable" | \
        sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update -qq
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
    sudo systemctl enable --now docker
    sudo usermod -aG docker ubuntu
    echo "  Docker installed: $(docker --version)"
else
    echo "  Docker already installed"
fi

# ── 3. AWS CLI v2 ─────────────────────────────────────────────────
echo "[3/10] Installing AWS CLI v2..."
if ! command -v aws &>/dev/null; then
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
    unzip -q /tmp/awscliv2.zip -d /tmp/awscli
    sudo /tmp/awscli/aws/install
    rm -rf /tmp/awscliv2.zip /tmp/awscli
    echo "  AWS CLI: $(aws --version)"
else
    echo "  AWS CLI already installed"
fi

# ── 4. Redis (local) ──────────────────────────────────────────────
echo "[4/10] Installing Redis..."
sudo apt-get install -y redis-server
# Bind Redis to localhost only
sudo sed -i 's/^bind 127.0.0.1 -::1/bind 127.0.0.1/' /etc/redis/redis.conf
sudo systemctl enable --now redis-server
echo "  Redis: $(redis-cli ping)"

# ── 5. App directory ──────────────────────────────────────────────
echo "[5/10] Creating app directory..."
sudo mkdir -p /opt/bashforge
sudo chown ubuntu:ubuntu /opt/bashforge

# ── 6. .env file ─────────────────────────────────────────────────
echo "[6/10] Creating .env template..."
# !! Fill in these values before running deploy !!
cat > /opt/bashforge/.env <<'ENVEOF'
# ================================================================
# BashForge Production Environment  — EDIT BEFORE USE
# ================================================================

# Redis (on this same EC2, local)
REDIS_URL=redis://127.0.0.1:6379/0

# Session
SESSION_TTL_SECONDS=3600
MAX_CONCURRENT_SESSIONS=20

# Kubernetes — EC2-2 private IP and kubeconfig path
K8S_NODE_IP=10.0.1.20
KUBECONFIG_PATH=/home/ubuntu/.kube/config-k8s
K8S_NAMESPACE=bashforge-sessions
K8S_SANDBOX_IMAGE=<YOUR_ECR_ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/bashforge-sandbox:latest

# Security — CHANGE THESE
COOKIE_SECRET=REPLACE_WITH_RANDOM_64_CHAR_STRING
SECURE_COOKIES=true

# CORS — your domain
CORS_ORIGINS=["https://yourdomain.com"]

# App
MOCK_K8S=false
DEBUG=false
ENVEOF

echo "  !! Edit /opt/bashforge/.env with real values !!"

# ── 7. docker-compose.prod.yml ────────────────────────────────────
echo "[7/10] Writing docker-compose.prod.yml..."
cat > /opt/bashforge/docker-compose.prod.yml <<'COMPOSEEOF'
version: "3.9"

services:

  backend:
    image: <YOUR_ECR_ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/bashforge-backend:latest
    restart: unless-stopped
    env_file: /opt/bashforge/.env
    network_mode: host           # Shares host network — can reach K8s ClusterIPs
    volumes:
      - /home/ubuntu/.kube/config-k8s:/home/ubuntu/.kube/config-k8s:ro
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/api/health"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"

  frontend:
    image: <YOUR_ECR_ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/bashforge-frontend:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:80"    # Nginx listens on 8080 internally; real Nginx in front
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:80/"]
      interval: 15s
      timeout: 5s
      retries: 3
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "3"
COMPOSEEOF

# ── 8. Nginx configuration ────────────────────────────────────────
echo "[8/10] Configuring Nginx..."
sudo tee /etc/nginx/sites-available/bashforge > /dev/null <<'NGINXEOF'
# HTTP — redirect to HTTPS
server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}

# HTTPS
server {
    listen 443 ssl http2;
    server_name yourdomain.com;     # !! Replace with your domain !!

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;

    # Security headers
    add_header X-Frame-Options          DENY;
    add_header X-Content-Type-Options   nosniff;
    add_header X-XSS-Protection        "1; mode=block";
    add_header Referrer-Policy          strict-origin-when-cross-origin;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript
               text/xml application/xml application/rss+xml text/javascript
               font/woff2;

    # API proxy → FastAPI backend on host:8000
    location /api/ {
        proxy_pass         http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }

    # WebSocket proxy → FastAPI backend on host:8000
    location /ws/ {
        proxy_pass         http://127.0.0.1:8000/ws/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Static frontend → Dockerized Nginx on 8080
    location / {
        proxy_pass         http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_read_timeout 15s;
    }
}
NGINXEOF

sudo ln -sf /etc/nginx/sites-available/bashforge /etc/nginx/sites-enabled/bashforge
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl enable --now nginx
echo "  Nginx configured"

# ── 9. Firewall ───────────────────────────────────────────────────
echo "[9/10] Configuring UFW firewall..."
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    comment "SSH"
sudo ufw allow 80/tcp    comment "HTTP"
sudo ufw allow 443/tcp   comment "HTTPS"
sudo ufw --force enable
sudo ufw status verbose

# ── 10. Kubeconfig placeholder ────────────────────────────────────
echo "[10/10] Creating .kube directory..."
mkdir -p /home/ubuntu/.kube
echo ""
echo "============================================================"
echo " NEXT STEPS (manual):"
echo "============================================================"
echo ""
echo " 1. Edit /opt/bashforge/.env — fill in all placeholder values"
echo "    especially: COOKIE_SECRET, K8S_NODE_IP, K8S_SANDBOX_IMAGE,"
echo "    ECR account ID, and AWS region."
echo ""
echo " 2. Copy kubeconfig from EC2-2:"
echo "    scp -i your-key.pem ubuntu@<EC2-2-IP>:/home/ubuntu/.kube/config \\"
echo "        /home/ubuntu/.kube/config-k8s"
echo "    Then replace the server IP inside config-k8s:"
echo "    sed -i 's|https://.*:6443|https://10.0.1.20:6443|' /home/ubuntu/.kube/config-k8s"
echo "    chmod 600 /home/ubuntu/.kube/config-k8s"
echo ""
echo " 3. Update /etc/nginx/sites-available/bashforge with your actual domain"
echo ""
echo " 4. Get SSL cert:"
echo "    sudo certbot --nginx -d yourdomain.com --non-interactive \\"
echo "        --agree-tos -m your@email.com"
echo ""
echo " 5. Update docker-compose.prod.yml with your ECR URL"
echo ""
echo " 6. Pull and run:"
echo "    cd /opt/bashforge"
echo "    aws ecr get-login-password --region <REGION> | \\"
echo "        docker login --username AWS --password-stdin <ECR_URL>"
echo "    docker compose -f docker-compose.prod.yml pull"
echo "    docker compose -f docker-compose.prod.yml up -d"
echo ""
echo "============================================================"
echo " Setup complete: $(date)"
echo "============================================================"
