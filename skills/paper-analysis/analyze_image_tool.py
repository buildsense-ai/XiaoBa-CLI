"""
Analyze Image Tool - 读取图片并直接调用多模态模型分析，返回纯文字结果。
合并 read_media + vision_chat，base64 数据不会进入主 Agent 对话历史。
"""

import base64
import mimetypes
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional

import requests

from base_tool import BaseTool

RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504, 529}
FAILOVER_STATUS_CODES = {401, 403}
MAX_BACKUP_SLOTS = 5


def _normalize_provider(provider: str) -> str:
    normalized = provider.strip().lower()
    if normalized in ("openai", "anthropic"):
        return normalized
    raise ValueError(f"不支持的 provider: {provider}，仅支持 openai/anthropic")


def _auto_detect_provider(api_base: str, model: str) -> str:
    url = (api_base or "").lower()
    model_name = (model or "").lower()
    if "anthropic" in url or "claude" in url or "claude" in model_name:
        return "anthropic"
    return "openai"


def _read_vision_env(prefix: str) -> Dict[str, Any]:
    provider = (os.getenv(f"{prefix}PROVIDER") or "").strip()
    api_base = (os.getenv(f"{prefix}API_BASE") or "").strip()
    api_key = (os.getenv(f"{prefix}API_KEY") or "").strip()
    model = (os.getenv(f"{prefix}MODEL") or "").strip()
    has_any = any([provider, api_base, api_key, model])

    return {
        "has_any": has_any,
        "provider": provider,
        "api_base": api_base,
        "api_key": api_key,
        "model": model,
    }


def _to_vision_config(raw: Dict[str, Any], label: str) -> Optional[Dict[str, str]]:
    if not raw["has_any"]:
        return None

    api_base = raw["api_base"]
    api_key = raw["api_key"]
    model = raw["model"]
    provider_raw = raw["provider"]

    if not all([api_base, api_key, model]):
        print(
            f"[analyze_image] 跳过 {label}：配置不完整（需要 API_BASE/API_KEY/MODEL）",
            file=sys.stderr,
        )
        return None

    provider = _normalize_provider(provider_raw) if provider_raw else _auto_detect_provider(api_base, model)
    return {
        "label": label,
        "provider": provider,
        "api_base": api_base,
        "api_key": api_key,
        "model": model,
    }


def _resolve_vision_configs() -> List[Dict[str, str]]:
    primary_raw = _read_vision_env("GAUZ_VISION_")
    primary = _to_vision_config(primary_raw, "primary")
    if primary is None:
        raise ValueError(
            "多模态模型未配置，请设置 GAUZ_VISION_PROVIDER / GAUZ_VISION_API_BASE / GAUZ_VISION_API_KEY / GAUZ_VISION_MODEL"
        )

    configs: List[Dict[str, str]] = [primary]

    slot1_raw = _read_vision_env("GAUZ_VISION_BACKUP_1_")
    has_slot1 = slot1_raw["has_any"]
    alias_raw = _read_vision_env("GAUZ_VISION_BACKUP_")

    if not has_slot1 and alias_raw["has_any"]:
        alias_cfg = _to_vision_config(alias_raw, "backup-1")
        if alias_cfg:
            configs.append(alias_cfg)

    for idx in range(1, MAX_BACKUP_SLOTS + 1):
        raw = _read_vision_env(f"GAUZ_VISION_BACKUP_{idx}_")
        if not raw["has_any"]:
            continue
        cfg = _to_vision_config(raw, f"backup-{idx}")
        if cfg:
            configs.append(cfg)

    return configs


def _extract_status(error: Exception) -> Optional[int]:
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    status = getattr(error, "status", None)
    if isinstance(status, int):
        return status
    return None


def _is_retryable(error: Exception) -> bool:
    status = _extract_status(error)
    if status and status in RETRYABLE_STATUS_CODES:
        return True
    return isinstance(error, requests.RequestException)


def _is_failover_eligible(error: Exception) -> bool:
    if _is_retryable(error):
        return True
    status = _extract_status(error)
    if status and status in FAILOVER_STATUS_CODES:
        return True
    return os.getenv("GAUZ_VISION_FAILOVER_ON_ANY_ERROR", "false").lower() == "true"


def _summarize_error(error: Exception) -> str:
    status = _extract_status(error)
    if status:
        return f"HTTP {status}"
    return str(error)


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
        cfg_chain = _resolve_vision_configs()
        if len(cfg_chain) > 1:
            hops = " -> ".join(
                [f"{cfg['label']}:{cfg['provider']}/{cfg['model']}" for cfg in cfg_chain]
            )
            print(f"[analyze_image] 已启用视觉主备链路: {hops}", file=sys.stderr)

        content = self._call_with_failover(cfg_chain, prompt, data_url, detail, max_tokens, system)

        print(f"[analyze_image] 分析完成，结果长度: {len(content)} 字符", file=sys.stderr)

        # 3) 只返回文字结果，不返回 base64
        return {
            "file_path": file_path,
            "mime_type": img["mime"],
            "size_bytes": img["size_bytes"],
            "analysis": content,
        }

    def _call_with_failover(
        self,
        cfg_chain: List[Dict[str, str]],
        prompt: str,
        data_url: str,
        detail: str,
        max_tokens: int,
        system: str = None,
    ) -> str:
        last_error: Optional[Exception] = None

        for index, cfg in enumerate(cfg_chain):
            provider = cfg["provider"]
            print(
                f"[analyze_image] 调用 {provider} 模型: {cfg['model']} ({cfg['label']} {index + 1}/{len(cfg_chain)})",
                file=sys.stderr,
            )

            try:
                if provider == "anthropic":
                    return self._with_retry(lambda: self._call_anthropic(cfg, prompt, data_url, max_tokens, system))
                return self._with_retry(
                    lambda: self._call_openai(cfg, prompt, data_url, detail, max_tokens, system)
                )
            except Exception as error:
                last_error = error
                has_next = index < len(cfg_chain) - 1
                if has_next and _is_failover_eligible(error):
                    next_cfg = cfg_chain[index + 1]
                    print(
                        f"[analyze_image] 当前模型失败，切换备模型: {cfg['label']} -> {next_cfg['label']} | 原因: {_summarize_error(error)}",
                        file=sys.stderr,
                    )
                    continue
                raise

        if last_error:
            raise last_error
        raise RuntimeError("视觉模型调用失败：无可用配置")

    def _with_retry(self, fn):
        max_retries = int(os.getenv("GAUZ_VISION_RETRY_MAX", "2"))
        base_delay_sec = float(os.getenv("GAUZ_VISION_RETRY_BASE_SECONDS", "1"))
        last_error: Optional[Exception] = None

        for attempt in range(max_retries + 1):
            try:
                return fn()
            except Exception as error:
                last_error = error
                if attempt >= max_retries or not _is_retryable(error):
                    raise

                delay = base_delay_sec * (2**attempt)
                print(
                    f"[analyze_image] 请求失败，{delay:.1f}s 后重试 ({attempt + 1}/{max_retries}) | 原因: {_summarize_error(error)}",
                    file=sys.stderr,
                )
                time.sleep(delay)

        if last_error:
            raise last_error
        raise RuntimeError("视觉模型重试失败：未知错误")

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
