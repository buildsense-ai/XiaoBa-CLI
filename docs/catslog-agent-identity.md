# CatsLog agent identity contract

CatsLog needs a stable agent discriminator to support agent-oriented session
search without treating untrusted conversation text as identity data. XiaoBa
therefore writes an optional `agent_identity` envelope on every newly emitted
session-log record when the session was created from a CatsCompany route:

```json
{
  "agent_identity": {
    "agent_id": "usr407",
    "agent_body_id": "body-main",
    "trust": "server_canonical",
    "source": "metadata.catsco_identity"
  }
}
```

`agent_id` comes from the already parsed `SessionRoute`, never from a user or
assistant message. `trust` preserves whether CatsCompany supplied a verified
identity (`server_canonical`) or XiaoBa used its existing local/legacy context.
`agent_body_id` and `source` are optional provenance, not authorization.

This is deliberately independent from `session_id`. In particular, existing
CatsCompany group sessions keep their `cc_group:*` runtime key and legacy
restore behavior; changing that key solely for analytics would fragment live
context and break compatibility.

CatsLog should consume this envelope only after validating the uploaded JSONL:

1. inspect record metadata, not user/assistant/event text;
2. require at most one non-empty `agent_id` per stream (reject or quarantine a
   conflict);
3. persist the selected value and trust level with stream provenance; and
4. leave historic streams without the envelope unlabelled rather than guessing.

## CatsLog v2 client behavior

The client negotiates `upload_protocol: 2` only from bootstrap. It then sends
newline-aligned JSONL chunks to the server-advertised `append_url`, with a
persisted byte offset, opaque revision, and stable request ID. A lost response
is retried with the identical request ID; an unprovable offset conflict falls
back to the established v1 whole-snapshot upload instead of guessing that two
prefixes are equal. One stream is always sequential, while independent stable
files use up to three concurrent requests by default (`CATSCO_LOG_MAX_CONCURRENT_UPLOADS`, capped at 8).

Bootstrap also retains the short-lived, device-bound Skill capability. A local
operator can read only that bound principal's Skills through `catsco catslog
skills`; no UID flag exists. Returned Skill content remains explicitly
`untrusted_runtime_skill` and is printed as data rather than injected into a
prompt.

All of this remains independent from runtime session routing and existing JSONL
readers. CatsLog still needs to implement the metadata reader above before its
analysis index can use `agent_identity`.
