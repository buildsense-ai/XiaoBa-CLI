import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { defaultDistilledOutputDir } from './path-resolver';
import { PathResolver } from './path-resolver';
import { getDistillationHeartbeatConfig } from './distillation-heartbeat-config';
import {
  applyCapabilityTransition,
  type AppliedTransition,
  type CurrentSkillRecord,
  type EvidenceBundle,
  isPathSafelyWithinDirectory,
  loadCurrentSkillRegistry,
  loadTransitionAudit,
  loadTransitionJournalForInspection,
  recoverTransitionJournal,
  type SkillEvolutionPaths,
  type TransitionAuditEntry,
} from './skill-evolution';

const OPERATOR_CONTROL_VERSION = 'operator-skill-control-v1';
const OPERATOR_RETIRE_BUNDLE_PREFIX = 'operator-retire:';

export interface GeneratedSkillControlOptions {
  workingDirectory?: string;
  outputDir?: string;
  registryPath?: string;
  auditPath?: string;
  journalPath?: string;
  branchLogRoot?: string;
}

interface ResolvedGeneratedSkillControlPaths extends SkillEvolutionPaths {
  workingDirectory: string;
}

export type GeneratedSkillRetirementState =
  | { state: 'active'; record: CurrentSkillRecord }
  | {
    state: 'already-retired';
    capabilityHandle: string;
    routingName: string;
    guidanceHash: string;
    historyPath: string;
    audit: TransitionAuditEntry;
  }
  | {
    state: 'pending-recovery';
    capabilityHandle: string;
    routingName: string;
    guidanceHash: string;
    historyPath: string;
    audit: TransitionAuditEntry;
  }
  | { state: 'not-found' };

export interface RetireGeneratedSkillResult {
  status: 'retired' | 'already-retired';
  capabilityHandle: string;
  routingName: string;
  guidanceHash: string;
  historyPath: string;
  transition: AppliedTransition;
}

export class GeneratedSkillNotFoundError extends Error {
  constructor(public readonly requestedName: string) {
    super(`Active generated Current Skill not found: ${requestedName}`);
    this.name = 'GeneratedSkillNotFoundError';
  }
}

export function inspectGeneratedSkillRetirement(
  name: string,
  options: GeneratedSkillControlOptions = {},
): GeneratedSkillRetirementState {
  const requestedName = name.trim();
  if (!requestedName) return { state: 'not-found' };
  const paths = resolveGeneratedSkillControlPaths(options);
  const loaded = loadCurrentSkillRegistry(paths.registryPath);
  validateGeneratedSkillRegistryPaths(loaded, paths.outputDir);
  return inspectGeneratedSkillRetirementState(requestedName, paths, loaded);
}

function inspectGeneratedSkillRetirementState(
  requestedName: string,
  paths: ResolvedGeneratedSkillControlPaths,
  registry: ReturnType<typeof loadCurrentSkillRegistry>,
): GeneratedSkillRetirementState {
  const record = Object.values(registry.capabilities).find(item => (
    item.routingName === requestedName || item.handle === requestedName
  ));
  if (record) {
    return { state: 'active', record };
  }

  const prior = loadTransitionAudit(paths.auditPath)
    .slice()
    .reverse()
    .find(entry => (
      entry.transition === 'retire_capability'
      && entry.bundleId?.startsWith(OPERATOR_RETIRE_BUNDLE_PREFIX)
      && (
        entry.priorRoutingName === requestedName
        || entry.involvedCapabilityHandles.includes(requestedName)
      )
    ));
  if (!prior || !prior.priorGuidanceHash || !prior.priorRoutingName) {
    const pending = inspectPendingOperatorRetirement(requestedName, paths);
    return pending ?? { state: 'not-found' };
  }
  const retired = verifiedRetirementHistory(prior, paths, 'audit');
  return {
    state: 'already-retired',
    ...retired,
    audit: prior,
  };
}

function inspectPendingOperatorRetirement(
  requestedName: string,
  paths: ResolvedGeneratedSkillControlPaths,
): Extract<GeneratedSkillRetirementState, { state: 'pending-recovery' }> | undefined {
  const journal = loadTransitionJournalForInspection(paths);
  if (
    !journal
    || journal.committedAt
    || journal.audit.transition !== 'retire_capability'
    || !journal.audit.bundleId?.startsWith(OPERATOR_RETIRE_BUNDLE_PREFIX)
  ) return undefined;
  const audit = journal.audit;
  if (
    audit.priorRoutingName !== requestedName
    && !audit.involvedCapabilityHandles.includes(requestedName)
  ) return undefined;
  const retired = verifiedRetirementHistory(audit, paths, 'journal');
  return {
    state: 'pending-recovery',
    ...retired,
    audit,
  };
}

function verifiedRetirementHistory(
  audit: TransitionAuditEntry,
  paths: ResolvedGeneratedSkillControlPaths,
  source: 'audit' | 'journal',
): {
  capabilityHandle: string;
  routingName: string;
  guidanceHash: string;
  historyPath: string;
} {
  const capabilityHandle = audit.involvedCapabilityHandles[0];
  if (!capabilityHandle || !/^cap_[a-z0-9_]+$/i.test(capabilityHandle)) {
    throw new Error(`Retirement ${source} contains an invalid Capability Handle.`);
  }
  if (!audit.priorGuidanceHash || !audit.priorRoutingName) {
    throw new Error(`Retirement ${source} is missing the prior generated Skill identity.`);
  }
  const historyPath = immutableHistoryPath(
    paths.outputDir,
    capabilityHandle,
    audit.priorGuidanceHash,
  );
  if (!isPathSafelyWithinDirectory(historyPath, paths.outputDir)) {
    throw new Error(`Retirement ${source} resolves outside the generated Skill root.`);
  }
  if (!fs.existsSync(historyPath)) {
    throw new Error(`Retired generated Current Skill history is missing: ${historyPath}`);
  }
  const historyHash = crypto.createHash('sha256').update(fs.readFileSync(historyPath)).digest('hex');
  if (historyHash !== audit.priorGuidanceHash) {
    throw new Error(`Retired generated Current Skill history hash does not match its ${source}.`);
  }
  return {
    capabilityHandle,
    routingName: audit.priorRoutingName,
    guidanceHash: audit.priorGuidanceHash,
    historyPath,
  };
}

/** Recover an interrupted transition before applying an operator retirement. */
function prepareGeneratedSkillControl(
  paths: ResolvedGeneratedSkillControlPaths,
): ReturnType<typeof loadCurrentSkillRegistry> {
  // Recovery is the only write-side preparation needed here.  Registry
  // reconciliation is a separate invariant/recovery operation; running it
  // before every retirement made this thin operator adapter mutate unrelated
  // active generated Skills.
  recoverTransitionJournal(paths);
  const loaded = loadCurrentSkillRegistry(paths.registryPath);
  validateGeneratedSkillRegistryPaths(loaded, paths.outputDir);
  return loaded;
}

function validateGeneratedSkillRegistryPaths(
  registry: ReturnType<typeof loadCurrentSkillRegistry>,
  outputDir: string,
): void {
  for (const record of Object.values(registry.capabilities)) {
    if (!isPathSafelyWithinDirectory(record.skillFilePath, outputDir)) {
      throw new Error(`Generated Skill Registry record ${record.handle} points outside the generated Skill root.`);
    }
  }
}

/**
 * Explicit operator retirement for generated Current Skills.
 *
 * This is intentionally not a purge: the active Registry entry and routable
 * artifact are removed through the existing audited transition, while the
 * immutable guidance revision and append-only audit remain available.
 */
export function retireGeneratedSkill(
  name: string,
  options: GeneratedSkillControlOptions = {},
): RetireGeneratedSkillResult {
  const requestedName = name.trim();
  if (!requestedName) throw new GeneratedSkillNotFoundError(name);
  const paths = resolveGeneratedSkillControlPaths(options);
  const preparedRegistry = prepareGeneratedSkillControl(paths);
  const inspected = inspectGeneratedSkillRetirementState(requestedName, paths, preparedRegistry);
  if (inspected.state === 'not-found') throw new GeneratedSkillNotFoundError(name);
  if (inspected.state === 'already-retired') {
    return {
      status: 'already-retired',
      capabilityHandle: inspected.capabilityHandle,
      routingName: inspected.routingName,
      guidanceHash: inspected.guidanceHash,
      historyPath: inspected.historyPath,
      transition: {
        transitionId: inspected.audit.transitionId,
        audit: inspected.audit,
      },
    };
  }
  if (inspected.state === 'pending-recovery') {
    throw new Error('Generated Skill retirement journal remained pending after recovery.');
  }

  const record = inspected.record;
  const requestRef = `operator:skill-retire:${record.handle}:request`;
  const confirmationRef = `operator:skill-retire:${record.handle}:confirmation`;
  const bundle: EvidenceBundle = {
    bundleId: `${OPERATOR_RETIRE_BUNDLE_PREFIX}${record.handle}:${record.guidanceHash}`,
    authority: {
      kind: 'operator-control',
      targetCapabilityHandle: record.handle,
    },
    episode: {
      kind: 'operator-skill-control',
      action: 'retire',
      capabilityHandle: record.handle,
      routingName: record.routingName,
    },
    completionEvidence: [{ ref: requestRef }],
    settlementEvidence: [{ ref: confirmationRef }],
    boundedContinuity: [],
    referencedSkills: [],
    relatedCurrentSkills: [{
      handle: record.handle,
      revision: record.revision,
      routingName: record.routingName,
      description: record.description,
      guidanceHash: record.guidanceHash,
    }],
    sourceEvidence: [
      {
        ref: requestRef,
        role: 'problem-action',
        content: `The operator requested retirement of generated Current Skill ${record.routingName}.`,
      },
      {
        ref: confirmationRef,
        role: 'verification',
        content: 'The operator explicitly confirmed retirement without purging immutable history.',
      },
    ],
  };
  const rationale = `Operator explicitly retired generated Current Skill ${record.routingName}; immutable history and audit are retained.`;
  const transition = applyCapabilityTransition({
    ...paths,
    bundle,
    draft: {
      body: 'Retire this generated Current Skill without purging immutable history.',
      envelope: {
        decision: 'retire_capability',
        targetCapabilityHandle: record.handle,
        evidenceRefs: [requestRef, confirmationRef],
      },
    },
    transition: 'retire_capability',
    verifier: {
      decision: 'accept',
      transition: 'retire_capability',
      issues: [],
      rationale,
      registryReadSet: [{ handle: record.handle, revision: record.revision }],
    },
    registryReadSet: [{ handle: record.handle, revision: record.revision }],
    branchTranscriptPaths: [],
    reviewerVersion: OPERATOR_CONTROL_VERSION,
    promptVersion: OPERATOR_CONTROL_VERSION,
  });
  return {
    status: 'retired',
    capabilityHandle: record.handle,
    routingName: record.routingName,
    guidanceHash: record.guidanceHash,
    historyPath: path.join(path.dirname(record.skillFilePath), 'history', record.guidanceHash, 'SKILL.md'),
    transition,
  };
}

function resolveGeneratedSkillControlPaths(
  options: GeneratedSkillControlOptions,
): ResolvedGeneratedSkillControlPaths {
  const workingDirectory = path.resolve(options.workingDirectory ?? process.cwd());
  const config = getDistillationHeartbeatConfig(workingDirectory);
  return {
    workingDirectory,
    outputDir: path.resolve(options.outputDir ?? defaultDistilledOutputDir(PathResolver.getSkillsPath())),
    registryPath: path.resolve(options.registryPath ?? config.skillEvolutionRegistryPath),
    auditPath: path.resolve(options.auditPath ?? config.skillEvolutionAuditPath),
    journalPath: path.resolve(options.journalPath ?? config.skillEvolutionJournalPath),
    branchLogRoot: path.resolve(options.branchLogRoot ?? config.branchLogRoot),
  };
}

function immutableHistoryPath(outputDir: string, handle: string, guidanceHash: string): string {
  return path.join(outputDir, handle, 'history', guidanceHash, 'SKILL.md');
}
