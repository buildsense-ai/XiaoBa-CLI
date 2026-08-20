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

Until CatsLog implements that reader, this release is backward-compatible log
provenance: it does not alter upload authentication, runtime session routing,
or existing JSONL readers.
