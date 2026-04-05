import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "../types";

interface UseSessionReturn {
  session: Session | null;
  isCreating: boolean;
  isChecking: boolean; // true while initial resume check is in-flight
  error: string | null;
  createSession: () => Promise<void>;
  terminateSession: () => Promise<void>;
  refreshTTL: () => void;
}

const TTL_POLL_INTERVAL = 30_000;

export function useSession(): UseSessionReturn {
  const [session, setSession] = useState<Session | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isChecking, setIsChecking] = useState(true); // starts true
  const [error, setError] = useState<string | null>(null);
  const ttlTimer = useRef<ReturnType<typeof setInterval>>();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshTTL = useCallback(async () => {
    if (!session) return;
    try {
      const res = await fetch("/api/sessions/status", {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current && data.remaining !== undefined) {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                expiresAt: Math.floor(Date.now() / 1000) + data.remaining,
              }
            : prev,
        );
      }
    } catch {
      /* network blip, ignore */
    }
  }, [session]);

  const createSession = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions/create", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: "Server error" }));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!mountedRef.current) return;

      const newSession: Session = {
        sessionId: data.session_id,
        expiresAt: Math.floor(Date.now() / 1000) + data.ttl,
        wsUrl: `/ws/${data.session_id}`,
        status: "ready",
      };
      setSession(newSession);
      sessionStorage.setItem("bashforge_sid", data.session_id);

      clearInterval(ttlTimer.current);
      ttlTimer.current = setInterval(refreshTTL, TTL_POLL_INTERVAL);
    } catch (err) {
      if (mountedRef.current)
        setError(
          err instanceof Error ? err.message : "Failed to create session",
        );
    } finally {
      if (mountedRef.current) setIsCreating(false);
    }
  }, [refreshTTL]);

  const terminateSession = useCallback(async () => {
    clearInterval(ttlTimer.current);
    try {
      await fetch("/api/sessions/terminate", {
        method: "DELETE",
        credentials: "include",
      });
    } catch {
      /* best-effort */
    }
    sessionStorage.removeItem("bashforge_sid");
    setSession(null);
  }, []);

  // Try to resume session on mount (e.g. page refresh)
  useEffect(() => {
    const tryResume = async () => {
      const sid = sessionStorage.getItem("bashforge_sid");
      if (!sid) {
        setIsChecking(false);
        return;
      }
      try {
        const res = await fetch("/api/sessions/status", {
          credentials: "include",
        });
        if (!res.ok) {
          sessionStorage.removeItem("bashforge_sid");
          setIsChecking(false);
          return;
        }
        const data = await res.json();
        if (mountedRef.current && data.remaining > 0) {
          setSession({
            sessionId: data.session_id,
            expiresAt: Math.floor(Date.now() / 1000) + data.remaining,
            wsUrl: `/ws/${data.session_id}`,
            status: "ready",
          });
          ttlTimer.current = setInterval(refreshTTL, TTL_POLL_INTERVAL);
        } else {
          sessionStorage.removeItem("bashforge_sid");
        }
      } catch {
        sessionStorage.removeItem("bashforge_sid");
      } finally {
        if (mountedRef.current) setIsChecking(false);
      }
    };
    tryResume();
    return () => clearInterval(ttlTimer.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    session,
    isCreating,
    isChecking,
    error,
    createSession,
    terminateSession,
    refreshTTL,
  };
}
