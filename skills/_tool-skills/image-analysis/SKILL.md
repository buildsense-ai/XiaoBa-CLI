---
name: image-analysis
description: "图片分析：OCR 文字识别、图表解读、多模态视觉分析。"
---

# 图片分析

提供 OCR 文字识别、图表解读等图片分析能力。

## 可用脚本

### analyze_image_tool.py - 图片分析

**调用方式**:
```bash
python3 skills/_tool-skills/image-analysis/analyze_image_tool.py '{"image_path":"path/to/image.png","task":"ocr"}'
```

**参数**:
- `image_path` (必需): 图片路径
- `task` (可选): 任务类型

**返回**: JSON 格式的分析结果

## 工作流程

1. 用户提供图片路径
2. 使用 bash 工具调用 Python 脚本
3. 解析返回结果
4. 向用户展示分析结果

## 注意

AI 模型本身支持视觉能力，可以直接分析图片。此 skill 提供额外的专业分析工具。
