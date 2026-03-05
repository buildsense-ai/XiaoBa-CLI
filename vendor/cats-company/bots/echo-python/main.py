"""Echo Bot - a minimal Cats Company bot example using the Python SDK.

This bot echoes back every message it receives, prefixed with "Echo: ".
It demonstrates the basic Bot SDK usage: connect, handle messages, reply.

Environment variables:
    BOT_API_KEY  - the bot's API key (required, format: cc_{hex_uid}_{random})
    BOT_WS_URL   - WebSocket server URL (default: ws://localhost:6061/v0/channels)
"""

import logging
import os
import sys

# Allow importing the SDK from the local source tree
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "bot-sdk", "python"))

from openchat_bot import Bot

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger("echo-bot")


def main():
    api_key = os.getenv("BOT_API_KEY", "")
    if not api_key:
        logger.error("BOT_API_KEY environment variable is required")
        sys.exit(1)

    ws_url = os.getenv("BOT_WS_URL", "ws://localhost:6061/v0/channels")

    bot = Bot(ws_url, api_key)

    @bot.on_ready
    def on_ready():
        logger.info("Echo bot is ready and listening for messages")

    @bot.on_message
    def on_message(ctx):
        reply = f"Echo: {ctx.content}"
        ctx.reply_with_typing(reply)

    logger.info(f"starting echo bot, server={ws_url}")
    bot.run()


if __name__ == "__main__":
    main()
