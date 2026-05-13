# BashForge

A browser-based Bash practice environment. Click **Start Session**, get a fully isolated Linux terminal + Monaco editor + script runner for 1 hour. No account needed.

```
 ┌─────────────────────────────────────────────────────────┐
 │  Browser                                                │
 │  ┌──────────────┐  ┌────────────┐  ┌────────────────┐  │
 │  │ Monaco Editor│  │  Terminal  │  │ Script Output  │  │
 │  └──────────────┘  └────────────┘  └────────────────┘  │
 └──────────────────────────┬──────────────────────────────┘
                            │  HTTPS / WSS
                            ▼
              ┌─────────────────────────┐
              │   Vercel (React SPA)    │
              └─────────────────────────┘
                            │  API  /  WebSocket
                            ▼
              ┌─────────────────────────┐
              │  ALB  (AWS)             │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  ECS Fargate Service    │
              │  FastAPI backend        │◄──► ElastiCache (Redis)
              └────────────┬────────────┘
                           │  run_task per session
              ┌────────────▼────────────┐
              │  ECS Fargate Task       │
              │  Go bash-ws-server      │  (Ubuntu 22.04, UID 1000)
              │  isolated per user      │
              └─────────────────────────┘
                           ▲
              ┌────────────┴────────────┐
              │  ECR  (container images)│
              └─────────────────────────┘
              All infra managed by Terraform
```

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 + TypeScript + Vite 5, Monaco Editor, xterm.js |
| Backend | FastAPI (Python 3.12), Redis |
| Sandbox | Go 1.22 PTY server, Ubuntu 22.04, ECS Fargate task per session |
| Infra | AWS ECS Fargate, ElastiCache Redis, ALB, ECR, VPC — Terraform |
| Frontend hosting | Vercel |
| CI/CD | GitHub Actions |

---

## Environments

| Env | Branch | Auto-deploy | Purpose |
|-----|--------|-------------|---------|
| `dev` | `develop` | on push | Active development |
| `staging` | `staging` | on push | Pre-prod validation |
| `prod` | `main` | manual approval gate | Live |

## Branching Strategy

```
main (prod, protected)
 └── staging (protected)
       └── develop
             └── feature/*  →  PR  →  develop
             └── fix/*       →  PR  →  develop
             └── chore/*     →  PR  →  develop
```

---

## Session Lifecycle

```
User clicks "Start Session"
  │
  ├─ [✓] Authenticating...         POST /sessions/create
  ├─ [✓] Provisioning container... ECS run_task()
  ├─ [✓] Starting environment...   wait RUNNING + health check
  ├─ [✓] Establishing connection...WebSocket auth handshake
  └─ [✓] Loading workspace...      file_list → open editor
```

ECS Fargate cold starts (5–15s) are surfaced as a live step animation — the provisioning lag becomes a feature, not a bug.

---

## Local Development

```bash
docker-compose up --build
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend | http://localhost:8000 |

`MOCK_ECS=true` — sandbox runs as a local Docker container, no AWS needed.

---

## Infrastructure

All AWS resources are managed by Terraform. See `terraform/`.

```
terraform/
├── modules/
│   ├── networking/     # VPC, subnets, security groups
│   ├── ecr/            # ECR repositories
│   ├── ecs/            # Cluster, task defs, IAM roles
│   ├── elasticache/    # Redis
│   └── alb/            # Load balancer
└── environments/
    ├── dev/
    ├── staging/
    └── prod/
```

Remote state: S3 + DynamoDB locking.

---

## CI/CD Pipeline

```
PR opened
  └── ci.yml
        ├── Frontend: tsc --noEmit + build
        ├── Backend: ruff + pytest
        └── Sandbox: go vet + build + Trivy scan

Merge to develop / staging / main
  └── deploy.yml
        ├── Build images → push to ECR (tagged with git SHA)
        ├── Terraform plan / apply (environment-scoped)
        └── ECS rolling deploy (new task def revision)
```

---

## Security

Each sandbox container runs as UID 1000 with no capabilities, seccomp RuntimeDefault, and egress restricted to public internet only (blocks AWS IMDS, VPC CIDRs, RFC 1918). See `SECURITY.md`.

---

## Authors

Pavan Kumar Bandaru · Ojha · Pranav
