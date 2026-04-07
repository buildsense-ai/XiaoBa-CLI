---
name: vision-analysis
description: 图片视觉分析技能。当主模型不支持多模态时，用于分析图片内容。
invocable: both
argument-hint: "<图片路径> [分析需求描述]"
max-turns: 5
---

# 图片视觉分析（Vision Analysis）

当主模型不支持多模态图片识别时，使用此技能分析图片内容。

## 硬规则

1. **配置优先**：每次执行前必须检查配置是否完整
2. **缺失配置时**：返回明确的缺失信息列表，不要执行读图
3. **环境隔离**：不使用任何环境变量，配置全部来自 SKILL.md 的 config 参数
4. **错误处理**：读图失败时返回清晰错误信息

## 分步执行流程

### Step 1：检查配置

检查 config 是否包含以下必填项：

| 配置项 | 说明 | 检查方式 |
|--------|------|----------|
| provider | 模型提供商 | `anthropic` / `openai` |
| api_key | API Key | 非空字符串 |
| model | 模型名称 | 非空字符串 |

如果缺少任何必填项，立即返回：
```json
{
  "status": "config_incomplete",
  "missing": ["api_key", "model"]
}
```

### Step 2：执行读图（如配置完整）

1. 读取图片文件
2. 压缩为适合 API 的格式
3. 调用视觉模型分析

### Step 3：返回结果

成功时：
```json
{
  "status": "success",
  "analysis": "图片分析内容...",
  "model_used": "claude-3-5-sonnet-20240620"
}
```

失败时：
```json
{
  "status": "error",
  "error": "错误原因"
}
```

## 配置参数说明

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| provider | 是 | - | 模型提供商：`anthropic` 或 `openai` |
| api_key | 是 | - | API Key（不要用环境变量） |
| model | 是 | - | 视觉模型名称 |
| base_url | 否 | 官方默认 | API 端点 |
| analysis_prompt | 否 | 请详细描述这张图片 | 分析提示词 |
| max_tokens | 否 | 1024 | 最大返回 token 数 |

## 使用示例

```
/vision-analysis /path/to/image.png
/vision-analysis /path/to/image.png 分析这张截图的功能
```
