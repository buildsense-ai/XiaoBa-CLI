# Skill Evolution Data Flow and Authoritative Owners

## Status

Current as of the slimming pass (PR #216). This note explains the authoritative
owners and data flow for Skill Evolution so maintainers can navigate the
durable review pipeline without guessing where state lives.

## Data flow

```
Session History
  → Learning Episode (LearningEpisodeStore.applyExtraction, idempotent by episodeId)
    → Evidence Bundle (EvidenceCapsuleStore, pinned at admission)
      → Evidence Review Job (EvidenceReviewJobStore, durable graph of Review Quanta)
        → Commit / Audit (TransitionAuditEntry, TransitionJournal)
          → Current Skill Registry (CurrentSkillRegistry)
```

### Stage owners

| Stage | Durable owner | File | Key invariant |
|-------|---------------|------|---------------|
| Learning Episode | `LearningEpisodeStore` | `data/learning-episodes.json` | Idempotent by `episodeId`; replay merges, never duplicates. |
| Evidence Capsule | `EvidenceCapsuleStore` | `data/evidence-capsules.json` | Pinned at admission; `findByBundleId` deduplication. |
| External Episode Provenance | `ExternalEpisodeProvenanceStore` | `data/external-source-provenance.json` | Idempotent by event key; `record()` is a Set-merge no-op on replay. |
| Evidence Review Job | `EvidenceReviewJobStore` | `data/evidence-review-jobs.json` | Durable graph of Review Quanta; progress derived from node states. Single owner of retry/defer state. |
| Transition Audit | `TransitionAuditEntry` | `data/transition-audit.jsonl` | Append-only audit of every Capability Transition. |
| Current Skill Registry | `CurrentSkillRegistry` | `data/current-skill-registry.json` | Optimistic-concurrency revision; journaled updates. |

### Recovery boundaries

1. **Episode → Capsule**: Episode is durably persisted before Capsule creation.
   A crash before Capsule creation leaves the Episode replayable; the next
   admission re-derives the Capsule from the same Episode.

2. **Capsule → Provenance**: Provenance is flushed after Capsule creation.
   A crash before provenance flush leaves the Capsule without provenance;
   replay repairs both before cursor acknowledgement.

3. **Provenance → Cursor acknowledgement**: Cursor acknowledgement is the final
   durable step for non-backfill lanes and is owned by the source adapter's
   `acknowledge()` call. Backfill pages skip the adapter ACK — their cursor
   advancement is lane-owned and outside this coordinator's commit boundary.
   A crash before cursor ack leaves the event replayable; re-admission is
   idempotent (no duplicate Episode, Capsule, or provenance) because each
   store deduplicates by its primary key.

4. **Review Job → Commit**: The commit quantum is the final durable
   `SkillEvolutionResult`. A crash after commit quantum success but before
   the caller reads the result must reconstruct from the persisted commit
   quantum, never from the draft intent or disposition.

## Single ownership of retry/defer state

The Evidence Review Job store (`evidence-review-jobs.json`) is the single
durable owner of review retry/defer state after the Round 9 consolidation.

1. **EvidenceReviewJob** (`evidence-review-jobs.json`): the durable graph owner.
   Jobs carry `disposition: 'deferred'` with a `deferState` bag recording the
   reviewer version, reason, and defer time. The immutable Review Basis owns
   the Registry read-set and evidence bundle hash used for re-eligibility.
   Operational failures live directly on the failed Review Quantum:
   `retry_wait`, attempts, current delay, failure metadata, and next retry
   time. The engine applies fair work-class rotation through the sole
   execution path.

See [Progressive Trust for Skill Evolution](./skill-evolution-progressive-trust.md)
for the acceptance policy that governs Author/Verifier decisions inside these
boundaries.
