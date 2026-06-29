# Execution Routing Debug Notes

## Current Inconsistency To Verify

- Model-facing target IDs are generic: `agent_self` and `speaker_default`.
- Tool schemas expose the same fixed enum: `agent_self | speaker_default`.
- The router maps `speaker_default` to CatsCompany `deviceSelection` or device grants.
- If CatsCompany selects the wrong device, the agent currently has no more precise target ID to choose.
- Remote tool results can be labeled as `agent_self`, which can pollute durable history and confuse later turns.

## Debug Order

1. Verify the CatsCompany-provided device context shape used by XiaoBa.
2. Verify the transient execution context actually injected for a single turn.
3. Verify router behavior for `agent_self` vs `speaker_default`, including result labeling behavior.

## First-Round Questions

- Does `deviceSelection` point to the intended Windows user device?
- Does XiaoBa use `deviceSelection` before falling back to grants?
- Does the injected `toolRules` contain readable Chinese rules?
- Does `target: speaker_default` create a Device RPC request for the selected device?
- Does the returned tool result preserve a stale remote `[tool_target] target: agent_self` marker?

## Confirmed Issue: Device Platform Is Not Carried By CatsCompany

CatsCompany currently registers and selects user devices with identity and routing fields, but does not carry an explicit OS/platform field.

Current effective device fields:

- `device_id`
- `display_name`
- `body_id`
- `installation_id`
- `status`
- `capabilities`

Implications:

- XiaoBa cannot reliably know from CatsCompany whether a selected remote device is Windows, Linux, or macOS.
- If the same user owns multiple active devices, for example a Windows XiaoBa and a Linux XiaoBa/runtime, CatsCompany can select or remember the wrong device without exposing enough platform context for XiaoBa or the model to notice before a tool call.
- A tool result that says `platform: linux` and returns `/root/...` means the tool actually executed in a Linux runtime. It is not just a Windows path being mislabeled by XiaoBa.
- Sending unknown fields from XiaoBa is not enough: Go JSON decoding accepts unknown fields without failing, but the current CatsCompany structs do not store or forward them into `deviceSelection` or `deviceGrants`.

Clean follow-up design:

- Add explicit `platform` and optionally normalized `os` fields to CatsCompany device registration, storage, selection candidates, selected device, and grants.
- Have XiaoBa upload `process.platform` during device registration.
- Have XiaoBa parse these fields and include them in execution context injection.
- Avoid overloading `display_name`, `capabilities`, `device_id`, `body_id`, or `installation_id` for OS information.

## Tool Pipeline Findings

Target-aware tools:

- `resolve_common_directory`
- `glob`
- `grep`
- `read_file`
- `write_file`
- `edit_file`
- `execute_shell`

Current intended route:

1. Tool receives optional `target`.
2. `resolveExecutionRoute()` chooses `agent_self` by default.
3. If `target="speaker_default"` in CatsCompany, it maps to `deviceSelection.selectedDeviceId` first, then falls back to active `deviceGrants`.
4. Remote execution uses Device RPC via `executeRouteIfRemote()`.
5. If route is local, the tool runs in the current XiaoBa process.

Confirmed tool-side issues to debug/fix next:

- `src/tools/tool-gateway.ts` still exists and is still called by `src/tools/local-tool-risk.ts` and `send_file`.
- Old permission-blocking messages can still appear from `tool-gateway.ts`, even though the newer target routing path lives in `src/tools/execution-router.ts`.
- `execute_shell` still runs local safety checks before route resolution, so a command can be blocked before the code knows whether it was meant for `agent_self` or `speaker_default`.
- Remote tool results can already contain a `[tool_target]` marker from the receiving device. The caller-side result can then preserve a stale marker such as `target: agent_self` even when the caller requested `speaker_default`.
- Path display helpers still redact CatsCompany local paths into generic labels. This may be useful for privacy, but it conflicts with the current debugging and "no privacy filtering" goal.

## Tool Simulation Findings

Script:

- `scripts/debug-execution-routing-sim.ts`
- Run with `node --import tsx scripts/debug-execution-routing-sim.ts`.

Confirmed by simulation:

- The transient runtime context is injected as the first `system` message in the turn.
- Chinese target rules are readable in the actual runtime context message.
- If CatsCompany selection points to a Windows device, `target="speaker_default"` routes to that Windows `targetDeviceId`.
- If CatsCompany selection points to a Linux device, `target="speaker_default"` routes to that Linux `targetDeviceId`.
- Omitting `target` routes to `agent_self`, by design.
- `ToolManager` currently builds caller-side `targetContext` after tool execution by looking only at the ambient context, not the route selected by the tool call. In a simulated `glob(..., target="speaker_default")` remote call, the result's caller-side `targetContext` still says `target: agent_self`.
- `ConversationRunner` prepends `result.targetContext` into the tool result before adding it to transcript. Therefore a wrong `ToolManager` target context directly pollutes the model-visible history.
- A remote receiver can also return content that already has its own `[tool_target]` marker. The caller currently preserves that marker instead of stripping/replacing it.
- `execute_shell` with `target="speaker_default"` can still be blocked before route execution by local command safety checks, for example recursive PowerShell deletion without `confirm_dangerous=true`.

Concrete cleanup points:

- Tool execution results need a route-aware target context, not a context-guessed target context.
- `executeRemoteDeviceRpcTool()` should strip receiver-side `[tool_target]` markers from returned content/errors and let the caller add the single authoritative route marker.
- `execute_shell` should resolve route before local command safety checks. Remote execution should be forwarded first; local checks should only apply when the route is actually `agent_self`.
- For lightweight CatsCompany mode, local safety/path/privacy checks should be intentionally bypassed or reduced for the target-aware base tools.

Implemented in this branch:

- `ToolExecutionResult` can now carry `targetContext`.
- `execution-router.ts` attaches route-aware target context to remote results.
- Remote returned `[tool_target]...[/tool_target]` blocks are stripped before the caller adds its authoritative marker.
- `ToolManager` uses `output.targetContext` before falling back to context-based target inference.
- `execute_shell` resolves and forwards remote routes before running local shell safety checks.

Verified:

- `node --import tsx scripts/debug-execution-routing-sim.ts`
- `npm run build`

Still open:

- CatsCompany still does not carry `platform/os`, so it can still select a Linux device for `speaker_default`.
- If the model omits `target` for “我的桌面”, current default remains `agent_self`; this is prompt/model behavior unless we add automatic target inference outside the model.
- Old `tool-gateway.ts` still exists for non-base paths such as `send_file` and risk classification helpers. The main target-aware base tools now use `execution-router.ts`, but this file is not fully deleted.

## CatsCompany Device Context Diagnostics

Implemented in this branch:

- Added `src/catscompany/execution-context-diagnostics.ts`.
- Added an optional diagnostic call before each CatsCompany message enters the agent session.
- Diagnostics are disabled by default and enabled with:

```powershell
$env:XIAOBA_CATSCOMPANY_CONTEXT_DEBUG="true"
```

The log prints:

- `sessionKey`
- `topic`
- `senderId`
- `executionScope`
- `deviceSelection`
- `deviceSelection.candidates`
- `deviceGrants`

Verification script:

- `scripts/debug-catscompany-device-context.ts`
- Run with `node --import tsx scripts/debug-catscompany-device-context.ts`.

Confirmed by simulation:

- XiaoBa extracts `selectedDeviceId`, `selectedDeviceDisplayName`, `selectedDeviceBodyId`, `selectedDeviceInstallationId`, `selectionSource`, candidates, and grants from CatsCompany metadata.
- If CatsCompany selects Linux while Windows is also a candidate, the diagnostic log clearly shows `selectionSource=most_recent_online`, `selectedDeviceId=cloud-demo-runtime`, and the Windows device in `candidates`.
- Platform/OS still cannot appear because CatsCompany does not currently put `platform/os` into registration, selection, candidates, or grants.

CatsCompany selection behavior confirmed from `cats-company/server/user_device_registry.go`:

- Explicit device mention wins if exactly one device name/id matches the message.
- Existing per-session device preference wins next.
- Otherwise, if multiple devices are active, CatsCompany selects `devices[0]`, marks `selectionSource=most_recent_online`, includes candidates, and remembers that selected device as the session preference.
- The preference TTL is 30 minutes.

Practical implication:

- If a Linux runtime was selected once for the same user/session, later requests can keep routing to Linux through `conversation_preference` until the preference expires or a different device is explicitly selected by name.

Tool-side cleanup direction:

- Make `execution-router.ts` the single route decision point for the target-aware base tools.
- Ensure confirmation/safety checks run after route resolution and only for the actual executing side.
- Remove or bypass old CatsCompany permission gateway checks for the lightweight no-privacy/no-safety mode.
- Normalize returned remote results by stripping receiver-side `[tool_target]` and adding caller-side target context based on the actual route.
- Disable CatsCompany path redaction in this lightweight route, so tool results preserve exact paths.
