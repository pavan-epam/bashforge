import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";

export default function LandingPage() {
  const navigate = useNavigate();
  const { session, isChecking, isCreating, error, createSession } =
    useSession();

  // If session already exists (e.g. resumed from sessionStorage), go straight to IDE
  useEffect(() => {
    if (!isChecking && session?.status === "ready")
      navigate("/ide", { replace: true });
  }, [isChecking, session, navigate]);

  const handlePractice = useCallback(async () => {
    await createSession();
  }, [createSession]);

  return (
    <div className="landing-root">
      {/* ── Nav ── */}
      <nav className="landing-nav">
        <div className="landing-logo">
          <div className="landing-logo-icon">⚡</div>
          <span className="landing-logo-text">
            Bash<span>Forge</span>
          </span>
        </div>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 16,
            alignItems: "center",
          }}
        >
          <span style={{ color: "var(--fg-comment)", fontSize: 12 }}>
            Real Linux · Real Terminal · In Your Browser
          </span>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="landing-hero">
        <div className="landing-glow" />

        {/* Terminal animation */}
        <TerminalPreview />

        <div className="landing-badge">⚡ DevOps Practice Environment</div>

        <h1 className="landing-title">
          Master <span className="accent">Bash</span> &amp;{" "}
          <span className="purple">DevOps</span>
          <br />
          in a Real Linux Shell
        </h1>

        <p className="landing-subtitle">
          A full-featured browser IDE with syntax highlighting, snippets,
          interactive terminal, and an isolated Kubernetes pod — just for you.
          No setup. No config. Click and start.
        </p>

        {error && (
          <div
            style={{
              marginBottom: 24,
              padding: "10px 20px",
              background: "rgba(248,81,73,0.1)",
              border: "1px solid rgba(248,81,73,0.4)",
              borderRadius: 8,
              color: "var(--fg-red)",
              fontSize: 13,
            }}
          >
            {error} — please try again.
          </div>
        )}

        <div className="landing-cta-row">
          <button
            className={`landing-btn-primary${isCreating || isChecking ? " loading" : ""}`}
            onClick={handlePractice}
            disabled={isCreating || isChecking}
          >
            {isCreating ? (
              <>
                <div className="spinner" />
                Creating your environment…
              </>
            ) : (
              <>▶ &nbsp; Practice Now</>
            )}
          </button>
          <button
            className="landing-btn-secondary"
            onClick={() => window.open("https://github.com", "_blank")}
          >
            View on GitHub
          </button>
        </div>

        {/* Feature cards */}
        <div className="landing-features">
          {FEATURES.map((f) => (
            <div className="feature-card" key={f.title}>
              <div className="feature-icon">{f.icon}</div>
              <div className="feature-title">{f.title}</div>
              <div className="feature-desc">{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="landing-footer">
        BashForge · Isolated Kubernetes pod per session · Max 1 hour · 150 MB
        RAM · 200 MB disk
      </footer>
    </div>
  );
}

// ── Animated terminal preview ─────────────────────────────────────
const LINES = [
  { text: "$ ./deploy.sh --env prod", delay: 0, color: "#3fb950" },
  { text: "Connecting to cluster...", delay: 800, color: "#79c0ff" },
  { text: "Applying manifests...   ", delay: 1600, color: "#e6edf3" },
  { text: "✓ Deployment complete   ", delay: 2400, color: "#3fb950" },
  { text: "Pods: 3/3 Running       ", delay: 3000, color: "#58a6ff" },
];

function TerminalPreview() {
  return (
    <div
      style={{
        background: "#010409",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "16px 20px",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        width: 440,
        marginBottom: 40,
        boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
        position: "relative",
        zIndex: 1,
      }}
    >
      {/* Window chrome */}
      <div style={{ display: "flex", gap: 7, marginBottom: 14 }}>
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "#f85149",
          }}
        />
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "#d29922",
          }}
        />
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: "#3fb950",
          }}
        />
        <span
          style={{ marginLeft: 12, color: "var(--fg-comment)", fontSize: 11 }}
        >
          bash — workspace
        </span>
      </div>
      {LINES.map((line, i) => (
        <div
          key={i}
          style={{
            color: line.color,
            marginBottom: 4,
            opacity: 0,
            animation: `fadeIn 0.3s ease ${line.delay}ms forwards`,
            whiteSpace: "pre",
          }}
        >
          {line.text}
        </div>
      ))}
      <style>{`
        @keyframes fadeIn { from { opacity:0; transform:translateX(-4px); } to { opacity:1; transform:translateX(0); } }
      `}</style>
    </div>
  );
}

const FEATURES = [
  {
    icon: "🔒",
    title: "Isolated Pod",
    desc: "Your own Kubernetes pod with strict resource limits. No shared resources, no data leaks.",
  },
  {
    icon: "⚡",
    title: "Full-Featured IDE",
    desc: "Monaco editor with bash syntax highlighting, DevOps snippets, find/replace, and shortcuts.",
  },
  {
    icon: "🖥️",
    title: "Real Terminal",
    desc: "A real PTY bash shell — history, tab complete, colors, interactive programs all work.",
  },
  {
    icon: "🌐",
    title: "Internet Access",
    desc: "curl, wget, git clone, ping — all work. Practice real-world DevOps workflows.",
  },
  {
    icon: "⏱️",
    title: "1-Hour Sessions",
    desc: "Create a session and get a full hour. Close the tab and come back — your session is waiting.",
  },
  {
    icon: "📦",
    title: "20+ Snippets",
    desc: "Curated bash snippets for DevOps — if/else, loops, docker run, kubectl, trap, and more.",
  },
];
