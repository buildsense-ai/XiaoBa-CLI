"""Cats Company AI Assistant Bot - connects to OpenAI-compatible LLM APIs.

This bot uses the Cats Company Python SDK to connect via WebSocket and
responds to messages using an LLM (OpenAI-compatible API).

Environment variables:
    BOT_API_KEY   - the bot's API key (required)
    BOT_WS_URL    - WebSocket server URL (default: ws://localhost:6061/v0/channels)
    LLM_API_BASE  - LLM API base URL (default: https://api.openai.com/v1)
    LLM_API_KEY   - LLM API key
    LLM_MODEL     - model name (default: gpt-3.5-turbo)
    MAX_HISTORY   - max conversation turns to keep per topic (default: 20)
"""

import logging
import os
import sys

import requests

# Allow importing the SDK from the local source tree
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "bot-sdk", "python"))

from openchat_bot import Bot

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger("assistant")

# Configuration
API_BASE = os.getenv("LLM_API_BASE", "https://api.openai.com/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
MODEL = os.getenv("LLM_MODEL", "gpt-3.5-turbo")
MAX_HISTORY = int(os.getenv("MAX_HISTORY", "20"))

SYSTEM_PROMPT = """你是 Cats Company 的 AI 助手。你友好、有帮助、简洁。
用中文回复，除非用户使用其他语言。保持回复简短自然，像朋友聊天一样。"""

# Per-topic conversation history
conversations: dict[str, list[dict]] = {}


def get_history(topic: str) -> list[dict]:
    """Get or create conversation history for a topic."""
    if topic not in conversations:
        conversations[topic] = []
    return conversations[topic]


def add_message(topic: str, role: str, content: str):
    """Add a message to conversation history, trimming if needed."""
    history = get_history(topic)
    history.append({"role": role, "content": content})
    if len(history) > MAX_HISTORY:
        conversations[topic] = history[-MAX_HISTORY:]


def call_llm(topic: str, user_message: str) -> str:
    """Call the LLM API and return the response text."""
    add_message(topic, "user", user_message)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(get_history(topic))

    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"

    try:
        resp = requests.post(
            f"{API_BASE}/chat/completions",
            headers=headers,
            json={"model": MODEL, "messages": messages, "max_tokens": 1024},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        reply = data["choices"][0]["message"]["content"].strip()
        add_message(topic, "assistant", reply)
        return reply
    except Exception as e:
        logger.error(f"LLM call failed: {e}")
        return "抱歉，我暂时无法回复，请稍后再试。"


def main():
    api_key = os.getenv("BOT_API_KEY", "")
    if not api_key:
        logger.error("BOT_API_KEY environment variable is required")
        sys.exit(1)

    ws_url = os.getenv("BOT_WS_URL", "ws://localhost:6061/v0/channels")

    if not LLM_API_KEY:
        logger.warning("LLM_API_KEY not set - LLM calls will fail")

    bot = Bot(ws_url, api_key)

    @bot.on_ready
    def on_ready():
        logger.info("AI assistant bot is ready")
        logger.info(f"  model: {MODEL}")
        logger.info(f"  api base: {API_BASE}")

    @bot.on_message
    def on_message(ctx):
        logger.info(f"message from {ctx.from_user} in {ctx.topic}: {ctx.content}")

        # Send typing indicator while we call the LLM
        ctx.bot.send_typing(ctx.topic)

        reply = call_llm(ctx.topic, ctx.content)
        logger.info(f"reply to {ctx.topic}: {reply}")
        ctx.reply(reply)

    logger.info(f"starting AI assistant bot, server={ws_url}")
    bot.run()


if __name__ == "__main__":
    main()
