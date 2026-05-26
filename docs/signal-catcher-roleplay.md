# Signal Catcher Roleplay Runtime

This profile starts CatsCo as a no-tool, no-skill roleplay DM for `信号捕手：心动与谎言`.

CatsCo connector:

```bash
npm run dev -- catsco --profile examples/signal-catcher-runtime-profile.json
```

CatsCo sessions are persisted by chat user. When testing the same account after switching profiles, send `/clear` in the chat or remove the matching local `data/sessions/cc_user_*.jsonl` test session before judging the prompt.

Dashboard-managed connector can use the same profile through `.env`:

```bash
XIAOBA_RUNTIME_PROFILE_PATH=examples/signal-catcher-runtime-profile.json
```

CLI fallback:

```bash
npm run dev -- chat --profile examples/signal-catcher-runtime-profile.json
```

Single-message smoke test:

```bash
npm run dev -- chat --profile examples/signal-catcher-runtime-profile.json -m "我想创建角色卡。姓名：韩书允，性别：女，年龄：28，职业：纪录片导演，性格标签：冷静、敏锐、慢热。"
```

The runtime profile:

- uses `prompts/signal-catcher-system-prompt.md` as the base system prompt;
- injects `prompts/signal-catcher-game-bible.md` as a transient context file;
- disables the engineering runtime-info suffix, current-directory hint, CatsCo surface prompt, startup branding, and CatsLog upload;
- disables all tools;
- disables skills.
