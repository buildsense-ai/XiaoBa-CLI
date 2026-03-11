<div align="center">

```
██╗  ██╗██╗ █████╗  ██████╗ ██████╗  █████╗
╚██╗██╔╝██║██╔══██╗██╔═══██╗██╔══██╗██╔══██╗
 ╚███╔╝ ██║███████║██║   ██║██████╔╝███████║
 ██╔██╗ ██║██╔══██║██║   ██║██╔══██╗██╔══██╗
██╔╝ ██╗██║██║  ██║╚██████╔╝██████╔╝██║  ██║
╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝  ╚═╝
```

**Your AI. Your Rules. Your Terminal.**

An extensible AI Agent Runtime that runs in your terminal,</br>
connects to your IM platforms, and bends to your will.

[![Node](https://img.shields.io/badge/node-%3E%3D18-black?style=for-the-badge&logo=nodedotjs&logoColor=%23f0db4f&labelColor=0a0a0a)](https://nodejs.org)
[![TS](https://img.shields.io/badge/typescript-5.3-black?style=for-the-badge&logo=typescript&logoColor=%233178c6&labelColor=0a0a0a)](https://typescriptlang.org)
[![MIT](https://img.shields.io/badge/license-MIT-black?style=for-the-badge&labelColor=0a0a0a&color=f5c542)](./LICENSE)

<br/>

---

**3 Skills** · **14 Core Tools** · **Hot-Reload** · **Multi-LLM** · **IM Integration**

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [Skills](#-skills) · [Configuration](#%EF%B8%8F-configuration)

</div>

<br/>

## Quick Start

```bash
git clone https://github.com/buildsense-ai/XiaoBa-CLI.git
cd XiaoBa-CLI
npm install
cp .env.example .env   # fill in your API keys
npm run build
```

```bash
# Interactive CLI
node dist/index.js chat

# Feishu Bot
node dist/index.js feishu

# CatsCompany Bot
node dist/index.js catscompany
```

<br/>

## Architecture

```
┌─────────────────────────────────────┐
│         AI Agent Runtime            │
├─────────────────────────────────────┤
│  Skill Layer                        │
│  - SKILL.md prompt + optional scripts│
│  - Hot-reload, self-evolution       │
├─────────────────────────────────────┤
│  Tool Layer (14 tools)              │
│  - File: read, write, edit, glob, grep │
│  - Shell: execute_shell             │
│  - Communication: send_text, send_file │
│  - Meta: thinking, skill            │
│  - Sub-agent: spawn, check, stop, resume │
├─────────────────────────────────────┤
│  Platform Adapters                  │
│  - Feishu (WebSocket)               │
│  - CatsCompany (WebSocket)          │
│  - CLI (interactive)                │
└─────────────────────────────────────┘
```

### Core Tools (14)

| Category | Tool | Description |
|----------|------|-------------|
| File | `read_file` | Read file contents |
| File | `write_file` | Write file |
| File | `edit_file` | Edit file (diff-based) |
| File | `glob` | File search (glob patterns) |
| File | `grep` | Content search (regex) |
| Shell | `execute_shell` | Run shell commands |
| Comm | `send_text` | Send text message to user |
| Comm | `send_file` | Send file to user |
| Meta | `thinking` | Internal reasoning (not visible to user) |
| Meta | `skill` | Invoke a skill |
| Agent | `spawn_subagent` | Spawn background sub-agent |
| Agent | `check_subagent` | Check sub-agent progress |
| Agent | `stop_subagent` | Stop a sub-agent |
| Agent | `resume_subagent` | Resume a sub-agent |

### Skills (3)

Pluggable capability modules defined in Markdown.

| Skill | Description |
|-------|-------------|
| `sub-agent` | Background sub-task execution |
| `agent-browser` | Browser automation via Playwright |
| `self-evolution` | Create new skills and tools at runtime |

<br/>

## Skills

### Using Skills

```bash
# Slash command in chat
/agent-browser https://example.com

# Or mention by name — auto-triggered if invocable: both
```

### Creating Custom Skills

1. Create `skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does
invocable: user
---

Your prompt here...
```

2. Optional: add scripts under `skills/my-skill/`
3. Hot-reload: `skill reload` or auto-detected

Or use the **self-evolution** skill to create new skills interactively.

<br/>

## Configuration

Copy `.env.example` to `.env`:

```bash
# Required: LLM provider
GAUZ_LLM_PROVIDER=anthropic
GAUZ_LLM_MODEL=claude-sonnet-4-20250514
GAUZ_LLM_API_KEY=your-key

# Optional: Feishu bot
FEISHU_APP_ID=your-app-id
FEISHU_APP_SECRET=your-secret

# Optional: CatsCompany bot
CATSCOMPANY_SERVER_URL=wss://your-server/v0/channels
CATSCOMPANY_API_KEY=your-key
CATSCOMPANY_HTTP_BASE_URL=https://your-server
```

See [.env.example](./.env.example) for all options.

<br/>

## License

[MIT](./LICENSE)

---

<div align="center">

Built with intent by **CatCompany**

</div>
