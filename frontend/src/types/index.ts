// ── Session ─────────────────────────────────────────────────────
export interface Session {
  sessionId: string
  expiresAt: number   // unix timestamp seconds
  wsUrl: string
  status: 'creating' | 'ready' | 'expired'
}

// ── File management ──────────────────────────────────────────────
export interface RemoteFile {
  name: string
  size: number
  modified: number   // unix timestamp
  isDir: boolean
}

export interface FileTab {
  id: string
  name: string
  path: string        // relative to workspace, e.g. "script.sh"
  content: string
  modified: boolean   // unsaved changes
  isNew: boolean      // not yet saved to pod
}

// ── WebSocket protocol ───────────────────────────────────────────
export type WsChannel = 0x01 | 0x02   // 0x01=terminal, 0x02=script output

export type WsMsgType =
  | 'run_script'
  | 'stop_script'
  | 'script_started'
  | 'script_done'
  | 'resize_terminal'
  | 'resize_script'
  | 'file_list'
  | 'file_list_result'
  | 'file_read'
  | 'file_content'
  | 'file_write'
  | 'file_written'
  | 'file_new'
  | 'file_created'
  | 'session_info'
  | 'error'
  | 'ping'
  | 'pong'

export interface WsControlMsg {
  type: WsMsgType
  // run_script
  path?: string
  args?: string[]
  // script_done
  exit_code?: number
  elapsed?: number
  // resize
  cols?: number
  rows?: number
  // file ops
  name?: string
  content?: string
  // file_list_result
  files?: RemoteFile[]
  // session_info
  remaining?: number
  // error
  message?: string
}

// ── IDE state ────────────────────────────────────────────────────
export type WsStatus = 'connecting' | 'connected' | 'disconnected'

export interface CursorPosition { line: number; col: number }

export interface ScriptRunState {
  running: boolean
  startTime: number | null
  elapsedMs: number
}

// ── Toast ────────────────────────────────────────────────────────
export interface Toast {
  id: string
  type: 'success' | 'error' | 'info' | 'warning'
  message: string
}
