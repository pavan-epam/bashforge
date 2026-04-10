import { useCallback, useEffect, useRef, useState } from 'react'
import type * as monacoType from 'monaco-editor'
import { useNavigate } from 'react-router-dom'

import { Toolbar }           from '../components/Toolbar'
import { FileTabsBar }       from '../components/FileTabs'
import { EditorPanel }       from '../components/EditorPanel'
import { OutputPanel }       from '../components/OutputPanel'
import { TerminalPanel }     from '../components/TerminalPanel'
import { ResizableSplitter } from '../components/ResizableSplitter'
import {
  ArgsBar, StatusBar, SnippetsPanel,
  FilePickerModal, SaveAsModal, ToastContainer,
  UnsavedDialog, EmptyEditorState,
} from '../components/Widgets'

import { useIDESocket }  from '../hooks/useIDESocket'
import { useSession }    from '../hooks/useSession'
import { DEFAULT_CONTENT } from '../constants/snippets'
import type {
  FileTab, CursorPosition, ScriptRunState, WsControlMsg,
  WsStatus, RemoteFile, Toast,
} from '../types'

import type { OutputPanelHandle }  from '../components/OutputPanel'
import type { TerminalPanelHandle } from '../components/TerminalPanel'

// ── Helpers ──────────────────────────────────────────────────────
let tabIdCounter = 0
function newTabId() { return `tab_${++tabIdCounter}` }

function makeUntitled(): FileTab {
  return { id: newTabId(), name: 'Untitled.sh', path: '', content: DEFAULT_CONTENT, modified: false, isNew: true }
}

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const add = useCallback((type: Toast['type'], message: string) => {
    const id = `${Date.now()}_${Math.random()}`
    setToasts(t => [...t, { id, type, message }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000)
  }, [])
  const dismiss = useCallback((id: string) => setToasts(t => t.filter(x => x.id !== id)), [])
  return { toasts, add, dismiss }
}

// ── IDE Page ─────────────────────────────────────────────────────
export default function IDEPage() {
  const navigate = useNavigate()
  const { session, isChecking, terminateSession } = useSession()

  useEffect(() => {
    if (!isChecking && !session) navigate('/', { replace: true })
  }, [isChecking, session, navigate])

  // ── Panel state ───────────────────────────────────────────────
  const [editorW, setEditorW] = useState(780)
  const [outputH, setOutputH] = useState(320)
  const mainAreaRef = useRef<HTMLDivElement>(null)

  // ── Tabs ──────────────────────────────────────────────────────
  const [tabs,     setTabs]     = useState<FileTab[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const activeTab = tabs.find(t => t.id === activeId) ?? null

  // ── Unsaved dialog ────────────────────────────────────────────
  const [unsavedDialog, setUnsavedDialog] = useState<{
    tabId: string; onConfirm: () => void
  } | null>(null)

  // ── Args / cursor / run ───────────────────────────────────────
  const [args,     setArgs]     = useState('')
  const [cursor,   setCursor]   = useState<CursorPosition>({ line: 1, col: 1 })
  const [runState, setRunState] = useState<ScriptRunState>({ running: false, startTime: null, elapsedMs: 0 })

  // ── UI toggles ────────────────────────────────────────────────
  const [showSnippets,    setShowSnippets]    = useState(false)
  const [showOpenModal,   setShowOpenModal]   = useState(false)
  const [showSaveAs,      setShowSaveAs]      = useState(false)
  const [fileList,        setFileList]        = useState<RemoteFile[]>([])
  const [fileListLoading, setFileListLoading] = useState(false)
  const [fileListDir,     setFileListDir]     = useState('workspace')
  const [wsStatus,        setWsStatus]        = useState<WsStatus>('disconnected')
  const [cwd,             setCwd]             = useState('~/workspace')
  const [activeSessions,  setActiveSessions]  = useState(1)

  // ── Refs ──────────────────────────────────────────────────────
  const editorRef   = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null)
  const outputRef   = useRef<OutputPanelHandle>(null)
  const termRef     = useRef<TerminalPanelHandle>(null)
  const runStateRef = useRef(runState)
  runStateRef.current = runState
  // Always-fresh refs for use inside useCallback closures
  const tabsRef     = useRef(tabs)
  tabsRef.current   = tabs
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const argsRef     = useRef(args)
  argsRef.current   = args
  const { toasts, add: addToast, dismiss: dismissToast } = useToasts()

  // ── WebSocket control messages ─────────────────────────────────
  const handleControl = useCallback((msg: WsControlMsg) => {
    switch (msg.type) {
      case 'script_started':
        setRunState({ running: true, startTime: Date.now(), elapsedMs: 0 })
        outputRef.current?.writeln(`── Started ── ${new Date().toLocaleTimeString()} ──`, 'system')
        outputRef.current?.setInputCb(data => socketRef.current?.sendScriptInput(data))
        break

      case 'script_done': {
        const rc = msg.exit_code ?? 0
        const elapsed = msg.elapsed ?? 0
        setRunState({ running: false, startTime: null, elapsedMs: elapsed * 1000 })
        outputRef.current?.setInputCb(null)
        outputRef.current?.writeln(`\r\n── ${rc === 0 ? '✓' : '✗'} Exit ${rc}  ${elapsed.toFixed(2)}s ──`, rc === 0 ? 'success' : 'error')
        if (rc === 0) addToast('success', `Done in ${elapsed.toFixed(2)}s`)
        else addToast('error', `Exit code ${rc}`)
        break
      }

      case 'file_list_result':
        setFileList(msg.files ?? [])
        setFileListLoading(false)
        if (msg.dir) setFileListDir(msg.dir as string)
        break

      case 'file_content':
        if (msg.path !== undefined && msg.content !== undefined) {
          const existingIdx = tabs.findIndex(t => t.path === msg.path)
          if (existingIdx >= 0) {
            const existing = tabs[existingIdx]
            setTabs(ts => ts.map(t => t.id === existing.id
              ? { ...t, content: msg.content!, modified: false } : t))
            setActiveId(existing.id)
          } else {
            const name = (msg.path!).split('/').pop() ?? msg.path!
            const newTab: FileTab = {
              id: newTabId(), name, path: msg.path!, content: msg.content!,
              modified: false, isNew: false,
            }
            setTabs(ts => [...ts, newTab])
            setActiveId(newTab.id)
          }
        }
        break

      case 'file_written':
        if (msg.path) {
          setTabs(ts => ts.map(t =>
            (t.path === msg.path || (t.isNew && t.id === activeId))
              ? { ...t, modified: false, isNew: false, path: msg.path!, name: msg.path!.split('/').pop()! }
              : t
          ))
          addToast('success', `Saved: ${msg.path}`)
        }
        break

      case 'error':
        addToast('error', msg.message ?? 'Unknown error')
        break

      case 'pong': break
    }
  }, [activeId, tabs, addToast])

  // ── Socket ────────────────────────────────────────────────────
  const socketRef = useRef<ReturnType<typeof useIDESocket> | null>(null)
  const socket = useIDESocket({
    sessionId:        session?.sessionId ?? null,
    onTerminalData:   data => termRef.current?.write(data),
    onScriptOutput:   data => outputRef.current?.write(data),
    onControlMessage: handleControl,
    onStatusChange:   setWsStatus,
  })
  socketRef.current = socket

  const handleTermResize = useCallback((cols: number, rows: number) => {
    socket.sendControl({ type: 'resize_terminal', cols, rows })
  }, [socket])

  // ── Run ────────────────────────────────────────────────────────
  const handleRun = useCallback(() => {
    if (runStateRef.current.running) return
    // Read tabs directly (not activeTab) so we always get the freshest content
    // even if React hasn't re-rendered since the last keystroke
    const tab = tabsRef.current.find(t => t.id === activeIdRef.current)
    if (!tab) { addToast('warning', 'No file open.'); return }
    // Also read directly from Monaco editor to bypass any React state lag
    const editorContent = editorRef.current?.getValue() ?? tab.content
    const path = tab.isNew || !tab.path ? 'script.sh' : tab.path
    socket.sendControl({
      type: 'run_script', path,
      content: editorContent,
      args: argsRef.current.trim() ? argsRef.current.trim().split(/\s+/) : [],
    })
    // Do NOT clear output — user has a Clear button for that
    outputRef.current?.focus()
  }, [socket, addToast])

  const handleStop = useCallback(() => socket.sendControl({ type: 'stop_script' }), [socket])

  // ── File ops ────────────────────────────────────────────────────
  const handleNew = useCallback(() => {
    const t = makeUntitled()
    setTabs(ts => [...ts, t])
    setActiveId(t.id)
  }, [])

  const requestFileList = useCallback((dir?: string) => {
    setFileListLoading(true)
    socket.sendControl({ type: 'file_list', dir: dir ?? '' })
  }, [socket])

  const handleOpen = useCallback(() => {
    setShowOpenModal(true)
    // Start at workspace root
    requestFileList('workspace')
  }, [requestFileList])

  const handleOpenSelect = useCallback((path: string) => {
    setShowOpenModal(false)
    socket.sendControl({ type: 'file_read', path })
  }, [socket])

  const handleNavigateDir = useCallback((dir: string) => {
    // dir is relative to /home/bashuser
    requestFileList(dir)
  }, [requestFileList])

  const handleNavigateUp = useCallback(() => {
    // Go up one directory level (but not above /home/bashuser)
    const parts = fileListDir.replace(/^\/home\/bashuser\/?/, '').split('/').filter(Boolean)
    if (parts.length <= 1) {
      requestFileList('workspace')
    } else {
      parts.pop()
      requestFileList(parts.join('/'))
    }
  }, [fileListDir, requestFileList])

  // Save: if file already has a path just save, only prompt for new files
  const handleSave = useCallback(() => {
    const tab = tabsRef.current.find(t => t.id === activeIdRef.current)
    if (!tab) return
    // isNew=true OR path is empty = never saved before = need a filename
    if (tab.isNew || !tab.path) {
      setShowSaveAs(true)
      return
    }
    // Already saved — write directly, no dialog
    const content = editorRef.current?.getValue() ?? tab.content
    socket.sendControl({ type: 'file_write', path: tab.path, content })
  }, [socket])

  const handleSaveAs = useCallback(() => setShowSaveAs(true), [])

  const handleSaveAsConfirm = useCallback((name: string) => {
    const tab = tabsRef.current.find(t => t.id === activeIdRef.current)
    if (!tab) return
    const safeName = name.trim() || 'script.sh'
    const content = editorRef.current?.getValue() ?? tab.content
    socket.sendControl({ type: 'file_write', path: safeName, content })
    setShowSaveAs(false)
  }, [socket])

  // Close tab: warn if unsaved
  const doCloseTab = useCallback((id: string) => {
    setTabs(ts => {
      const next = ts.filter(t => t.id !== id)
      if (activeId === id) {
        const idx = ts.findIndex(t => t.id === id)
        const newActive = next[Math.max(0, idx - 1)]
        setActiveId(newActive?.id ?? '')
      }
      return next
    })
  }, [activeId])

  const handleCloseTab = useCallback((id: string) => {
    const tab = tabs.find(t => t.id === id)
    if (tab?.modified) {
      setUnsavedDialog({
        tabId: id,
        onConfirm: () => {
          // Save then close
          const path = tab.isNew || !tab.path ? null : tab.path
          if (path) {
            socket.sendControl({ type: 'file_write', path, content: tab.content })
          } else {
            setShowSaveAs(true)
          }
          setUnsavedDialog(null)
        },
      })
    } else {
      doCloseTab(id)
    }
  }, [tabs, doCloseTab, socket])

  const handleContentChange = useCallback((content: string) => {
    setTabs(ts => ts.map(t =>
      t.id === activeId ? { ...t, content, modified: !t.isNew } : t
    ))
  }, [activeId])

  // ── Editor actions ────────────────────────────────────────────
  const handleComment  = useCallback(() => editorRef.current?.trigger('keyboard', 'editor.action.commentLine', null), [])
  const handleFind     = useCallback(() => editorRef.current?.trigger('keyboard', 'actions.find', null), [])
  const handleInsertSnippet = useCallback((code: string) => {
    const editor = editorRef.current
    if (!editor) return
    const sel = editor.getSelection()
    if (sel) editor.executeEdits('snippet', [{ range: sel, text: code }])
    editor.focus()
  }, [])

  // ── Session ────────────────────────────────────────────────────
  const handleEndSession = useCallback(async () => {
    if (!window.confirm('End session? Your workspace will be deleted.')) return
    await terminateSession()
    navigate('/', { replace: true })
  }, [terminateSession, navigate])

  // ── Global keyboard shortcuts ─────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      if (e.key === 'Enter') { e.preventDefault(); handleRun() }
      if (e.key === 'n')     { e.preventDefault(); handleNew() }
      if (e.key === 'o')     { e.preventDefault(); handleOpen() }
      if (e.key === 's' && e.shiftKey) { e.preventDefault(); handleSaveAs() }
      else if (e.key === 's') { e.preventDefault(); handleSave() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleRun, handleNew, handleOpen, handleSave, handleSaveAs])

  // ── Poll active session count every 15s ──────────────────────
  useEffect(() => {
    const fetchCount = async () => {
      try {
        const r = await fetch('/api/sessions/count', { credentials: 'include' })
        if (r.ok) { const d = await r.json(); setActiveSessions(d.count ?? 1) }
      } catch { /* ignore */ }
    }
    fetchCount()
    const t = setInterval(fetchCount, 15_000)
    return () => clearInterval(t)
  }, [])

  // ── Layout constants ──────────────────────────────────────────
  const MIN_OUTPUT   = 100
  const MIN_EDITOR_W = 320
  const clampOutputH = (h: number) => Math.max(MIN_OUTPUT, Math.min(h, 800))

  // ── isChecking guard (all hooks above this) ───────────────────
  if (isChecking) {
    return (
      <div style={{
        width: '100vw', height: '100vh', background: '#0d1117',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#8b949e', fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 16, height: 16, borderRadius: '50%',
            border: '2px solid rgba(88,166,255,0.3)', borderTopColor: '#58a6ff',
            animation: 'spin 0.6s linear infinite',
          }} />
          Connecting…
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  const unsavedTab = unsavedDialog ? tabs.find(t => t.id === unsavedDialog.tabId) : null

  return (
    <div className="ide-root">

      {/* Toolbar */}
      <Toolbar
        onNew={handleNew} onOpen={handleOpen} onSave={handleSave} onSaveAs={handleSaveAs}
        onRun={handleRun} onStop={handleStop} runState={runState}
        onComment={handleComment} onSnippets={() => setShowSnippets(s => !s)} onFind={handleFind}
        onEndSession={handleEndSession} wsStatus={wsStatus}
        activeSessions={activeSessions}
      />

      {/* Main area */}
      <div className="main-area" ref={mainAreaRef}>

        {/* Editor pane */}
        <div className="editor-pane" style={{ width: editorW, minWidth: MIN_EDITOR_W }}>
          <div className="panel-hdr">
            <span className="panel-hdr-title">Editor</span>
            <span className="panel-hdr-hint">Ctrl+/ comment · Ctrl+D dup · Ctrl+Enter run</span>
          </div>
          <FileTabsBar tabs={tabs} activeId={activeId} onActivate={setActiveId} onClose={handleCloseTab} />
          {activeTab ? (
            <EditorPanel
              activeTab={activeTab}
              onContentChange={handleContentChange}
              onCursorChange={setCursor}
              onRun={handleRun}
              onSave={handleSave}
              editorRef={editorRef}
              width={editorW}
            />
          ) : (
            <EmptyEditorState onNew={handleNew} onOpen={handleOpen} />
          )}
        </div>

        <ResizableSplitter direction="horizontal"
          onDelta={d => setEditorW(w => Math.max(MIN_EDITOR_W, w + d))} />

        {/* Right pane */}
        <div className="right-pane">
          <ArgsBar value={args} onChange={setArgs} />

          {/* Output */}
          <div className="output-pane" style={{ height: outputH }}>
            <div className="panel-hdr">
              <span className="panel-hdr-title">Output</span>
              <span className="panel-hdr-hint">
                {runState.running
                  ? <span className="running-indicator"><span className="running-dot"/>Running…</span>
                  : 'interactive stdin when script prompts'}
              </span>
              <button className="panel-clear-btn" style={{ marginLeft: 8 }}
                onClick={() => outputRef.current?.clear()}>⊗ Clear</button>
            </div>
            <OutputPanel ref={outputRef} isRunning={runState.running} />
          </div>

          <ResizableSplitter direction="vertical"
            onDelta={d => setOutputH(h => clampOutputH(h + d))} />

          {/* Terminal */}
          <div className="terminal-pane">
            <div className="panel-hdr">
              <span className="panel-hdr-title">Terminal</span>
              <span className="panel-hdr-hint">Up/Down history · Tab complete</span>
              <button className="panel-clear-btn" style={{ marginLeft: 8 }}
                onClick={() => termRef.current?.clear()}>⊗ Clear</button>
            </div>
            <TerminalPanel ref={termRef} onInput={socket.sendTerminalInput} onResize={handleTermResize} />
          </div>
        </div>
      </div>

      {/* Status bar */}
      <StatusBar
        fileName={activeTab?.name ?? 'No file open'}
        modified={activeTab?.modified ?? false}
        cursor={cursor}
        cwd={cwd}
        ttlSeconds={session ? session.expiresAt - Math.floor(Date.now() / 1000) : 0}
        wsStatus={wsStatus}
      />

      {/* Overlays */}
      {showSnippets && (
        <SnippetsPanel onInsert={handleInsertSnippet} onClose={() => setShowSnippets(false)} />
      )}

      {showOpenModal && (
        <FilePickerModal
          files={fileList} onSelect={handleOpenSelect}
          onClose={() => setShowOpenModal(false)}
          loading={fileListLoading} currentDir={fileListDir}
          onNavigate={handleNavigateDir}
          onNavigateUp={handleNavigateUp}
        />
      )}

      {showSaveAs && (
        <SaveAsModal
          initialName={activeTab?.name ?? 'script.sh'}
          onSave={handleSaveAsConfirm}
          onClose={() => setShowSaveAs(false)}
        />
      )}

      {unsavedDialog && unsavedTab && (
        <UnsavedDialog
          fileName={unsavedTab.name}
          onSave={unsavedDialog.onConfirm}
          onDiscard={() => { doCloseTab(unsavedDialog.tabId); setUnsavedDialog(null) }}
          onCancel={() => setUnsavedDialog(null)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
