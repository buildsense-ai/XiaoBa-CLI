# Stage 4 synthetic-observation wire identity calibration — 2026-08-02

This is a redacted calibration record, not cache acceptance evidence. It contains no credentials,
provider endpoints, prompt bodies, response bodies, or memory-record contents. The authoritative
raw evidence remains in private repository-external benchmark directories.

## Scope closed in this stage

- Synthetic observations keep their unique internal observation and branch provenance for audit,
  attestation, and correlation, but those random lifecycle identifiers no longer enter the
  provider-visible tool-call ID.
- The provider-visible ID is derived from the complete model-visible synthetic pair: canonical tool
  arguments plus tool output. Equivalent visible observations therefore serialize identically
  across different internal branch IDs, while visible content changes produce a different ID.
- A stable request-local ordinal preserves unique assistant/tool pairing when equivalent
  observations arrive in separate tool-loop drains. Existing tool-call and tool-result IDs in the
  growing request are both considered, so request preflight cannot discard a later pair as a
  duplicate.
- The same identity rule is covered through OpenAI Responses and Chat serialization. DeepSeek v4
  continues to lower the valid synthetic pair to its supported Chat envelope without exposing
  internal provenance.

## Rejected prefix-placement experiments

Two broader placement experiments were tested and then fully reverted before the final candidate.
They are retained as negative calibration evidence:

| experiment | behavior | NewCLI cache-read / input | raw ratio | capped-task ratio | disposition |
| --- | --- | ---: | ---: | ---: | --- |
| absolute epoch prefix | moved typed epoch system context ahead of the durable transcript | 45,056 / 119,990 | 37.55% | 36.64% | reverted |
| episode-boundary epoch | kept typed epoch context at the core-inserted episode boundary | 39,936 / 104,132 | 38.35% | 37.62% | reverted |

The first arrangement also has a structural defect independent of the noisy live ratio: changing
an epoch event at the start of the next logical call invalidates the durable transcript prefix. The
second arrangement preserves more cross-call prefix but cannot preserve the complete prior tool
history. Neither is the append-only lifecycle required for final acceptance.

## Final-candidate real calibration

Both providers ran the real four-task Goal/Memory workload with one required cold logical call and
one warm logical call per task. Every physical Memory Branch attempt remains in token-weighted
scoring. Cache-read values below come only from the provider usage fields bound by the manifest.

| run | artifact | physical attempts | cache-read / input | raw ratio | capped-task ratio | capability / quality / safety | result |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| NewCLI v2 | `sha256:5a0c7ea4...` | 34 | 41,984 / 112,719 | 37.25% | 35.98% | passed / passed / passed | ratio failure |
| DeepSeek v2 | `sha256:5a0c7ea4...` | 38 | 97,920 / 157,930 | 62.00% | 61.15% | passed / failed / passed | diagnostic failure |
| DeepSeek v3 | `sha256:5a0c7ea4...` | 37 | 98,688 / 152,342 | 64.78% | 63.56% | passed / passed / passed | ratio failure |

NewCLI's final-candidate split was 23,552 / 61,763 (38.13%) for main attempts and
18,432 / 50,956 (36.17%) for Memory Branch attempts. DeepSeek v3 was 29,568 / 71,245
(41.50%) for main attempts and 69,120 / 81,097 (85.23%) for Memory Branch attempts.

DeepSeek v2 is intentionally retained as a failed sample. In one warm non-memory task, the Memory
Branch broadened its search, selected the unrelated authorized archive record, and published it;
the branch quality oracle rejected all seven physical attempts in that logical call. The linked
main answer still passed, but the scorer correctly failed the whole round. An unchanged-artifact v3
rerun suppressed irrelevant memory in that task and passed every capability, quality, and safety
attestation. This failure/rerun pair demonstrates that the gate records model retrieval drift rather
than hiding it.

The usage sources were `openai.input_tokens_details.cached_tokens` for NewCLI Responses and
`openai.prompt_tokens_details.cached_tokens` for the DeepSeek-compatible Chat endpoint. The final
artifact fingerprint was
`sha256:5a0c7ea4385df2902fa895a04dbce8a035bee2e337a59289921c447792481142`.

## Verification

- Targeted synthetic observation, ConversationRunner, provider serialization, DeepSeek lowering,
  and preflight coverage: 72 tests passed.
- `npm run build`: passed.
- Official `npm test`: 1,489 tests; 1,481 passed; 0 failed; 0 cancelled; 8 skipped.
- Independent read-only review rechecked digest coverage, cross-drain uniqueness, retry and restore
  behavior, provider lowering, internal attestation provenance, and the request-preflight boundary.
  It found no blocker.
- No dashboard or other UI files changed, so desktop/mobile visual testing was not applicable.

## What this stage does not claim

This stage removes one random provider-visible prefix contaminant; it does not claim a measurable
single-round ratio improvement or meet the 94% acceptance threshold. The short one-warm-call
calibration remains dominated by required cold calls, provider cache admission variance, and
growing Memory Branch tool loops. The next stage must introduce an append-only lifecycle event
stream for durable memory/runtime/state events and add naturally growing detached and real-project
workloads before collecting three consecutive acceptance rounds per provider.
