# BashForge — Complete Production Architecture

> **Inspiration:** KodeKloud Labs  
> **Stack:** React · FastAPI · WebSocket · Docker · Kubernetes (Minikube) · AWS EC2 · GitHub Actions

---

## 1. What You Are Building

You are building a **browser-based Bash practice IDE** that mirrors your existing Python/Tkinter BashForge app — same three-panel layout, same dark GitHub-dark colour scheme, same toolbar, same snippets, same syntax highlighting, same shortcuts — but running entirely in a web browser. Every user who clicks "Practice Now" gets their own **isolated Kubernetes Pod** running a hardened Docker container. That container is their personal Linux box: they can write scripts in the editor, run them, use the interactive terminal, `cd` around, create files and folders — all sandboxed. After one hour (or when they close the tab) the pod is terminated and all data is gone.

---

## 2. High-Level Component Map

```
Browser (User)
    │
    │  HTTPS (React SPA)
    ▼
┌──────────────────────────────────┐
│  EC2 — App Server                │
│  ┌────────────┐  ┌─────────────┐ │
│  │  React     │  │  FastAPI    │ │
│  │  Frontend  │  │  Backend    │ │
│  │  (Nginx)   │  │  (Uvicorn)  │ │
│  └────────────┘  └──────┬──────┘ │
│                         │        │
│                   REST + WebSocket
└─────────────────────────┼────────┘
                          │  Kubernetes API (kubectl / k8s Python client)
                          │
┌─────────────────────────┼────────┐
│  EC2 — K8s Server       ▼        │
│  ┌──────────────────────────────┐ │
│  │  Minikube (single-node K8s)  │ │
│  │  ┌──────────┐  ┌──────────┐  │ │
│  │  │  Pod A   │  │  Pod B   │  │ │
│  │  │ session1 │  │ session2 │  │ │
│  │  └──────────┘  └──────────┘  │ │
│  └──────────────────────────────┘ │
└──────────────────────────────────┘
```

---

## 3. AWS Infrastructure — Two EC2 Instances

### 3.1 EC2-1 — App Server (Frontend + Backend)

| Property       | Value                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| Instance type  | `t3.small` (2 vCPU, 2 GB RAM) — enough for API + Nginx                                    |
| OS             | Ubuntu 22.04 LTS                                                                          |
| Storage        | 20 GB gp3                                                                                 |
| Security Group | Port 80, 443 inbound (0.0.0.0/0); Port 22 SSH (your IP only); Port 8000 from K8s EC2 only |
| Elastic IP     | Yes — attach one so DNS doesn't break on restart                                          |
| IAM Role       | None needed (no AWS service calls)                                                        |

**Services running:**

- Nginx — serves the React build on port 443 (SSL via Let's Encrypt / Certbot), reverse-proxies `/api/` and `/ws/` to FastAPI on `localhost:8000`
- FastAPI (Uvicorn) — REST + WebSocket backend on port 8000
- Redis — session state store on `localhost:6379` (no external exposure)

### 3.2 EC2-2 — Kubernetes Server

| Property       | Value                                                             |
| -------------- | ----------------------------------------------------------------- |
| Instance type  | `t3.medium` (2 vCPU, 4 GB RAM) — headroom for ~10 concurrent pods |
| OS             | Ubuntu 22.04 LTS                                                  |
| Storage        | 40 GB gp3                                                         |
| Security Group | Port 6443 (K8s API) from EC2-1 only; Port 22 SSH (your IP only)   |
| Elastic IP     | Yes                                                               |
| IAM Role       | None                                                              |

**Services running:**

- Docker daemon
- Minikube (using Docker driver)
- Kubernetes API on `:6443` — accessible from EC2-1 over a private VPC connection

### 3.3 VPC / Networking

```
VPC: 10.0.0.0/16
  Subnet (public): 10.0.1.0/24
    EC2-1 (App):  10.0.1.10
    EC2-2 (K8s):  10.0.1.20

Security Groups:
  sg-app:
    inbound:  80, 443 from 0.0.0.0/0
              22 from <your-office-ip>/32
    outbound: all (needs to call K8s API on EC2-2)

  sg-k8s:
    inbound:  6443 from sg-app (App EC2)
              22 from <your-office-ip>/32
    outbound: all (pods need internet; controlled by NetworkPolicy inside K8s)
```

Both EC2s sit in the same VPC and the same public subnet so they can talk over private IP without NAT.

---

## 4. Session Lifecycle — The Core Mechanic

This is the most important part of the design. Here is the complete lifecycle of a session:

```
User opens site
       │
       ▼
Landing Page  ──"Practice Now"──►  POST /api/sessions/create
                                          │
                              ┌───────────▼────────────┐
                              │  Check: does this       │
                              │  browser already have   │
                              │  an active session?     │
                              │  (check Redis by        │
                              │   session_token cookie) │
                              └───────────┬────────────┘
                                    YES   │   NO
                                    │     │
                              Return │     ▼
                              existing    Generate session_id (UUID4)
                              pod URL     Set TTL=3600s in Redis
                                          Kubectl: create Pod + Service
                                          Wait for Pod "Running" (~5s)
                                          Return {ws_url, session_id}
                                          Set HttpOnly cookie
                                          │
                                          ▼
                              React IDE loads, connects WebSocket
                                          │
                              ┌───────────▼────────────┐
                              │  WebSocket proxied by   │
                              │  FastAPI → Pod's        │
                              │  bash-server process    │
                              └────────────────────────┘
                                          │
                              User works in IDE (max 60 min)
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                       │
              User clicks             60-min TTL             User closes tab
              "End Session"           expires in Redis        (WebSocket closes)
                    │                     │                       │
                    └─────────────────────┴───────────────────────┘
                                          │
                              FastAPI session-reaper job
                              Kubectl: delete Pod + Service
                              Redis: delete session key
```

### 4.1 One Session Per User — Enforcement

The uniqueness guarantee uses a combination of two things:

**Browser side:** A `session_token` is stored as an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Every request to `/api/sessions/create` sends this cookie. If FastAPI sees the cookie and finds the session still alive in Redis, it returns the existing session instead of creating a new one.

**Backend side (Redis schema):**

```
Key:   session:{session_id}
Value: {
  "pod_name": "bashforge-session-abc123",
  "created_at": 1712345678,
  "expires_at": 1712349278,
  "browser_token": "uuid-of-cookie"
}
TTL: 3600 seconds (auto-expires in Redis)
```

If a user opens a second tab, the same cookie is sent → same session → redirected to existing IDE. They cannot burn a second pod.

### 4.2 Session Reaper (background job)

FastAPI runs an `asyncio` background task that wakes up every 60 seconds and checks Redis for sessions whose `expires_at` has passed. For each expired session it calls `kubectl delete pod` and `kubectl delete service`. This ensures pods are cleaned up even if the user never closed their tab.

---

## 5. Kubernetes Pod Design

### 5.1 Pod Manifest (generated per session)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: bashforge-{session_id_short} # e.g. bashforge-a3f9b1c2
  namespace: bashforge-sessions
  labels:
    app: bashforge-session
    session-id: "{session_id}"
spec:
  restartPolicy: Never # Pod dies, stays dead
  automountServiceAccountToken: false # No K8s API access for pod

  securityContext:
    runAsNonRoot: true
    runAsUser: 1000 # "bashuser" inside container
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault # blocks ~300 dangerous syscalls

  containers:
    - name: bash-session
      image: bashforge/sandbox:latest # Your hardened image
      imagePullPolicy: IfNotPresent

      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: false # User needs to write files
        capabilities:
          drop: ["ALL"] # Drop every Linux capability
          add: [] # Add nothing back

      resources:
        requests:
          memory: "64Mi"
          cpu: "50m"
        limits:
          memory: "150Mi" # Hard 150MB RAM ceiling
          cpu: "300m" # ~0.3 of a core

      volumeMounts:
        - name: workspace
          mountPath: /home/bashuser/workspace # Only writable dir
        - name: tmp
          mountPath: /tmp

      env:
        - name: HOME
          value: /home/bashuser
        - name: SESSION_ID
          value: "{session_id}"
        - name: WS_TOKEN
          value: "{ws_auth_token}" # Backend verifies this on WS connect

  volumes:
    - name: workspace
      emptyDir:
        sizeLimit: "200Mi" # Hard disk limit
    - name: tmp
      emptyDir:
        sizeLimit: "20Mi"
```

### 5.2 Service Manifest (one per pod)

```yaml
apiVersion: v1
kind: Service
metadata:
  name: bashforge-svc-{session_id_short}
  namespace: bashforge-sessions
spec:
  selector:
    session-id: "{session_id}"
  ports:
    - port: 8765
      targetPort: 8765 # WebSocket server inside container
  type: ClusterIP # Internal only — App EC2 reaches this
```

The FastAPI backend on EC2-1 connects to this ClusterIP from outside the cluster using the kubeconfig from EC2-2. The backend proxies WebSocket messages between the browser and the pod.

---

## 6. The Sandbox Container Image

### 6.1 Dockerfile

```dockerfile
FROM ubuntu:22.04

# Install only the tools a practice user needs
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    coreutils \
    grep \
    sed \
    awk \
    gawk \
    findutils \
    util-linux \
    procps \
    net-tools \
    iproute2 \
    iputils-ping \
    curl \
    wget \
    git \
    vim \
    nano \
    jq \
    bc \
    tar \
    gzip \
    unzip \
    less \
    man-db \
    openssh-client \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user with a locked password
RUN groupadd -g 1000 bashuser && \
    useradd -u 1000 -g 1000 -m -s /bin/bash -d /home/bashuser bashuser && \
    passwd -l bashuser

# Create workspace directory (this is the ONLY place user can write)
RUN mkdir -p /home/bashuser/workspace && \
    chown bashuser:bashuser /home/bashuser/workspace

# The bash-ws-server binary bridges stdin/stdout to a WebSocket
COPY bash-ws-server /usr/local/bin/bash-ws-server
RUN chmod +x /usr/local/bin/bash-ws-server

# Restrict /home/bashuser to the user only
RUN chmod 700 /home/bashuser

# Make root filesystem as tight as possible
# User can only write to workspace and /tmp (both are emptyDir volumes)
RUN chmod 1777 /tmp

USER bashuser
WORKDIR /home/bashuser/workspace

# Start the WebSocket-to-PTY bridge on port 8765
EXPOSE 8765
CMD ["/usr/local/bin/bash-ws-server", "--port", "8765", "--shell", "/bin/bash", "--chdir", "/home/bashuser/workspace"]
```

### 6.2 bash-ws-server

This is a small Go binary (or Python script) that:

1. Listens on `:8765` for a WebSocket connection
2. Validates the `WS_TOKEN` from the first message (prevents other pods or strangers from connecting)
3. Spawns `/bin/bash` inside a PTY (`pty.openpty()`) in the user's workspace
4. Bridges WebSocket ↔ PTY bidirectionally — browser input goes to bash stdin, bash stdout/stderr comes back to browser

This is the same PTY model your Python code already uses (`pty.openpty`, `select.select`, `os.read/write`) — just moved into a microserver inside the container.

**Implementation choices (pick one):**

- Go: use `github.com/creack/pty` + `github.com/gorilla/websocket` — ~200 lines, single binary, ~8MB
- Python: use `websockets` + `pty` stdlib — ~100 lines, but requires Python in image

The Go option is better because: smaller image, lower memory overhead, no runtime dependency.

### 6.3 Disk Quota Enforcement

The `emptyDir.sizeLimit: "200Mi"` in the pod spec causes the kubelet to enforce a 200MB disk limit on that volume via the OS-level quota system. If the user exceeds 200MB (e.g., running `dd if=/dev/zero of=bigfile`), the write fails with `No space left on device`. The pod is NOT killed — writes just start failing, which is the correct behaviour for a practice environment.

---

## 7. Security Model — Layered Defence

Security is applied at 4 independent layers. An attacker would have to break all 4:

### Layer 1 — Container User (non-root)

The process inside the pod runs as `uid=1000 (bashuser)`. Commands like `sudo`, `su`, `passwd`, or writing to `/etc` simply fail with permission denied. No `sudo` binary is installed. Even if somehow elevated, Layer 2 stops the next step.

### Layer 2 — Linux Capabilities (none)

`capabilities: drop: ["ALL"]` removes every Linux capability from the container process. This means the bash process cannot:

- `CAP_NET_ADMIN` — no iptables/routes manipulation
- `CAP_SYS_ADMIN` — no mounting, no namespace creation, no `chroot`
- `CAP_SYS_PTRACE` — no attaching to other processes
- `CAP_CHOWN` / `CAP_DAC_OVERRIDE` — no bypassing file permissions
- `CAP_SETUID` / `CAP_SETGID` — no `setuid` escalation

### Layer 3 — Seccomp (syscall filter)

`seccompProfile: type: RuntimeDefault` applies Docker/containerd's default seccomp profile which blocks ~300 dangerous system calls including `ptrace`, `reboot`, `kexec_load`, `create_module`, `init_module`, `finit_module`, `delete_module`, `mount`, `umount2`, `pivot_root`, `chroot`, `unshare`, `clone` (with dangerous flags), and more. The user's bash process only has access to safe, well-understood syscalls.

### Layer 4 — Kubernetes NetworkPolicy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: session-network-policy
  namespace: bashforge-sessions
spec:
  podSelector:
    matchLabels:
      app: bashforge-session
  policyTypes:
    - Ingress
    - Egress

  ingress:
    # Only the FastAPI backend (on App EC2) can connect to the pod
    - from:
        - ipBlock:
            cidr: 10.0.1.10/32 # App EC2 private IP
      ports:
        - port: 8765

  egress:
    # Allow DNS (so curl/wget work by hostname)
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP

    # Allow HTTP/HTTPS (internet access for practice scripts)
    - ports:
        - port: 80
          protocol: TCP
        - port: 443
          protocol: TCP

  # BLOCK everything else:
  # - No access to other pods in cluster
  # - No access to AWS metadata endpoint (169.254.169.254)
  # - No access to EC2-1 or EC2-2 internal IPs
  # - No raw sockets, no port scanning
```

Additionally, a `LimitRange` object is applied to the namespace so no pod can escape resource limits:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: session-limits
  namespace: bashforge-sessions
spec:
  limits:
    - type: Container
      max:
        memory: 150Mi
        cpu: "300m"
      default:
        memory: 150Mi
        cpu: "300m"
      defaultRequest:
        memory: 64Mi
        cpu: "50m"
```

And a `ResourceQuota` on the namespace caps total cluster consumption:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: session-quota
  namespace: bashforge-sessions
spec:
  hard:
    pods: "20" # max 20 concurrent sessions
    requests.memory: "1Gi"
    limits.memory: "3Gi"
    requests.cpu: "1"
    limits.cpu: "6"
```

### What the user CAN do (inside workspace)

- Create, read, write, execute any files inside `/home/bashuser/workspace/`
- Create subdirectories (unlimited nesting)
- Write bash scripts and run them
- Use `curl`, `wget` to HTTP/HTTPS endpoints
- Use `git clone` (HTTPS only)
- Use `ping`, `nslookup`, `dig` for network practice
- Run standard GNU tools: `awk`, `sed`, `grep`, `find`, `sort`, etc.

### What the user CANNOT do

- Write outside `/home/bashuser/workspace/` (permission denied)
- `sudo` or `su` (not installed, user is non-root)
- Mount filesystems, create namespaces, use raw sockets
- Access the AWS metadata endpoint (`169.254.169.254`)
- Access other pods or cluster-internal services
- Consume more than 150MB RAM (pod gets OOMKilled)
- Consume more than 200MB disk (write returns ENOSPC)
- Run `nmap`, network scans (raw sockets are blocked by seccomp)
- Fork bomb (the `pids` cgroup limit can be set to 100 in the pod spec)

---

## 8. Frontend — React Web App (Exact BashForge UI)

### 8.1 Technology Stack

- **React 18** + **TypeScript**
- **Monaco Editor** (same engine as VS Code) — replaces the Tkinter text widget; gives you syntax highlighting, line numbers, find/replace, keyboard shortcuts, auto-close brackets, tab indent — all built in
- **xterm.js** — replaces the Tkinter terminal widget; gives you a real terminal emulator in the browser with colours, cursor, scrollback, history, tab-complete feel
- **WebSocket API** (native browser) — connects to FastAPI which proxies to the pod
- **Tailwind CSS** — utility-first styling; exact colour values from your Python code

### 8.2 Color Tokens (exact Python → CSS variables)

```css
:root {
  --bg-main: #0d1117;
  --bg-editor: #0d1117;
  --bg-output: #010409;
  --bg-terminal: #0a0e14;
  --bg-toolbar: #161b22;
  --bg-statusbar: #161b22;
  --bg-lineno: #0d1117;
  --bg-panel-hdr: #13171f;
  --bg-args: #0d1421;

  --fg-default: #e6edf3;
  --fg-dim: #8b949e;
  --fg-accent: #58a6ff;
  --fg-green: #3fb950;
  --fg-yellow: #d29922;
  --fg-red: #f85149;
  --fg-purple: #bc8cff;
  --fg-orange: #ffa657;
  --fg-cyan: #79c0ff;
  --fg-string: #a5d6ff;
  --fg-comment: #6e7681;

  --border: #30363d;
  --hover-bg: #1c2128;
  --active-bg: #21262d;
  --sel-bg: #1f3a5f;
}
```

### 8.3 Layout (mirrors three-panel Python layout)

```
┌─────────────────────────────────────────────────────────┐
│  TOOLBAR: [+New] [Open] [Save] [Save As] | [▶ Run] [■ Stop] | [# Comment] [...Snippets] [F Find] | [Clear ▼] [Exit]
├──────────────────────────────┬──────────────────────────┤
│                              │  ARGS BAR: $1 $2 ...     │
│                              ├──────────────────────────┤
│  EDITOR PANEL                │  SCRIPT OUTPUT           │
│  (Monaco Editor)             │  (xterm.js — output-only │
│  • Line numbers built-in     │   + interactive stdin)   │
│  • Bash syntax highlight     │                          │
│  • JetBrains Mono font       ├──────────────────────────┤
│  • Resizable                 │  TERMINAL                │
│                              │  (xterm.js — full PTY)   │
│                              │  $ ▋                     │
├──────────────────────────────┴──────────────────────────┤
│  STATUSBAR: filename  *modified  |  Ln 1 Col 1  |  ~/workspace
└─────────────────────────────────────────────────────────┘
```

Both right panels are xterm.js instances connected to the same WebSocket but different "channels" (multiplexed with a 1-byte channel prefix: `0x01` = script output, `0x02` = terminal).

### 8.4 Key Shortcuts (matching Python exactly)

| Shortcut              | Action                               |
| --------------------- | ------------------------------------ |
| `Ctrl+Enter`          | Run script                           |
| `Ctrl+S`              | Save file                            |
| `Ctrl+O`              | Open file                            |
| `Ctrl+N`              | New file                             |
| `Ctrl+/`              | Toggle comment                       |
| `Ctrl+F`              | Open find bar                        |
| `Ctrl+H`              | Open find+replace                    |
| `Ctrl+D`              | Duplicate line                       |
| `Ctrl+Z` / `Ctrl+Y`   | Undo / Redo                          |
| `Tab`                 | Indent (4 spaces)                    |
| `Shift+Tab`           | Dedent                               |
| `Up/Down` in terminal | Command history                      |
| `Tab` in terminal     | Tab-completion (handled by bash PTY) |

### 8.5 File Management in Browser

Since files live inside the pod's workspace, the frontend communicates file operations over the WebSocket:

- **New file** → sends `{type: "file_new", name: "script.sh"}` → pod creates the file and opens it in editor
- **Open file** → sends `{type: "file_list"}` → pod returns directory listing → user picks file → `{type: "file_open", path: "..."}` → pod returns content
- **Save** → sends `{type: "file_save", path: "...", content: "..."}` → pod writes the file
- **Multiple tabs** → Monaco Editor's multi-model API; each open file is a separate model; tab bar across the top of the editor panel

### 8.6 Landing Page

```
┌────────────────────────────────────────────────┐
│  ⚡ BashForge                              [Login]│
├────────────────────────────────────────────────┤
│                                                │
│     DevOps Bash Practice                       │
│     ── Real Linux. Real Terminal. In your      │
│        browser. No setup needed.               │
│                                                │
│     [  ▶  Practice Now  ]                      │
│                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Isolated │  │ 20+ DevOps│  │ 1-hour  │     │
│  │   Pod    │  │ Snippets  │  │ Sessions│     │
│  └──────────┘  └──────────┘  └──────────┘     │
└────────────────────────────────────────────────┘
```

Clicking "Practice Now" calls `POST /api/sessions/create`. If the session is created, the page navigates to `/ide`. If the user already has an active session, they are redirected to the existing IDE immediately with a toast: _"Resuming your existing session (42 min remaining)"_.

---

## 9. Backend — FastAPI

### 9.1 API Routes

```
POST   /api/sessions/create          Create or resume session
GET    /api/sessions/status          Check remaining TTL
DELETE /api/sessions/terminate       User-initiated early termination
GET    /api/sessions/files           List files in workspace
WS     /ws/terminal/{session_id}     WebSocket → Pod PTY (multiplexed)
```

### 9.2 Session Create Logic (pseudocode)

```python
@app.post("/api/sessions/create")
async def create_session(response: Response, request: Request):
    token = request.cookies.get("bashforge_session")

    if token:
        session = await redis.get(f"session:{token}")
        if session:
            return {"status": "resumed", "session_id": token,
                    "ttl": session["expires_at"] - time.time()}

    session_id = str(uuid.uuid4())
    pod_name   = f"bashforge-{session_id[:8]}"
    ws_token   = secrets.token_hex(32)

    # Render pod+service YAML templates with session_id values
    pod_yaml = render_pod_manifest(session_id, pod_name, ws_token)
    svc_yaml = render_service_manifest(session_id, pod_name)

    # Apply to K8s via Python k8s client
    k8s_core_v1.create_namespaced_pod("bashforge-sessions", pod_yaml)
    k8s_core_v1.create_namespaced_service("bashforge-sessions", svc_yaml)

    # Wait for pod to be Running (poll every 500ms, timeout 30s)
    await wait_for_pod_ready(pod_name)

    await redis.setex(
        f"session:{session_id}",
        3600,
        json.dumps({"pod": pod_name, "ws_token": ws_token,
                    "created": time.time(), "expires": time.time() + 3600})
    )

    response.set_cookie("bashforge_session", session_id,
                        httponly=True, secure=True, samesite="strict",
                        max_age=3600)
    return {"status": "created", "session_id": session_id}
```

### 9.3 WebSocket Proxy

The FastAPI WebSocket endpoint acts as a proxy between the browser and the pod:

```
Browser  <──WS──>  FastAPI  <──WS──>  bash-ws-server in Pod
                   (proxy)
```

This is important: the browser never directly reaches the pod. The pod is on an internal Kubernetes ClusterIP that only the App EC2 can reach.

Multiplexing: the FastAPI proxy adds a 1-byte channel prefix to every WebSocket frame:

- `\x01` + data → script execution output/input
- `\x02` + data → terminal PTY

The frontend JavaScript splits incoming frames by this prefix and routes to the right xterm.js instance.

### 9.4 Session Reaper

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    reaper_task = asyncio.create_task(session_reaper())
    yield
    reaper_task.cancel()
    try:
        await reaper_task
    except asyncio.CancelledError:
        pass
    await close_redis()
    log.info("BashForge backend shut down")

async def session_reaper():
    while True:
        await asyncio.sleep(60)
        keys = await redis.keys("session:*")
        for key in keys:
            session = await redis.get(key)
            if session and time.time() > session["expires"]:
                await terminate_pod(session["pod"])
                await redis.delete(key)
```

---

## 10. WebSocket Message Protocol

All messages are JSON with a `type` field:

### Browser → Backend

```json
{"type": "terminal_input",  "data": "ls -la\n"}
{"type": "script_run",      "code": "#!/bin/bash\necho hello", "args": "arg1 arg2"}
{"type": "script_stop"}
{"type": "file_save",       "path": "myscript.sh", "content": "#!/bin/bash\n..."}
{"type": "file_open",       "path": "myscript.sh"}
{"type": "file_new",        "name": "new_script.sh"}
{"type": "file_list"}
{"type": "ping"}
```

### Backend → Browser

```json
{"type": "terminal_output", "data": "total 8\ndrwxr-xr-x..."}
{"type": "script_output",   "data": "hello\n",   "stream": "stdout"}
{"type": "script_output",   "data": "Error: ...", "stream": "stderr"}
{"type": "script_done",     "exit_code": 0,       "elapsed": 1.23}
{"type": "file_content",    "path": "x.sh",      "content": "#!/bin/bash\n..."}
{"type": "file_list",       "files": [{"name": "script.sh", "size": 123, "modified": 1712345}]}
{"type": "file_saved",      "path": "x.sh"}
{"type": "session_ttl",     "remaining": 3421}
{"type": "pong"}
```

---

## 11. Project Directory Structure

```
bashforge/
├── frontend/                    # React app
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Landing.tsx      # Landing page with "Practice Now"
│   │   │   └── IDE.tsx          # Main IDE page
│   │   ├── components/
│   │   │   ├── Toolbar.tsx
│   │   │   ├── EditorPanel.tsx  # Monaco Editor wrapper
│   │   │   ├── OutputPanel.tsx  # xterm.js (script output)
│   │   │   ├── TerminalPanel.tsx # xterm.js (shell terminal)
│   │   │   ├── ArgsBar.tsx
│   │   │   ├── StatusBar.tsx
│   │   │   ├── FindBar.tsx
│   │   │   ├── SnippetsPanel.tsx
│   │   │   └── SessionTimer.tsx # Countdown HH:MM:SS
│   │   ├── hooks/
│   │   │   ├── useSession.ts    # Session create/resume logic
│   │   │   └── useIDESocket.ts  # WebSocket management
│   │   ├── constants/
│   │   │   ├── colors.ts        # Exact colour values from Python
│   │   │   └── snippets.ts      # All 20 DevOps snippets
│   │   └── App.tsx
│   ├── public/
│   ├── package.json
│   ├── tailwind.config.js
│   └── Dockerfile               # Multi-stage: build → nginx:alpine
│
├── backend/                     # FastAPI app
│   ├── main.py                  # FastAPI app, routes
│   ├── session_manager.py       # Create/terminate/reaper
│   ├── k8s_client.py            # Kubernetes API wrapper
│   ├── ws_proxy.py              # WebSocket proxy logic
│   ├── redis_client.py
│   ├── templates/
│   │   ├── pod.yaml.j2          # Jinja2 pod template
│   │   └── service.yaml.j2
│   ├── requirements.txt
│   └── Dockerfile
│
├── sandbox/                     # Container that runs in pods
│   ├── bash-ws-server/
│   │   ├── main.go              # Go WebSocket↔PTY bridge
│   │   └── go.mod
│   └── Dockerfile
│
├── k8s/                         # K8s manifests applied once
│   ├── namespace.yaml
│   ├── network-policy.yaml
│   ├── limit-range.yaml
│   └── resource-quota.yaml
│
├── infra/                       # Infrastructure as code
│   ├── ec2-app-setup.sh         # Bootstrap script for EC2-1
│   └── ec2-k8s-setup.sh         # Bootstrap script for EC2-2
│
├── .github/
│   └── workflows/
│       ├── ci.yml               # Test + lint on PR
│       └── deploy.yml           # Deploy on push to main
│
└── docker-compose.yml           # Local dev (no K8s needed)
```

---

## 12. GitHub Actions CI/CD Pipeline

### 12.1 CI — runs on every PR and push

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  frontend-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: cd frontend && npm ci
      - run: cd frontend && npm run lint
      - run: cd frontend && npm test -- --watchAll=false
      - run: cd frontend && npm run build

  backend-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11" }
      - run: cd backend && pip install -r requirements.txt
      - run: cd backend && pip install pytest pytest-asyncio httpx
      - run: cd backend && pytest

  sandbox-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: "1.22" }
      - run: cd sandbox/bash-ws-server && go build ./...
      - run: cd sandbox && docker build -t bashforge/sandbox:test .
      # Security scan the sandbox image
      - uses: aquasecurity/trivy-action@master
        with:
          image-ref: "bashforge/sandbox:test"
          severity: "CRITICAL,HIGH"
          exit-code: "1"
```

### 12.2 Deploy — runs on push to `main`

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

env:
  AWS_REGION: ap-south-1
  EC2_APP_HOST: ${{ secrets.EC2_APP_HOST }}
  EC2_K8S_HOST: ${{ secrets.EC2_K8S_HOST }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to Amazon ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build & push frontend
        run: |
          IMAGE=${{ steps.login-ecr.outputs.registry }}/bashforge-frontend:${{ github.sha }}
          docker build -t $IMAGE ./frontend
          docker push $IMAGE
          echo "FRONTEND_IMAGE=$IMAGE" >> $GITHUB_ENV

      - name: Build & push backend
        run: |
          IMAGE=${{ steps.login-ecr.outputs.registry }}/bashforge-backend:${{ github.sha }}
          docker build -t $IMAGE ./backend
          docker push $IMAGE
          echo "BACKEND_IMAGE=$IMAGE" >> $GITHUB_ENV

      - name: Build & push sandbox
        run: |
          IMAGE=${{ steps.login-ecr.outputs.registry }}/bashforge-sandbox:${{ github.sha }}
          docker build -t $IMAGE ./sandbox
          docker push $IMAGE

      - name: Deploy to App EC2 via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.EC2_APP_HOST }}
          username: ubuntu
          key: ${{ secrets.EC2_APP_SSH_KEY }}
          script: |
            # Pull new images
            aws ecr get-login-password --region ap-south-1 | \
              docker login --username AWS --password-stdin ${{ steps.login-ecr.outputs.registry }}
            docker pull ${{ env.FRONTEND_IMAGE }}
            docker pull ${{ env.BACKEND_IMAGE }}

            # Zero-downtime swap using docker compose
            cd /opt/bashforge
            sed -i "s|bashforge-frontend:.*|bashforge-frontend:${{ github.sha }}|" docker-compose.prod.yml
            sed -i "s|bashforge-backend:.*|bashforge-backend:${{ github.sha }}|" docker-compose.prod.yml
            docker compose -f docker-compose.prod.yml up -d --no-deps frontend backend
            docker compose -f docker-compose.prod.yml ps

  deploy-sandbox-k8s:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Pull new sandbox image on K8s EC2
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.EC2_K8S_HOST }}
          username: ubuntu
          key: ${{ secrets.EC2_K8S_SSH_KEY }}
          script: |
            aws ecr get-login-password --region ap-south-1 | \
              docker login --username AWS --password-stdin ${{ steps.login-ecr.outputs.registry }}
            # Pre-pull the new sandbox image into minikube's Docker daemon
            eval $(minikube docker-env)
            docker pull ${{ steps.login-ecr.outputs.registry }}/bashforge-sandbox:latest
            # New pods created after this point will use the new image
            echo "Sandbox image updated on K8s node"
```

### 12.3 Secrets to configure in GitHub

| Secret                  | Value                        |
| ----------------------- | ---------------------------- |
| `AWS_ACCESS_KEY_ID`     | IAM user key (ECR push only) |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret              |
| `EC2_APP_HOST`          | Elastic IP of EC2-1          |
| `EC2_K8S_HOST`          | Elastic IP of EC2-2          |
| `EC2_APP_SSH_KEY`       | Private key for EC2-1 SSH    |
| `EC2_K8S_SSH_KEY`       | Private key for EC2-2 SSH    |

---

## 13. Low-Latency Optimisations

Since you specifically asked about performance on low-bandwidth networks:

**Frontend bundle size:**

- Code-split Monaco Editor (lazy load only when IDE page opens, not on landing page)
- xterm.js is ~200KB gzipped — load it async after WebSocket connects
- Total landing page: target <100KB first paint

**WebSocket:**

- Use binary WebSocket frames (not JSON) for terminal I/O — saves JSON overhead on every keystroke
- Enable WebSocket permessage-deflate compression in FastAPI (built-in with `uvicorn`)
- Reconnect logic: if WebSocket drops (mobile switching networks), auto-reconnect within 3s and re-attach to existing session (pod is still running)

**Nginx:**

- `gzip on` for all static assets
- `Cache-Control: max-age=31536000, immutable` for hashed JS/CSS bundles
- `Cache-Control: no-cache` for `index.html` (always fresh)

**Pod startup latency:**

- Pre-pull the sandbox image on the K8s node at deploy time (the deploy pipeline does `docker pull` on EC2-2 in advance)
- A pod with a pre-pulled image starts in ~1–2 seconds instead of 15–30 seconds for a cold pull

---

## 14. EC2 Bootstrap Scripts

### EC2-1 (App Server) setup

```bash
#!/bin/bash
# infra/ec2-app-setup.sh
set -euo pipefail

apt-get update && apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx redis-server awscli

# Start Redis (session store)
systemctl enable --now redis-server

# Docker
systemctl enable --now docker
usermod -aG docker ubuntu

# Get kubeconfig from EC2-2 (run after EC2-2 is set up)
# scp ubuntu@<EC2-2-IP>:~/.kube/config ~/.kube/config
# Then replace server IP to EC2-2's private IP

mkdir -p /opt/bashforge
# Copy docker-compose.prod.yml here, then:
# docker compose -f /opt/bashforge/docker-compose.prod.yml up -d

# SSL
certbot --nginx -d yourdomain.com --non-interactive --agree-tos -m you@email.com
```

### EC2-2 (K8s Server) setup

```bash
#!/bin/bash
# infra/ec2-k8s-setup.sh
set -euo pipefail

apt-get update && apt-get install -y docker.io curl conntrack

# Minikube
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
install minikube-linux-amd64 /usr/local/bin/minikube

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
install kubectl /usr/local/bin/kubectl

usermod -aG docker ubuntu

# Start minikube (as ubuntu user, with enough resources)
su ubuntu -c "minikube start --driver=docker --cpus=2 --memory=3500mb --disk-size=30g"

# Apply one-time K8s resources
su ubuntu -c "kubectl apply -f /opt/bashforge/k8s/"

# Expose K8s API on the EC2's private IP (minikube does this already via 0.0.0.0:6443)
# Copy kubeconfig to App EC2:
# cat ~/.kube/config  (then send to EC2-1)
```

---

## 15. Local Development Setup

```bash
# Run everything locally without K8s using docker-compose
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

---

## 16. Implementation Order (Recommended)

Do this in phases so you have something working at each step:

**Phase 1 — Local IDE (2–3 days)**
Build the React IDE with Monaco + xterm.js, connecting to a locally running sandbox Docker container. No sessions, no K8s. Just make the IDE feel right.

**Phase 2 — Backend + Local K8s (2–3 days)**
Build FastAPI. Add session create/terminate. Use `minikube` on your own laptop (or a local VM) to test pod lifecycle. Add Redis. Get the WebSocket proxy working.

**Phase 3 — AWS + Minikube on EC2 (1–2 days)**
Provision the two EC2s. Run the bootstrap scripts. Copy your working code there. Test end-to-end in the cloud.

**Phase 4 — Security hardening (1 day)**
Apply all the NetworkPolicy, LimitRange, ResourceQuota, seccomp, capability drops. Test that you actually can't break out.

**Phase 5 — GitHub Actions (1 day)**
Add the CI/CD pipeline. Set up ECR. Wire up secrets. Test a full deploy on push.

**Phase 6 — Landing page + UX polish (1 day)**
Session timer, reconnect logic, toast notifications, mobile-responsive toolbar.

---

## 17. Rough Monthly Cost Estimate (AWS ap-south-1)

| Resource           | Type                | Est. $/month   |
| ------------------ | ------------------- | -------------- |
| EC2-1 App Server   | t3.small On-Demand  | ~$17           |
| EC2-2 K8s Server   | t3.medium On-Demand | ~$35           |
| EC2-1 EBS 20GB gp3 | Storage             | ~$2            |
| EC2-2 EBS 40GB gp3 | Storage             | ~$4            |
| Elastic IPs (2)    | Networking          | ~$8            |
| ECR image storage  | Registry            | ~$1            |
| Data transfer      | Outbound            | ~$3            |
| **Total**          |                     | **~$70/month** |

Switch to Reserved Instances (1-year, no upfront) and this drops to ~$45/month.

---

## 18. Summary — The Complete Picture

You are building a platform with these moving parts, all working together:

1. **User hits landing page** → served by Nginx on EC2-1 from a React bundle
2. **Clicks Practice Now** → React calls `POST /api/sessions/create` on FastAPI
3. **FastAPI checks Redis** → no existing session → calls K8s API on EC2-2 → creates Pod + Service in `bashforge-sessions` namespace
4. **Pod starts** (~2s with pre-pulled image) → runs `bash-ws-server` on port 8765
5. **FastAPI returns session_id** → sets HttpOnly cookie → React navigates to `/ide`
6. **React IDE loads** → Monaco Editor, two xterm.js panes, toolbar with all BashForge features
7. **React opens WebSocket** to `/ws/terminal/{session_id}` → FastAPI proxies to pod's ClusterIP:8765
8. **User types in terminal** → keystrokes go Browser→FastAPI→Pod→bash PTY → output comes back Pod→FastAPI→Browser→xterm.js
9. **User writes a script** in Monaco → clicks Run → FastAPI sends `{type: "script_run"}` → pod forks bash to execute it → output streams back in real time
10. **1 hour passes** → session reaper deletes pod → browser shows "Session expired" toast
11. **GitHub push to main** → Actions builds images → pushes to ECR → SSHes into both EC2s → rolls out new containers with zero downtime

---

## Local Setup and Development

For local development and setup instructions, please refer to [DEPLOYMENT.md](DEPLOYMENT.md). It contains detailed steps for:

- Setting up the local development environment using Docker Compose
- Running the application locally without Kubernetes
- Building and deploying to AWS infrastructure
- Configuring CI/CD with GitHub Actions
- Troubleshooting common issues

The deployment guide provides comprehensive instructions for getting BashForge running in various environments, from local development to production deployment on AWS.
