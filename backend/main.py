"""
main.py  —  FastAPI backend for BashForge
"""
import asyncio
import logging
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Cookie, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import get_settings
from redis_client import close_redis, session_get
from session_manager import (
    create_session,
    get_session,
    get_session_remaining,
    session_reaper,
    terminate_session,
)
from ws_proxy import WSProxy

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
log      = logging.getLogger(__name__)
settings = get_settings()

# ── Lifespan ─────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("BashForge backend starting (mock_k8s=%s)", settings.mock_k8s)
    reaper_task = asyncio.create_task(session_reaper())
    yield
    reaper_task.cancel()
    try:
        await reaper_task
    except asyncio.CancelledError:
        pass
    await close_redis()
    log.info("BashForge backend shut down")


app = FastAPI(title="BashForge API", version="1.0.0", lifespan=lifespan, docs_url="/api/docs")

# ── CORS ──────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helpers ───────────────────────────────────────────────────────
def _cookie_val(request: Request) -> Optional[str]:
    return request.cookies.get(settings.session_cookie_name)


def _set_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_id,
        httponly=True,
        secure=settings.secure_cookies,
        samesite="strict",
        max_age=settings.session_ttl_seconds,
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.session_cookie_name,
        path="/",
    )


# ── Health check ─────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "time": time.time()}


# ── Session create / resume ───────────────────────────────────────
@app.post("/api/sessions/create")
async def api_create_session(request: Request, response: Response):
    """
    Creates a new session (K8s pod) or resumes an existing one.
    Enforces one-session-per-browser via HttpOnly cookie.
    """
    existing_id = _cookie_val(request)

    # Try to resume
    if existing_id:
        session_data = await get_session(existing_id)
        if session_data:
            remaining = await get_session_remaining(existing_id)
            if remaining > 0:
                log.info("Resuming session %s (%ds remaining)", existing_id, remaining)
                _set_session_cookie(response, existing_id)
                return {
                    "status":     "resumed",
                    "session_id": existing_id,
                    "ttl":        remaining,
                }
            else:
                # Expired — clean up
                await terminate_session(existing_id)

    # Check global cap (50 concurrent max)
    from redis_client import session_list_all, session_ttl as get_ttl
    active = await session_list_all()
    MAX_SESSIONS = 50
    if len(active) >= MAX_SESSIONS:
        # Find the session closest to expiry to estimate wait time
        ttls = []
        for sid in active:
            t = await get_ttl(sid)
            if t > 0:
                ttls.append(t)
        min_wait = min(ttls) if ttls else 60
        raise HTTPException(
            status_code=503,
            detail=f"CAPACITY_REACHED:{len(active)}:{MAX_SESSIONS}:{min_wait}",
        )

    # Create new
    session_id = str(uuid.uuid4())
    try:
        await create_session(session_id)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    remaining = await get_session_remaining(session_id)
    _set_session_cookie(response, session_id)
    log.info("Created session %s", session_id)
    return {
        "status":     "created",
        "session_id": session_id,
        "ttl":        remaining,
    }


# ── Session status ────────────────────────────────────────────────
@app.get("/api/sessions/status")
async def api_session_status(request: Request):
    session_id = _cookie_val(request)
    if not session_id:
        raise HTTPException(status_code=401, detail="No session cookie")

    remaining = await get_session_remaining(session_id)
    if remaining <= 0:
        raise HTTPException(status_code=404, detail="Session not found or expired")

    return {"session_id": session_id, "remaining": remaining}


# ── Session terminate ─────────────────────────────────────────────
@app.delete("/api/sessions/terminate")
async def api_terminate_session(request: Request, response: Response):
    session_id = _cookie_val(request)
    if not session_id:
        return {"status": "no_session"}

    await terminate_session(session_id)
    _clear_session_cookie(response)
    log.info("User terminated session %s", session_id)
    return {"status": "terminated"}


# ── WebSocket endpoint ────────────────────────────────────────────
@app.websocket("/ws/{session_id}")
async def ws_endpoint(websocket: WebSocket, session_id: str):
    """
    WebSocket proxy: browser <-> FastAPI <-> pod bash-ws-server.
    Validates session cookie before accepting.
    """
    # Validate session cookie
    cookie_val = websocket.cookies.get(settings.session_cookie_name)
    if cookie_val != session_id:
        await websocket.close(code=4001, reason="Session mismatch")
        return

    # Look up session in Redis
    session_data = await get_session(session_id)
    if not session_data:
        await websocket.close(code=4004, reason="Session not found or expired")
        return

    await websocket.accept()
    log.info("WebSocket accepted for session %s", session_id)

    proxy = WSProxy(
        browser_ws=websocket,
        pod_ip=session_data["pod_ip"],
        session_id=session_id,
        ws_token=session_data["ws_token"],
        mock=settings.mock_k8s,
    )

    try:
        await proxy.run()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.error("WebSocket proxy error for session %s: %s", session_id, e)
    finally:
        log.info("WebSocket closed for session %s", session_id)
