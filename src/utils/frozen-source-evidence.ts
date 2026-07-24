import type { BoundedSourceEvidence, SkillEvidenceRef } from './skill-evolution';

export interface FrozenSourceEvidenceValidationProfile {
  maxEntries?: number;
  maxPayloadBytes?: number;
  maxContentBytes?: number;
  requireMetadataMatch?: boolean;
  requireCompletionCoverage?: boolean;
  requireSettlementCoverage?: boolean;
}

export type FrozenSourceEvidenceFailureCode =
  | 'missing'
  | 'malformed'
  | 'oversized'
  | 'duplicate'
  | 'incomplete'
  | 'metadata-mismatch';

export interface FrozenSourceEvidenceFailure {
  code: FrozenSourceEvidenceFailureCode;
  ref?: string;
  message: string;
}

export interface FrozenSourceEvidenceValidationInput {
  completionEvidence: readonly SkillEvidenceRef[];
  settlementEvidence: readonly SkillEvidenceRef[];
  sourceEvidence?: readonly BoundedSourceEvidence[];
}

/**
 * Pure structural validator shared by Episode admission, bundle validation,
 * and persisted-review quarantine. It deliberately does not decide whether
 * an evidence source is semantically trustworthy; it only proves that the
 * frozen refs have bounded, role-correct, optionally identity-matching source
 * content.
 */
export function validateFrozenSourceEvidence(
  input: FrozenSourceEvidenceValidationInput,
  profile: FrozenSourceEvidenceValidationProfile = {},
): FrozenSourceEvidenceFailure | undefined {
  const {
    completionEvidence,
    settlementEvidence,
    sourceEvidence,
  } = input;
  if (sourceEvidence === undefined) {
    return { code: 'missing', message: 'source evidence is missing' };
  }
  if (!Array.isArray(sourceEvidence)) {
    return { code: 'malformed', message: 'source evidence is malformed' };
  }

  const maxEntries = profile.maxEntries;
  if (maxEntries !== undefined && sourceEvidence.length > maxEntries) {
    return {
      code: 'oversized',
      message: `source evidence exceeds ${maxEntries} entries`,
    };
  }
  if (profile.maxPayloadBytes !== undefined) {
    let payloadBytes: number;
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(sourceEvidence), 'utf8');
    } catch {
      return { code: 'malformed', message: 'source evidence is not serializable' };
    }
    if (payloadBytes > profile.maxPayloadBytes) {
      return {
        code: 'oversized',
        message: `source evidence exceeds ${profile.maxPayloadBytes} bytes`,
      };
    }
  }

  const completionRefs = completionEvidence.map(item => item.ref);
  const settlementRefs = settlementEvidence.map(item => item.ref);
  if (
    completionRefs.some(ref => typeof ref !== 'string' || !ref.trim())
    || settlementRefs.some(ref => typeof ref !== 'string' || !ref.trim())
  ) {
    return { code: 'malformed', message: 'evidence refs are malformed' };
  }
  if (new Set(completionRefs).size !== completionRefs.length) {
    return { code: 'duplicate', message: 'completion evidence contains duplicate refs' };
  }
  if (new Set(settlementRefs).size !== settlementRefs.length) {
    return { code: 'duplicate', message: 'settlement evidence contains duplicate refs' };
  }

  const sourceByRef = new Map<string, BoundedSourceEvidence>();
  for (const source of sourceEvidence) {
    if (!source || typeof source !== 'object' || typeof source.ref !== 'string' || !source.ref.trim()) {
      return { code: 'malformed', message: 'source evidence contains an invalid ref' };
    }
    if (sourceByRef.has(source.ref)) {
      return { code: 'duplicate', ref: source.ref, message: `source evidence contains duplicate ref ${source.ref}` };
    }
    if (source.role !== 'problem-action' && source.role !== 'verification') {
      return { code: 'malformed', ref: source.ref, message: `source evidence has an invalid role for ${source.ref}` };
    }
    if (
      (source.sourceFilePath !== undefined && typeof source.sourceFilePath !== 'string')
      || (source.turn !== undefined && !Number.isInteger(source.turn))
      || (source.byteRange !== undefined && (
        !Number.isInteger(source.byteRange.start)
        || !Number.isInteger(source.byteRange.end)
        || source.byteRange.start < 0
        || source.byteRange.end < source.byteRange.start
      ))
    ) {
      return { code: 'malformed', ref: source.ref, message: `source evidence metadata is malformed for ${source.ref}` };
    }
    if (typeof source.content !== 'string' || !source.content.trim()) {
      return { code: 'incomplete', ref: source.ref, message: `source evidence is empty for ${source.ref}` };
    }
    if (
      profile.maxContentBytes !== undefined
      && Buffer.byteLength(source.content, 'utf8') > profile.maxContentBytes
    ) {
      return {
        code: 'oversized',
        ref: source.ref,
        message: `source evidence content is oversized for ${source.ref}`,
      };
    }
    sourceByRef.set(source.ref, source);
  }

  const requireCompletionCoverage = profile.requireCompletionCoverage ?? true;
  const requireSettlementCoverage = profile.requireSettlementCoverage ?? true;
  if (requireCompletionCoverage) {
    for (const ref of completionEvidence) {
      const source = sourceByRef.get(ref.ref);
      if (!source || source.role !== 'problem-action') {
        return {
          code: 'incomplete',
          ref: ref.ref,
          message: `source evidence does not cover completion ref ${ref.ref}`,
        };
      }
      const metadataFailure = metadataMismatch(ref, source, profile);
      if (metadataFailure) return metadataFailure;
    }
  }
  if (requireSettlementCoverage) {
    for (const ref of settlementEvidence) {
      const source = sourceByRef.get(ref.ref);
      if (!source || source.role !== 'verification') {
        return {
          code: 'incomplete',
          ref: ref.ref,
          message: `source evidence does not cover settlement ref ${ref.ref}`,
        };
      }
      const metadataFailure = metadataMismatch(ref, source, profile);
      if (metadataFailure) return metadataFailure;
    }
  }
  return undefined;
}

function metadataMismatch(
  ref: SkillEvidenceRef,
  source: BoundedSourceEvidence,
  profile: FrozenSourceEvidenceValidationProfile,
): FrozenSourceEvidenceFailure | undefined {
  if (!profile.requireMetadataMatch) return undefined;
  if (
    (ref.sourceFilePath !== undefined && source.sourceFilePath !== ref.sourceFilePath)
    || (ref.turn !== undefined && source.turn !== ref.turn)
  ) {
    return {
      code: 'metadata-mismatch',
      ref: ref.ref,
      message: `source evidence metadata does not match ${ref.ref}`,
    };
  }
  return undefined;
}
