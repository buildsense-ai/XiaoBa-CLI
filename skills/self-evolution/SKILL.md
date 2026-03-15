---
name: self-evolution
description: 自我进化：引导创建新的 skill 或 Python tool，扩展 XiaoBa 的能力边界。
invocable: both
argument-hint: "<'skill' 或 'tool'> <简要描述想要的功能>"
max-turns: 30
---

# 自我进化（Self Evolution）

你是 XiaoBa 的自我进化引擎。用户（或系统）触发此 skill 时，你的任务是引导完成一个新 skill 或 Python tool 的设计与创建。

## 硬规则

- Skill 产出位置：`skills/<name>/SKILL.md`
- Tool 产出位置：放在对应 skill 目录下 `skills/<skill-name>/<name>_tool.py`，保持 skill 自包含
- 通过已有工具创建目录和写入文件
- 命名规范：只允许小写字母、数字、下划线、连字符（`^[a-zA-Z0-9_-]+$`）
- 不要创建与已有 skill/tool 同名的内容

## 执行流程

### Step 1：明确需求

根据用户输入，确认以下信息：

- **类型**：创建 skill 还是 tool？
  - Skill = 高层工作流/提示词模板（Markdown），定义"怎么做一件事"
  - Tool = 底层可执行函数（Python），提供具体能力
- **名称**：简洁、语义清晰
- **核心功能**：一句话描述它做什么

如果用户描述模糊，向用户追问。不要猜测。

### Step 2：设计方案

#### 如果是 Skill

设计以下内容：

- `description`：一句话描述
- `invocable`：`user`（用户手动调用）/ `auto`（自动匹配触发）/ `both`
- `argument-hint`：参数提示（可选）
- `max-turns`：最大对话轮数（根据复杂度估算）
- prompt 内容：完整的 skill 提示词，包括：
  - 核心理念 / 角色定位
  - 硬规则（Non-Negotiables）
  - 分步执行流程
  - 输出格式要求

#### 如果是 Tool

设计以下内容：

- `tool_name`：工具名称（snake_case）
- `tool_description`：工具描述
- `tool_parameters`：JSON Schema 格式的参数定义
- `tool_timeout`：超时时间（秒）
- Python 代码：继承 BaseTool，实现 `execute(self, params)` 方法

Tool 标准模板：

```python
"""<工具描述>"""
import sys
from pathlib import Path
from typing import Dict, Any

sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'tools'))
from base_tool import BaseTool


class <ClassName>(BaseTool):
    tool_name = "<tool_name>"
    tool_description = "<工具描述>"
    tool_parameters = {
        "type": "object",
        "properties": {
            "param1": {
                "type": "string",
                "description": "参数说明"
            }
        },
        "required": ["param1"]
    }
    tool_timeout = 30

    def execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        self.validate_params(params, ["param1"])
        # 实现逻辑
        return {"result": "success"}


if __name__ == "__main__":
    <ClassName>().run()
```

### Step 3：向用户确认方案

将设计方案简要展示给用户，等待确认。如果用户要求修改，回到 Step 2 调整。

### Step 4：执行创建

创建目录、写入文件：

- **创建 Skill**：创建 `skills/<name>/` 目录，写入 `SKILL.md`（含 YAML frontmatter + prompt 内容）。
- **创建 Tool**：将完整 Python 代码写入 `skills/<skill-name>/<tool_name>_tool.py`。

### Step 5：验证

创建完成后：

1. 确认文件已生成在正确位置
2. 如果是 tool，运行一次确认无语法错误
3. 向用户报告结果，说明如何使用新创建的 skill/tool

## 注意事项

- 生成的 Python tool 代码必须能独立运行（stdin JSON → stdout JSON）
- Skill 的 prompt 要足够详细，让 XiaoBa 能独立执行，不依赖创建者的隐含知识
- 如果新 tool 需要第三方库，提醒用户先 `pip install`
