---
name: advanced-reader
description: 图片读取兜底技能。仅当用户需要读取图片、截图或扫描图，而当前主模型无法可靠理解图片内容时使用。它会调用 Cats reader proxy 提取可见内容，再让主模型继续回答。
category: tools
invocable: both
argument-hint: "<file_path_or_url> [analysis_prompt]"
max-turns: 8
---

# Advanced Reader

这是一个保守的图片读取兜底技能，用于“必须看图才能回答”的场景。

它的职责很窄：

1. 把图片发送到 Cats 后端的 `POST /api/reader/analyze` 代理接口。
2. 返回图片中的可见文字、版面结构或必要的图像理解结果。
3. 让 XiaoBa 的主模型基于读取结果继续推理和最终回答。

## 核心规则

- 如果不读取图片也能回答，不要调用这个技能。
- 不要根据文件名、路径、缩略图猜内容。
- 把这个技能当作“读取器”，不要把它当成最终回答生成器。
- 优先做提取，不要主动做诊断、推断、总结背景。
- 不要用这个技能读取普通文档、表格或演示文件；文档附件后续应由单独的文档读取技能处理。
- 如果接口失败，说明图片解析失败，并请用户重试或补充文本上下文。

## 默认调用

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

默认接口地址是：

```text
https://app.catsco.cc/api/reader
```

这个技能不会直连上游大模型。Cats 后端负责服务间转发、鉴权和上游签名。

## 推荐 Prompt

- 截图读取：
  `Extract the visible text, UI labels, error messages, and layout from this screenshot. Do not diagnose yet.`
- OCR 风格读取：
  `Read all visible text from this image and keep the original order and hierarchy as much as possible.`

## 什么时候使用

- 用户问图片、截图、扫描件里写了什么。
- 用户要求读取 OCR 类图片或截图文字。
- 回答依赖图片内容，而当前主模型无法可靠读取图片。

## 什么时候不要使用

- 用户问题是纯文本问题，不依赖图片。
- 用户已经把关键内容贴到对话里。
- 当前模型已经成功读取图片。
- 用户只问不需要打开文件的元信息问题。
- 用户上传的是普通文档、表格或演示文件，而不是图片或截图。

## 处理流程

1. 找到本地图片路径或远程图片 URL。
2. 构造偏“提取”的 prompt，而不是偏“解释/推断”的 prompt。
3. 调用 helper 脚本。
4. 读取接口返回结果。
5. 把读取结果作为图片上下文，交给主模型继续回答。

## 输出规则

- 把 API 结果当作“图片上下文”，不是天然最终答案。
- 除非用户明确要原始提取结果，否则不要直接把 API 输出当最终回答。
- 如果确实需要读图片，不要在尝试这个兜底前说“我看不到图片”。

## 实现说明

`vision-analysis` 是图片/截图场景的兼容入口，但它会转调本技能的同一份脚本。

因此鉴权、上传、reader proxy、错误处理都集中维护在：

```text
skills/advanced-reader/scripts/invoke_reader_api.py
```
