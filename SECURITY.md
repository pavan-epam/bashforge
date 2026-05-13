# BashForge — Security Architecture

> **Scope:** This document covers every security control applied to the BashForge sandbox environment — from the Linux kernel level up to the application layer. It describes the threat model, each defense layer, verified attack vectors and their mitigations, and known residual risks.

---

## Table of Contents

1. [Threat Model](#1-threat-model)
2. [Defense-in-Depth Overview](#2-defense-in-depth-overview)
3. [Layer 1 — Linux User Isolation](#3-layer-1--linux-user-isolation)
4. [Layer 2 — Linux Capabilities (Drop All)](#4-layer-2--linux-capabilities-drop-all)
5. [Layer 3 — Seccomp Syscall Filter](#5-layer-3--seccomp-syscall-filter)
6. [Layer 4 — Kubernetes NetworkPolicy](#6-layer-4--kubernetes-networkpolicy)
7. [Layer 5 — Resource Limits](#7-layer-5--resource-limits)
8. [Layer 6 — Application Hardening (sandbox server)](#8-layer-6--application-hardening-sandbox-server)
9. [Attack Surface Assessment](#9-attack-surface-assessment)
10. [What Users CAN and CANNOT Do](#10-what-users-can-and-cannot-do)
11. [Security Testing Checklist](#11-security-testing-checklist)
12. [Residual Risks and Known Limitations](#12-residual-risks-and-known-limitations)

---

## 1. Threat Model

### Who are we protecting?

| Asset | Protected From |
|---|---|
| **AWS EC2 host and IAM credentials** | Pod escape, metadata endpoint access, host privilege escalation |
| **Other user sessions** | Cross-pod access, side-channel attacks |
| **The K8s cluster itself** | API server access, namespace pollution |
| **BashForge infrastructure** | DDoS origination, internal service scanning |
| **The `WS_TOKEN` secret** | Session hijacking by a user reading process memory |

### Who are the adversaries?

BashForge treats **every user as untrusted by default**. The assumed adversary is:

- A curious or malicious user running arbitrary bash commands
- Someone attempting to escape the container and reach the host or other pods
- Someone attempting to steal cloud credentials via the AWS metadata endpoint
- Someone attempting to exhaust resources and impact other users' sessions
- Someone attempting to read files outside their home directory via the file editor API

### Non-goals

- Protection against kernel zero-days (this requires regular image patching)
- Protection against a fully compromised Kubernetes node
- Content filtering of scripts (users should be free to write any bash)

---

## 2. Defense-in-Depth Overview

BashForge uses **8 independent security layers**. An attacker must bypass all applicable layers to cause real harm. Most attack paths are blocked at multiple layers simultaneously.

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 8 │  Application: File API symlink protection             │
├──────────────────────────────────────────────────────────────────┤
│  Layer 7 │  Application: Signal trap, WS_TOKEN scrub, timeouts   │
├──────────────────────────────────────────────────────────────────┤
│  Layer 6 │  Application: ulimit wrapper (processes, fds, CPU)    │
├──────────────────────────────────────────────────────────────────┤
│  Layer 5 │  K8s: Resource limits (CPU, RAM, disk, /dev/shm)      │
├──────────────────────────────────────────────────────────────────┤
│  Layer 4 │  K8s: NetworkPolicy (egress: public internet only)    │
├──────────────────────────────────────────────────────────────────┤
│  Layer 3 │  Linux: Seccomp RuntimeDefault (~300 blocked syscalls) │
├──────────────────────────────────────────────────────────────────┤
│  Layer 2 │  Linux: All capabilities dropped (CAP_* = none)       │
├──────────────────────────────────────────────────────────────────┤
│  Layer 1 │  Linux: Non-root user (UID 1000, no sudo binary)      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Layer 1 — Linux User Isolation

### What is enforced

Every process inside the container runs as `bashuser` (UID/GID 1000) with a locked password. The following binaries are **deleted from the image at build time**:

| Binary | Why Removed |
|---|---|
| `/usr/bin/sudo` | Prevents `sudo su` or `sudo bash` escalation |
| `/usr/sbin/useradd` | Prevents creating new users |
| `/usr/sbin/adduser` | Same |

The home directory is `chmod 700` — only `bashuser` can read it. The root filesystem is owned by root; `bashuser` can only write inside `/home/bashuser/` (the home) and the two volume-backed directories (`/home/bashuser/workspace`, `/tmp`).

### What this stops

- Writing to `/etc/passwd`, `/etc/shadow`, system binaries
- Creating SUID files (they can create them, but SUID is irrelevant without elevated capabilities — see Layer 2)
- Any action that requires `root` or another UID

### Dockerfile snippet

```dockerfile
RUN groupadd -g 1000 bashuser \
    && useradd -u 1000 -g 1000 -m -s /bin/bash -d /home/bashuser bashuser \
    && passwd -l bashuser \
    && rm -f /usr/bin/sudo /usr/sbin/useradd /usr/sbin/adduser \
    && chmod 700 /home/bashuser

USER bashuser
```

---

## 4. Layer 2 — Linux Capabilities (Drop All)

### What is enforced

The pod's security context drops **every** Linux capability:

```yaml
securityContext:
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
```

`allowPrivilegeEscalation: false` sets the `no_new_privs` bit on all processes in the container. This means `execve` can never gain new capabilities, even via SUID binaries.

### What this stops

| Capability | Attack Blocked |
|---|---|
| `CAP_NET_ADMIN` | No iptables manipulation, no routing changes, no packet injection |
| `CAP_NET_RAW` | No raw sockets → `nmap` SYN scans, ICMP ping floods, packet crafting all fail |
| `CAP_SYS_ADMIN` | No mounting filesystems, no namespace creation (`unshare`), no `chroot` |
| `CAP_SYS_PTRACE` | No `ptrace` → cannot attach a debugger to other processes |
| `CAP_CHOWN` / `CAP_DAC_OVERRIDE` | Cannot override file permission checks |
| `CAP_SETUID` / `CAP_SETGID` | `setuid(0)` calls fail |
| `CAP_SYS_BOOT` | No `reboot()` |
| `CAP_SYS_MODULE` | No `insmod` / kernel module loading |
| `CAP_MKNOD` | Cannot create device files (`/dev/mem`, `/dev/kmem`) |

---

## 5. Layer 3 — Seccomp Syscall Filter

### What is enforced

```yaml
seccompProfile:
  type: RuntimeDefault
```

The `RuntimeDefault` seccomp profile (provided by containerd) blocks approximately **300 dangerous system calls** at the kernel level. Blocked calls include but are not limited to:

| Syscall | Why Blocked |
|---|---|
| `ptrace` | Process injection / memory inspection |
| `kexec_load` | Load a new kernel |
| `create_module`, `init_module`, `finit_module`, `delete_module` | Kernel module manipulation |
| `mount`, `umount2`, `pivot_root` | Filesystem manipulation |
| `reboot` | System reboot |
| `unshare` (with dangerous flags) | Namespace escape |
| `clone` (with `CLONE_NEWUSER`) | User namespace creation (privilege escalation vector) |
| `syslog` | Kernel log access |
| `acct` | Process accounting manipulation |
| `settimeofday`, `adjtimex` | System clock manipulation |

Seccomp filters operate at the kernel level — they cannot be bypassed from userspace regardless of what capabilities or permissions a process has.

---

## 6. Layer 4 — Kubernetes NetworkPolicy

### What is enforced

A `NetworkPolicy` resource in the `bashforge-sessions` namespace applies to all session pods. It is a **default-deny** policy with explicit allow rules.

#### Ingress

Only the App EC2 (the FastAPI backend) can reach port 8765 on session pods. All other inbound connections are dropped, including connections from other session pods.

#### Egress — public internet only

The egress policy deliberately allows `curl`, `wget`, and `git clone` from the internet (this is core to the Bash practice use case), but **blocks all private/cloud-internal address ranges**:

```yaml
egress:
  - ports: [53/UDP, 53/TCP]          # DNS — unrestricted

  - ports: [80/TCP, 443/TCP]
    to:
      - ipBlock:
          cidr: 0.0.0.0/0
          except:
            - 169.254.0.0/16    # AWS/GCP/Azure IMDS (metadata credentials endpoint)
            - 10.0.0.0/8        # RFC 1918: AWS VPC, K8s pod/service CIDRs
            - 172.16.0.0/12     # RFC 1918: Docker bridge, K8s pod CIDR
            - 192.168.0.0/16    # RFC 1918: private ranges
            - 100.64.0.0/10     # RFC 6598: shared address space
            - 127.0.0.0/8       # Loopback
```

### Why the metadata endpoint block is critical

Without the `169.254.0.0/16` exception, a user could run:

```bash
curl http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

This returns the IAM role's temporary AWS access key, secret key, and session token — effectively granting full programmatic access to whatever the EC2 instance role allows. This is blocked at the kernel level by the NetworkPolicy before the packet ever leaves the pod.

### What this stops

- AWS/GCP/Azure cloud metadata credential theft
- Accessing other pods in the cluster (no pod-to-pod egress)
- Reaching the Kubernetes API server (internal IP, blocked by RFC 1918 rule)
- Accessing RDS, ElastiCache, or other VPC-internal services
- Port scanning internal VPC ranges (only ports 80/443 egress allowed, and only to public IPs)

---

## 7. Layer 5 — Resource Limits

### Kubernetes-enforced limits

| Resource | Limit | Enforcement |
|---|---|---|
| CPU | 300m (0.3 cores) | K8s `LimitRange` — throttled at kernel cgroup level |
| Memory (heap) | 150 MiB | K8s `LimitRange` — pod is OOMKilled if exceeded |
| Workspace disk | 200 MiB | `emptyDir.sizeLimit` — writes return `ENOSPC` |
| `/tmp` disk | 20 MiB | `emptyDir.sizeLimit` |
| `/dev/shm` (shared memory) | 64 MiB | `emptyDir { medium: Memory, sizeLimit: 64Mi }` |
| Concurrent pods (cluster total) | 20 | `ResourceQuota` |
| Cluster memory total | 3000 MiB | `ResourceQuota` |

#### The `/dev/shm` detail

`/dev/shm` is a RAM-backed `tmpfs` mount that exists in every Linux container by default. Without an explicit size limit, a user can run:

```bash
dd if=/dev/zero of=/dev/shm/bomb bs=1M count=999
```

This allocates RAM outside the process heap — K8s's container memory limit only counts heap memory, so this bypasses it. The fix mounts `/dev/shm` as a K8s `emptyDir` with `medium: Memory`, which is accounted for by the kubelet and enforced within the pod's memory limit.

```yaml
volumes:
  - name: shm
    emptyDir:
      medium: Memory
      sizeLimit: "64Mi"
volumeMounts:
  - name: shm
    mountPath: /dev/shm
```

### ulimit wrapper (process-level limits)

Every bash process — both the interactive terminal and each script execution — is started via `/usr/local/bin/bashforge-run`, a **root-owned wrapper script** that enforces:

```bash
#!/bin/bash
ulimit -u 100   # max 100 processes (per-user, blocks fork bombs)
ulimit -n 256   # max 256 open file descriptors
ulimit -t 60    # max 60 CPU-seconds per script (hard kill on CPU hog)
exec "$@"
```

This file is owned by root and `chmod 755` — users cannot modify or overwrite it.

#### Why a wrapper instead of K8s pids limit

K8s `resources.limits.pids` requires the `SupportPodPidsLimit` feature gate, which is not always available on Minikube. The `ulimit` wrapper is portable, explicit, and applied before the bash process starts — it cannot be bypassed by the user.

#### Fork bomb protection

Without a process limit, a user can run:

```bash
:(){:|:&};:
```

This creates exponentially more processes until the system exhausts its process table. With `ulimit -u 100`, process creation fails with `bash: fork: Resource temporarily unavailable` after the 100th process — the server remains unaffected.

---

## 8. Layer 6 — Application Hardening (sandbox server)

The `bash-ws-server` Go binary (`sandbox/main.go`) implements several security controls at the application level.

### 8.1 PID 1 signal protection (`kill 1`)

**The problem:** The `bash-ws-server` runs as PID 1 in the container's PID namespace. Go's runtime registers a `SIGTERM` handler by default that calls `os.Exit`. Since the kernel's PID-1 "init protection" only blocks signals with *no registered handler*, the user could run:

```bash
kill 1       # sends SIGTERM → Go's default handler → server exits
```

**The fix:** At startup, before any connections are accepted:

```go
signal.Ignore(syscall.SIGTERM, syscall.SIGHUP)
```

This removes Go's SIGTERM handler entirely. The kernel then applies its native PID-1 protection: any signal without a registered handler sent to PID 1 is silently dropped. As a result:

| Signal | Source | Result |
|---|---|---|
| `SIGTERM` (`kill 1`) | User bash | Silently dropped (kernel PID-1 protection) |
| `SIGHUP` (`kill -HUP 1`) | User bash | Silently dropped |
| `SIGKILL` (`kill -9 1`) | User bash | **Already safe** — Linux kernel unconditionally blocks SIGKILL delivery to PID 1 from user processes in the same namespace |
| `SIGTERM` | Kubernetes pod termination | Delivered (K8s uses the kubelet, which bypasses the PID namespace restriction) → graceful shutdown works correctly |

### 8.2 WS_TOKEN secret management

**The problem:** Kubernetes injects the `WS_TOKEN` as an environment variable. Without cleanup, a user can read it:

```bash
cat /proc/1/environ | tr '\0' '\n' | grep WS_TOKEN
```

**The fix:** The token is read from the environment and immediately cleared before any child process is spawned:

```go
func main() {
    wsToken = os.Getenv("WS_TOKEN")
    if wsToken == "" {
        log.Fatal("WS_TOKEN env variable is required")
    }
    os.Unsetenv("WS_TOKEN")  // cleared: /proc/1/environ no longer contains it
    // ...
}
```

All bash sessions are started *after* this call, so they inherit a clean environment.

### 8.3 Script execution wall-clock timeout

Scripts have a hard **30-second wall-clock timeout** enforced by a Go timer, independent of CPU time:

```
Script starts
    │
    ├──── 30s timer fires ──► SIGTERM → 500ms grace → SIGKILL
    │                         frontend receives: "Script exceeded 30-second limit"
    │
    └──── Script exits naturally ──► timer.Stop() → script_done sent
```

The `ulimit -t 60` CPU-time limit in the wrapper handles pure CPU loops. The Go timer handles infinite `sleep` loops (which use no CPU but run forever):

```bash
while true; do sleep 1; done   # CPU limit won't catch this; wall-clock timer will
```

Both together ensure scripts are always bounded.

### 8.4 File API — symlink traversal prevention

**The problem:** The file read/list/write API checks paths using `filepath.Abs()`, which resolves `.` and `..` but **does not resolve symlinks**. A user could:

```bash
ln -s /etc/passwd ~/workspace/hack
```

Then send `{"type":"file_read","path":"workspace/hack"}` — the lexical path passes the containment check, but `os.ReadFile` follows the symlink and returns `/etc/passwd` contents.

**The fix:** A `resolvedSafeInHome()` helper calls `filepath.EvalSymlinks()` (which fully resolves all symlink components) before any I/O operation and re-checks containment against the *resolved* path:

```go
func resolvedSafeInHome(path string) (string, bool) {
    resolved, err := filepath.EvalSymlinks(path)
    if err != nil {
        return "", false
    }
    return resolved, safeInHome(resolved)
}
```

This is applied to:
- `file_read` — the file being read
- `file_list` — the directory being listed
- `file_write` — existing files before overwrite (new files cannot be symlinks)

### 8.5 Path traversal prevention

For file write operations, paths are processed with `filepath.Base()` (relative) or `filepath.Clean()` (absolute), followed by the `safeInHome()` containment check. Go's `filepath.Join` does **not** treat intermediate absolute paths as root — `filepath.Join("/home/bashuser/workspace", "/etc/passwd")` returns `/home/bashuser/workspace/etc/passwd`, making classic `../../../etc/passwd` traversal attacks ineffective.

### 8.6 WebSocket authentication

Each pod is assigned a cryptographically random `WS_TOKEN` (32 hex bytes = 128 bits of entropy, generated via `secrets.token_hex(32)` in Python). The sandbox server validates this token as the very first WebSocket message (within a 10-second deadline) and rejects all connections that do not present the correct token:

```go
conn.SetReadDeadline(time.Now().Add(10 * time.Second))
// ... read auth message ...
if authMsg.Type != "auth" || authMsg.Token != wsToken {
    conn.WriteMessage(..., `{"type":"error","message":"Authentication failed"}`)
    return
}
conn.SetReadDeadline(time.Time{})
```

This prevents one session from connecting to another session's pod, even if the ClusterIP is somehow learned.

---

## 9. Attack Surface Assessment

The table below lists known attack vectors, the layer(s) that block them, and the outcome.

| Attack | Vector | Blocked By | Outcome |
|---|---|---|---|
| `kill 1` | Terminal → `kill 1` | App: `signal.Ignore` | Dropped silently |
| `kill -9 1` | Terminal → `kill -9 1` | Kernel: PID-1 SIGKILL protection | Dropped silently |
| Fork bomb | `:(){:\|:&};:` in terminal | App: `ulimit -u 100` | Fails after ~100 processes |
| Infinite CPU loop | `while true; do :; done` as script | App: `ulimit -t 60` + Go 30s timer | Killed after 60s CPU or 30s wall-clock |
| Infinite sleep loop | `while true; do sleep 1; done` as script | App: Go 30s wall-clock timer | Killed after 30s |
| Memory bomb (heap) | `python3 -c "x='A'*999999999"` | K8s: 150MiB limit → OOMKill | Pod restarted by K8s... actually `restartPolicy: Never`, so pod is terminated → session ends |
| Memory bomb (`/dev/shm`) | `dd if=/dev/zero of=/dev/shm/bomb` | K8s: `/dev/shm` limited to 64MiB | Fails with `ENOSPC` after 64MiB |
| Disk bomb | `dd if=/dev/zero of=bigfile` | K8s: `emptyDir.sizeLimit: 200Mi` | Fails with `ENOSPC` after 200MiB |
| AWS metadata theft | `curl http://169.254.169.254/...` | K8s: NetworkPolicy `169.254.0.0/16` except | Connection refused at kernel level |
| VPC internal access | `curl http://10.0.1.20/...` | K8s: NetworkPolicy `10.0.0.0/8` except | Connection refused |
| K8s API server | `curl https://10.96.0.1:443/...` | K8s: NetworkPolicy + `automountServiceAccountToken: false` | Connection refused; no token anyway |
| Cross-pod access | `curl http://<other-pod-ip>:8765` | K8s: NetworkPolicy (no pod-to-pod egress) | Connection refused |
| Read `/etc/passwd` via editor | `ln -s /etc/passwd workspace/hack` → `file_read` | App: `resolvedSafeInHome()` | Returns "Access denied" |
| List `/etc` via editor | `ln -s /etc workspace/etc_link` → `file_list` | App: `resolvedSafeInHome()` | Returns "Access denied" |
| Steal `WS_TOKEN` | `cat /proc/1/environ` | App: `os.Unsetenv("WS_TOKEN")` at startup | Variable not present in `/proc/1/environ` |
| Raw socket / port scan | `nmap -sS target` | Cap: `CAP_NET_RAW` dropped + Seccomp | Raw socket creation fails |
| Mount filesystem | `mount /dev/sda /mnt` | Cap: `CAP_SYS_ADMIN` dropped + Seccomp `mount` blocked | Permission denied |
| Load kernel module | `insmod evil.ko` | Cap: `CAP_SYS_MODULE` dropped + Seccomp `init_module` blocked | Permission denied |
| Namespace escape | `unshare --user --map-root-user` | Seccomp: `clone(CLONE_NEWUSER)` blocked | Syscall blocked |
| `sudo su` | `sudo bash` | Layer 1: `/usr/bin/sudo` deleted | `bash: sudo: command not found` |
| `ptrace` another process | `strace -p 1` | Cap: `CAP_SYS_PTRACE` dropped + Seccomp `ptrace` blocked | Permission denied |
| Reboot / sysrq | `echo b > /proc/sysrq-trigger` | Seccomp: `reboot` blocked | Permission denied |
| Inode exhaustion | Creating millions of tiny files | Partially mitigated by workspace `sizeLimit` | Some risk remains (see §12) |
| IPv6 metadata (`fd00:ec2::254`) | `curl http://[fd00:ec2::254]/...` | K8s: NetworkPolicy (IPv4 only currently) | Partially mitigated — see §12 |

---

## 10. What Users CAN and CANNOT Do

### Can do (intentional)

| Action | Why Allowed |
|---|---|
| Write, read, execute files in `~/workspace/` | Core practice functionality |
| Run any bash script | Core practice functionality |
| Use `curl`, `wget`, `git clone` from the internet | Essential for practice scripts |
| Use `ping` (ICMP via socket, not raw) | Network practice |
| Use `dig`, `nslookup`, `host` | DNS practice |
| Use all GNU tools (`awk`, `sed`, `grep`, `find`, etc.) | Core bash practice |
| Create directories, pipes, FIFOs in `~/workspace/` | Core bash practice |
| Run `python3` scripts | Extended practice |
| Use `nc`, `curl` to test HTTP endpoints | Networking practice |
| Use `git`, `ssh-keygen`, `openssl` | DevOps practice |

### Cannot do (enforced)

| Action | Blocked By |
|---|---|
| Write outside `~/home/bashuser/` | UID 1000 file permissions |
| `sudo`, `su`, escalate to root | sudo deleted, no SUID viable without capabilities |
| Kill the sandbox server process (`kill 1`) | Signal trap + kernel PID-1 protection |
| Fork bomb | ulimit -u 100 |
| Run scripts longer than 30 seconds (wall-clock) | Go timer → SIGKILL |
| Consume > 150MiB RAM | K8s OOMKill |
| Write > 200MiB to workspace | K8s `emptyDir.sizeLimit` |
| Consume > 64MiB of `/dev/shm` | K8s Memory-backed emptyDir |
| Access `169.254.169.254` (cloud metadata) | NetworkPolicy |
| Access any RFC 1918 private IP | NetworkPolicy |
| Access other users' pods | NetworkPolicy + unique WS_TOKEN |
| Use raw sockets, `nmap` SYN scan | `CAP_NET_RAW` dropped + Seccomp |
| Mount filesystems | `CAP_SYS_ADMIN` dropped + Seccomp |
| Load kernel modules | `CAP_SYS_MODULE` dropped + Seccomp |
| Create user namespaces | Seccomp `clone(CLONE_NEWUSER)` blocked |
| Read files outside `~/` via the file editor API | `resolvedSafeInHome()` symlink resolution |
| Read `WS_TOKEN` from `/proc/1/environ` | `os.Unsetenv("WS_TOKEN")` at startup |

---

## 11. Security Testing Checklist

Use this checklist to verify each control is working in a deployed pod. Connect a terminal session and run each command.

### Signal protection

```bash
# Should have no effect — server continues running
kill 1
kill -HUP 1
kill -15 1

# Should also have no effect (kernel blocks SIGKILL to PID 1)
kill -9 1
```

Expected: terminal continues working after all of the above.

### Fork bomb protection

```bash
:(){:|:&};:
```

Expected: terminal prints `bash: fork: Resource temporarily unavailable` repeatedly, then stabilises. The sandbox server and other sessions remain unaffected.

### AWS metadata endpoint

```bash
curl -v --connect-timeout 3 http://169.254.169.254/latest/meta-data/
```

Expected: connection times out or is refused. No IAM credentials returned.

### RFC 1918 internal access

```bash
# Replace with your actual VPC CIDR / K8s service CIDR
curl -v --connect-timeout 3 http://10.0.1.20/
curl -v --connect-timeout 3 http://10.96.0.1/
```

Expected: connection refused or timed out.

### Disk quota

```bash
dd if=/dev/zero of=bigfile bs=1M count=300
```

Expected: fails with `No space left on device` before reaching 200MiB.

### `/dev/shm` quota

```bash
dd if=/dev/zero of=/dev/shm/bomb bs=1M count=100
```

Expected: fails with `No space left on device` before reaching 64MiB.

### WS_TOKEN not in environment

```bash
cat /proc/1/environ | tr '\0' '\n' | grep -i token
printenv | grep -i token
```

Expected: empty output — `WS_TOKEN` is cleared at startup.

### File API symlink traversal

```bash
# Create a symlink pointing outside homeDir
ln -s /etc/passwd ~/workspace/secret_test

# Then use the file editor's "Open" button to open 'secret_test'
# OR send via WebSocket: {"type":"file_read","path":"workspace/secret_test"}
```

Expected: "Access denied" error. The file contents of `/etc/passwd` are never returned.

### Process limit

```bash
# Spawn many background processes
for i in $(seq 1 200); do sleep 60 & done
jobs | wc -l
```

Expected: stops spawning processes and prints `bash: fork: Resource temporarily unavailable` around process 100.

### Raw socket (nmap)

```bash
# If nmap is somehow available
nmap -sS 8.8.8.8
```

Expected: fails with permission denied (no `CAP_NET_RAW`).

### Namespace creation

```bash
unshare --user --map-root-user bash
```

Expected: fails (`Operation not permitted` — blocked by seccomp).

---

## 12. Residual Risks and Known Limitations

The following risks are known and accepted or partially mitigated.

| Risk | Severity | Status | Notes |
|---|---|---|---|
| **IPv6 metadata endpoint** (`fd00:ec2::254`) | Medium | Partially mitigated | The NetworkPolicy `except` blocks are IPv4-only. If the cluster supports IPv6, add `fc00::/7` and `fe80::/10` to the egress `except` list. |
| **Inode exhaustion** | Low | Accepted | Creating millions of zero-byte files exhausts inodes without hitting the size limit. `emptyDir.sizeLimit` tracks disk bytes, not inode count. Mitigating this requires custom kernel quota configuration on the K8s node. |
| **OOMKill ends the whole session** | Low | Accepted | If a process consumes all 150MiB, the container OOMKills and the session is lost (pod has `restartPolicy: Never`). This is intentional — the session TTL system handles re-creation. |
| **WS_TOKEN visible in `kubectl describe pod`** | Low | Accepted | The token is stored as a plaintext env var in the pod spec (and thus in etcd). It is cleared from `/proc/1/environ` at runtime. To fully eliminate this: create a K8s Secret per pod and mount it as a file; read from `/run/secrets/ws_token` in Go. |
| **Session pod runs `bash-ws-server` as PID 1** | Low | Mitigated | Signal trap + kernel PID-1 protection covers `kill 1`. The remaining risk is any future signal type not covered by `signal.Ignore`. Using `tini` as PID 1 would eliminate this class entirely. |
| **DNS query exfiltration** | Very Low | Accepted | DNS egress is unrestricted. A user could encode data in DNS queries. This is an accepted trade-off for allowing normal DNS resolution in practice scripts. |
| **CPU timing side-channels** | Very Low | Accepted | Shared CPU on the K8s node could theoretically allow Spectre-class cross-session timing attacks. Mitigating this requires CPU pinning or dedicated nodes. |

---

## 13. Security Contacts and Disclosure

This is an open-source project. To report a security vulnerability:

1. **Do not open a public GitHub issue.**
2. Email the maintainers directly (see `package.json` or commit history for contact details).
3. Alternatively, open a [GitHub Security Advisory](https://github.com/pth55/bashforge/security/advisories/new) (private disclosure).

We aim to acknowledge reports within 48 hours and release a fix within 7 days for critical issues.

---

*Last updated: April 2026 — reflects security hardening session including signal protection, WS_TOKEN scrubbing, symlink traversal fixes, NetworkPolicy metadata blocking, and `/dev/shm` size limiting.*
