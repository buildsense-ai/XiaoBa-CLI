---
name: code-style
description: 代码风格规范。写 TypeScript 或 Python 代码时激活，确保风格与项目一致。
user-invocable: true
auto-invocable: false
---

# 代码风格规范

你正在为 XiaoBa 项目写代码。以下风格规则必须严格遵守，写出的每一行代码都要和项目已有代码风格一致。

---

## TypeScript 规范

### 命名

| 场景 | 风格 | 示例 |
|------|------|------|
| 变量 / 函数 / 方法 | camelCase | `buildRequestBody`, `toolFailureCount` |
| 类 / 接口 / 类型 | PascalCase | `BridgeServer`, `RunnerOptions` |
| 模块级常量 | UPPER_SNAKE_CASE | `DEFAULT_PROMPT_BUDGET`, `MAX_BODY_SIZE` |
| 枚举成员 | PascalCase | `Status.Running` |
| 文件名 | kebab-case | `bridge-server.ts`, `prompt-manager.ts` |

- 布尔变量/方法以 `is` / `has` / `should` / `can` 开头
- 私有成员用 `private` 关键字，不加下划线前缀

### 格式

- 缩进：2 空格
- 引号：单引号，模板字符串用反引号
- 分号：必须加
- 尾逗号：多行数组/对象/参数列表末尾加
- 大括号：同行风格 `if (x) {`，单行 body 也加大括号
- 空行：import 块后一个空行，类成员之间一个空行，逻辑段落之间一个空行

### 导入

```typescript
// 1. Node 内置（import * as）
import * as fs from 'fs';
import * as path from 'path';

// 2. 第三方
import axios from 'axios';

// 3. 项目内部（命名导入）
import { Logger } from '../utils/logger';
import { Message } from '../types';
```

同组内按字母排序。不要用 `require()`。

### 类结构

```typescript
export class MyService {
  // 静态常量
  private static readonly MAX_RETRIES = 3;

  // 实例字段
  private items = new Map<string, Item>();

  constructor(private config: Config) {}

  // ─── 公开方法 ─────────────────────────────────

  /** 做某事（中文 JSDoc） */
  async doSomething(): Promise<void> { ... }

  // ─── 私有方法 ─────────────────────────────────

  private helper(): void { ... }
}
```

- 用 `// ─── 区域名 ───` 分隔符分区
- 公开方法必须有中文 JSDoc
- 类强相关的常量用 `private static readonly`

### 错误处理

```typescript
// catch 统一写法
try {
  await riskyOperation();
} catch (err: any) {
  Logger.error(`操作失败: ${err.message}`);
}

// 异步 fire-and-forget 必须兜住
promise.catch(err => {
  Logger.warning(`后台任务失败: ${err.message}`);
});
```

- 禁止 `console.log/warn/error`，全部走 `Logger`
- 不允许 unhandled rejection

### 注释

- 注释和 JSDoc 用中文
- 标识符（变量名、类名）用英文
- 不写废话注释（`// 设置 name` → 删掉）

---

## Python 规范

### 命名

| 场景 | 风格 | 示例 |
|------|------|------|
| 变量 / 函数 / 方法 | snake_case | `build_request`, `tool_count` |
| 类 | PascalCase | `ToolWrapper`, `BaseAgent` |
| 常量 | UPPER_SNAKE_CASE | `MAX_RETRIES`, `DEFAULT_TIMEOUT` |
| 私有成员 | 单下划线前缀 | `_internal_state` |
| 文件名 | snake_case | `base_tool.py`, `math_tool.py` |

### 格式

- 缩进：4 空格
- 引号：单引号优先，docstring 用三双引号 `"""`
- 行宽：88 字符（Black 默认）
- 空行：顶层定义之间 2 个空行，类内方法之间 1 个空行

### 导入

```python
# 1. 标准库
import os
import json
from pathlib import Path

# 2. 第三方
import numpy as np

# 3. 项目内部
from .base_tool import BaseTool
```

- 不要用 `from module import *`
- 同组内按字母排序

### 类结构

```python
class MyTool(BaseTool):
    """工具描述（中文 docstring）"""

    MAX_RETRIES = 3

    def __init__(self, config: dict):
        self._config = config

    def execute(self, args: dict) -> str:
        """执行工具（中文 docstring）"""
        ...

    def _helper(self) -> None:
        ...
```

- 公开方法必须有中文 docstring
- 类型注解：函数参数和返回值必须标注

### 错误处理

```python
try:
    result = risky_operation()
except Exception as e:
    logger.error(f"操作失败: {e}")
```

- 不要裸 `except:`，至少 `except Exception`
- 用 `logging` 或项目的 logger，不要 `print()`

---

## 通用规则

- 不要留 dead code（注释掉的代码块、unused import）
- 不要加 `// TODO` 或 `# TODO` 除非有明确的后续计划
- 一个函数只做一件事，超过 50 行考虑拆分
- 魔法数字提取为命名常量
