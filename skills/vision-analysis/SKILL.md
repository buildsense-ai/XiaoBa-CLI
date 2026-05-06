---
name: vision-analysis
description: 图片和截图读取兜底技能。当前主模型无法可靠读取截图、扫描图或其他图片附件时使用。它会调用 Cats reader proxy 提取可见文本和结构，再让主模型继续回答。
category: tools
invocable: both
argument-hint: "<file_path_or_url> [analysis_prompt]"
max-turns: 8
---

# Vision Analysis

这是图片/截图场景的兼容入口。它保留 `vision-analysis` 这个直观名字，但底层会复用 `advanced-reader` 的共享 reader proxy 实现。

它的职责是：

1. 把图片发送到 Cats 后端的 `POST /api/reader/analyze` 代理接口。
2. 返回图片中的可见文字、基础布局和必要结构。
3. 让 XiaoBa 的主模型基于读取结果继续推理和最终回答。

## 核心规则

- 优先做忠实读取，不要猜。
- 接受本地图片路径或远程图片 URL。
- 如果有可见文字，先提取文字。
- 对模糊、太小、被截断、不确定的文字，标记为 `[unclear]`。
- 不要推断文档类型、业务场景、应用名称或缺失文字，除非图片里明确可见。
- 如果当前模型不能直接查看图片，应该使用这个技能，而不是直接说“看不到图片”。
- 除非用户明确要原始提取结果，否则不要把技能结果当最终回答。

## 调用方式

```bash
python "<SKILL_DIR>/scripts/invoke_reader_api.py" "<file_path_or_url>" "<analysis_prompt>"
```

脚本会读取这些环境变量：

- `CATSCOMPANY_HTTP_BASE_URL`
- `CATSCOMPANY_API_KEY`
- 可选：`CATSCOMPANY_READER_API_URL`
- 可选覆盖：`READER_PROXY_URL`
- 可选覆盖：`READER_PROXY_API_KEY`
- 可选覆盖：`READER_PROXY_BEARER_TOKEN`

这个技能不会直连上游大模型。Cats 后端负责服务间转发、鉴权和上游签名。

## 推荐 Prompt

- 保守读图：
  `Read this image conservatively and do not guess. Extract all visible text in reading order. If any text is uncertain, write [unclear]. Do not infer the document type or purpose.`
- 截图读取：
  `Extract the visible text, UI labels, error messages, and layout from this screenshot. Mark unclear text as [unclear]. Do not diagnose yet.`
- OCR 风格读取：
  `Read all visible text from this image and keep the original order and hierarchy as much as possible. Do not infer missing words.`

## 什么时候使用

- 用户上传截图并问里面写了什么。
- 用户上传图片、扫描图、课程图、报错截图，需要读取可见内容。
- 用户问题依赖图片内容，而当前主模型无法可靠读取。

## 什么时候不要使用

- 用户问题不依赖图片内容。
- 用户已经把图片里的关键文字贴出来了。
- 当前模型已经可靠读懂图片。
- 用户要的是常识解释，而不是读取图片内容。

## 实现说明

这个脚本只是兼容 wrapper，会转调：

```text
skills/advanced-reader/scripts/invoke_reader_api.py
```

这样图片入口和通用附件入口都保留，但 reader proxy 鉴权、上传和错误处理只维护一份。
