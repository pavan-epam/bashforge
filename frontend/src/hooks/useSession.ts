import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '../types'

interface WaitInfo { totalSlots: number; active: number; waitSeconds: number }

interface UseSessionReturn {
  session:          Session | null
  isCreating:       boolean
  isChecking:       boolean
  error:            string | null
  waitInfo:         WaitInfo | null   // set when at capacity
  createSession:    () => Promise<void>
  terminateSession: () => Promise<void>
  refreshTTL:       () => void
}

const TTL_POLL_INTERVAL = 30_000

export function useSession(): UseSessionReturn {
  const [session,    setSession]    = useState<Session | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [isChecking, setIsChecking] = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [waitInfo,   setWaitInfo]   = useState<WaitInfo | null>(null)
  const ttlTimer   = useRef<ReturnType<typeof setInterval>>()
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const refreshTTL = useCallback(async () => {
    if (!session) return
    try {
      const res  = await fetch('/api/sessions/status', { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      if (mountedRef.current && data.remaining !== undefined) {
        setSession(prev =>
          prev ? { ...prev, expiresAt: Math.floor(Date.now() / 1000) + data.remaining } : prev
        )
      }
    } catch { /* network blip, ignore */ }
  }, [session])

  const createSession = useCallback(async () => {
    setIsCreating(true)
    setError(null)
    try {
      const res  = await fetch('/api/sessions/create', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: 'Server error' }))
        const detail = body.detail || `HTTP ${res.status}`
        if (typeof detail === 'string' && detail.startsWith('CAPACITY_REACHED:')) {
          const parts = detail.split(':')
          setWaitInfo({ active: Number(parts[1]), totalSlots: Number(parts[2]), waitSeconds: Number(parts[3]) })
          throw new Error('__capacity__')
        }
        throw new Error(detail)
      }
      const data = await res.json()
      if (!mountedRef.current) return

      setWaitInfo(null)
      const newSession: Session = {
        sessionId: data.session_id,
        expiresAt: Math.floor(Date.now() / 1000) + data.ttl,
        wsUrl:     `/ws/${data.session_id}`,
        status:    'ready',
      }
      setSession(newSession)
      sessionStorage.setItem('bashforge_sid', data.session_id)

      clearInterval(ttlTimer.current)
      ttlTimer.current = setInterval(refreshTTL, TTL_POLL_INTERVAL)
    } catch (err) {
      if (mountedRef.current) {
        const msg = err instanceof Error ? err.message : 'Failed to create session'
        if (msg !== '__capacity__') setError(msg)
      }
    } finally {
      if (mountedRef.current) setIsCreating(false)
    }
  }, [refreshTTL])

  const terminateSession = useCallback(async () => {
    clearInterval(ttlTimer.current)
    try {
      await fetch('/api/sessions/terminate', { method: 'DELETE', credentials: 'include' })
    } catch { /* best-effort */ }
    sessionStorage.removeItem('bashforge_sid')
    setSession(null)
  }, [])

  // Try to resume session on mount.
  // Checks the HttpOnly cookie via /api/sessions/status so any tab or browser
  // on the same machine that already has a session cookie will automatically resume.
  useEffect(() => {
    const tryResume = async () => {
      // Always check the API — cookie is HttpOnly so we can't read it directly,
      // but the server will see it and return the active session if one exists.
      const sid = sessionStorage.getItem('bashforge_sid')
      try {
        const res  = await fetch('/api/sessions/status', { credentials: 'include' })
        if (!res.ok) { sessionStorage.removeItem('bashforge_sid'); setIsChecking(false); return }
        const data = await res.json()
        if (mountedRef.current && data.remaining > 0) {
          setSession({
            sessionId: data.session_id,
            expiresAt: Math.floor(Date.now() / 1000) + data.remaining,
            wsUrl:     `/ws/${data.session_id}`,
            status:    'ready',
          })
          ttlTimer.current = setInterval(refreshTTL, TTL_POLL_INTERVAL)
        } else {
          sessionStorage.removeItem('bashforge_sid')
        }
      } catch {
        sessionStorage.removeItem('bashforge_sid')
      } finally {
        if (mountedRef.current) setIsChecking(false)
      }
    }
    tryResume()
    return () => clearInterval(ttlTimer.current)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { session, isCreating, isChecking, error, waitInfo, createSession, terminateSession, refreshTTL }
}
