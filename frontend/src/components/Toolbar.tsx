import type { ScriptRunState, WsStatus } from '../types'

interface ToolbarProps {
  // File
  onNew:        () => void
  onOpen:       () => void
  onSave:       () => void
  onSaveAs:     () => void
  // Run
  onRun:        () => void
  onStop:       () => void
  runState:     ScriptRunState
  // Edit
  onComment:    () => void
  onSnippets:   () => void
  onFind:       () => void
  // Clear
  onClearOutput:   () => void
  onClearTerminal: () => void
  onClearEditor:   () => void
  // Session
  onEndSession: () => void
  wsStatus:     WsStatus
}

function elapsed(ms: number) {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`
}

export function Toolbar({
  onNew, onOpen, onSave, onSaveAs,
  onRun, onStop, runState,
  onComment, onSnippets, onFind,
  onClearOutput, onClearTerminal, onClearEditor,
  onEndSession,
  wsStatus,
}: ToolbarProps) {
  return (
    <div className="toolbar" role="toolbar" aria-label="IDE toolbar">

      {/* Left group — File */}
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
        <button className="tb-btn" onClick={onSaveAs} title="Save As">
          <span className="tb-btn-icon">📄</span>
          <span className="tb-btn-label">Save As</span>
        </button>
      </div>

      <div className="toolbar-sep" />

      {/* Run group */}
      <div className="toolbar-group">
        {runState.running ? (
          <>
            <button className="tb-btn yellow" disabled>
              <span className="running-dot" />
              <span className="tb-btn-label">
                Running... {runState.startTime ? elapsed(Date.now() - runState.startTime) : ''}
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
              className="tb-btn green"
              onClick={onRun}
              title="Run script (Ctrl+Enter)"
              disabled={wsStatus !== 'connected'}
            >
              <span className="tb-btn-icon">▶</span>
              <span className="tb-btn-label">Run</span>
              <span className="tb-btn-hint">Ctrl+Enter</span>
            </button>
            <button className="tb-btn" onClick={onStop} title="Stop script" disabled>
              <span className="tb-btn-icon">■</span>
              <span className="tb-btn-label">Stop</span>
            </button>
          </>
        )}
      </div>

      <div className="toolbar-sep" />

      {/* Edit group */}
      <div className="toolbar-group">
        <button className="tb-btn comment-color" onClick={onComment} title="Toggle comment (Ctrl+/)">
          <span className="tb-btn-icon">#</span>
          <span className="tb-btn-label">Comment</span>
          <span className="tb-btn-hint">Ctrl+/</span>
        </button>
        <button className="tb-btn purple" onClick={onSnippets} title="DevOps snippets">
          <span className="tb-btn-icon">⟨⟩</span>
          <span className="tb-btn-label">Snippets</span>
        </button>
        <button className="tb-btn yellow" onClick={onFind} title="Find & Replace (Ctrl+H)">
          <span className="tb-btn-icon">⌕</span>
          <span className="tb-btn-label">Find</span>
          <span className="tb-btn-hint">Ctrl+F</span>
        </button>
      </div>

      {/* Right group */}
      <div className="toolbar-group right">
        <button className="tb-btn" onClick={onClearOutput} title="Clear script output">
          <span className="tb-btn-icon">⊗</span>
          <span className="tb-btn-label">Clear Output</span>
        </button>
        <button className="tb-btn" onClick={onClearTerminal} title="Clear terminal">
          <span className="tb-btn-icon">⊗</span>
          <span className="tb-btn-label">Clear Terminal</span>
        </button>
        <button className="tb-btn" onClick={onClearEditor} title="Clear editor content">
          <span className="tb-btn-icon">✕</span>
          <span className="tb-btn-label">Clear Editor</span>
        </button>

        <div className="toolbar-sep" />

        <button className="tb-btn red" onClick={onEndSession} title="End session and return to landing">
          <span className="tb-btn-icon">⏻</span>
          <span className="tb-btn-label">End Session</span>
        </button>
      </div>
    </div>
  )
}
