# CatsCompany Thin Runtime Routing

This document records the lightweight remote execution design for CatsCompany-backed XiaoBa sessions.

## Fixed Rules

- CatsCompany has two runtime duties for this path: forward `thin_tool_rpc` requests/results, and inject realtime `xiaoba_runtime.devices` facts for messages delivered to bot recipients.
- The new path does not read `device_grants`, `device_selection`, or `grant_id` to choose a thin RPC target.
- Tool calls without `target` execute on `agent_self`, the host computer running the current agent process.
- Tool calls with `target` use a chat participant's displayed name, label, or user id. XiaoBa runtime maps that string to a ready user device.
- Only tools whose schema includes `target` can execute on user computers.
- The agent does not need to see `ownerUserId` or `deviceId`; those are runtime routing facts.
- Normal local CLI sessions do not inject remote device rules.
- History/replay messages do not carry executable `xiaoba_runtime` facts.

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

## Observed Issues To Track

- 2026-06-30 group runtime facts changed for the same participant across turns: `arrowhaken` was first injected as `EASON, Windows`, then later as `xiaoba-demo-runtime, Unknown`. This indicates CatsCompany runtime device selection can still surface an older/demo ready device instead of the expected current Windows device.
- In group chats, user wording such as "your desktop" can be misread after previous assistant replies said "your desktop" while referring to the speaker's own desktop. The model-facing rule should explicitly cover "your desktop / your files / your side" as the bot host computer, and assistant replies should prefer explicit names such as "Lin's desktop" or "your (Lin) desktop" to avoid polluting future turns.
