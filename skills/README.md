# Skills 目录说明

## 仓库资源与运行时工作区

项目根目录的 `skills/` 是跟随代码发布的 seed/template Skill 资源目录，不是
Electron 开发版或打包版默认使用的用户 Skill 工作区。

当前生效目录由运行时 userData 决定：

- Electron 开发版：`<项目根目录>/.dev-user-data/skills`；
- Electron 打包版：`<Electron app.getPath('userData')>/skills`；
- CLI/服务器：`<XIAOBA_USER_DATA_DIR>/skills`，也可以由 `XIAOBA_SKILLS_DIR` 显式覆盖；
- 未设置任何 userData 环境变量的原始 CLI 才会回退到 `<cwd>/skills`。

不要在运行 Electron 版时通过编辑仓库根目录 `skills/` 来判断当前 Agent 的
Skill 状态。WebApp 的“本地工作区”会显示真正生效的绝对路径。

## 按 Bot 隔离

运行时只有当前 Bot 占用 `<userData>/skills` 这个活动入口。切换 Bot 时：

- 上一个 Bot 的工作区停放到 `<userData>/data/bot-skills/workspaces/<botId>`；
- 目标 Bot 的工作区再移回 `<userData>/skills`；
- `sync-base/<botId>.json` 是同步基线清单，不是完整文件备份；
- `local-pending/<botId>/...` 才是需要人工处理时保留的可恢复快照。

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
catsco skill list
```

### 从 GitHub 安装 Skill

```bash
catsco skill install-github owner/repo
```

示例：
```bash
catsco skill install-github obra/superpowers
```

Skill 会被克隆到当前运行时的 `skills/` 工作区。

### 查看 Skill 详情

```bash
catsco skill info <skill-name>
```

### 删除 Skill

```bash
catsco skill remove <skill-name>
```

强制删除（不询问）：
```bash
catsco skill remove <skill-name> -f
```

## 手动添加 Skill

直接在当前运行时 `skills/` 工作区下创建文件夹，每个 Skill 包含一个
`SKILL.md` 文件：

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

- ✅ 当前 Bot 的 Skills 统一从当前运行时 `skills/` 工作区加载
- ✅ 每个 Skill 一个独立文件夹
- ✅ 必须包含 `SKILL.md` 文件
- ✅ 支持从 GitHub 直接安装
- ✅ 旧版 `xiaoba skill ...` 命令仍作为兼容别名保留
- ❌ 不再支持多级目录（npm、用户级、项目级等复杂结构）

## 迁移现有 Skills

如果你之前的 Skills 在其他位置（如 `.xiaoba/skills/` 或 `~/.xiaoba/skills/`），请手动移动到
当前运行时的 `skills/` 工作区：

```bash
# 示例：迁移 .xiaoba/skills/ 中的 Skills
mv .xiaoba/skills/* skills/
```
