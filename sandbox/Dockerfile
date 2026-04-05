# ── Stage 1: Build Go binary ──────────────────────────────────────
FROM golang:1.22-alpine AS builder
WORKDIR /build
COPY go.mod ./
COPY main.go ./
RUN go mod download && go mod tidy && \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o bash-ws-server .

# ── Stage 2: Runtime ──────────────────────────────────────────────
FROM ubuntu:22.04

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash coreutils grep sed gawk findutils procps \
    net-tools iproute2 iputils-ping dnsutils \
    curl wget git vim-tiny nano jq bc \
    tar gzip bzip2 xz-utils unzip less \
    man-db tree file diffutils patch \
    python3 python3-pip netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 bashuser \
    && useradd -u 1000 -g 1000 -m -s /bin/bash -d /home/bashuser bashuser \
    && passwd -l bashuser \
    && rm -f /usr/bin/sudo /usr/sbin/useradd /usr/sbin/adduser \
    && mkdir -p /home/bashuser/workspace \
    && chown bashuser:bashuser /home/bashuser/workspace \
    && chmod 700 /home/bashuser

COPY --from=builder /build/bash-ws-server /usr/local/bin/bash-ws-server
RUN chmod +x /usr/local/bin/bash-ws-server
COPY --chown=bashuser:bashuser bashrc /home/bashuser/.bashrc

USER bashuser
WORKDIR /home/bashuser/workspace
EXPOSE 8765

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8765/health || exit 1

CMD ["/usr/local/bin/bash-ws-server"]
