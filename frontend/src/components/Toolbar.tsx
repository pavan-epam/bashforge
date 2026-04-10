import type { ScriptRunState, WsStatus } from '../types'

interface ToolbarProps {
  onNew:        () => void
  onOpen:       () => void
  onSave:       () => void
  onSaveAs:     () => void
  onRun:        () => void
  onStop:       () => void
  runState:     ScriptRunState
  onComment:    () => void
  onSnippets:   () => void
  onFind:       () => void
  onEndSession: () => void
  wsStatus:     WsStatus
  activeSessions: number
}

function elapsed(ms: number) {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function Toolbar({
  onNew, onOpen, onSave, onSaveAs,
  onRun, onStop, runState,
  onComment, onSnippets, onFind,
  onEndSession, wsStatus, activeSessions,
}: ToolbarProps) {
  return (
    <div className="toolbar" role="toolbar" aria-label="IDE toolbar">

      {/* File */}
      <div className="toolbar-group">
        <button className="tb-btn" onClick={onNew} title="New file (Ctrl+N)">
          <span className="tb-btn-icon">⊕</span>
          <span className="tb-btn-label">New</span>
        </button>
        <button className="tb-btn" onClick={onOpen} title="Open file (Ctrl+O)">
          <span className="tb-btn-icon">⊙</span>
          <span className="tb-btn-label">Open</span>
        </button>
        <button className="tb-btn" onClick={onSave} title="Save (Ctrl+S)">
          <span className="tb-btn-icon">💾</span>
          <span className="tb-btn-label">Save</span>
        </button>
        <button className="tb-btn" onClick={onSaveAs} title="Save As (Ctrl+Shift+S)">
          <span className="tb-btn-icon">📄</span>
          <span className="tb-btn-label">Save As</span>
        </button>
      </div>

      <div className="toolbar-sep" />

      {/* Run */}
      <div className="toolbar-group">
        {runState.running ? (
          <>
            <button className="tb-btn yellow" disabled>
              <span className="running-dot" />
              <span className="tb-btn-label">
                Running{runState.startTime ? ` ${elapsed(Date.now() - runState.startTime)}` : '…'}
              </span>
            </button>
            <button className="tb-btn red" onClick={onStop} title="Stop script">
              <span className="tb-btn-icon">■</span>
              <span className="tb-btn-label">Stop</span>
            </button>
          </>
        ) : (
          <>
            <button
              className="tb-btn green" onClick={onRun}
              title="Run script (Ctrl+Enter)"
              disabled={wsStatus !== 'connected'}
            >
              <span className="tb-btn-icon">▶</span>
              <span className="tb-btn-label">Run</span>
              <span className="tb-btn-hint">Ctrl+Enter</span>
            </button>
            <button className="tb-btn" onClick={onStop} disabled>
              <span className="tb-btn-icon">■</span>
              <span className="tb-btn-label">Stop</span>
            </button>
          </>
        )}
      </div>

      <div className="toolbar-sep" />

      {/* Edit */}
      <div className="toolbar-group">
        <button className="tb-btn comment-color" onClick={onComment} title="Toggle comment (Ctrl+/)">
          <span className="tb-btn-icon">#</span>
          <span className="tb-btn-label">Comment</span>
        </button>
        <button className="tb-btn purple" onClick={onSnippets} title="Snippets">
          <span className="tb-btn-icon">⟨⟩</span>
          <span className="tb-btn-label">Snippets</span>
        </button>
        <button className="tb-btn yellow" onClick={onFind} title="Find & Replace (Ctrl+F)">
          <span className="tb-btn-icon">⌕</span>
          <span className="tb-btn-label">Find</span>
        </button>
      </div>

      {/* Right: online count + end session */}
      <div className="toolbar-group right">
        {/* Live online users badge */}
        <div className="tb-online-badge" title={`${activeSessions} active session${activeSessions !== 1 ? 's' : ''} right now`}>
          <span className="tb-online-dot" />
          <span className="tb-online-count">{activeSessions}</span>
          <span className="tb-online-label">online</span>
        </div>

        <div className="toolbar-sep" />

        <button className="tb-btn red" onClick={onEndSession} title="End session">
          <span className="tb-btn-icon">⏻</span>
          <span className="tb-btn-label">End Session</span>
        </button>
      </div>
    </div>
  )
}
