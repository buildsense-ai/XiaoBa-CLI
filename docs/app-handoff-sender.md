# Application handoff sender (runtime platform integration)

This runtime adapter completes the structured sender side of the existing platform handoff. It does not modify any application, publish an artifact, click a DOM control, or execute a job. Application receiver integration and authenticated business execution remain separate work.

## Usage and boundaries

`open_app({action: 'list'})` reads the currently authenticated Agent's existing application catalogue. `open_app({app_id})` remains the v1 open-only contract. `open_app({app_id, action: 'initialize', request_id, parameters})` initializes only. Run additionally requires `action: 'run'` and the literal `user_requested_run: true`, asserting that the actual user explicitly requested execution. This flag is not a credential or consent mechanism and cannot bypass the application's authorization or dangerous-operation confirmation.

Application capability and parameter schema must come from a trusted integration description, not inferred from a catalogue title/description. Without known capability, use open-only or initialize with no parameters. The catalogue does not currently provide parameter schemas or trusted run declarations; the tool description explicitly forbids guessing them. No application-specific task or schema is hardcoded here.

The tool accepts no topic, Agent owner, URL, expiry, or credential arguments. Current topic comes from outbound-gateway checks against channel and executionScope, then the actual callback verifies its closed-over topic. Aborted or untrusted contexts fail; pending catalogue lookups recheck context before sending. Only structured-capable channels can emit a handoff. Unsupported channels and transport failures cannot return success.

The read-only CatsClient catalogue method uses the fixed existing `/api/artifacts/apps` endpoint with the configured Agent API credential and follows no redirects. It defaults to authenticated caller ownership; no model-selected uid or arbitrary URL is accepted. Actual server `artifact_apps.go` uses the optional `agent` query, not `agent_uid` described in the initial platform handoff documentation. The runtime needs neither query. Catalogue output is projected to id/title/description only. The server remains authoritative for ownership, membership, and Agent stamping.

## Contract and transport

v2 emits `metadata.app_open` with `catsco.app-open.v2`; its handoff has a caller-stable 8–80 ASCII request_id, real topic_id, initialize/run action, flat bounded scalar parameters, now+60s expiry and normalized user_requested_run. At most 16 keys are allowed, with the server key and denylist rules. Strings are limited to 512 Unicode code points; controls, unpaired surrogates, URL/Bearer/private-key patterns and nonfinite numbers are refused. Null/nesting/arrays are refused. Go's JSON HTML escaping is accounted for when measuring the 4096-byte parameter budget, with a conservative 32-byte reserve per numeric value for Go/JS formatting differences. This can reject some near-limit valid objects; it cannot admit an oversized Go encoding via those differences.

Metadata follows the existing tool → buildChannel → MessageSender.reply → sendText → send → WS path. HTTP fallback preserves the same app_open and transport client_msg_id. Only the first segment receives app_open; other metadata remains on every segment. Structured empty replies and missing/zero acknowledgments fail. `hasOutbound` is set only after acknowledgment. Body text is never parsed as a command.

A message ACK is only transport acceptance. The server may strip an unauthorized handoff without rejecting the surrounding message. Tool success therefore means only a request was sent, not that the app opened, initialized, ran or completed. The existing panel owns ready/ack/timeout/unknown statuses. This sender does not invent polling, automatic app retries, or result completion.

## Identity and retries

A v2 logical task must have a stable caller-generated request_id. Exact same-ID calls within one tool instance share the original promise; changed semantic payloads under that identity fail. Preflight failures which never attempted transport release the identity for same-ID recovery. Once a send was attempted, both success and ambiguous failure retain it; retrying cannot send another request. At 1024 retained identities the instance fails closed instead of evicting an identity that could rerun a job. The fingerprint excludes generated expiry and note, and sorts parameters. It includes Agent/session/topic/ID binding.

This in-memory guard is not a business exactly-once guarantee or durable cross-process ledger. Existing panel consumption/sessionStorage checks and expiration provide viewer-side defenses, and a run-capable application must implement backend deduplication by request_id across reloads/tabs. Do not generate a new ID after an unknown outcome without checking the original application task. No automatic execution or transport re-emission is introduced by this tool.

## Verification

Registered suite: `node scripts/run-tests.mjs app-handoff`. It is also discovered by the default runtime glob. Additional affected existing suites are registered as `app-handoff-regression`.

The original new suite first produced 9 behavioral failures (22 passes out of 31); its completed version passes 36/36 after added safety tests. TypeScript `node node_modules/typescript/bin/tsc --noEmit` passes. Tests call the real OpenAppTool, actual CatsCompanyBot.buildChannel and actual MessageSender against a captured structured transport / HTTP fetch. No live deployment, real app handshake or job was exercised.

Affected existing regression suites: 181/185 pass; four failures were independently reproduced on untouched base 062c7cf in a separate detached worktree (two WS-header tests and two reader-proxy tests). No assertions were weakened. Full runtime (289 test files) was attempted with concurrency 2; a 240-second tool deadline interrupted it after many existing failures, so full runtime is not green or complete. The original dirty worktree remains unchanged; dependencies are shared by junction without installation. Raw unrelated regression assertions can include environment secrets, so retained logs are sanitized and must not be quoted wholesale.
