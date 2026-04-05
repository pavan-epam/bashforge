import json
from typing import Any, Optional

import redis.asyncio as aioredis

from config import get_settings

_redis: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        settings = get_settings()
        _redis   = aioredis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_connect_timeout=5,
            socket_timeout=5,
        )
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis:
        await _redis.aclose()
        _redis = None


# ── Typed helpers ─────────────────────────────────────────────────

async def session_get(session_id: str) -> Optional[dict]:
    r   = await get_redis()
    raw = await r.get(f"session:{session_id}")
    if raw is None:
        return None
    return json.loads(raw)


async def session_set(session_id: str, data: dict, ttl: int) -> None:
    r = await get_redis()
    await r.setex(f"session:{session_id}", ttl, json.dumps(data))


async def session_delete(session_id: str) -> None:
    r = await get_redis()
    await r.delete(f"session:{session_id}")


async def session_ttl(session_id: str) -> int:
    """Returns remaining TTL in seconds, or -1 if not found."""
    r = await get_redis()
    return await r.ttl(f"session:{session_id}")


async def session_list_all() -> list[str]:
    """Return all session IDs (for the reaper)."""
    r    = await get_redis()
    keys = await r.keys("session:*")
    return [k.replace("session:", "") for k in keys]
