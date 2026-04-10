export interface Session {
  sessionId: string
  expiresAt: number
  wsUrl:     string
  status:    'creating' | 'ready' | 'expired'
}

export interface RemoteFile {
  name:     string
  path:     string
  size:     number
  modified: number
  isDir:    boolean
}

export interface FileTab {
  id:       string
  name:     string
  path:     string
  content:  string
  modified: boolean
  isNew:    boolean
}

export type WsMsgType =
  | 'run_script' | 'stop_script' | 'script_started' | 'script_done'
  | 'resize_terminal' | 'file_list' | 'file_list_result'
  | 'file_read' | 'file_content' | 'file_write' | 'file_written'
  | 'file_new' | 'file_created' | 'session_info' | 'error' | 'ping' | 'pong'

export interface WsControlMsg {
  type:      WsMsgType
  path?:     string
  dir?:      string
  name?:     string
  content?:  string
  args?:     string[]
  cols?:     number
  rows?:     number
  files?:    RemoteFile[]
  remaining?: number
  message?:  string
  exit_code?: number
  elapsed?:  number
}

export type WsStatus = 'connecting' | 'connected' | 'disconnected'
export interface CursorPosition { line: number; col: number }
export interface ScriptRunState { running: boolean; startTime: number | null; elapsedMs: number }
export interface Toast { id: string; type: 'success' | 'error' | 'info' | 'warning'; message: string }
