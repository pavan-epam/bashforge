import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../hooks/useSession'


// ── Waiting Room State ───────────────────────────────────────────
function WaitingState({ active, total, waitSeconds, onRetry, isRetrying }: {
  active: number; total: number; waitSeconds: number
  onRetry: () => void; isRetrying: boolean
}) {
  const [countdown, setCountdown] = useState(waitSeconds)
  useEffect(() => {
    if (countdown <= 0) { onRetry(); return }
    const t = setInterval(() => setCountdown(c => c - 1), 1000)
    return () => clearInterval(t)
  }, [countdown <= 0])

  const pct = Math.round((active / total) * 100)
  const mins = Math.ceil(countdown / 60)

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(6,10,15,0.95)', backdropFilter: 'blur(12px)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 24,
    }}>
      <div style={{ fontSize: 48 }}>⏳</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#e6edf3' }}>All slots are full</div>
      <div style={{ color: '#8b949e', fontSize: 14, textAlign: 'center', maxWidth: 400, lineHeight: 1.7 }}>
        {active} of {total} sessions are active. A slot will open in approximately{' '}
        <strong style={{ color: '#58a6ff' }}>{mins} minute{mins !== 1 ? 's' : ''}</strong>.
        <br />Auto-retrying in <strong style={{ color: '#3fb950' }}>{countdown}s</strong>…
      </div>
      {/* Progress bar */}
      <div style={{ width: 320, background: 'rgba(48,54,61,0.5)', borderRadius: 8, height: 8, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: 'linear-gradient(90deg, #f85149, #d29922)',
          borderRadius: 8, transition: 'width 0.3s',
        }} />
      </div>
      <div style={{ fontSize: 12, color: '#484f58' }}>{active}/{total} slots used</div>
      <button
        onClick={onRetry} disabled={isRetrying}
        style={{
          background: 'rgba(88,166,255,0.1)', border: '1px solid rgba(88,166,255,0.3)',
          borderRadius: 8, color: '#58a6ff', fontSize: 13, padding: '10px 24px',
          cursor: 'pointer',
        }}
      >
        {isRetrying ? 'Checking…' : 'Check Now'}
      </button>
    </div>
  )
}

export default function LandingPage() {
  const navigate = useNavigate()
  const { session, isChecking, isCreating, error, waitInfo, createSession } = useSession()
  const [termLine, setTermLine] = useState(0)

  useEffect(() => {
    if (!isChecking && session?.status === 'ready') navigate('/ide', { replace: true })
  }, [isChecking, session, navigate])

  // Animate terminal lines
  const LINES = [
    { text: '$ curl -sL api.example.com/deploy | bash', color: '#3fb950' },
    { text: '  Pulling image... done', color: '#8b949e' },
    { text: '  Container started on :8080', color: '#58a6ff' },
    { text: '$ grep -r "error" /var/log/*.log | wc -l', color: '#3fb950' },
    { text: '  42', color: '#e6edf3' },
  ]
  useEffect(() => {
    if (termLine >= LINES.length) return
    const t = setTimeout(() => setTermLine(l => l + 1), 600 + termLine * 200)
    return () => clearTimeout(t)
  }, [termLine, LINES.length])

  const handlePractice = useCallback(async () => { await createSession() }, [createSession])

  return (
    <div style={{
      minHeight: '100vh', background: '#060a0f', color: '#e6edf3',
      fontFamily: "'Space Grotesk', sans-serif", overflowX: 'hidden',
    }}>
      {/* Ambient glows */}
      <div style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
        background: `
          radial-gradient(ellipse 80% 50% at 20% -10%, rgba(88,166,255,0.08) 0%, transparent 60%),
          radial-gradient(ellipse 60% 40% at 80% 110%, rgba(188,140,255,0.07) 0%, transparent 60%)
        `,
      }} />

      {/* Nav */}
      <nav style={{
        position: 'sticky', top: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', padding: '0 40px', height: 60,
        background: 'rgba(6,10,15,0.85)', backdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(48,54,61,0.6)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 30, height: 30,
            background: 'linear-gradient(135deg, #58a6ff 0%, #bc8cff 100%)',
            borderRadius: 8, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 16, fontWeight: 700,
          }}>⚡</div>
          <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.02em' }}>BashForge</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={handlePractice}
            disabled={isCreating || isChecking}
            style={{
              background: 'rgba(88,166,255,0.1)', border: '1px solid rgba(88,166,255,0.3)',
              borderRadius: 8, color: '#58a6ff', fontSize: 13, fontWeight: 500,
              padding: '8px 20px', cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {isCreating || isChecking ? 'Starting…' : 'Open Terminal →'}
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section style={{
        position: 'relative', zIndex: 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '100px 24px 80px', textAlign: 'center',
      }}>
        {/* Badge */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          background: 'rgba(88,166,255,0.08)', border: '1px solid rgba(88,166,255,0.2)',
          borderRadius: 20, padding: '5px 16px', fontSize: 11,
          color: '#58a6ff', letterSpacing: '0.1em', textTransform: 'uppercase',
          marginBottom: 32, fontWeight: 600,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3fb950', boxShadow: '0 0 6px #3fb950', flexShrink: 0 }} />
          Live Linux Environment
        </div>

        {/* Headline */}
        <h1 style={{
          fontSize: 'clamp(44px, 6vw, 80px)', fontWeight: 700,
          lineHeight: 1.05, letterSpacing: '-0.04em',
          marginBottom: 24, maxWidth: 800,
        }}>
          <span style={{ color: '#e6edf3' }}>A real shell.</span>
          <br />
          <span style={{
            background: 'linear-gradient(135deg, #58a6ff 0%, #bc8cff 100%)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>In your browser.</span>
        </h1>

        <p style={{
          fontSize: 18, color: '#8b949e', maxWidth: 480,
          lineHeight: 1.7, marginBottom: 48,
        }}>
          Spin up an isolated Linux container and practice bash in a full IDE —
          editor, terminal, and script runner, all in one tab.
        </p>

        {error && (
          <div style={{
            marginBottom: 24, padding: '10px 20px',
            background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.3)',
            borderRadius: 8, color: '#f85149', fontSize: 13,
          }}>
            {error} — please try again.
          </div>
        )}

        {/* CTA */}
        <button
          onClick={handlePractice}
          disabled={isCreating || isChecking}
          style={{
            background: 'linear-gradient(135deg, #58a6ff 0%, #79c0ff 100%)',
            border: 'none', borderRadius: 12, color: '#060a0f',
            fontSize: 16, fontWeight: 700, padding: '16px 40px',
            cursor: isCreating || isChecking ? 'wait' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 10,
            boxShadow: '0 0 40px rgba(88,166,255,0.25)',
            transition: 'opacity 0.15s, transform 0.15s',
            opacity: isCreating || isChecking ? 0.8 : 1,
            marginBottom: 16,
          }}
        >
          {isCreating || isChecking ? (
            <>
              <div style={{
                width: 16, height: 16, borderRadius: '50%',
                border: '2px solid rgba(0,0,0,0.3)', borderTopColor: '#000',
                animation: 'spin 0.6s linear infinite',
              }} />
              Starting your environment…
            </>
          ) : <>▶ &nbsp; Start Practicing</>}
        </button>
        <span style={{ fontSize: 12, color: '#484f58' }}>Free · No signup · 1-hour sessions</span>

        {/* Terminal preview */}
        <div style={{
          marginTop: 64, width: '100%', maxWidth: 640,
          background: 'rgba(1,4,9,0.9)',
          border: '1px solid rgba(48,54,61,0.8)',
          borderRadius: 14, overflow: 'hidden',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
        }}>
          {/* Window bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '12px 16px', borderBottom: '1px solid rgba(48,54,61,0.5)',
            background: 'rgba(22,27,34,0.6)',
          }}>
            {['#f85149','#d29922','#3fb950'].map((c, i) => (
              <div key={i} style={{ width: 12, height: 12, borderRadius: '50%', background: c }} />
            ))}
            <span style={{ marginLeft: 10, color: '#484f58', fontSize: 12, fontFamily: 'JetBrains Mono' }}>
              bashuser@bashforge:~/workspace
            </span>
          </div>
          
          {/* Terminal lines */}
          <div style={{
  padding: '16px 20px',
  fontFamily: 'JetBrains Mono',
  fontSize: 13,
  minHeight: 140,
  textAlign: 'left',
  width: '100%'
}}>
            {LINES.slice(0, termLine).map((line, i) => (
              <div key={i} style={{ color: line.color, marginBottom: 4, lineHeight: 1.6 }}>
                {line.text}
              </div>
            ))}
            {termLine < LINES.length && (
              <span style={{ color: '#3fb950' }}>$ </span>
            )}
            <span style={{
              display: 'inline-block', width: 8, height: 14,
              background: '#58a6ff', marginLeft: 1, verticalAlign: 'middle',
              animation: 'blink 1s step-end infinite',
            }} />
          </div>
        </div>
      </section>

      {/* Feature grid */}
      <section style={{
        position: 'relative', zIndex: 1,
        maxWidth: 960, margin: '0 auto', padding: '40px 24px 100px',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
        }}>
          {FEATURES.map(f => (
            <div key={f.title} style={{
              background: 'rgba(13,17,23,0.8)',
              border: '1px solid rgba(48,54,61,0.6)',
              borderRadius: 12, padding: '24px 20px',
              transition: 'border-color 0.15s',
            }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(88,166,255,0.4)')}
              onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(48,54,61,0.6)')}
            >
              <div style={{ fontSize: 26, marginBottom: 12 }}>{f.icon}</div>
              <div style={{ fontWeight: 600, marginBottom: 8, color: '#e6edf3' }}>{f.title}</div>
              <div style={{ fontSize: 13, color: '#8b949e', lineHeight: 1.6 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Waiting State Overlay */}
      {waitInfo && (
        <WaitingState
          active={waitInfo.active}
          total={waitInfo.totalSlots}
          waitSeconds={waitInfo.waitSeconds}
          onRetry={handlePractice}
          isRetrying={isCreating}
        />
      )}

      <footer style={{
        textAlign: 'center', padding: '24px', position: 'relative', zIndex: 1,
        borderTop: '1px solid rgba(48,54,61,0.4)', color: '#484f58', fontSize: 12,
      }}>
        BashForge · Isolated container per session · 150 MB RAM · 200 MB disk · 1-hour TTL
      </footer>

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
      `}</style>
    </div>
  )
}

const FEATURES = [
  { icon: '🖥️', title: 'Full Linux Environment', desc: 'Real bash shell with curl, git, sed, awk, grep and all standard GNU tools.' },
  { icon: '⚡', title: 'Monaco Editor', desc: 'VS Code-grade editor with bash syntax highlighting, snippets, and shortcuts.' },
  { icon: '🔒', title: 'Isolated Container', desc: 'Your own sandboxed Linux container. Resource-limited and network-controlled.' },
  { icon: '↕️', title: 'Split-Pane Layout', desc: 'Editor, script output, and interactive terminal — all visible at once.' },
  { icon: '⏱️', title: '1-Hour Sessions', desc: 'Close the tab and come back. Your session stays alive for a full hour.' },
  { icon: '🌐', title: 'Internet Access', desc: 'curl, wget, git clone all work. Practice against real endpoints.' },
]
