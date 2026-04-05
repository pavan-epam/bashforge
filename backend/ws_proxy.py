"""
ws_proxy.py  —  WebSocket proxy between the browser and the pod's bash-ws-server.

Binary frames:   0x01 = terminal PTY,  0x02 = script output
Text frames:     JSON control messages
"""
import asyncio
import json
import logging
import time
from typing import Optional

import websockets
from websockets.exceptions import ConnectionClosed, WebSocketException
from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

MOCK_WS_PORT = 8765
CH_TERMINAL  = 0x01
CH_SCRIPT    = 0x02
MAX_RETRIES  = 3
RETRY_DELAY  = 1.0


class WSProxy:
    def __init__(self, browser_ws: WebSocket, pod_ip: str,
                 session_id: str, ws_token: str, mock: bool = False):
        self.browser_ws = browser_ws
        self.pod_ip     = pod_ip
        self.session_id = session_id
        self.ws_token   = ws_token
        self.mock       = mock

    async def _connect_to_pod(self):
        """Connect to pod with retries. Returns websocket or raises."""
        pod_url = f"ws://{self.pod_ip}:{MOCK_WS_PORT}/ws"
        log.info("Connecting to pod at %s for session %s", pod_url, self.session_id)

        last_err = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                # ping_interval=None disables automatic pings.
                # gorilla/websocket (Go) does not auto-respond to pings
                # so Python's websockets library would close the conn after ping_timeout.
                ws = await websockets.connect(
                    pod_url,
                    max_size=4 * 1024 * 1024,
                    ping_interval=None,   # CRITICAL: disable Python→Go pings
                    close_timeout=5,
                )
                log.info("Connected to pod (attempt %d) for session %s", attempt, self.session_id)
                return ws
            except OSError as e:
                last_err = e
                log.warning("Pod connect attempt %d/%d failed: %s", attempt, MAX_RETRIES, e)
                if attempt < MAX_RETRIES:
                    await asyncio.sleep(RETRY_DELAY)

        raise ConnectionRefusedError(f"Could not connect to pod after {MAX_RETRIES} attempts: {last_err}")

    async def run(self) -> None:
        try:
            pod_ws = await self._connect_to_pod()
        except Exception as e:
            log.error("Failed to connect to pod for session %s: %s", self.session_id, e)
            await self._send_error("Could not connect to your container. Please try refreshing.")
            return

        try:
            # Authenticate with the pod immediately
            await pod_ws.send(json.dumps({"type": "auth", "token": self.ws_token}))
            log.info("Auth sent to pod for session %s", self.session_id)

            # Bridge both directions concurrently
            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(self._browser_to_pod(pod_ws)),
                    asyncio.create_task(self._pod_to_browser(pod_ws)),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            # Cancel the other task when one finishes
            for task in pending:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

        except (ConnectionClosed, WebSocketException) as e:
            log.warning("Pod WS closed for session %s: %s", self.session_id, e)
            await self._send_error("Connection to your container was lost. Please refresh.")
        except Exception as e:
            log.error("Pod WS unexpected error for session %s: %s", self.session_id, e)
            await self._send_error("An unexpected error occurred. Please refresh.")
        finally:
            try:
                await pod_ws.close()
            except Exception:
                pass

    async def _send_error(self, message: str) -> None:
        try:
            await self.browser_ws.send_text(json.dumps({"type": "error", "message": message}))
        except Exception:
            pass

    async def _browser_to_pod(self, pod_ws) -> None:
        """Forward browser → pod."""
        try:
            while True:
                msg = await self.browser_ws.receive()
                if msg["type"] == "websocket.disconnect":
                    log.info("Browser disconnected for session %s", self.session_id)
                    break

                raw_bytes = msg.get("bytes")
                raw_text  = msg.get("text")

                if raw_bytes is not None:
                    # Binary: channel-prefixed PTY input
                    await pod_ws.send(raw_bytes)

                elif raw_text is not None:
                    try:
                        data = json.loads(raw_text)
                    except json.JSONDecodeError:
                        continue

                    msg_type = data.get("type", "")

                    if msg_type == "ping":
                        await self.browser_ws.send_text(json.dumps({"type": "pong"}))
                        continue

                    # Forward all other control messages to the pod
                    if msg_type in (
                        "run_script",
                        "stop_script",
                        "resize_terminal",
                        "resize_script",
                        "file_list",
                        "file_read",
                        "file_write",
                        "file_new",
                    ):
                        await pod_ws.send(json.dumps(data))

        except WebSocketDisconnect:
            pass
        except (ConnectionClosed, WebSocketException):
            raise
        except Exception as e:
            log.debug("browser→pod ended: %s", e)

    async def _pod_to_browser(self, pod_ws) -> None:
        """Forward pod → browser."""
        try:
            async for msg in pod_ws:
                if isinstance(msg, bytes):
                    await self.browser_ws.send_bytes(msg)
                elif isinstance(msg, str):
                    await self.browser_ws.send_text(msg)
                    # Log control messages for debugging
                    try:
                        parsed = json.loads(msg)
                        if parsed.get("type") not in ("pong",):
                            log.debug("Pod→Browser control: %s", parsed.get("type"))
                    except Exception:
                        pass
        except (ConnectionClosed, WebSocketException):
            raise
        except Exception as e:
            log.debug("pod→browser ended: %s", e)