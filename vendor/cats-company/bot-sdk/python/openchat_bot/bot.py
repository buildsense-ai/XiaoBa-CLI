"""Cats Company Python Bot SDK - WebSocket-based bot framework."""

import json
import logging
import threading
import time
from typing import Callable, Optional

import websocket

logger = logging.getLogger("catscompany.bot")


class Context:
    """Message context passed to handlers."""

    def __init__(self, bot: "Bot", topic: str, from_user: str, content: str, seq_id: int = 0):
        self.bot = bot
        self.topic = topic
        self.from_user = from_user
        self.content = content
        self.seq_id = seq_id

    def reply(self, text: str):
        """Reply with text to the same topic."""
        self.bot.send_message(self.topic, text)

    def reply_with_typing(self, text: str, delay: float = 0.5):
        """Send typing indicator, wait briefly, then reply."""
        self.bot.send_typing(self.topic)
        time.sleep(delay)
        self.bot.send_message(self.topic, text)


class Bot:
    """Cats Company bot that connects via WebSocket.

    Usage:
        bot = Bot("ws://localhost:6061/v0/channels", "cc_1a_abc123...")

        @bot.on_message
        def handle(ctx):
            ctx.reply("Hello!")

        bot.run()
    """

    def __init__(self, server_url: str, api_key: str):
        self.server_url = server_url
        self.api_key = api_key
        self._ws: Optional[websocket.WebSocketApp] = None
        self._message_handler: Optional[Callable] = None
        self._ready_handler: Optional[Callable] = None
        self._running = False
        self._msg_id = 0
        self._lock = threading.Lock()

    def _next_id(self) -> str:
        with self._lock:
            self._msg_id += 1
            return str(self._msg_id)

    def on_message(self, handler: Callable) -> Callable:
        """Register a message handler. Can be used as a decorator."""
        self._message_handler = handler
        return handler

    def on_ready(self, handler: Callable) -> Callable:
        """Register a ready callback. Can be used as a decorator."""
        self._ready_handler = handler
        return handler

    def send_message(self, topic: str, text: str):
        """Send a text message to a topic."""
        msg = {"pub": {"id": self._next_id(), "topic": topic, "content": text}}
        self._send(msg)

    def send_typing(self, topic: str):
        """Send a typing indicator to a topic."""
        msg = {"note": {"topic": topic, "what": "kp"}}
        self._send(msg)

    def _send(self, msg: dict):
        """Serialize and send a message over the WebSocket."""
        if self._ws:
            try:
                self._ws.send(json.dumps(msg))
            except Exception as e:
                logger.error(f"send error: {e}")

    def _do_handshake(self, ws):
        """Send {hi} handshake and wait for ctrl 200."""
        hi = {"hi": {"id": self._next_id(), "ver": "0.1.0"}}
        ws.send(json.dumps(hi))

    def _on_open(self, ws):
        """Called when WebSocket connection is established."""
        logger.info(f"connected to {self.server_url}")
        self._do_handshake(ws)

    def _on_message(self, ws, raw: str):
        """Called for each incoming WebSocket message."""
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning(f"invalid JSON: {raw[:100]}")
            return

        # Handle handshake response
        if "ctrl" in msg:
            ctrl = msg["ctrl"]
            if ctrl.get("code") == 200 and ctrl.get("params", {}).get("build") == "catscompany":
                logger.info("handshake complete")
                if self._ready_handler:
                    self._ready_handler()
            return

        # Handle data messages
        if "data" in msg:
            data = msg["data"]
            if self._message_handler:
                ctx = Context(
                    bot=self,
                    topic=data.get("topic", ""),
                    from_user=data.get("from", ""),
                    content=str(data.get("content", "")),
                    seq_id=data.get("seq", 0),
                )
                try:
                    self._message_handler(ctx)
                except Exception as e:
                    logger.error(f"handler error: {e}")

    def _on_error(self, ws, error):
        logger.error(f"websocket error: {error}")

    def _on_close(self, ws, close_status_code, close_msg):
        logger.info(f"connection closed (code={close_status_code})")
        self._running = False

    def run(self):
        """Start the bot (blocking). Reconnects on disconnect."""
        self._running = True
        url = f"{self.server_url}?api_key={self.api_key}"

        logger.info(f"bot starting, connecting to {self.server_url}")

        while self._running:
            try:
                self._ws = websocket.WebSocketApp(
                    url,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self._ws.run_forever(ping_interval=30, ping_timeout=10)
            except KeyboardInterrupt:
                logger.info("bot shutting down...")
                self._running = False
                break
            except Exception as e:
                logger.error(f"connection error: {e}")

            if self._running:
                logger.info("reconnecting in 3s...")
                time.sleep(3)

        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
        logger.info("bot stopped")
