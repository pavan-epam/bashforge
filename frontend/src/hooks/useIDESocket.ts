import { useCallback, useEffect, useRef, useState } from 'react'
import type { WsControlMsg, WsStatus } from '../types'

export interface IDESocketOptions {
  sessionId: string | null
  onTerminalData:   (data: Uint8Array) => void
  onScriptOutput:   (data: Uint8Array) => void
  onControlMessage: (msg: WsControlMsg) => void
  onStatusChange:   (status: WsStatus) => void
}

export interface IDESocketHandle {
  sendTerminalInput:  (data: string | Uint8Array) => void
  sendScriptInput:    (data: string | Uint8Array) => void
  sendControl:        (msg: WsControlMsg) => void
  status:             WsStatus
  reconnect:          () => void
}

const CHANNEL_TERMINAL = 0x01
const CHANNEL_SCRIPT   = 0x02

const WS_RECONNECT_DELAY = 2500
const WS_PING_INTERVAL   = 20_000

export function useIDESocket(opts: IDESocketOptions): IDESocketHandle {
  const wsRef               = useRef<WebSocket | null>(null)
  const reconnectTimer      = useRef<ReturnType<typeof setTimeout>>()
  const pingTimer           = useRef<ReturnType<typeof setInterval>>()
  const mountedRef          = useRef(true)
  const [status, setStatus] = useState<WsStatus>('disconnected')
  const optsRef             = useRef(opts)
  optsRef.current           = opts

  const notifyStatus = useCallback((s: WsStatus) => {
    setStatus(s)
    optsRef.current.onStatusChange(s)
  }, [])

  const connect = useCallback(() => {
    if (!optsRef.current.sessionId) return
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return

    // Close existing socket if any
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.close()
      wsRef.current = null
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url   = `${proto}//${window.location.host}/ws/${optsRef.current.sessionId}`

    notifyStatus('connecting')
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      notifyStatus('connected')
      // Start ping loop
      clearInterval(pingTimer.current)
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, WS_PING_INTERVAL)
    }

    ws.onmessage = (event) => {
      if (!mountedRef.current) return

      if (event.data instanceof ArrayBuffer) {
        const buf     = new Uint8Array(event.data)
        if (buf.length < 2) return
        const channel = buf[0]
        const payload = buf.slice(1)
        if (channel === CHANNEL_TERMINAL) {
          optsRef.current.onTerminalData(payload)
        } else if (channel === CHANNEL_SCRIPT) {
          optsRef.current.onScriptOutput(payload)
        }
      } else if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as WsControlMsg
          optsRef.current.onControlMessage(msg)
        } catch {
          // not JSON, ignore
        }
      }
    }

    ws.onerror = () => {
      // onclose will be called right after
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      notifyStatus('disconnected')
      clearInterval(pingTimer.current)
      // Auto-reconnect after delay
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current && optsRef.current.sessionId) {
          connect()
        }
      }, WS_RECONNECT_DELAY)
    }
  }, [notifyStatus])

  // Connect when sessionId becomes available
  useEffect(() => {
    if (opts.sessionId) connect()
  }, [opts.sessionId, connect])

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(reconnectTimer.current)
      clearInterval(pingTimer.current)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [])

  // ── Send helpers ──────────────────────────────────────────────

  const sendBinary = useCallback((channel: number, data: string | Uint8Array) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const frame   = new Uint8Array(1 + encoded.length)
    frame[0] = channel
    frame.set(encoded, 1)
    ws.send(frame.buffer)
  }, [])

  const sendTerminalInput = useCallback((data: string | Uint8Array) => {
    sendBinary(CHANNEL_TERMINAL, data)
  }, [sendBinary])

  const sendScriptInput = useCallback((data: string | Uint8Array) => {
    sendBinary(CHANNEL_SCRIPT, data)
  }, [sendBinary])

  const sendControl = useCallback((msg: WsControlMsg) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(msg))
  }, [])

  return {
    sendTerminalInput,
    sendScriptInput,
    sendControl,
    status,
    reconnect: connect,
  }
}
