#!/usr/bin/env bash
# =============================================================================
# ec2-k8s-setup.sh  —  Bootstrap EC2-2 (Kubernetes Server with Minikube)
# Run as ubuntu user: bash ec2-k8s-setup.sh
# Requires: EC2 type t3.medium or larger, 40 GB root disk
# =============================================================================
set -euo pipefail
LOGFILE="/home/ubuntu/setup-k8s.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo "============================================================"
echo " BashForge K8s EC2 Setup  —  $(date)"
echo "============================================================"

# ── 1. System packages ────────────────────────────────────────────
echo "[1/9] Installing system packages..."
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
    conntrack \
    socat \
    ufw

# ── 2. Docker ─────────────────────────────────────────────────────
echo "[2/9] Installing Docker..."
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
fi

# ── 3. kubectl ────────────────────────────────────────────────────
echo "[3/9] Installing kubectl..."
if ! command -v kubectl &>/dev/null; then
    KUBE_VER=$(curl -fsSL https://dl.k8s.io/release/stable.txt)
    curl -fsSLO "https://dl.k8s.io/release/${KUBE_VER}/bin/linux/amd64/kubectl"
    sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
    rm kubectl
    echo "  kubectl: $(kubectl version --client --short 2>/dev/null || kubectl version --client)"
fi

# ── 4. Minikube ───────────────────────────────────────────────────
echo "[4/9] Installing Minikube..."
if ! command -v minikube &>/dev/null; then
    curl -fsSLO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
    sudo install minikube-linux-amd64 /usr/local/bin/minikube
    rm minikube-linux-amd64
    echo "  Minikube: $(minikube version)"
fi

# ── 5. AWS CLI ────────────────────────────────────────────────────
echo "[5/9] Installing AWS CLI v2..."
if ! command -v aws &>/dev/null; then
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
    unzip -q /tmp/awscliv2.zip -d /tmp/awscli
    sudo /tmp/awscli/aws/install
    rm -rf /tmp/awscliv2.zip /tmp/awscli
fi

# ── 6. Start Minikube ─────────────────────────────────────────────
echo "[6/9] Starting Minikube..."
# Must run as ubuntu (not root) since we use docker driver
if ! minikube status | grep -q "Running"; then
    minikube start \
        --driver=docker \
        --cpus=2 \
        --memory=3500mb \
        --disk-size=30g \
        --kubernetes-version=stable \
        --embed-certs \
        --extra-config=apiserver.bind-address=0.0.0.0 \
        --listen-address=0.0.0.0

    echo "  Minikube started"
else
    echo "  Minikube already running"
fi

# Wait for all system pods
echo "  Waiting for K8s system pods..."
kubectl wait --for=condition=Ready pod --all -n kube-system --timeout=120s || true

# ── 7. Apply K8s namespaces and limits ────────────────────────────
echo "[7/9] Applying K8s manifests (namespace, limits, network policy)..."
mkdir -p /home/ubuntu/bashforge-k8s

cat > /home/ubuntu/bashforge-k8s/namespace-and-limits.yaml <<'K8SYAML'
---
apiVersion: v1
kind: Namespace
metadata:
  name: bashforge-sessions
  labels:
    app: bashforge
---
apiVersion: v1
kind: LimitRange
metadata:
  name: session-limits
  namespace: bashforge-sessions
spec:
  limits:
  - type: Container
    max:
      memory: "150Mi"
      cpu: "300m"
    min:
      memory: "16Mi"
      cpu: "10m"
    default:
      memory: "150Mi"
      cpu: "300m"
    defaultRequest:
      memory: "64Mi"
      cpu: "50m"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: session-quota
  namespace: bashforge-sessions
spec:
  hard:
    pods:             "20"
    requests.memory:  "1280Mi"
    limits.memory:    "3000Mi"
    requests.cpu:     "1"
    limits.cpu:       "6"
    count/services:   "25"
K8SYAML

kubectl apply -f /home/ubuntu/bashforge-k8s/namespace-and-limits.yaml
echo "  Namespace and limits applied"

# ── 8. Expose K8s API server so App EC2 can reach it ─────────────
echo "[8/9] Configuring K8s API access from App EC2..."
# Minikube API is on the Docker network bridge (172.17.0.x) by default.
# We need it accessible on the EC2's private IP.
# The --listen-address=0.0.0.0 flag above makes API server listen on all interfaces.
# Get the current Minikube IP:
MINIKUBE_IP=$(minikube ip)
PRIVATE_IP=$(curl -sf http://169.254.169.254/latest/meta-data/local-ipv4 || hostname -I | awk '{print $1}')
echo "  Minikube IP:   $MINIKUBE_IP"
echo "  EC2 private IP: $PRIVATE_IP"

# Export kubeconfig with the EC2's private IP (so App EC2 can use it)
mkdir -p /home/ubuntu/.kube
minikube update-context
# Replace minikube IP with EC2 private IP in kubeconfig
cp /home/ubuntu/.kube/config /home/ubuntu/.kube/config.backup
sed "s|https://${MINIKUBE_IP}:8443|https://${PRIVATE_IP}:8443|g" \
    /home/ubuntu/.kube/config.backup > /home/ubuntu/.kube/config-for-app-ec2
echo "  Kubeconfig for App EC2 saved to: /home/ubuntu/.kube/config-for-app-ec2"
echo "  Copy this to App EC2:"
echo "    scp -i key.pem ubuntu@<THIS-EC2-IP>:/home/ubuntu/.kube/config-for-app-ec2 \\"
echo "        ubuntu@<APP-EC2-IP>:/home/ubuntu/.kube/config-k8s"

# ── 9. Firewall ───────────────────────────────────────────────────
echo "[9/9] Configuring UFW..."
# Get App EC2 private IP (you MUST fill this in after App EC2 is set up)
APP_EC2_IP="${APP_EC2_PRIVATE_IP:-10.0.1.10}"

sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp                          comment "SSH"
sudo ufw allow from "$APP_EC2_IP" to any port 8443 comment "K8s API from App EC2"
sudo ufw allow from "$APP_EC2_IP" to any port 8765 comment "Pod WebSocket from App EC2"
# Allow Minikube docker network
sudo ufw allow from 172.17.0.0/16              comment "Docker bridge"
sudo ufw allow from 192.168.49.0/24            comment "Minikube network"
sudo ufw --force enable
sudo ufw status verbose

# ── Systemd service to restart minikube on reboot ─────────────────
sudo tee /etc/systemd/system/minikube.service > /dev/null <<'SVCEOF'
[Unit]
Description=Minikube Kubernetes
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=ubuntu
ExecStart=/usr/local/bin/minikube start --driver=docker
ExecStop=/usr/local/bin/minikube stop
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable minikube
echo "  Minikube systemd service enabled"

echo ""
echo "============================================================"
echo " K8s EC2 Setup Complete: $(date)"
echo "============================================================"
echo ""
echo " Minikube status:"
minikube status
echo ""
echo " K8s nodes:"
kubectl get nodes
echo ""
echo " bashforge-sessions namespace:"
kubectl get all -n bashforge-sessions 2>/dev/null || echo "  (empty)"
echo ""
echo " IMPORTANT — Manual steps:"
echo "  1. Copy kubeconfig to App EC2 (see instructions above)"
echo "  2. Set APP_EC2_PRIVATE_IP in UFW rules if not already correct"
echo "  3. After deploying sandbox image via CI/CD, pre-pull it:"
echo "     eval \$(minikube docker-env)"
echo "     docker pull <ECR_URL>/bashforge-sandbox:latest"
echo ""
