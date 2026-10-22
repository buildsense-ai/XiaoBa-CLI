# CatsCompany Thin Runtime Routing

This document records the lightweight remote execution design for CatsCompany-backed XiaoBa sessions.

## Current default and explicit target protocol (2026-10-21)

The earlier grant-free routing notes below describe the historical path. Ordinary
user-device tools now require a current scoped grant. `device_grants` contains
only the selected default's grant; `speaker_default` and user-name aliases may
use only that grant. A desktop task with no device named in the user's request
uses this default, while tool calls without a `target` still run on the Bot host
for normal Skill and attachment work.

With server v2 enabled, `catsco_identity.device_target_authorizations` (schema
`catsco.device-targets.v1`) contains separate `explicit_device` capabilities.
Only exact device names/IDs may select these, and the runtime sends
`target_scope: "explicit_device"` together with the exact device ID on both RPC
transports. The server enforces scope and device ID. Old clients read only the
selected-only field; unknown explicit-envelope schemas are ignored. Never
interpret the first explicit capability as the default. An explicit or multi-device
task does not update the picker; offline/missing/ambiguous targets do not permit
fallback to another computer. Each device task retains its own grant and result.

Server rollout remains gated; these changes do not enable a production flag.

## Fixed Rules

- CatsCompany has two runtime duties for this path: forward `thin_tool_rpc` requests/results, and inject realtime `xiaoba_runtime.devices` facts for messages delivered to bot recipients.
- The new path does not read `device_grants`, `device_selection`, or `grant_id` to choose a thin RPC target.
- Tool calls without `target` execute on `agent_self`, the host computer running the current agent process.
- Tool calls with `target` use a chat participant's displayed name, label, or user id. XiaoBa runtime maps that string to a ready user device.
- Only tools whose schema includes `target` can execute on user computers.
- `send_file` remains chat-only and never accepts a remote target.
- Remote `import_file` runs on the selected computer, uploads the original bytes there, returns only attachment metadata through `thin_tool_rpc`, and lets the requesting runtime materialize that upload in its managed workspace.
- The agent does not need to see `ownerUserId` or `deviceId`; those are runtime routing facts.
- Normal local CLI sessions do not inject remote device rules.
- History/replay messages do not carry executable `xiaoba_runtime` facts.

## Group History and Device Authorization

Group chat history, restore/cleanup and attachment scope retain the shared key `cc_group:<topic>`. Device grants and device selection use a separate, server-issued authorization key scoped to the group, speaking user and Bot: `session:v2:catscompany:group:<encodeURIComponent(topic + ':actor:' + actorUserId)>:agent:<encodeURIComponent(agentId)>`. The CLI derives that authorization key from the trusted execution identity when matching or validating device authorization; the shared history key is never accepted as a device authorization key. Private-chat keys are unchanged.

## Runtime Facts

CatsCompany injects this shape only on realtime messages sent to bot recipients:

```json
{
  "xiaoba_runtime": {
    "schema": "xiaoba.runtime.v1",
    "devices": [
      {
        "userId": "usr85",
        "userName": "Alice",
        "deviceId": "alice-laptop",
        "label": "Alice 的电脑",
        "os": "windows"
      }
    ]
  }
}
```

The facts contain ready human participant devices only. The bot host computer is implicit and remains the default when `target` is omitted.

## Model-Facing Target Rule

Tool schemas describe `target` as a free string:

```text
Optional. Omit target to run on the host computer running this agent. Set target to a chat participant's displayed name or user id only when the user explicitly asks to operate that participant's computer.
```

The transient runtime context remains short Chinese text and does not expose internal owner/device ids.

## Remote File Transfer

`import_file` requires a participant `target`; `send_file` keeps its original meaning of sending an agent-local file to the current chat. The import RPC payload carries `file_path` and `file_name`, never the file body. The target runtime validates and opens the local path, streams it through the existing CatsCompany upload endpoint, and returns `{ url, name, size, type }`. The requesting runtime downloads that trusted upload into its managed workspace, verifies the stored size, and returns the new local path to the model. It does not publish an attachment to the chat. File content does not pass through the model transcript or the RPC JSON payload.

## Observed Issues To Track

- 2026-06-30 group runtime facts changed for the same participant across turns: `arrowhaken` was first injected as `EASON, Windows`, then later as `xiaoba-demo-runtime, Unknown`. This indicates CatsCompany runtime device selection can still surface an older/demo ready device instead of the expected current Windows device.
- In group chats, user wording such as "your desktop" can be misread after previous assistant replies said "your desktop" while referring to the speaker's own desktop. The model-facing rule should explicitly cover "your desktop / your files / your side" as the bot host computer, and assistant replies should prefer explicit names such as "Lin's desktop" or "your (Lin) desktop" to avoid polluting future turns.
