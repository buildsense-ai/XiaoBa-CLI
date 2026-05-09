---
name: remember
description: 记住用户的个性化偏好并持久化。当用户要求"记住"、"改名"、"以后叫"、"设置偏好"、"改变行为"时使用此 skill
version: 1.0.0
author: CatsCo Team
user_invocable: true
---

# Remember Skill

用户要求记住偏好时，**必须立即用 execute_shell 工具执行**：

```bash
python skills/remember/remember.py "偏好内容"
```

**禁止**只回复"已记住"而不执行命令！

示例：
- 用户："以后叫自己三八" → 执行 `python skills/remember/remember.py "我的名字：三八"`
- 用户："回复加喵" → 执行 `python skills/remember/remember.py "所有回复后面加喵"`

