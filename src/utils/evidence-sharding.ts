/**
 * Compatibility re-export of Deterministic Evidence Sharding (#106 package).
 * Prefer importing from `./evidence-review` for new code.
 */
export {
  DEFAULT_SHARD_HARD_LIMIT_BYTES,
  DEFAULT_SHARD_SOFT_LIMIT_BYTES,
  hashEvidenceBundle,
  hashEvidenceContent,
  makeShardId,
  shardEvidenceBundle,
  verifyShardContent,
} from './evidence-review';
export type { ShardingOptions, ShardEvidenceBundleResult } from './evidence-review';
