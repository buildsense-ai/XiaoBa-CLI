# Security Hardening (Stage A)

Date: 2026-02-10

## Completed Hardening

1. `grep` command injection mitigation
- File: `src/tools/grep-tool.ts`
- Change: replaced shell string execution with `execFileSync('rg', args)`.
- Added `--` separator before pattern to avoid option injection.

2. Read path boundary enforcement
- File: `src/tools/read-tool.ts`
- Change: integrated `ToolPolicyGateway.checkReadPath(...)` before file access.

3. Centralized tool policy gateway
- File: `src/utils/tool-policy-gateway.ts`
- Change: unified checks for tool allowlist, bash command policy, read/write path policy.

4. Session-scoped tool context
- Files:
  - `src/core/agent-session.ts`
  - `src/core/conversation-runner.ts`
  - `src/tools/tool-manager.ts`
  - `src/agents/agent-tool-executor.ts`
  - `src/types/tool.ts`
- Change: propagated `sessionId/surface/permissionProfile/runId` through tool execution context.

5. Feishu session isolation
- Files:
  - `src/feishu/index.ts`
  - `src/tools/feishu-reply-tool.ts`
  - `src/tools/feishu-send-file-tool.ts`

- Change: replaced global bind/unbind with session-scoped binding map.

6. Shared static state cleanup
- Files:
  - `src/tools/task-planner-tool.ts`
  - `src/tools/todo-write-tool.ts`
  - `src/tools/enter-plan-mode-tool.ts`
  - `src/tools/exit-plan-mode-tool.ts`
  - `src/tools/plan-mode-store.ts`
- Change: state switched from process-global/static to per-session storage.

7. Safer defaults for dangerous tools
- File: `.env.example`
- Change: `GAUZ_TOOL_ALLOW` defaults to empty (deny by default).

8. MinerU HTTP/TLS safety cleanup
- File: `tools/python/paper_parser_tool.py`
- Change: removed `verify=False` request usage.
- Change: removed weak default credentials fallback for MinIO/MinerU env vars.

## Regression Coverage Added

- `tests/safety.test.ts`
  - verifies dangerous tool default deny
  - verifies read path boundary behavior
- `tests/tool-manager.test.ts`
  - verifies invalid tool JSON args return structured error
- `tests/research-core.test.ts`
  - verifies run store persistence and evidence coverage basics

## Remaining Risk Items

1. `bash` safety still uses blacklist regex patterns.
2. API key local storage is still plaintext in `~/.xiaoba/config.json`.
3. No sandbox for Python execution yet (policy only).
