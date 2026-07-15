# Official xURL Rendered Timeline Is the External Reader Contract

Status: accepted

XiaoBa invokes the unmodified official xURL CLI through its documented `agents://` URI interface and consumes its provider-neutral rendered Timeline. XiaoBa does not add a private `session-log-v1` command, fork xURL, parse Codex/Claude/Pi source formats, or fall back to guessing an unrecognized rendering.

The adapter validates xURL's numbered User, Assistant, and Context Compacted entries and derives each external event from the provider identity, thread identity, normalized ordinal range, and content fingerprint. A newly enabled provider completes a bounded, resumable, non-admitting baseline before continuous admission; later rendering changes are accepted only when existing normalized event fingerprints remain compatible, otherwise that provider fails closed.

This choice accepts a thin renderer-contract parser and a one-time activation baseline in exchange for using xURL as the sole provider-specific integration module. It avoids duplicating xURL's provider parsers while retaining future-only admission, mutation detection, and source-local failure isolation.
