import { useCallback, useEffect, useRef, useState } from "react";
import type * as monacoType from "monaco-editor";
import { useNavigate } from "react-router-dom";

import { Toolbar } from "../components/Toolbar";
import { FileTabsBar } from "../components/FileTabs";
import { EditorPanel } from "../components/EditorPanel";
import { OutputPanel } from "../components/OutputPanel";
import { TerminalPanel } from "../components/TerminalPanel";
import { ResizableSplitter } from "../components/ResizableSplitter";
import {
  ArgsBar,
  StatusBar,
  SnippetsPanel,
  FilePickerModal,
  SaveAsModal,
  ToastContainer,
} from "../components/Widgets";

import { useIDESocket } from "../hooks/useIDESocket";
import { useSession } from "../hooks/useSession";
import { DEFAULT_CONTENT } from "../constants/snippets";
import type {
  FileTab,
  CursorPosition,
  ScriptRunState,
  WsControlMsg,
  WsStatus,
  RemoteFile,
  Toast,
} from "../types";

import type { OutputPanelHandle } from "../components/OutputPanel";
import type { TerminalPanelHandle } from "../components/TerminalPanel";

// ── Helpers ──────────────────────────────────────────────────────
let tabIdCounter = 0;
function newTabId() {
  return `tab_${++tabIdCounter}`;
}

function makeUntitled(): FileTab {
  return {
    id: newTabId(),
    name: "Untitled.sh",
    path: "",
    content: DEFAULT_CONTENT,
    modified: false,
    isNew: true,
  };
}

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const add = useCallback((type: Toast["type"], message: string) => {
    const id = `${Date.now()}_${Math.random()}`;
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  const dismiss = useCallback(
    (id: string) => setToasts((t) => t.filter((x) => x.id !== id)),
    [],
  );
  return { toasts, add, dismiss };
}

// ── IDE page ─────────────────────────────────────────────────────
export default function IDEPage() {
  const navigate = useNavigate();
  const { session, isChecking, terminateSession } = useSession();

  // Don't redirect while initial resume-check is still in-flight.
  // Without isChecking guard the page redirects to / immediately on mount
  // before the async sessionStorage → API restore has a chance to run.
  useEffect(() => {
    if (!isChecking && !session) navigate("/", { replace: true });
  }, [isChecking, session, navigate]);

  // ── Panel sizes (px) ─────────────────────────────────────────
  const [editorW, setEditorW] = useState(780);
  const [outputH, setOutputH] = useState(340);
  const mainAreaRef = useRef<HTMLDivElement>(null);

  // ── File tabs ─────────────────────────────────────────────────
  const [tabs, setTabs] = useState<FileTab[]>([makeUntitled()]);
  const [activeId, setActiveId] = useState<string>(tabs[0].id);
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  // ── Args bar ─────────────────────────────────────────────────
  const [args, setArgs] = useState("");

  // ── Cursor position ───────────────────────────────────────────
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, col: 1 });

  // ── Run state ─────────────────────────────────────────────────
  const [runState, setRunState] = useState<ScriptRunState>({
    running: false,
    startTime: null,
    elapsedMs: 0,
  });

  // ── UI toggles ────────────────────────────────────────────────
  const [showSnippets, setShowSnippets] = useState(false);
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [fileList, setFileList] = useState<RemoteFile[]>([]);
  const [fileListLoading, setFileListLoading] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [cwd, setCwd] = useState("~/workspace");

  // ── Refs ──────────────────────────────────────────────────────
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(
    null,
  );
  const outputRef = useRef<OutputPanelHandle>(null);
  const termRef = useRef<TerminalPanelHandle>(null);
  const { toasts, add: addToast, dismiss: dismissToast } = useToasts();
  const runStateRef = useRef(runState);
  runStateRef.current = runState;

  // ── WebSocket control message handler ─────────────────────────
  const handleControl = useCallback(
    (msg: WsControlMsg) => {
      switch (msg.type) {
        case "script_started":
          setRunState({ running: true, startTime: Date.now(), elapsedMs: 0 });
          outputRef.current?.writeln(
            `── Started ── ${new Date().toLocaleTimeString()} ──`,
            "system",
          );
          // Enable script input forwarding
          outputRef.current?.setInputCb((data) => {
            socket.sendScriptInput(data);
          });
          break;

        case "script_done": {
          const rc = msg.exit_code ?? 0;
          const elapsed = msg.elapsed ?? 0;
          setRunState({
            running: false,
            startTime: null,
            elapsedMs: elapsed * 1000,
          });
          outputRef.current?.setInputCb(null);
          const icon = rc === 0 ? "✓" : "✗";
          const style = rc === 0 ? "success" : "error";
          outputRef.current?.writeln(
            `\r\n── ${icon} Exit ${rc}  ${elapsed.toFixed(2)}s ──`,
            style,
          );
          if (rc === 0)
            addToast("success", `Script completed in ${elapsed.toFixed(2)}s`);
          else addToast("error", `Script exited with code ${rc}`);
          break;
        }

        case "file_list_result":
          setFileList(msg.files ?? []);
          setFileListLoading(false);
          break;

        case "file_content":
          if (msg.path && msg.content !== undefined) {
            // Check if already open
            const existing = tabs.find((t) => t.path === msg.path);
            if (existing) {
              setTabs((ts) =>
                ts.map((t) =>
                  t.id === existing.id
                    ? { ...t, content: msg.content!, modified: false }
                    : t,
                ),
              );
              setActiveId(existing.id);
            } else {
              const newTab: FileTab = {
                id: newTabId(),
                name: msg.path!.split("/").pop()!,
                path: msg.path!,
                content: msg.content!,
                modified: false,
                isNew: false,
              };
              setTabs((ts) => [...ts, newTab]);
              setActiveId(newTab.id);
            }
          }
          break;

        case "file_written":
          if (msg.path) {
            setTabs((ts) =>
              ts.map((t) =>
                t.path === msg.path || (t.isNew && t.id === activeId)
                  ? {
                      ...t,
                      modified: false,
                      isNew: false,
                      path: msg.path!,
                      name: msg.path!.split("/").pop()!,
                    }
                  : t,
              ),
            );
            addToast("success", `Saved: ${msg.path}`);
          }
          break;

        case "file_created":
          if (msg.name) addToast("info", `Created: ${msg.name}`);
          break;

        case "session_info":
          // TTL update from server
          break;

        case "pong":
          break;

        case "error":
          addToast("error", msg.message ?? "Unknown error");
          break;
      }
    },
    [activeId, tabs, addToast],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Socket ────────────────────────────────────────────────────
  const socket = useIDESocket({
    sessionId: session?.sessionId ?? null,
    onTerminalData: (data) => termRef.current?.write(data),
    onScriptOutput: (data) => outputRef.current?.write(data),
    onControlMessage: handleControl,
    onStatusChange: setWsStatus,
  });

  // ── Terminal resize → send to backend ─────────────────────────
  const handleTermResize = useCallback(
    (cols: number, rows: number) => {
      socket.sendControl({ type: "resize_terminal", cols, rows });
    },
    [socket],
  );

  // ── Run script ────────────────────────────────────────────────
  const handleRun = useCallback(() => {
    if (runStateRef.current.running) return;
    if (!activeTab) {
      addToast("warning", "No file open to run.");
      return;
    }
    // Save first (send current content to pod)
    const path = activeTab.isNew ? "script.sh" : activeTab.path;
    socket.sendControl({
      type: "run_script",
      path,
      content: activeTab.content,
      args: args.trim() ? args.trim().split(/\s+/) : [],
    });
    outputRef.current?.clear();
    outputRef.current?.focus();
  }, [activeTab, args, socket, addToast]);

  const handleStop = useCallback(() => {
    socket.sendControl({ type: "stop_script" });
  }, [socket]);

  // ── File ops ──────────────────────────────────────────────────
  const handleNew = useCallback(() => {
    const t = makeUntitled();
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
  }, []);

  const handleOpen = useCallback(() => {
    setFileListLoading(true);
    setShowOpenModal(true);
    socket.sendControl({ type: "file_list" });
  }, [socket]);

  const handleOpenSelect = useCallback(
    (name: string) => {
      setShowOpenModal(false);
      socket.sendControl({ type: "file_read", path: name });
    },
    [socket],
  );

  const handleSave = useCallback(() => {
    if (!activeTab) return;
    if (activeTab.isNew) {
      setShowSaveAs(true);
      return;
    }
    socket.sendControl({
      type: "file_write",
      path: activeTab.path,
      content: activeTab.content,
    });
  }, [activeTab, socket]);

  const handleSaveAs = useCallback(() => setShowSaveAs(true), []);

  const handleSaveAsConfirm = useCallback(
    (name: string) => {
      if (!activeTab) return;
      const safeName = name.trim() || "script.sh";
      socket.sendControl({
        type: "file_write",
        path: safeName,
        content: activeTab.content,
      });
      setShowSaveAs(false);
    },
    [activeTab, socket],
  );

  const handleCloseTab = useCallback(
    (id: string) => {
      setTabs((ts) => {
        const idx = ts.findIndex((t) => t.id === id);
        const next = ts.filter((t) => t.id !== id);
        if (activeId === id) {
          const newActive = next[Math.max(0, idx - 1)];
          setActiveId(newActive?.id ?? "");
        }
        return next.length > 0 ? next : [makeUntitled()];
      });
    },
    [activeId],
  );

  // Update tab content on editor change
  const handleContentChange = useCallback(
    (content: string) => {
      setTabs((ts) =>
        ts.map((t) =>
          t.id === activeId
            ? { ...t, content, modified: t.isNew ? false : true }
            : t,
        ),
      );
    },
    [activeId],
  );

  // ── Editor smart actions ──────────────────────────────────────
  const handleComment = useCallback(() => {
    editorRef.current?.trigger("keyboard", "editor.action.commentLine", null);
  }, []);

  const handleFind = useCallback(() => {
    editorRef.current?.trigger("keyboard", "actions.find", null);
  }, []);

  const handleClearEditor = useCallback(() => {
    if (!window.confirm("Clear all editor content?")) return;
    setTabs((ts) =>
      ts.map((t) =>
        t.id === activeId ? { ...t, content: "", modified: true } : t,
      ),
    );
  }, [activeId]);

  const handleInsertSnippet = useCallback((code: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const sel = editor.getSelection();
    if (!sel) return;
    editor.executeEdits("snippet", [{ range: sel, text: code }]);
    editor.focus();
  }, []);

  // ── Session end ───────────────────────────────────────────────
  const handleEndSession = useCallback(async () => {
    if (!window.confirm("End session? Your workspace will be deleted.")) return;
    await terminateSession();
    navigate("/", { replace: true });
  }, [terminateSession, navigate]);

  // ── Keyboard shortcuts for IDE page ──────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.key === "Enter") {
        e.preventDefault();
        handleRun();
      }
      if (e.key === "n") {
        e.preventDefault();
        handleNew();
      }
      if (e.key === "o") {
        e.preventDefault();
        handleOpen();
      }
      if (e.key === "s" && e.shiftKey) {
        e.preventDefault();
        handleSaveAs();
      } else if (e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleRun, handleNew, handleOpen, handleSave, handleSaveAs]);

  // Layout constants
  const MIN_OUTPUT = 100;
  const MIN_EDITOR_W = 320;
  const clampOutputH = (h: number) => Math.max(MIN_OUTPUT, Math.min(h, 800));

  // NOTE: isChecking check is HERE — after ALL hooks — so hook order is never violated
  if (isChecking) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          background: "#0d1117",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#8b949e",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              border: "2px solid rgba(88,166,255,0.3)",
              borderTopColor: "#58a6ff",
              animation: "spin 0.6s linear infinite",
            }}
          />
          Connecting…
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div className="ide-root">
      {/* ── Toolbar ── */}
      <Toolbar
        onNew={handleNew}
        onOpen={handleOpen}
        onSave={handleSave}
        onSaveAs={handleSaveAs}
        onRun={handleRun}
        onStop={handleStop}
        runState={runState}
        onComment={handleComment}
        onSnippets={() => setShowSnippets((s) => !s)}
        onFind={handleFind}
        onClearOutput={() => outputRef.current?.clear()}
        onClearTerminal={() => termRef.current?.clear()}
        onClearEditor={handleClearEditor}
        onEndSession={handleEndSession}
        wsStatus={wsStatus}
      />

      {/* ── Main area: editor + right panels ── */}
      <div className="main-area" ref={mainAreaRef}>
        {/* ── Left: editor pane ── */}
        <div
          className="editor-pane"
          style={{ width: editorW, minWidth: MIN_EDITOR_W }}
        >
          {/* Panel header */}
          <div className="panel-hdr">
            <span className="panel-hdr-title">Editor</span>
            <span className="panel-hdr-hint">
              Ctrl+/ comment · Ctrl+D dup · Tab indent · Ctrl+Enter run
            </span>
          </div>
          {/* File tabs */}
          <FileTabsBar
            tabs={tabs}
            activeId={activeId}
            onActivate={setActiveId}
            onClose={handleCloseTab}
          />
          {/* Monaco editor */}
          <EditorPanel
            activeTab={activeTab}
            onContentChange={handleContentChange}
            onCursorChange={setCursor}
            onRun={handleRun}
            onSave={handleSave}
            editorRef={editorRef}
            width={editorW}
          />
        </div>

        {/* ── Horizontal splitter ── */}
        <ResizableSplitter
          direction="horizontal"
          onDelta={(d) => setEditorW((w) => Math.max(MIN_EDITOR_W, w + d))}
        />

        {/* ── Right: output + terminal ── */}
        <div className="right-pane">
          {/* Args bar */}
          <ArgsBar value={args} onChange={setArgs} />

          {/* Output pane */}
          <div className="output-pane" style={{ height: outputH }}>
            <div className="panel-hdr">
              <span className="panel-hdr-title">Script Output</span>
              <span className="panel-hdr-hint">
                {runState.running ? (
                  <span className="running-indicator">
                    <span className="running-dot" />
                    Running…
                  </span>
                ) : (
                  "interactive — type input when script asks"
                )}
              </span>
              <button
                className="panel-clear-btn"
                style={{ marginLeft: 8 }}
                onClick={() => outputRef.current?.clear()}
                title="Clear output"
              >
                ⊗ Clear
              </button>
            </div>
            <OutputPanel ref={outputRef} isRunning={runState.running} />
          </div>

          {/* Vertical splitter */}
          <ResizableSplitter
            direction="vertical"
            onDelta={(d) => setOutputH((h) => clampOutputH(h + d))}
          />

          {/* Terminal pane — fills remaining space via CSS flex:1 */}
          <div className="terminal-pane">
            <div className="panel-hdr">
              <span className="panel-hdr-title">Terminal</span>
              <span className="panel-hdr-hint">
                Up/Down history · Tab complete · cd / clear
              </span>
              <button
                className="panel-clear-btn"
                style={{ marginLeft: 8 }}
                onClick={() => termRef.current?.clear()}
                title="Clear terminal"
              >
                ⊗ Clear
              </button>
            </div>
            <TerminalPanel
              ref={termRef}
              onInput={socket.sendTerminalInput}
              onResize={handleTermResize}
            />
          </div>
        </div>
      </div>

      {/* ── Status bar ── */}
      <StatusBar
        fileName={activeTab?.name ?? "Untitled.sh"}
        modified={activeTab?.modified ?? false}
        cursor={cursor}
        cwd={cwd}
        ttlSeconds={
          session ? session.expiresAt - Math.floor(Date.now() / 1000) : 0
        }
        wsStatus={wsStatus}
      />

      {/* ── Overlays ── */}
      {showSnippets && (
        <SnippetsPanel
          onInsert={handleInsertSnippet}
          onClose={() => setShowSnippets(false)}
        />
      )}

      {showOpenModal && (
        <FilePickerModal
          files={fileList}
          onSelect={handleOpenSelect}
          onClose={() => setShowOpenModal(false)}
          loading={fileListLoading}
        />
      )}

      {showSaveAs && (
        <SaveAsModal
          initialName={activeTab?.name ?? "script.sh"}
          onSave={handleSaveAsConfirm}
          onClose={() => setShowSaveAs(false)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
