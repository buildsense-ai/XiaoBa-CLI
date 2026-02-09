"""
Analyze Image Tool - 读取图片并直接调用多模态模型分析，返回纯文字结果。
合并 read_media + vision_chat，base64 数据不会进入主 Agent 对话历史。
"""

import base64
import mimetypes
import os
import re
import sys
from typing import Any, Dict, List

import requests

from utils.base_tool import BaseTool


def _resolve_vision_config() -> Dict[str, str]:
    provider = (os.getenv("GAUZ_VISION_PROVIDER") or "").strip()
    api_base = (os.getenv("GAUZ_VISION_API_BASE") or "").strip()
    api_key = (os.getenv("GAUZ_VISION_API_KEY") or "").strip()
    model = (os.getenv("GAUZ_VISION_MODEL") or "").strip()

    if not all([provider, api_base, api_key, model]):
        raise ValueError(
            "多模态模型未配置，请设置 GAUZ_VISION_PROVIDER / GAUZ_VISION_API_BASE / GAUZ_VISION_API_KEY / GAUZ_VISION_MODEL"
        )

    return {"provider": provider, "api_base": api_base, "api_key": api_key, "model": model}


def _read_image_as_data_url(file_path: str, max_bytes: int = 8 * 1024 * 1024) -> Dict[str, str]:
    if not os.path.isabs(file_path):
        file_path = os.path.join(os.getcwd(), file_path)

    if not os.path.exists(file_path):
        raise ValueError(f"文件不存在: {file_path}")

    size_bytes = os.path.getsize(file_path)
    if size_bytes > max_bytes:
        raise ValueError(f"文件过大: {size_bytes} bytes, 超过限制 {max_bytes} bytes")

    mime_type, _ = mimetypes.guess_type(file_path)
    if not mime_type or not mime_type.startswith("image/"):
        raise ValueError(f"不支持的图片类型: {mime_type or 'unknown'}")

    with open(file_path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")

    return {"mime": mime_type, "data": data, "size_bytes": size_bytes}


def _parse_data_url(data_url: str) -> Dict[str, str]:
    match = re.match(r"^data:(.+?);base64,(.+)$", data_url)
    if match:
        return {"mime": match.group(1), "data": match.group(2)}
    fallback_mime = os.getenv("GAUZ_VISION_DEFAULT_MIME", "image/png")
    return {"mime": fallback_mime, "data": data_url}


class AnalyzeImageTool(BaseTool):
    """读取图片并调用多模态模型分析，只返回文字结果"""

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ["file_path", "prompt"])

        file_path = params["file_path"]
        prompt = params["prompt"]
        detail = params.get("detail", "auto")
        max_tokens = int(params.get("max_tokens", 2048))
        system = params.get("system")

        # 1) 读取图片为 base64（不返回给主 Agent）
        print(f"[analyze_image] 读取图片: {file_path}", file=sys.stderr)
        img = _read_image_as_data_url(file_path)
        data_url = f"data:{img['mime']};base64,{img['data']}"
        print(f"[analyze_image] 图片大小: {img['size_bytes']} bytes, 类型: {img['mime']}", file=sys.stderr)

        # 2) 调用多模态模型
        cfg = _resolve_vision_config()
        provider = cfg["provider"].lower()
        print(f"[analyze_image] 调用 {provider} 模型: {cfg['model']}", file=sys.stderr)

        if provider == "anthropic":
            content = self._call_anthropic(cfg, prompt, data_url, max_tokens, system)
        else:
            content = self._call_openai(cfg, prompt, data_url, detail, max_tokens, system)

        print(f"[analyze_image] 分析完成，结果长度: {len(content)} 字符", file=sys.stderr)

        # 3) 只返回文字结果，不返回 base64
        return {
            "file_path": file_path,
            "mime_type": img["mime"],
            "size_bytes": img["size_bytes"],
            "analysis": content,
        }

    def _call_openai(
        self, cfg: Dict[str, str], prompt: str, data_url: str, detail: str, max_tokens: int, system: str = None
    ) -> str:
        api_url = cfg["api_base"].rstrip("/")
        if not api_url.endswith("/v1/chat/completions"):
            api_url = f"{api_url}/v1/chat/completions"

        content_blocks: List[Dict[str, Any]] = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_url, "detail": detail}},
        ]

        messages: List[Dict[str, Any]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": content_blocks})

        resp = requests.post(
            api_url,
            json={"model": cfg["model"], "messages": messages, "max_tokens": max_tokens},
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg['api_key']}"},
            timeout=90,
        )
        resp.raise_for_status()
        data = resp.json()
        return (data.get("choices") or [{}])[0].get("message", {}).get("content", "")

    def _call_anthropic(
        self, cfg: Dict[str, str], prompt: str, data_url: str, max_tokens: int, system: str = None
    ) -> str:
        api_url = cfg["api_base"].rstrip("/")
        if not api_url.endswith("/v1/messages"):
            api_url = f"{api_url}/v1/messages"

        parsed = _parse_data_url(data_url)
        content_blocks: List[Dict[str, Any]] = [
            {"type": "text", "text": prompt},
            {"type": "image", "source": {"type": "base64", "media_type": parsed["mime"], "data": parsed["data"]}},
        ]

        payload: Dict[str, Any] = {
            "model": cfg["model"],
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": content_blocks}],
        }
        if system:
            payload["system"] = system

        resp = requests.post(
            api_url,
            json=payload,
            headers={"Content-Type": "application/json", "x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01"},
            timeout=90,
        )
        resp.raise_for_status()
        data = resp.json()
        for block in data.get("content") or []:
            if block.get("type") == "text":
                return block.get("text", "")
        return ""


if __name__ == "__main__":
    AnalyzeImageTool().run()
