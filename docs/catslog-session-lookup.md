# On-demand CatsLog session metadata

`catslog_session_lookup` is available to the main agent and the Memory Branch through the existing device-bound provider and tool allowlists. Listing tools does not query CatsLog. The existing explicit-read role and `CATSLOG_KNOWLEDGE_RECALL_ENABLED` gate apply; disabling the automatic memory branch alone does not disable main-agent lookup.

```json
{"action":"read","session_id":"cc_group:grp_10"}
```

```json
{"action":"search","name":"发布准备","match":"exact","limit":20}
```

`match=contains` enables literal substring matching. Both modes are case-insensitive on CatsLog. A search returns a candidate list, never an automatically selected ID. Keep `session_id_source=conversation_directory`, `archive_status=not_checked`, redaction/truncation flags and the directory snapshot time visible. Names are current metadata, not historical evidence. Reading an archived transcript still requires its actual execution key and existing archive authorization.

The provider persists the two bootstrap URLs and shares the existing bounded, same-origin, non-redirecting HTTP client. Older state defaults to the canonical paths; an older server without these routes yields a typed unavailable result. A missing visible session, denied viewer, cancellation and unavailable directory are errors, not successful empty searches.

Repeatable verification (Node 20.20.2 managed by mise):

```sh
CATSLOG_SESSION_LOOKUP_REPORT=/tmp/xiaoba-session-lookup-journey.json \
  mise exec node@20.20.2 -- node --import tsx --test tests/catslog-session-lookup-journey.test.ts
```

Failure modes decided before implementation:

- Constructing a runtime or listing tools must not query the directory. Only an explicit lookup dispatches HTTP.
- An explicit profile allowlist or missing provider must keep the tool unavailable; disabling automatic memory retrieval must not disable explicit lookup.
- ID-to-name and name-to-ID use the device read token, never upload/write credentials. Bootstrap routes must survive restart, upload scheduler merges and capability clearing.
- Exact matching defaults to case-insensitive equality on the server; contains is explicit. Duplicate names remain separate candidates; zero matches is a successful empty list. Directory locators never prove archived transcript existence.
- Invalid, contradictory, oversized, control-character or unpaired-surrogate inputs must fail before HTTP. Arguments never select a UID or supply credentials.
- A rejected read token can refresh once through existing bootstrap. Denial, viewer mismatch, a missing route, missing session, unavailable directory and malformed/oversized responses must remain distinguishable from an empty result.
- Redirects and unsafe advertised URLs must not send the read token to another origin. Cancellation must stop a pending request. Metadata results whitelist fields and cannot return arbitrary server fields or error text.
- Metadata is untrusted and has no evidence citation. It does not enter the Branch's delivered evidence ledger or acquire read/injected/answer source markers.

The repeatable HTTP journey is `tests/catslog-session-lookup-journey.test.ts`. It drives ToolManager → provider → client → an actual local HTTP peer, and writes a credential-free report when `CATSLOG_SESSION_LOOKUP_REPORT` is set. Local fixtures prove dispatch and response contracts; they do not claim model quality or production deployment.
