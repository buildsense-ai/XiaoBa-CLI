# Skills 目录说明

## 统一的 Skill 管理

所有 Skills 统一存放在项目根目录的 `skills/` 文件夹中。

## 目录结构

```
skills/
├── paper-analysis/
│   └── SKILL.md
├── sci-paper-writing/
│   └── SKILL.md
├── xhs-vibe-write/
│   └── SKILL.md
└── your-custom-skill/
    └── SKILL.md
```

## Skill 命令

### 查看所有可用的 Skills

```bash
xiaoba skill list
```

### 从 GitHub 安装 Skill

```bash
xiaoba skill install-github owner/repo
```

示例：
```bash
xiaoba skill install-github obra/superpowers
```

Skill 会被克隆到 `skills/` 目录。

### 查看 Skill 详情

```bash
xiaoba skill info <skill-name>
```

### 删除 Skill

```bash
xiaoba skill remove <skill-name>
```

强制删除（不询问）：
```bash
xiaoba skill remove <skill-name> -f
```

## 手动添加 Skill

直接在 `skills/` 目录下创建文件夹，每个 Skill 包含一个 `SKILL.md` 文件：

```
skills/
└── my-custom-skill/
    └── SKILL.md
```

### SKILL.md 格式

```markdown
---
name: my-custom-skill
description: 我的自定义 Skill
invocable: user
---

# Skill 内容

在这里编写 Skill 的具体指令...
```

## 注意事项

- ✅ 所有 Skills 统一在 `skills/` 目录
- ✅ 每个 Skill 一个独立文件夹
- ✅ 必须包含 `SKILL.md` 文件
- ✅ 支持从 GitHub 直接安装
- ❌ 不再支持多级目录（npm、用户级、项目级等复杂结构）

## 迁移现有 Skills

如果你之前的 Skills 在其他位置（如 `.xiaoba/skills/` 或 `~/.xiaoba/skills/`），请手动移动到 `skills/` 目录：

```bash
# 示例：迁移 .xiaoba/skills/ 中的 Skills
mv .xiaoba/skills/* skills/
```
