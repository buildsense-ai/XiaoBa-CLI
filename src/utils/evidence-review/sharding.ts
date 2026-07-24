/**
 * Deterministic Evidence Sharding — Runtime-owned partition of an Evidence Bundle.
 *
 * Partitions first along stable domain boundaries (episode, completion,
 * settlement, continuity, Referenced Skills, related Current Skills, semantic
 * observations, source windows). An oversized domain unit is split recursively
 * along its own stable structure (paragraph → line → byte). Models never create,
 * omit, or redefine shard boundaries. Identity never depends on a tokenizer.
 */

import type { EvidenceBundle } from '../skill-evolution';
import { hashEvidenceContent, sha256Hex, stableStringify } from './canonical';
import type {
  EvidenceBundleManifest,
  EvidenceShard,
  EvidenceShardDomainKind,
  EvidenceShardSpan,
} from './types';

/** Soft content budget for one shard before recursive split (bytes). */
export const DEFAULT_SHARD_SOFT_LIMIT_BYTES = 12_000;

export interface ShardingOptions {
  softLimitBytes?: number;
  /**
   * When true (default), a whole bundle that already fits the soft limit is
   * emitted as one `bundle_remainder` shard for one-shard tracer jobs.
   * Multi-shard tests set this false to force domain partitioning.
   */
  preferSingleShardWhenFits?: boolean;
}

export interface ShardEvidenceBundleResult {
  readonly manifest: EvidenceBundleManifest;
  readonly shards: readonly EvidenceShard[];
}

interface DomainUnit {
  domainKind: EvidenceShardDomainKind;
  sourceIdentity: string;
  content: string;
}

export function makeShardId(
  domainKind: EvidenceShardDomainKind,
  contentHash: string,
  index: number,
): string {
  return `shard:${domainKind}:${contentHash.slice(0, 16)}:${index}`;
}

export function hashEvidenceBundle(bundle: EvidenceBundle): string {
  return hashEvidenceContent(stableStringify(bundle));
}

function domainUnitsFromBundle(bundle: EvidenceBundle): DomainUnit[] {
  const units: DomainUnit[] = [];

  units.push({
    domainKind: 'episode',
    sourceIdentity: `episode:${bundle.bundleId}`,
    content: stableStringify(bundle.episode ?? null),
  });

  for (const [index, item] of (bundle.completionEvidence ?? []).entries()) {
    units.push({
      domainKind: 'completion_evidence',
      sourceIdentity: typeof item?.ref === 'string' ? item.ref : `completion:${index}`,
      content: stableStringify(item),
    });
  }

  for (const [index, item] of (bundle.settlementEvidence ?? []).entries()) {
    units.push({
      domainKind: 'settlement_evidence',
      sourceIdentity: typeof item?.ref === 'string' ? item.ref : `settlement:${index}`,
      content: stableStringify(item),
    });
  }

  if (bundle.boundedContinuity?.length) {
    units.push({
      domainKind: 'bounded_continuity',
      sourceIdentity: `continuity:${bundle.bundleId}`,
      content: stableStringify(bundle.boundedContinuity),
    });
  }

  for (const [index, skill] of (bundle.referencedSkills ?? []).entries()) {
    const name = typeof (skill as { name?: string })?.name === 'string'
      ? (skill as { name: string }).name
      : `referenced:${index}`;
    units.push({
      domainKind: 'referenced_skill',
      sourceIdentity: name,
      content: stableStringify(skill),
    });
  }

  for (const [index, skill] of (bundle.relatedCurrentSkills ?? []).entries()) {
    const handle = typeof (skill as { handle?: string })?.handle === 'string'
      ? (skill as { handle: string }).handle
      : `related:${index}`;
    units.push({
      domainKind: 'related_current_skill',
      sourceIdentity: handle,
      content: stableStringify(skill),
    });
  }

  if (bundle.semanticObservations?.length) {
    units.push({
      domainKind: 'semantic_observations',
      sourceIdentity: `semantic:${bundle.bundleId}`,
      content: stableStringify(bundle.semanticObservations),
    });
  }

  // Source windows are independent domain units so large windows split alone.
  for (const [index, item] of (bundle.sourceEvidence ?? []).entries()) {
    units.push({
      domainKind: 'source_evidence',
      sourceIdentity: typeof item?.ref === 'string' ? item.ref : `source:${index}`,
      content: stableStringify(item),
    });
  }

  return units;
}

function packParts(parts: readonly string[], limit: number, joiner: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    const candidate = current ? `${current}${joiner}${part}` : part;
    if (Buffer.byteLength(candidate, 'utf8') <= limit) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    if (Buffer.byteLength(part, 'utf8') <= limit) {
      current = part;
    } else {
      // Leave oversized atomic parts for the next recursion level.
      out.push(part);
      current = '';
    }
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [''];
}

/**
 * Split on the coarsest stable internal structure that actually reduces size.
 * Returns null when no structural split is possible (caller falls back to bytes).
 */
function tryStructuralSplit(content: string, limit: number): string[] | null {
  if (Buffer.byteLength(content, 'utf8') <= limit) return [content];

  const paragraphParts = content.split(/\n{2,}/);
  if (paragraphParts.length > 1) {
    const packed = packParts(paragraphParts, limit, '\n\n');
    if (packed.length > 1 || packed[0] !== content) return packed;
  }

  const lineParts = content.split('\n');
  if (lineParts.length > 1) {
    const packed = packParts(lineParts, limit, '\n');
    if (packed.length > 1 || packed[0] !== content) return packed;
  }

  // JSON array / object-ish boundaries (turns, blocks).
  const turnish = content.split(/(?<=\})\s*,\s*(?=\{)/);
  if (turnish.length > 1) {
    const packed = packParts(turnish, limit, ',');
    if (packed.length > 1 || packed[0] !== content) return packed;
  }

  return null;
}

/** Final fallback: split on stable UTF-8 byte boundaries without breaking codepoints. */
export function splitByStableBytes(content: string, limit: number): string[] {
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length <= limit) return [content];
  const out: string[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    let end = Math.min(buffer.length, offset + limit);
    // Back up so we do not split a multi-byte UTF-8 sequence.
    while (end > offset && (buffer[end]! & 0xc0) === 0x80) end -= 1;
    if (end === offset) end = Math.min(buffer.length, offset + limit);
    out.push(buffer.subarray(offset, end).toString('utf8'));
    offset = end;
  }
  return out;
}

/**
 * Recursively split one domain unit until every piece fits `softLimit`.
 * Structure first; stable bytes only when structure cannot reduce further.
 */
export function recursivelySplitContent(
  content: string,
  softLimit: number,
): string[] {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= softLimit) return [content];

  const structural = tryStructuralSplit(content, softLimit);
  if (structural && structural.length > 1) {
    return structural.flatMap(piece => recursivelySplitContent(piece, softLimit));
  }

  // Structure could not reduce; fall back to byte boundaries at soft limit.
  return splitByStableBytes(content, Math.max(1, softLimit));
}

function locateOriginSpan(original: string, piece: string, fromOffset: number): EvidenceShardSpan {
  // Prefer exact byte-window match when the piece was a contiguous substring.
  const buffer = Buffer.from(original, 'utf8');
  const pieceBuf = Buffer.from(piece, 'utf8');
  const searchFrom = Math.min(fromOffset, buffer.length);
  const idx = buffer.indexOf(pieceBuf, searchFrom);
  if (idx >= 0) {
    return { start: idx, end: idx + pieceBuf.length };
  }
  // Non-contiguous structural reassembly (rare): report whole unit.
  return { start: 0, end: buffer.length };
}

function shardFromUnit(
  unit: DomainUnit,
  content: string,
  index: number,
  originSpan?: EvidenceShardSpan,
): EvidenceShard {
  const contentHash = hashEvidenceContent(content);
  return {
    shardId: makeShardId(unit.domainKind, contentHash, index),
    domainKind: unit.domainKind,
    sourceIdentity: unit.sourceIdentity,
    contentHash,
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
    ...(originSpan ? { originSpan } : {}),
  };
}

/**
 * Partition a frozen Evidence Bundle into content-addressed Evidence Shards.
 *
 * - Whole bundle ≤ soft limit → one `bundle_remainder` (unless forced multi-shard).
 * - Otherwise → one domain unit per stable evidence member, recursively split.
 */
export function shardEvidenceBundle(
  bundle: EvidenceBundle,
  options: ShardingOptions = {},
): ShardEvidenceBundleResult {
  const softLimit = Math.max(1, options.softLimitBytes ?? DEFAULT_SHARD_SOFT_LIMIT_BYTES);
  const preferSingle = options.preferSingleShardWhenFits !== false;

  const whole = stableStringify(bundle);
  const wholeBytes = Buffer.byteLength(whole, 'utf8');

  let shards: EvidenceShard[];

  if (preferSingle && wholeBytes <= softLimit) {
    const contentHash = hashEvidenceContent(whole);
    shards = [{
      shardId: makeShardId('bundle_remainder', contentHash, 0),
      domainKind: 'bundle_remainder',
      sourceIdentity: `bundle:${bundle.bundleId}`,
      contentHash,
      content: whole,
      byteLength: wholeBytes,
    }];
  } else {
    const units = domainUnitsFromBundle(bundle);
    const expanded: EvidenceShard[] = [];
    let index = 0;
    for (const unit of units) {
      const pieces = recursivelySplitContent(unit.content, softLimit);
      let searchFrom = 0;
      for (const piece of pieces) {
        const originSpan = pieces.length > 1
          ? locateOriginSpan(unit.content, piece, searchFrom)
          : undefined;
        if (originSpan) searchFrom = originSpan.end;
        expanded.push(shardFromUnit(unit, piece, index++, originSpan));
      }
    }
    shards = expanded;
  }

  // Stable order by shardId for reproducible manifests.
  shards = [...shards].sort((a, b) => a.shardId.localeCompare(b.shardId, 'en'));

  const contentHashes = shards.map(s => s.contentHash);
  const shardIds = shards.map(s => s.shardId);
  const manifestHash = sha256Hex(stableStringify({
    bundleId: bundle.bundleId,
    shardIds,
    contentHashes,
  }));

  const manifest: EvidenceBundleManifest = {
    manifestId: `manifest:${manifestHash.slice(0, 24)}`,
    manifestHash,
    bundleId: bundle.bundleId,
    shardIds,
    contentHashes,
    // Pure foundation uses a fixed epoch so identity is content-only.
    createdAt: new Date(0).toISOString(),
  };

  return { manifest, shards };
}

/** Re-hash shard content and compare to the stored content hash. */
export function verifyShardContent(shard: EvidenceShard): boolean {
  return hashEvidenceContent(shard.content) === shard.contentHash
    && Buffer.byteLength(shard.content, 'utf8') === shard.byteLength;
}
