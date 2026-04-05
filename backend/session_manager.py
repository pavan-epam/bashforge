"""
session_manager.py  —  manages session lifecycle:
  create → Redis record + K8s pod + service
  terminate → delete pod/service + Redis
  reaper → background task cleaning up expired sessions
"""
import asyncio
import logging
import secrets
import time
from typing import Optional

from config import get_settings
from redis_client import session_get, session_set, session_delete, session_ttl, session_list_all
from k8s_client import get_k8s_client

log = logging.getLogger(__name__)


def _pod_name(session_id: str) -> str:
    return f"bashforge-{session_id[:8]}"

def _svc_name(session_id: str) -> str:
    return f"bashforge-svc-{session_id[:8]}"


async def create_session(session_id: str) -> dict:
    """
    Create a new session:
    1. Generate ws_token
    2. Spin up K8s pod + service
    3. Store in Redis
    Returns the session dict stored in Redis.
    """
    settings   = get_settings()
    k8s        = get_k8s_client()
    # In mock mode, use the same static token the sandbox container has (WS_TOKEN env var)
    # In real mode, generate a fresh random token per pod
    import os as _os
    if _os.environ.get("MOCK_K8S", "false").lower() == "true":
        ws_token = _os.environ.get("MOCK_WS_TOKEN", "dev_token_not_secret")
    else:
        ws_token = secrets.token_hex(32)
    pod_name   = _pod_name(session_id)
    svc_name   = _svc_name(session_id)

    try:
        pod_ip = await k8s.create_pod(session_id, pod_name, svc_name, ws_token)
    except Exception as e:
        log.error("Failed to create pod for session %s: %s", session_id, e)
        raise RuntimeError(f"Failed to start container: {e}") from e

    data = {
        "session_id": session_id,
        "pod_name":   pod_name,
        "svc_name":   svc_name,
        "pod_ip":     pod_ip,
        "ws_token":   ws_token,
        "created_at": time.time(),
        "expires_at": time.time() + settings.session_ttl_seconds,
    }
    await session_set(session_id, data, settings.session_ttl_seconds)
    log.info("Session created: %s pod=%s ip=%s", session_id, pod_name, pod_ip)
    return data


async def terminate_session(session_id: str) -> None:
    """Delete pod/service and remove from Redis."""
    data = await session_get(session_id)
    if not data:
        log.debug("terminate_session: session %s not found in Redis", session_id)
        return
    k8s = get_k8s_client()
    await k8s.delete_pod(data["pod_name"], data["svc_name"])
    await session_delete(session_id)
    log.info("Session terminated: %s", session_id)


async def get_session(session_id: str) -> Optional[dict]:
    return await session_get(session_id)


async def get_session_remaining(session_id: str) -> int:
    """Returns remaining TTL in seconds."""
    return await session_ttl(session_id)


# ── Background reaper ─────────────────────────────────────────────

async def session_reaper() -> None:
    """Runs forever. Every 60 s checks for expired sessions and deletes pods."""
    log.info("Session reaper started")
    while True:
        try:
            await asyncio.sleep(60)
            ids = await session_list_all()
            for sid in ids:
                ttl_val = await session_ttl(sid)
                if ttl_val == -2:   # key gone from Redis (TTL expired)
                    # Key expired in Redis but pod might still exist
                    data = await session_get(sid)
                    if data:
                        await terminate_session(sid)
                    log.info("Reaper cleaned up expired session %s", sid)
        except asyncio.CancelledError:
            log.info("Session reaper stopping")
            break
        except Exception as e:
            log.error("Reaper error: %s", e)
