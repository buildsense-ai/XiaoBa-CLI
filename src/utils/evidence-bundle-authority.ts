/**
 * Explicit authority carried by an Evidence Bundle.
 *
 * Bundle IDs remain useful for human-readable tracing, but they are not a
 * security boundary. Review mutation policy must use this typed authority
 * marker and only use legacy bundle-ID classification for persisted bundles
 * created before the marker existed.
 */
export type EvidenceBundleAuthority =
  | { kind: 'learning-episode'; episodeId: string }
  | { kind: 'usage-reassessment'; targetCapabilityHandle: string }
  | { kind: 'semantic-reassessment'; targetCapabilityHandle: string }
  | { kind: 'flashcard'; episodeId: string }
  | { kind: 'operator-control'; targetCapabilityHandle: string };

export type EvidenceBundleFamily = EvidenceBundleAuthority['kind'] | 'legacy-generic';

export interface EvidenceBundleAuthorityClassification {
  family: EvidenceBundleFamily;
  authority?: EvidenceBundleAuthority;
  legacy: boolean;
  missingAuthority?: boolean;
  malformedAuthority?: boolean;
  episodeId?: string;
  targetCapabilityHandle?: string;
}

interface BundleAuthorityInput {
  bundleId: string;
  authority?: unknown;
  episode?: unknown;
}

export function isEvidenceBundleAuthority(value: unknown): value is EvidenceBundleAuthority {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    kind?: unknown;
    episodeId?: unknown;
    targetCapabilityHandle?: unknown;
  };
  switch (candidate.kind) {
    case 'learning-episode':
    case 'flashcard':
      return isNonEmptyString(candidate.episodeId);
    case 'usage-reassessment':
    case 'semantic-reassessment':
    case 'operator-control':
      return isNonEmptyString(candidate.targetCapabilityHandle);
    default:
      return false;
  }
}

/**
 * New review admission and every mutation boundary require an explicit marker.
 * Bundle IDs are deliberately ignored here: prefix inference is reserved for
 * migratePersistedEvidenceBundleAuthority at the durable Job load/fence seam.
 */
export function requireExplicitEvidenceBundleAuthority(
  bundle: BundleAuthorityInput,
): EvidenceBundleAuthority {
  if (bundle.authority === undefined) {
    throw new Error('Evidence Bundle authority is missing.');
  }
  if (!isEvidenceBundleAuthority(bundle.authority)) {
    throw new Error('Evidence Bundle authority is malformed.');
  }
  return bundle.authority;
}

export function semanticPriorGuidanceEvidenceRef(
  targetCapabilityHandle: string,
  guidanceHash: string,
): string {
  return `registry:${targetCapabilityHandle}:prior-guidance:${guidanceHash}`;
}

/** Match a stable handle or route as a complete identifier, never a substring. */
export function containsExactStableIdentifier(text: string, identifier: string): boolean {
  const normalizedText = text.normalize('NFKC').toLowerCase();
  const normalizedIdentifier = identifier.normalize('NFKC').toLowerCase().trim();
  if (!normalizedIdentifier) return false;
  const escaped = normalizedIdentifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`,
    'u',
  ).test(normalizedText);
}

/**
 * Classify only the explicit marker. Missing markers stay unclassified here;
 * durable legacy migration is owned by migratePersistedEvidenceBundleAuthority.
 */
export function classifyEvidenceBundleAuthority(
  bundle: BundleAuthorityInput,
): EvidenceBundleAuthorityClassification {
  if (bundle.authority !== undefined) {
    if (!isEvidenceBundleAuthority(bundle.authority)) {
      return { family: 'legacy-generic', legacy: false, malformedAuthority: true };
    }
    const authority = bundle.authority;
    return {
      family: authority.kind,
      authority,
      legacy: false,
      ...(authority.kind === 'learning-episode' ? { episodeId: authority.episodeId } : {}),
      ...(
        authority.kind === 'usage-reassessment'
        || authority.kind === 'semantic-reassessment'
        || authority.kind === 'flashcard'
        || authority.kind === 'operator-control'
          ? (
            authority.kind === 'flashcard'
              ? { episodeId: authority.episodeId }
              : { targetCapabilityHandle: authority.targetCapabilityHandle }
          )
          : {}
      ),
    };
  }
  // Missing authority is deliberately unclassified here. Prefix inference is
  // allowed only inside migratePersistedEvidenceBundleAuthority, where the
  // durable Job seam can require a structural payload match before creating a
  // successor. New bundles and mutation callers must never use this fallback.
  return { family: 'legacy-generic', legacy: true, missingAuthority: true };
}

/**
 * One explicit compatibility boundary for pre-authority persisted Jobs.
 *
 * The returned bundle always carries a real marker, so every successor and
 * mutation path can use the same fail-closed rules as newly-created work.
 * Only a small set of legacy payloads with mutually-checked identity fields
 * receives successor authority. An unclassifiable bundle remains dormant
 * instead of inheriting a broad transition vocabulary.
 */
export function migratePersistedEvidenceBundleAuthority<
  T extends BundleAuthorityInput,
>(bundle: T): (T & { authority: EvidenceBundleAuthority }) | undefined {
  if (bundle.authority !== undefined) {
    return isEvidenceBundleAuthority(bundle.authority)
      ? bundle as T & { authority: EvidenceBundleAuthority }
      : undefined;
  }
  const bundleId = typeof bundle.bundleId === 'string' ? bundle.bundleId : '';
  const episode = asRecord(bundle.episode);

  // Old Learning Episode jobs retain the derived candidate rather than the
  // original Episode object. Its deterministic capability ID is therefore the
  // second identity needed to corroborate the Bundle ID.
  const learningEpisodeId = exactSuffix(bundleId, 'v3:learning-episode:');
  const learningCandidateId = stringField(episode, 'capabilityId');
  const localLearningCandidateId = learningEpisodeId
    ? `episode-capability-${learningEpisodeId.slice('episode-'.length)}`
    : undefined;
  const capsuleLearningCandidateId = learningEpisodeId
    ? `capsule-${learningEpisodeId.replace(/^episode-/, '')}`
    : undefined;
  if (
    learningEpisodeId
    && (
      learningCandidateId === localLearningCandidateId
      || learningCandidateId === capsuleLearningCandidateId
    )
  ) {
    return {
      ...bundle,
      authority: { kind: 'learning-episode', episodeId: learningEpisodeId },
    };
  }

  const usageMatch = /^usage-curation:([^:]+):.+$/.exec(bundleId);
  const usageTarget = stringField(episode, 'capabilityHandle');
  if (usageMatch && episode?.kind === 'usage-reassessment' && usageTarget === usageMatch[1]) {
    return {
      ...bundle,
      authority: { kind: 'usage-reassessment', targetCapabilityHandle: usageTarget },
    };
  }

  const semanticMatch = /^semantic-reassessment:([^:]+):.+$/.exec(bundleId);
  const semanticTarget = stringField(episode, 'capabilityHandle');
  if (semanticMatch && semanticTarget === semanticMatch[1]) {
    return {
      ...bundle,
      authority: { kind: 'semantic-reassessment', targetCapabilityHandle: semanticTarget },
    };
  }

  // Flashcard composition is the only legacy family-specific path retained.
  // Its workflow marker, Episode ID, and bundle ID must all agree.
  const flashcardEpisodeId = exactSuffix(bundleId, 'flashcard-');
  const flashcardPayloadId = stringField(episode, 'episodeId');
  if (
    flashcardEpisodeId
    && flashcardPayloadId === flashcardEpisodeId
    && stringField(episode, 'workflow') === 'flashcard correction and verified retry'
  ) {
    return {
      ...bundle,
      authority: { kind: 'flashcard', episodeId: flashcardEpisodeId },
    };
  }

  // Operator control was introduced with explicit authority and has no
  // trustworthy pre-authority form. Unknown operator jobs stay dormant.
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactSuffix(value: string, prefix: string): string | undefined {
  if (!value.startsWith(prefix)) return undefined;
  const suffix = value.slice(prefix.length);
  return suffix || undefined;
}
