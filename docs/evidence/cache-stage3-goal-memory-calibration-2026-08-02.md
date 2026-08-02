# Stage 3 Goal and Memory cache calibration — 2026-08-02

This is a redacted calibration record, not cache acceptance evidence. It contains no credentials,
provider endpoints, prompt bodies, response bodies, or memory-record contents. The authoritative
raw evidence remains in the private repository-external benchmark directories.

## Scope closed in this stage

- Typed Goal state is validated, atomically persisted, restored, injected with `goal_status`
  provenance, cleared with a migration tombstone, and rolled back on persistence failure.
- Every workload executes the real Memory Branch. Published refs require a successful branch-local
  read receipt and a matching model-visible content fingerprint; model self-report is insufficient.
- The online memory fixture is isolated from global/workspace logs and held by a sealed descriptor.
  Inode, path, directory, byte fingerprint, and before/after call checks detect replacement or
  mutation.
- All physical main and branch provider attempts remain in journal order and token-weighted
  scoring. A branch logical call may contain 1–N physical attempts.
- DeepSeek synthetic-observation lowering retains trusted lifecycle metadata, including
  `late_previous_turn` timing.
- Credential reads use the same opened and validated descriptor. Production memory reads reject
  symlink components and verify regular-file identity.

## Provider cache-mode probe

The NewCLI Responses adapter was probed with five exact repeats before selecting a cache mode:

| mode | input tokens per call | provider cache-read tokens |
| --- | ---: | --- |
| automatic | 19,168 | 0, 0, 0, 18,176, 0 |
| `openai-key` | 19,170 | 0, 18,176, 18,176, 18,176, 18,176 |

`openai-key` was retained. The warm difference of roughly 994 tokens demonstrates a provider-side
fresh-token floor; local request fingerprints alone cannot classify those tokens as cache hits.

## Real calibration results

Both providers used one required cold logical call and one warm logical call for each of four main
tasks and four paired Memory Branch cases. Ratios include all physical attempts and use only the
provider usage field configured in the manifest.

| run | artifact | physical attempts | cache-read / input tokens | raw ratio | capped-task ratio | capability coverage | result |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| NewCLI v4 | `sha256:2f203528…` | 43 | 72,192 / 138,659 | 52.06% | 51.14% | complete | diagnostic failure |
| DeepSeek v4 | `sha256:2f203528…` | 43 | 119,936 / 182,127 | 65.85% | 64.79% | complete | diagnostic failure |
| NewCLI v5 | `sha256:90d4b0e6…` | 39 | 53,760 / 125,642 | 42.79% | 41.87% | complete | ratio failure |
| DeepSeek v5 | `sha256:90d4b0e6…` | 38 | 104,576 / 158,181 | 66.11% | 65.30% | complete | ratio failure |

The v4 runner incorrectly allowed a non-memory workload to publish an unrelated ref; a shared
benchmark token made that defect observable on DeepSeek. The raw run was preserved as failed
calibration. v5 requires publication only for the memory-only workload, requires suppression for
the other three, uses a unique action oracle, and binds the published ref to the successful read
digest. Both v5 rounds sealed with complete capability, quality, and safety attestation; they fail
only the 94% raw and capped-task ratio gates.

## Verification

- `npm run build`: passed.
- Official `npm test`: 1,483 tests; 1,475 passed; 0 failed; 0 cancelled; 8 skipped.
- Independent read-only review rechecked Goal persistence, memory receipts and sealing, DeepSeek
  lowering, credential and memory-path TOCTOU defenses, joined-branch cleanup, and physical journal
  order. It found no Stage 3 acceptance blocker.
- No dashboard or other UI files changed, so desktop/mobile visual testing was not applicable.

## What this stage does not claim

The fixed short workload is intentionally a capability and evidence-chain calibration. Repeating it
cannot establish a representative 94% average: short NewCLI requests retain an approximately
1,000-token fresh floor, while Memory Branch search/read/finish loops add multiple growing physical
requests. Final acceptance therefore requires capability-preserving prefix planning plus naturally
growing multi-turn and real-project workloads, including production-default detached memory and
late observation behavior, followed by three consecutive qualifying rounds per provider.
