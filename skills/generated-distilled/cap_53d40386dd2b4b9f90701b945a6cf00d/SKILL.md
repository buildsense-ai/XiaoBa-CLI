---
name: "clarify-pi-dal-main-remote-before-pull"
description: "Inspect repository remotes and clarify what pi-dal/main refers to before any pull or other state-changing Git operation, while preserving the no-build/no-restart constraint."
user-invocable: true
x-xiaoba-capability-handle: "cap_53d40386dd2b4b9f90701b945a6cf00d"
x-xiaoba-transition-id: "transition-e647fd71-297e-4986-88db-19f9dc850167"
x-xiaoba-evidence-refs: "/opt/xiaoba-cli/logs/sessions/catscompany/2026-07-30/catscompany_cc_group_grp_1133.jsonl#turn-1:assistant-response, /opt/xiaoba-cli/logs/sessions/catscompany/2026-07-30/catscompany_cc_group_grp_1133.jsonl#episode-episode:1:501feed7:settlement-2026-07-30T06:50:07.424Z"
---

# Clarify an ambiguous `pi-dal/main` target before pulling

Use this narrow capability when a user asks to pull `pi-dal/main` without building or restarting, but the repository has no remote named `pi-dal`.

## Guidance

1. Inspect the configured remotes, current branch, and worktree only far enough to identify the requested target and report relevant repository state.
2. If no remote named `pi-dal` exists, stop before any fetch, pull, merge, conflict resolution, build, or restart. Do not assume that `pi-dal/main` means `origin/main`.
3. Explain the ambiguity. If `origin` points to `github.com/pi-dal/XiaoBa-CLI.git`, state that observed relationship, then ask whether the user intends `origin/main` or a different remote.
4. If the user intends a different source, ask for the correct remote name or URL.
5. Preserve the user's constraint that no build or restart should occur. This guidance covers inspection and clarification only; it does not authorize or prescribe the later Git operation.

Do not reuse this pattern while the user is correcting or iterating on the task.
