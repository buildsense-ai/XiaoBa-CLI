# Restore opt-in Memory and Summary branches

> Execution: implement in this session, then independently review standards and spec. User explicitly approved implementation and an open combination PR.

**Goal:** Restore the behavior of Saturday commit `a4e4757184569e2677e9255d80113a7e5d92315b` on upstream `09066b4bf6d6a05111d6efb9acfeabf0ac503077`, with only the approved `evidence` finish parameter and default-off branch switches as intentional changes.

**Architecture:** Keep current main's runtime, cancellation, manual checkpoint, provider and connector infrastructure. Restore the old autonomous local-log Memory implementation and its long-episode refresh; port the old asynchronous checkpoint candidate into main's existing safe boundaries. No second strategy, server change, deployment, or unrelated rollback.

**Tech Stack:** TypeScript, Node.js, node:test.

**Spec:** User-approved conversation: old combined behavior, Memory finish `refs` becomes `evidence`, both branches independently default off. Latest main interfaces require minimal compatibility adaptations, not new retrieval policy.

## Global constraints

- Memory: local historical `logs/sessions`, search/read/neighbors tools, original prompts and no new 45s/16K/4x2 limits. Preserve original invalid-finish cap, cancellation, path containment, truncation and historical-evidence safeguards.
- Refresh: prior run complete + 15 minutes + new parent content; original task, delta, previous injections; no evidence blacklist. Preserve original carryover behavior.
- Rename only finish's model-facing citation parameter to `evidence: string[]`; keep read-tool `ref` and internal observation metadata compatible. Strict validation and actionable reminders, no silent scalar coercion.
- Summary: original physical-window >75% launch and safe >85% wait, candidate retries/deadline, immutable prefix + suffix, safe commit and logs. No new algorithm or unrelated fixes.
- Both opt-in. Summary disabled preserves ordinary synchronous checkpoint and `/compact`. Existing explicit memory configuration is honored; upgrade does not enable branches automatically.
- Preserve latest main outside these capabilities. Do not edit Saturday or PR #7.

## Tasks

### 1. Restore autonomous Memory
- [x] Import baseline local log store/tools/session and relevant tests using apply_patch.
- [x] Pin search/read/neighbors, original no-injection behavior and strict evidence finalization in tests; demonstrate failing tests before implementation.
- [x] Adapt current sidecar/runtime interfaces without passing new memory budgets to the restored session. Retain common cancellation and observation delivery infrastructure.
- [x] Update tests/docs that specifically assert the superseded pipeline; retain independent remote API tests.

### 2. Restore long-episode refresh and async Summary
- [x] Port only baseline Memory coordinator and checkpoint candidate boundary changes, preserving latest main `/compact`, interrupts, session termination and other updates.
- [x] Set candidate enablement explicit opt-in; preserve existing Memory default off.
- [x] Verify baseline candidate tests, suffix/tool-pair preservation, retry behavior and manual/synchronous checkpoint regression tests.

### 3. Verification and handoff
- [x] Test all four switch combinations and effective absence of 45s/16K limits.
- [x] Build, release check, targeted tests, full runtime and SkillHub tests; distinguish pre-existing/environmental failures.
- [x] Self-review plus independent standards/spec reviews; repair findings within scope.
- [ ] Commit, push and open one non-draft PR against buildsense-ai/XiaoBa-CLI main; attach PR and report verification honestly.

## Review focus

- Missing/malformed/legacy configuration never unexpectedly enables a branch.
- Restored log reads reject traversal and remain within configured agent-owned roots; historical text is evidence, not executable instructions.
- Long parent deltas do not inherit 16K/45s caps; external abort still terminates the branch.
- Summary pending/ready across finalization, interrupts and manual compact never replaces changed context or drops suffix/tool results.
- A disabled Summary branch leaves automatic checkpoint and `/compact` working; a disabled Memory produces no background model calls.

## Verification notes

- Independent standards and spec reviews found candidate hooks affecting the Summary-off path; these hooks and the pre-turn stop are now opt-in only. Additional summary truncation policy from an intermediate port was removed.
- Re-review at `4b829f84`: no remaining blocking findings on either axis.
- Targeted Memory/Summary/configuration/citation/timing regression set: 90/90 passed.
- TypeScript build and release preflight passed. SkillHub: 363 passed, 3 skipped.
- Full runtime tests are being compared with untouched upstream main on the same Windows host. Platform/baseline failures are reported in the PR, not silently treated as passes.
- Existing candidate lifecycle-event usage totals can omit failed summary attempts; the separate metrics collector still records responses. This inherited accounting limitation is retained to avoid unrelated changes in the restoration.
- Saturday and fork PR #7 remain untouched.
