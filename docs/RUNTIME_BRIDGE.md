# Runtime host adapter contract

`xiaoba-runtime-bridge` is the supported process boundary for a host that
needs one isolated Runtime Learning wake. It is a release artifact, compiled
from `src/runtime-bridge.ts` to `dist/runtime-bridge.js`.

This adapter does not change Runtime Learning. It owns no learning policy,
state format, scheduler behavior, or session-log parsing. Its only job is to
construct the existing XiaoBa runtime for a caller-provided isolated root and
return a small, versioned result.

## Supported commands

```sh
xiaoba-runtime-bridge describe
(
  cd /srv/runtime/tenant-a
  CATSLOG_RUNTIME_ROOT="$PWD" xiaoba-runtime-bridge wake
)
```

`describe` emits JSON with `protocol_version`, `xiaoba_version`, and the
supported commands. `wake` emits JSON with `protocol_version`, `status`,
`ran`, `units_processed`, and `advanced_files`.

`wake` requires an existing directory as `CATSLOG_RUNTIME_ROOT`, and the
current working directory must resolve to that same directory. It uses the
normal XiaoBa data-root settings for that directory, disables CatsLog upload,
and disables external session sources. A host must provide an isolated root
per tenant and must not share it across concurrent wakes.

## Compatibility rules

- Protocol version 1 supports only `describe` and `wake`.
- New optional response fields and commands are additive. A breaking request
  or response change requires a new protocol version.
- Hosts must call `describe` before accepting work and reject an unsupported
  protocol version.
- Hosts must call only this executable. They must not import files under
  `dist/utils/` or depend on XiaoBa's internal module layout.

The bridge is an integration edge, not a second Runtime Learning
implementation. Changes to it must preserve the behavior of the existing
Runtime Learning runtime.
