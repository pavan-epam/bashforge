# BashForge — Complete Deployment Guide

# Every command needed from zero to running in production

==============================================================

## PART 1: LOCAL DEVELOPMENT (no AWS needed)

==============================================================

### Step 1.1 — Clone and install frontend deps

```bash
git clone https://github.com/yourname/bashforge.git
cd bashforge

# Install frontend deps
cd frontend
npm install
cd ..
```

### Step 1.2 — Run everything with Docker Compose

```bash
# From the project root
docker compose up --build

# First time takes ~3 min to build sandbox Go binary + Ubuntu image
# After that: ~20 seconds for incremental builds
```

URLs once running:

- Frontend: http://localhost:3000
- Backend: http://localhost:8000
- API docs: http://localhost:8000/api/docs

The `MOCK_K8S=true` setting means the backend connects to the local sandbox
container instead of spinning real K8s pods. Everything works identically.

### Step 1.3 — Develop frontend only (faster HMR)

```bash
# Terminal 1: Start backend + Redis + sandbox
docker compose up redis backend sandbox

# Terminal 2: Start Vite dev server with HMR
cd frontend
npm run dev
# Open http://localhost:3000
```

==============================================================

## PART 2: AWS SETUP

==============================================================

### Step 2.1 — Create VPC and Subnets (AWS Console or CLI)

```bash
# Using AWS CLI — replace region as needed
export AWS_REGION=ap-south-1

# Create VPC
VPC_ID=$(aws ec2 create-vpc \
    --cidr-block 10.0.0.0/16 \
    --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=bashforge-vpc}]' \
    --query 'Vpc.VpcId' --output text)
echo "VPC: $VPC_ID"

# Enable DNS
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames
aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support

# Create public subnet
SUBNET_ID=$(aws ec2 create-subnet \
    --vpc-id "$VPC_ID" \
    --cidr-block 10.0.1.0/24 \
    --availability-zone "${AWS_REGION}a" \
    --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=bashforge-public}]' \
    --query 'Subnet.SubnetId' --output text)
echo "Subnet: $SUBNET_ID"

# Internet Gateway
IGW_ID=$(aws ec2 create-internet-gateway \
    --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=bashforge-igw}]' \
    --query 'InternetGateway.InternetGatewayId' --output text)
aws ec2 attach-internet-gateway --vpc-id "$VPC_ID" --internet-gateway-id "$IGW_ID"

# Route table
RTB_ID=$(aws ec2 create-route-table \
    --vpc-id "$VPC_ID" \
    --query 'RouteTable.RouteTableId' --output text)
aws ec2 create-route --route-table-id "$RTB_ID" \
    --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID"
aws ec2 associate-route-table --subnet-id "$SUBNET_ID" --route-table-id "$RTB_ID"
aws ec2 modify-subnet-attribute --subnet-id "$SUBNET_ID" \
    --map-public-ip-on-launch

echo "VPC: $VPC_ID  Subnet: $SUBNET_ID"
```

### Step 2.2 — Security Groups

```bash
# App EC2 security group
SG_APP=$(aws ec2 create-security-group \
    --group-name "bashforge-app-sg" \
    --description "BashForge App EC2" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)

# Allow HTTP, HTTPS, SSH
aws ec2 authorize-security-group-ingress --group-id "$SG_APP" \
    --ip-permissions \
    'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=YOUR_IP/32,Description=SSH}]' \
    'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]' \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]'

# K8s EC2 security group
SG_K8S=$(aws ec2 create-security-group \
    --group-name "bashforge-k8s-sg" \
    --description "BashForge K8s EC2" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)

# Allow SSH from your IP and K8s API from App EC2
aws ec2 authorize-security-group-ingress --group-id "$SG_K8S" \
    --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=YOUR_IP/32}]" \
    "IpProtocol=tcp,FromPort=8443,ToPort=8443,UserIdGroupPairs=[{GroupId=$SG_APP,Description='K8s API from App EC2'}]" \
    "IpProtocol=tcp,FromPort=8765,ToPort=8765,UserIdGroupPairs=[{GroupId=$SG_APP,Description='Pod WS from App EC2'}]"

echo "SG_APP=$SG_APP  SG_K8S=$SG_K8S"
```

### Step 2.3 — Create EC2 Key Pair

```bash
aws ec2 create-key-pair \
    --key-name bashforge-key \
    --query 'KeyMaterial' \
    --output text > ~/.ssh/bashforge-key.pem
chmod 600 ~/.ssh/bashforge-key.pem
echo "Key saved to ~/.ssh/bashforge-key.pem"
```

### Step 2.4 — Launch EC2-1 (App Server, t3.small)

```bash
# Get Ubuntu 22.04 AMI ID
AMI_ID=$(aws ec2 describe-images \
    --owners 099720109477 \
    --filters 'Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*' \
              'Name=state,Values=available' \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text)
echo "AMI: $AMI_ID"

EC2_APP_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type t3.small \
    --key-name bashforge-key \
    --security-group-ids "$SG_APP" \
    --subnet-id "$SUBNET_ID" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
    --tag-specifications \
        'ResourceType=instance,Tags=[{Key=Name,Value=bashforge-app}]' \
    --query 'Instances[0].InstanceId' \
    --output text)
echo "App EC2: $EC2_APP_ID"

# Wait for it to be running
aws ec2 wait instance-running --instance-ids "$EC2_APP_ID"

# Get public IP
APP_PUBLIC_IP=$(aws ec2 describe-instances \
    --instance-ids "$EC2_APP_ID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)
APP_PRIVATE_IP=$(aws ec2 describe-instances \
    --instance-ids "$EC2_APP_ID" \
    --query 'Reservations[0].Instances[0].PrivateIpAddress' \
    --output text)
echo "App EC2 Public: $APP_PUBLIC_IP  Private: $APP_PRIVATE_IP"
```

### Step 2.5 — Launch EC2-2 (K8s Server, t3.medium)

```bash
EC2_K8S_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type t3.medium \
    --key-name bashforge-key \
    --security-group-ids "$SG_K8S" \
    --subnet-id "$SUBNET_ID" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":40,"VolumeType":"gp3"}}]' \
    --tag-specifications \
        'ResourceType=instance,Tags=[{Key=Name,Value=bashforge-k8s}]' \
    --query 'Instances[0].InstanceId' \
    --output text)

aws ec2 wait instance-running --instance-ids "$EC2_K8S_ID"

K8S_PUBLIC_IP=$(aws ec2 describe-instances \
    --instance-ids "$EC2_K8S_ID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)
K8S_PRIVATE_IP=$(aws ec2 describe-instances \
    --instance-ids "$EC2_K8S_ID" \
    --query 'Reservations[0].Instances[0].PrivateIpAddress' \
    --output text)
echo "K8s EC2 Public: $K8S_PUBLIC_IP  Private: $K8S_PRIVATE_IP"
```

### Step 2.6 — Allocate and associate Elastic IPs

```bash
# Elastic IP for App EC2
EIP_APP=$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)
aws ec2 associate-address --instance-id "$EC2_APP_ID" --allocation-id "$EIP_APP"

# Elastic IP for K8s EC2
EIP_K8S=$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)
aws ec2 associate-address --instance-id "$EC2_K8S_ID" --allocation-id "$EIP_K8S"

echo "App EIP:  $(aws ec2 describe-addresses --allocation-ids $EIP_APP --query 'Addresses[0].PublicIp' --output text)"
echo "K8s EIP:  $(aws ec2 describe-addresses --allocation-ids $EIP_K8S --query 'Addresses[0].PublicIp' --output text)"
```

### Step 2.7 — Create ECR Repositories

```bash
for repo in bashforge-frontend bashforge-backend bashforge-sandbox; do
    aws ecr create-repository --repository-name "$repo" \
        --image-scanning-configuration scanOnPush=true \
        --query 'repository.repositoryUri' --output text
done
```

==============================================================

## PART 3: CONFIGURE BOTH EC2s

==============================================================

### Step 3.1 — Bootstrap K8s EC2 (run FIRST)

```bash
# SSH into K8s EC2
ssh -i ~/.ssh/bashforge-key.pem ubuntu@<K8S_PUBLIC_IP>

# Upload and run setup script
```

```bash
# On your LOCAL machine — copy setup script to K8s EC2
scp -i ~/.ssh/bashforge-key.pem \
    infra/ec2-k8s-setup.sh \
    ubuntu@<K8S_PUBLIC_IP>:/home/ubuntu/

# SSH in and run it
ssh -i ~/.ssh/bashforge-key.pem ubuntu@<K8S_PUBLIC_IP>
bash /home/ubuntu/ec2-k8s-setup.sh
```

After it completes, copy the kubeconfig to your local machine:

```bash
# Still on K8s EC2
cat /home/ubuntu/.kube/config-for-app-ec2
# Copy this content
```

### Step 3.2 — Bootstrap App EC2

```bash
# Copy setup script to App EC2
scp -i ~/.ssh/bashforge-key.pem \
    infra/ec2-app-setup.sh \
    ubuntu@<APP_PUBLIC_IP>:/home/ubuntu/

ssh -i ~/.ssh/bashforge-key.pem ubuntu@<APP_PUBLIC_IP>
bash /home/ubuntu/ec2-app-setup.sh
```

### Step 3.3 — Copy kubeconfig from K8s EC2 to App EC2

```bash
# From your LOCAL machine (or copy via clipboard)
scp -i ~/.ssh/bashforge-key.pem \
    ubuntu@<K8S_PUBLIC_IP>:/home/ubuntu/.kube/config-for-app-ec2 \
    /tmp/config-k8s-temp

# Upload to App EC2
scp -i ~/.ssh/bashforge-key.pem \
    /tmp/config-k8s-temp \
    ubuntu@<APP_PUBLIC_IP>:/home/ubuntu/.kube/config-k8s

# SSH into App EC2 and verify
ssh -i ~/.ssh/bashforge-key.pem ubuntu@<APP_PUBLIC_IP>
chmod 600 /home/ubuntu/.kube/config-k8s
kubectl --kubeconfig=/home/ubuntu/.kube/config-k8s get nodes
# Should show:  minikube   Ready   ...
```

### Step 3.4 — Edit .env on App EC2

```bash
# On App EC2
nano /opt/bashforge/.env
```

Fill in every placeholder:

```
REDIS_URL=redis://127.0.0.1:6379/0
K8S_NODE_IP=<K8S_PRIVATE_IP>          # e.g. 10.0.1.20
KUBECONFIG_PATH=/home/ubuntu/.kube/config-k8s
K8S_SANDBOX_IMAGE=<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/bashforge-sandbox:latest
COOKIE_SECRET=<run: openssl rand -hex 32>
SECURE_COOKIES=true
CORS_ORIGINS=["https://yourdomain.com"]
MOCK_K8S=false
```

### Step 3.5 — Point your domain to App EC2's Elastic IP

In your DNS provider (Route 53, Cloudflare, etc.):

```
A record:  yourdomain.com  →  <APP_EC2_ELASTIC_IP>
```

Wait for DNS to propagate (1–5 minutes for Cloudflare, up to 48h for others).

### Step 3.6 — Get SSL certificate

```bash
# On App EC2 — after DNS is pointing to this EC2
sudo certbot --nginx \
    -d yourdomain.com \
    --non-interactive \
    --agree-tos \
    -m your@email.com
```

### Step 3.7 — Update Nginx config with real domain

```bash
# On App EC2
sudo nano /etc/nginx/sites-available/bashforge
# Replace all instances of "yourdomain.com" with your actual domain
sudo nginx -t        # verify config
sudo systemctl reload nginx
```

==============================================================

## PART 4: GITHUB ACTIONS SETUP

==============================================================

### Step 4.1 — Create IAM user for CI/CD

```bash
# Create user
aws iam create-user --user-name bashforge-cicd

# Create policy (ECR push only)
cat > /tmp/cicd-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "*"
    }
  ]
}
EOF

POLICY_ARN=$(aws iam create-policy \
    --policy-name BashForgeCICD \
    --policy-document file:///tmp/cicd-policy.json \
    --query 'Policy.Arn' --output text)

aws iam attach-user-policy \
    --user-name bashforge-cicd \
    --policy-arn "$POLICY_ARN"

# Create access key
aws iam create-access-key \
    --user-name bashforge-cicd \
    --query 'AccessKey.{ID:AccessKeyId,Secret:SecretAccessKey}'
# SAVE THESE VALUES
```

### Step 4.2 — Add secrets to GitHub repository

Go to your repo → Settings → Secrets and variables → Actions → New repository secret:

```
AWS_ACCESS_KEY_ID         # From Step 4.1
AWS_SECRET_ACCESS_KEY     # From Step 4.1
EC2_APP_HOST              # App EC2 Elastic IP
EC2_APP_SSH_KEY           # Content of ~/.ssh/bashforge-key.pem
EC2_K8S_HOST              # K8s EC2 Elastic IP
EC2_K8S_SSH_KEY           # Same key (or a separate one)
```

To get the SSH key content:

```bash
cat ~/.ssh/bashforge-key.pem
# Copy the ENTIRE output including -----BEGIN/END RSA PRIVATE KEY-----
```

### Step 4.3 — Update deploy.yml with your AWS region and ECR account

```bash
# In .github/workflows/deploy.yml, update:
env:
  AWS_REGION:      ap-south-1    # your region
  ECR_REPO_PREFIX: bashforge     # your ECR prefix (matches repo names)
```

Also update docker-compose.prod.yml on App EC2 with your ECR URL:

```bash
# On App EC2
ECR_URL="<ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com"
sed -i "s|<YOUR_ECR_ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com|$ECR_URL|g" \
    /opt/bashforge/docker-compose.prod.yml
```

### Step 4.4 — Trigger first deploy

```bash
git add .
git commit -m "feat: initial deployment"
git push origin main
# GitHub Actions will build and deploy automatically
```

Watch progress at: https://github.com/yourname/bashforge/actions

==============================================================

## PART 5: VERIFY EVERYTHING WORKS

==============================================================

### Step 5.1 — Verify K8s EC2

```bash
ssh -i ~/.ssh/bashforge-key.pem ubuntu@<K8S_PUBLIC_IP>

# Check minikube
minikube status

# Check namespace
kubectl get namespace bashforge-sessions
kubectl describe limitrange session-limits -n bashforge-sessions
kubectl describe resourcequota session-quota -n bashforge-sessions

# Check no pods running yet
kubectl get pods -n bashforge-sessions
```

### Step 5.2 — Verify App EC2

```bash
ssh -i ~/.ssh/bashforge-key.pem ubuntu@<APP_PUBLIC_IP>

# Check services
systemctl status nginx redis-server

# Check containers
cd /opt/bashforge
docker compose -f docker-compose.prod.yml ps

# Check backend health
curl http://localhost:8000/api/health
# Should return: {"status":"ok","time":...}

# Check K8s connectivity from App EC2
kubectl --kubeconfig=/home/ubuntu/.kube/config-k8s get nodes
```

### Step 5.3 — End-to-end test

```bash
# Create a session via API (simulates what the browser does)
curl -c /tmp/cookies.txt -b /tmp/cookies.txt \
    -X POST https://yourdomain.com/api/sessions/create \
    -H "Content-Type: application/json"

# Check a pod was created (on K8s EC2)
kubectl get pods -n bashforge-sessions

# Terminate the session
SESSION_ID=$(cat /tmp/cookies.txt | grep bashforge_session | awk '{print $NF}')
curl -c /tmp/cookies.txt -b /tmp/cookies.txt \
    -X DELETE https://yourdomain.com/api/sessions/terminate

# Verify pod was deleted
kubectl get pods -n bashforge-sessions
```

### Step 5.4 — Open the website

Go to https://yourdomain.com — you should see the BashForge landing page.
Click "Practice Now" and watch a pod spin up!

==============================================================

## PART 6: TROUBLESHOOTING

==============================================================

### Problem: WebSocket connection fails after session create

```bash
# On App EC2 — check backend logs
docker compose -f /opt/bashforge/docker-compose.prod.yml logs -f backend

# On K8s EC2 — check if pod is running
kubectl get pods -n bashforge-sessions
kubectl logs <POD_NAME> -n bashforge-sessions

# Check K8s connectivity
kubectl --kubeconfig=/home/ubuntu/.kube/config-k8s get pods -n bashforge-sessions
```

### Problem: Pod stuck in Pending

```bash
# On K8s EC2
kubectl describe pod <POD_NAME> -n bashforge-sessions
# Look for "Events" at bottom — usually image pull issue or resource limit hit

# Check sandbox image is pre-pulled
eval $(minikube docker-env)
docker images | grep sandbox
```

### Problem: "All practice slots in use"

```bash
# On K8s EC2 — force delete all stuck pods
kubectl delete pods --all -n bashforge-sessions --force --grace-period=0

# On App EC2 — clear Redis sessions
redis-cli keys "session:*" | xargs redis-cli del
```

### Problem: Port 8443 connection refused (App EC2 → K8s EC2)

```bash
# On K8s EC2 — check minikube API binding
netstat -tlnp | grep 8443

# If not listening on 0.0.0.0:8443, restart minikube with correct flags
minikube stop
minikube start --driver=docker \
    --extra-config=apiserver.bind-address=0.0.0.0 \
    --listen-address=0.0.0.0
```

### Viewing real-time pod resource usage

```bash
# On K8s EC2
watch kubectl top pods -n bashforge-sessions
```

### Checking session TTLs in Redis

```bash
# On App EC2
redis-cli keys "session:*"
# For each key:
redis-cli ttl "session:<ID>"   # seconds remaining
redis-cli get "session:<ID>"   # full session data
```
