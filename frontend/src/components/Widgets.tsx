import { useState, useEffect } from 'react'
import { SNIPPETS } from '../constants/snippets'
import type { CursorPosition, RemoteFile, Toast, WsStatus } from '../types'

// ── Args Bar ─────────────────────────────────────────────────────
interface ArgsBarProps {
  value:    string
  onChange: (v: string) => void
}
export function ArgsBar({ value, onChange }: ArgsBarProps) {
  return (
    <div className="args-bar">
      <span className="args-label">$1 $2 … args:</span>
      <input
        className="args-input"
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="space-separated positional arguments"
        spellCheck={false}
        autoComplete="off"
      />
      <span className="args-hint">positional args for the script</span>
    </div>
  )
}

// ── Status Bar ────────────────────────────────────────────────────
interface StatusBarProps {
  fileName:    string
  modified:    boolean
  cursor:      CursorPosition
  cwd:         string
  ttlSeconds:  number
  wsStatus:    WsStatus
}
function fmtTTL(s: number): string {
  if (s <= 0) return 'Expired'
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2,'0')} left`
}
export function StatusBar({ fileName, modified, cursor, cwd, ttlSeconds, wsStatus }: StatusBarProps) {
  const [remaining, setRemaining] = useState(ttlSeconds)
  useEffect(() => { setRemaining(ttlSeconds) }, [ttlSeconds])
  useEffect(() => {
    if (remaining <= 0) return
    const t = setInterval(() => setRemaining(r => Math.max(0, r - 1)), 1000)
    return () => clearInterval(t)
  }, [ttlSeconds]) // reset when prop changes

  const cls = remaining < 300 ? 'critical' : remaining < 600 ? 'warning' : ''

  return (
    <div className="statusbar">
      <span className="sb-file">{fileName}</span>
      {modified && <span className="sb-modified" title="Unsaved changes">●</span>}
      <span className="sb-sep">│</span>
      <span className="sb-pos">Ln {cursor.line}, Col {cursor.col}</span>
      <span className="sb-sep">│</span>
      <span className="sb-cwd" title="Current directory">{cwd}</span>
      <div className="sb-right">
        <span className={`sb-session ${cls}`} title="Session time remaining">{fmtTTL(remaining)}</span>
        <span className="sb-sep">│</span>
        <div
          className={`sb-ws-status ${wsStatus}`}
          title={`WebSocket: ${wsStatus}`}
        />
        <span style={{ color: 'var(--fg-comment)', fontSize: 10 }}>
          {wsStatus === 'connected' ? 'Connected' : wsStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </span>
      </div>
    </div>
  )
}

// ── Snippets Panel ────────────────────────────────────────────────
interface SnippetsPanelProps {
  onInsert: (code: string) => void
  onClose:  () => void
}
export function SnippetsPanel({ onInsert, onClose }: SnippetsPanelProps) {
  return (
    <div className="snippets-overlay" role="dialog" aria-label="DevOps Snippets">
      <div className="snippets-header">
        <span className="snippets-title">⟨⟩  DevOps Snippets</span>
        <button className="snippets-close" onClick={onClose} aria-label="Close snippets">×</button>
      </div>
      <div className="snippets-list">
        {SNIPPETS.map(s => (
          <button
            key={s.label}
            className="snippet-item"
            onClick={() => { onInsert(s.code); onClose() }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── File Picker Modal ─────────────────────────────────────────────
interface FilePickerModalProps {
  files:       RemoteFile[]
  onSelect:    (name: string) => void
  onClose:     () => void
  loading:     boolean
  title?:      string
}
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)}KB`
  return `${(bytes/(1024*1024)).toFixed(1)}MB`
}
export function FilePickerModal({ files, onSelect, onClose, loading, title = 'Open File' }: FilePickerModalProps) {
  const [filter, setFilter] = useState('')
  const filtered = files.filter(f => f.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <input
            className="modal-input"
            placeholder="Filter files…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            autoFocus
          />
          {loading ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--fg-dim)' }}>
              Loading files…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--fg-comment)' }}>
              {files.length === 0 ? 'No files in workspace.' : 'No matches.'}
            </div>
          ) : (
            filtered.map(f => (
              <div
                key={f.name}
                className="file-list-item"
                onClick={() => onSelect(f.name)}
              >
                <span className="file-icon">⚡</span>
                <span>{f.name}</span>
                <span className="file-size">{fmtSize(f.size)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ── Save As Modal ─────────────────────────────────────────────────
interface SaveAsModalProps {
  initialName: string
  onSave:      (name: string) => void
  onClose:     () => void
}
export function SaveAsModal({ initialName, onSave, onClose }: SaveAsModalProps) {
  const [name, setName] = useState(initialName)
  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxHeight: 'none', width: 400 }}>
        <div className="modal-header">
          <span className="modal-title">Save As</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ padding: '16px' }}>
          <input
            className="modal-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="filename.sh"
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') onSave(name) }}
          />
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={() => onSave(name)} disabled={!name.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Toast Container ───────────────────────────────────────────────
interface ToastContainerProps { toasts: Toast[]; onDismiss: (id: string) => void }
export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => onDismiss(t.id)} style={{ cursor: 'pointer' }}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
