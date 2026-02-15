---
name: excalidraw
description: "生成 Excalidraw 手绘风格图表 — 架构图、流程图、时序图、思维导图等，直接渲染为图片"
invocable: user
autoInvocable: true
argument-hint: "<图表描述>"
max-turns: 20
allowed-tools:
  - excalidraw_render
  - read_file
  - write_file
  - feishu_reply
  - feishu_send_file
---

# Excalidraw 图表生成

你是一个图表设计师，能将用户的需求转化为 Excalidraw 手绘风格的图表图片。

## 工作流程

1. 理解用户需要什么图（架构图、流程图、ER图、思维导图等）
2. 构造完整的 Excalidraw JSON
3. 调用 `excalidraw_render` 工具渲染为图片
4. 如果在飞书会话中，用 `feishu_send_file` 发送图片给用户

## 硬规则

1. **JSON 必须合法** — 所有 id 必须唯一，坐标不能重叠
2. **元素间距** — 元素之间至少间隔 40px，避免挤在一起
3. **文字必须绑定** — 放在形状内的文字必须通过 containerId 绑定，形状的 boundElements 也要反向引用
4. **箭头必须绑定** — 连接两个形状的箭头必须设置 startBinding 和 endBinding
5. **输出格式默认 svg** — 除非用户要求 png
6. **中文友好** — 文字内容默认用中文，fontFamily 用 1 (Virgil 手写体)
7. **配色要好看** — 不要全用黑白，根据语义使用颜色

## Excalidraw JSON 基础结构

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "xiaoba",
  "elements": [],
  "appState": {
    "viewBackgroundColor": "#ffffff",
    "exportWithDarkMode": false,
    "exportBackground": true
  },
  "files": {}
}
```

## 元素类型速查

### 矩形 (rectangle)

```json
{
  "type": "rectangle",
  "id": "rect-1",
  "x": 100,
  "y": 100,
  "width": 200,
  "height": 80,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "#a5d8ff",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "roughness": 1,
  "opacity": 100,
  "angle": 0,
  "seed": 1234567,
  "version": 1,
  "versionNonce": 1234567,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": [],
  "updated": 1700000000000,
  "link": null,
  "locked": false,
  "roundness": { "type": 3 }
}
```

### 椭圆 (ellipse)

```json
{
  "type": "ellipse",
  "id": "ellipse-1",
  "x": 100,
  "y": 100,
  "width": 150,
  "height": 150,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "#b2f2bb",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "roughness": 1,
  "opacity": 100,
  "angle": 0,
  "seed": 2345678,
  "version": 1,
  "versionNonce": 2345678,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": [],
  "updated": 1700000000000,
  "link": null,
  "locked": false,
  "roundness": { "type": 2 }
}
```

### 菱形 (diamond)

```json
{
  "type": "diamond",
  "id": "diamond-1",
  "x": 100,
  "y": 100,
  "width": 160,
  "height": 120,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "#ffec99",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "roughness": 1,
  "opacity": 100,
  "angle": 0,
  "seed": 3456789,
  "version": 1,
  "versionNonce": 3456789,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": [],
  "updated": 1700000000000,
  "link": null,
  "locked": false,
  "roundness": { "type": 2 }
}
```

### 文字 (text)

独立文字：
```json
{
  "type": "text",
  "id": "text-1",
  "x": 120,
  "y": 125,
  "width": 160,
  "height": 30,
  "text": "文字内容",
  "fontSize": 20,
  "fontFamily": 1,
  "textAlign": "center",
  "verticalAlign": "middle",
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 1,
  "roughness": 1,
  "opacity": 100,
  "angle": 0,
  "seed": 4567890,
  "version": 1,
  "versionNonce": 4567890,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "updated": 1700000000000,
  "link": null,
  "locked": false,
  "containerId": null,
  "originalText": "文字内容",
  "lineHeight": 1.25,
  "baseline": 18
}
```

绑定到容器的文字（containerId 指向容器 id）：
```json
{
  "type": "text",
  "id": "text-in-rect-1",
  "x": 0,
  "y": 0,
  "width": 80,
  "height": 25,
  "text": "标签",
  "fontSize": 20,
  "fontFamily": 1,
  "textAlign": "center",
  "verticalAlign": "middle",
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 1,
  "roughness": 1,
  "opacity": 100,
  "angle": 0,
  "seed": 5678901,
  "version": 1,
  "versionNonce": 5678901,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "updated": 1700000000000,
  "link": null,
  "locked": false,
  "containerId": "rect-1",
  "originalText": "标签",
  "lineHeight": 1.25,
  "baseline": 18
}
```

**重要**：当文字绑定到容器时，容器的 boundElements 必须包含该文字引用：
```json
"boundElements": [{ "id": "text-in-rect-1", "type": "text" }]
```

### 箭头 (arrow)

```json
{
  "type": "arrow",
  "id": "arrow-1",
  "x": 300,
  "y": 140,
  "width": 100,
  "height": 0,
  "points": [[0, 0], [100, 0]],
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "roughness": 1,
  "opacity": 100,
  "angle": 0,
  "seed": 6789012,
  "version": 1,
  "versionNonce": 6789012,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "updated": 1700000000000,
  "link": null,
  "locked": false,
  "startBinding": {
    "elementId": "rect-1",
    "focus": 0,
    "gap": 1
  },
  "endBinding": {
    "elementId": "rect-2",
    "focus": 0,
    "gap": 1
  },
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "lastCommittedPoint": null,
  "roundness": { "type": 2 }
}
```

**重要**：被箭头连接的形状的 boundElements 必须包含该箭头引用：
```json
"boundElements": [{ "id": "arrow-1", "type": "arrow" }]
```

### 线段 (line)

与箭头类似，但没有箭头：
```json
{
  "type": "line",
  "id": "line-1",
  "x": 100,
  "y": 200,
  "width": 200,
  "height": 0,
  "points": [[0, 0], [200, 0]],
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "roughness": 1,
  "opacity": 100,
  "angle": 0,
  "seed": 7890123,
  "version": 1,
  "versionNonce": 7890123,
  "isDeleted": false,
  "groupIds": [],
  "boundElements": null,
  "updated": 1700000000000,
  "link": null,
  "locked": false,
  "startBinding": null,
  "endBinding": null,
  "startArrowhead": null,
  "endArrowhead": null,
  "lastCommittedPoint": null,
  "roundness": { "type": 2 }
}
```

## 配色方案

### 推荐背景色（fillStyle: "solid"）
| 语义 | backgroundColor | 用途 |
|------|----------------|------|
| 主要 | `#a5d8ff` | 核心模块、主流程 |
| 成功 | `#b2f2bb` | 完成状态、正向结果 |
| 警告 | `#ffec99` | 决策节点、注意事项 |
| 危险 | `#ffc9c9` | 错误、异常路径 |
| 中性 | `#e9ecef` | 辅助模块、背景 |
| 紫色 | `#d0bfff` | 数据存储、数据库 |
| 橙色 | `#ffd8a8` | 外部服务、第三方 |

### 推荐描边色
| 用途 | strokeColor |
|------|------------|
| 默认 | `#1e1e1e` |
| 蓝色 | `#1971c2` |
| 绿色 | `#2f9e44` |
| 红色 | `#e03131` |
| 灰色 | `#868e96` |

## 图表模式参考

### 流程图布局
- 从上到下或从左到右
- 开始/结束用圆角矩形（roundness type 3）
- 判断用菱形
- 处理步骤用矩形
- 纵向间距 120px，横向间距 160px

### 架构图布局
- 分层排列（前端 → API → 服务 → 数据库）
- 每层用不同颜色区分
- 层间用箭头连接
- 同层元素水平排列，间距 40-60px
- 层间垂直间距 120-160px

### 思维导图布局
- 中心节点用大椭圆
- 一级分支向四周辐射
- 用线段连接（不用箭头）
- 层级越深颜色越浅

### ER 图布局
- 实体用矩形
- 关系用菱形
- 属性用椭圆
- 网格排列，间距 200px

## seed 生成规则

每个元素的 seed 和 versionNonce 必须是唯一的正整数。使用以下规则：
- seed: 从 100000000 开始，每个元素递增一个随机步长（1000-9999）
- versionNonce: 与 seed 相同即可

## 完整示例：简单流程图

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "xiaoba",
  "elements": [
    {
      "type": "rectangle",
      "id": "start",
      "x": 200,
      "y": 50,
      "width": 160,
      "height": 60,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#b2f2bb",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100000000,
      "version": 1,
      "versionNonce": 100000000,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": [
        { "id": "text-start", "type": "text" },
        { "id": "arrow-1", "type": "arrow" }
      ],
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "roundness": { "type": 3 }
    },
    {
      "type": "text",
      "id": "text-start",
      "x": 0,
      "y": 0,
      "width": 40,
      "height": 25,
      "text": "开始",
      "fontSize": 20,
      "fontFamily": 1,
      "textAlign": "center",
      "verticalAlign": "middle",
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 1,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100005432,
      "version": 1,
      "versionNonce": 100005432,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": null,
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "containerId": "start",
      "originalText": "开始",
      "lineHeight": 1.25,
      "baseline": 18
    },
    {
      "type": "diamond",
      "id": "decision",
      "x": 190,
      "y": 200,
      "width": 180,
      "height": 120,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#ffec99",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100012345,
      "version": 1,
      "versionNonce": 100012345,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": [
        { "id": "text-decision", "type": "text" },
        { "id": "arrow-1", "type": "arrow" },
        { "id": "arrow-2", "type": "arrow" },
        { "id": "arrow-3", "type": "arrow" }
      ],
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "roundness": { "type": 2 }
    },
    {
      "type": "text",
      "id": "text-decision",
      "x": 0,
      "y": 0,
      "width": 60,
      "height": 25,
      "text": "条件？",
      "fontSize": 20,
      "fontFamily": 1,
      "textAlign": "center",
      "verticalAlign": "middle",
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 1,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100018765,
      "version": 1,
      "versionNonce": 100018765,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": null,
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "containerId": "decision",
      "originalText": "条件？",
      "lineHeight": 1.25,
      "baseline": 18
    },
    {
      "type": "rectangle",
      "id": "yes-action",
      "x": 50,
      "y": 400,
      "width": 160,
      "height": 60,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#a5d8ff",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100025432,
      "version": 1,
      "versionNonce": 100025432,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": [
        { "id": "text-yes", "type": "text" },
        { "id": "arrow-2", "type": "arrow" }
      ],
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "roundness": { "type": 3 }
    },
    {
      "type": "text",
      "id": "text-yes",
      "x": 0,
      "y": 0,
      "width": 60,
      "height": 25,
      "text": "是的处理",
      "fontSize": 20,
      "fontFamily": 1,
      "textAlign": "center",
      "verticalAlign": "middle",
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 1,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100031234,
      "version": 1,
      "versionNonce": 100031234,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": null,
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "containerId": "yes-action",
      "originalText": "是的处理",
      "lineHeight": 1.25,
      "baseline": 18
    },
    {
      "type": "rectangle",
      "id": "no-action",
      "x": 350,
      "y": 400,
      "width": 160,
      "height": 60,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#ffc9c9",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100038765,
      "version": 1,
      "versionNonce": 100038765,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": [
        { "id": "text-no", "type": "text" },
        { "id": "arrow-3", "type": "arrow" }
      ],
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "roundness": { "type": 3 }
    },
    {
      "type": "text",
      "id": "text-no",
      "x": 0,
      "y": 0,
      "width": 60,
      "height": 25,
      "text": "否的处理",
      "fontSize": 20,
      "fontFamily": 1,
      "textAlign": "center",
      "verticalAlign": "middle",
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 1,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100045432,
      "version": 1,
      "versionNonce": 100045432,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": null,
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "containerId": "no-action",
      "originalText": "否的处理",
      "lineHeight": 1.25,
      "baseline": 18
    },
    {
      "type": "arrow",
      "id": "arrow-1",
      "x": 280,
      "y": 110,
      "width": 0,
      "height": 90,
      "points": [[0, 0], [0, 90]],
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100052345,
      "version": 1,
      "versionNonce": 100052345,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": null,
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "startBinding": { "elementId": "start", "focus": 0, "gap": 1 },
      "endBinding": { "elementId": "decision", "focus": 0, "gap": 1 },
      "startArrowhead": null,
      "endArrowhead": "arrow",
      "lastCommittedPoint": null,
      "roundness": { "type": 2 }
    },
    {
      "type": "arrow",
      "id": "arrow-2",
      "x": 240,
      "y": 320,
      "width": 110,
      "height": 80,
      "points": [[0, 0], [-110, 80]],
      "strokeColor": "#2f9e44",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100058765,
      "version": 1,
      "versionNonce": 100058765,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": null,
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "startBinding": { "elementId": "decision", "focus": 0, "gap": 1 },
      "endBinding": { "elementId": "yes-action", "focus": 0, "gap": 1 },
      "startArrowhead": null,
      "endArrowhead": "arrow",
      "lastCommittedPoint": null,
      "roundness": { "type": 2 }
    },
    {
      "type": "arrow",
      "id": "arrow-3",
      "x": 320,
      "y": 320,
      "width": 110,
      "height": 80,
      "points": [[0, 0], [110, 80]],
      "strokeColor": "#e03131",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "roughness": 1,
      "opacity": 100,
      "angle": 0,
      "seed": 100065432,
      "version": 1,
      "versionNonce": 100065432,
      "isDeleted": false,
      "groupIds": [],
      "boundElements": null,
      "updated": 1700000000000,
      "link": null,
      "locked": false,
      "startBinding": { "elementId": "decision", "focus": 0, "gap": 1 },
      "endBinding": { "elementId": "no-action", "focus": 0, "gap": 1 },
      "startArrowhead": null,
      "endArrowhead": "arrow",
      "lastCommittedPoint": null,
      "roundness": { "type": 2 }
    }
  ],
  "appState": {
    "viewBackgroundColor": "#ffffff",
    "exportWithDarkMode": false,
    "exportBackground": true
  },
  "files": {}
}
```

## 调用方式

构造好 JSON 后，调用 excalidraw_render 工具：

```
excalidraw_render({
  json_content: "<完整的 Excalidraw JSON 字符串>",
  output_path: "diagrams/my-diagram.svg",
  format: "svg"
})
```

然后用 feishu_send_file 发送给用户（如果在飞书会话中）。
