---
name: image-analysis
description: "图片分析：读取图片文件并调用多模态视觉模型进行分析。适用于图片内容识别、OCR、图表解读等场景。"
additional-tools: [analyze_image]
---

# 图片分析

读取图片文件并调用多模态视觉模型（OpenAI/Anthropic）进行分析，返回纯文字结果。

## 可用工具

| 工具 | 用途 |
|------|------|
| `analyze_image` | 图片多模态分析 |

## 使用场景

- 识别图片内容、物体、场景
- OCR 文字识别
- 图表、图形解读
- 截图内容分析

## analyze_image 用法

```json
{
  "file_path": "<图片路径>",
  "prompt": "<分析提示词>",
  "detail": "auto",
  "max_tokens": 2048
}
```

参数说明：
- `file_path`（必需）：图片文件路径（支持绝对路径和相对路径）
- `prompt`（必需）：分析提示词，描述你希望模型关注的内容
- `detail`（可选）：图片分析精度，可选 auto / low / high，默认 auto
- `max_tokens`（可选）：最大输出 token 数，默认 2048
- `system`（可选）：系统提示词

## 示例

识别图片内容：
```json
{
  "file_path": "screenshot.png",
  "prompt": "请描述这张图片的内容"
}
```

OCR 文字识别：
```json
{
  "file_path": "document.jpg",
  "prompt": "请提取图片中的所有文字"
}
```

图表解读：
```json
{
  "file_path": "chart.png",
  "prompt": "请分析这个图表，说明数据趋势和关键发现"
}
```
