import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';

import { PathResolver } from './path-resolver';
import { GENERATED_DISTILLED_DIR_NAME } from './distilled-skill-installer';
import {
  BoundedSourceEvidence,
  CapabilityTransitionKind,
  EvidenceBundle,
  SkillEvolutionRuntime,
} from './skill-evolution';
import { DistilledKnowledgeCandidate } from './capability-distiller';

export interface LegacyDistilledBootstrapResult {
  filePath: string;
  bundleId: string;
  transition: CapabilityTransitionKind;
  queued?: 'deferred' | 'operational';
  deleted: boolean;
}

export interface LegacyDistilledBootstrapOptions {
  /** Runtime-owned V3 transition engine. */
  skillEvolution: SkillEvolutionRuntime;
  /** Root directory to scan. Defaults to `skills/generated-distilled`. */
  generatedDistilledRoot?: string;
  /** Optional deterministic timestamp source for synthetic legacy fields. */
  now?: () => string;
  /** Test seam for simulating a post-commit cleanup failure. */
  deleteArtifact?: (filePath: string) => void;
}

interface LegacyParsedSkill {
  filePath: string;
  content: string;
  metadata: Record<string, unknown>;
  capabilityId: string;
  sourceFilePath: string;
  sourceByteRange: { start: number; end: number };
  sourceUnitGeneratedAt: string;
  title: string;
  applicability: string;
  actionPattern: string;
  boundaries: string[];
  risks: string[];
  provenanceTurns: Array<{ turn: number; role: 'problem-action' | 'verification'; start: number; end: number; sourceFilePath: string }>;
}

let inFlightBootstrap = new Map<string, Promise<LegacyDistilledBootstrapResult[]>>();
const MAX_LEGACY_SOURCE_EVIDENCE_BYTES = 16 * 1024;

export async function bootstrapLegacyDistilledSkillsOnce(
  options: LegacyDistilledBootstrapOptions,
): Promise<LegacyDistilledBootstrapResult[]> {
  const generatedRoot = options.generatedDistilledRoot ?? path.join(
    PathResolver.getSkillsPath(),
    GENERATED_DISTILLED_DIR_NAME,
  );
  const key = path.resolve(generatedRoot);
  const active = inFlightBootstrap.get(key);
  if (active) {
    return active;
  }

  const promise = bootstrapLegacyDistilledSkills(options);
  inFlightBootstrap.set(key, promise);

  return promise.finally(() => {
    inFlightBootstrap.delete(key);
  });
}

async function bootstrapLegacyDistilledSkills(
  options: LegacyDistilledBootstrapOptions,
): Promise<LegacyDistilledBootstrapResult[]> {
  const generatedRoot = options.generatedDistilledRoot ?? path.join(
    PathResolver.getSkillsPath(),
    GENERATED_DISTILLED_DIR_NAME,
  );
  const now = options.now ?? (() => new Date().toISOString());
  const results: LegacyDistilledBootstrapResult[] = [];

  if (!fs.existsSync(generatedRoot)) {
    return results;
  }

  const files = listLegacyDistilledSkillFiles(generatedRoot)
    .sort((left, right) => left.localeCompare(right));

  // `bundleId` is written by the V3 transition audit. It separates a durable
  // review result from cleanup, so a failed delete cannot replay the review.
  const committedTransitions = new Map(
    options.skillEvolution.getAudit()
      .filter(audit => typeof audit.bundleId === 'string' && audit.bundleId.length > 0)
      .map(audit => [audit.bundleId!, audit.transition]),
  );

  for (const filePath of files) {
    const parsed = parseLegacyDistilledSkill(filePath);
    if (!parsed) {
      continue;
    }

    const bundle = buildBootstrapBundle(parsed, options.skillEvolution, now);
    const pendingQueue = options.skillEvolution.getQueuedReviewKind(bundle.bundleId);
    if (pendingQueue) {
      results.push({
        filePath,
        bundleId: bundle.bundleId,
        transition: pendingQueue === 'deferred' ? 'defer' : 'reject_candidate',
        queued: pendingQueue,
        deleted: false,
      });
      continue;
    }
    const committedTransition = committedTransitions.get(bundle.bundleId);
    if (committedTransition && shouldDeleteArtifact(committedTransition)) {
      try {
        (options.deleteArtifact ?? deleteLegacyArtifact)(filePath);
        results.push({
          filePath,
          bundleId: bundle.bundleId,
          transition: committedTransition,
          deleted: true,
        });
      } catch {
        results.push({
          filePath,
          bundleId: bundle.bundleId,
          transition: committedTransition,
          deleted: false,
        });
      }
      continue;
    }

    let deleteAfter = false;
    let transition: CapabilityTransitionKind = 'reject_candidate';
    let queued: LegacyDistilledBootstrapResult['queued'];

    try {
      const result = await options.skillEvolution.reviewAndApply(bundle);
      transition = result.transition;
      queued = result.queued;
      deleteAfter = shouldDeleteArtifact(result.transition, result.queued);
      if (!deleteAfter) {
        results.push({
          filePath,
          bundleId: bundle.bundleId,
          transition: result.transition,
          queued: result.queued,
          deleted: false,
        });
        continue;
      }

      (options.deleteArtifact ?? deleteLegacyArtifact)(filePath);
      results.push({
        filePath,
        bundleId: bundle.bundleId,
        transition: result.transition,
        deleted: true,
      });
    } catch (error: any) {
      results.push({
        filePath,
        bundleId: bundle.bundleId,
        transition,
        queued,
        deleted: false,
      });
      continue;
    }
  }

  return results;
}

function shouldDeleteArtifact(
  transition: CapabilityTransitionKind,
  queued?: 'deferred' | 'operational',
): boolean {
  if (queued === 'deferred' || queued === 'operational') {
    return false;
  }
  if (transition === 'defer') {
    return false;
  }
  return true;
}

function parseLegacyDistilledSkill(filePath: string): LegacyParsedSkill | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    parsed = matter(raw);
  } catch {
    return null;
  }

  const data = (parsed.data as Record<string, unknown>) ?? {};
  if (String(data.distilled).toLowerCase() !== 'true' && data.distilled !== true) {
    return null;
  }
  if (String(data.kind ?? '').toLowerCase() !== 'capability') {
    return null;
  }

  const capabilityId = toString(data.capability_id) || `legacy-${sanitizeLegacySlug(path.relative(process.cwd(), filePath))}`;
  const sourceFilePath = toString(data.source_file_path) || filePath;
  const sourceByteRange = {
    start: toSafeInteger(data.source_byte_range_start, 0),
    end: toSafeInteger(data.source_byte_range_end, 0),
  };
  const normalizedRange = normalizeRange(sourceByteRange);
  const sourceUnitGeneratedAt = toString(data.source_unit_generated_at)
    || toString(data.review_reviewed_at)
    || toString(data.generated_at)
    || new Date(0).toISOString();

  const extracted = parseRenderedBody(parsed.content);
  const parsedProvenance = parseProvenanceRefs(parsed.content, sourceFilePath, sourceByteRange);
  const provenance: LegacyParsedSkill['provenanceTurns'] = parsedProvenance.length > 0
    ? parsedProvenance
    : [
      { turn: 1, role: 'problem-action', start: normalizedRange.start, end: normalizedRange.end, sourceFilePath },
      { turn: 2, role: 'verification', start: normalizedRange.start, end: normalizedRange.end, sourceFilePath },
    ];

  return {
    filePath,
    content: parsed.content,
    metadata: data,
    capabilityId,
    sourceFilePath,
    sourceByteRange: normalizedRange,
    sourceUnitGeneratedAt,
    title: extracted.title || `Legacy skill ${capabilityId}`,
    applicability: extracted.applicability || `When: ${capabilityId}.`,
    actionPattern: extracted.actionPattern || `Execute the pattern captured for ${capabilityId}.`,
    boundaries: extracted.boundaries,
    risks: extracted.risks,
    provenanceTurns: provenance,
  };
}

function buildBootstrapBundle(
  legacy: LegacyParsedSkill,
  skillEvolution: SkillEvolutionRuntime,
  now: () => string,
): EvidenceBundle {
  const candidate: DistilledKnowledgeCandidate = {
    schemaVersion: 1,
    kind: 'capability',
    capabilityId: legacy.capabilityId,
    title: legacy.title,
    applicability: legacy.applicability,
    actionPattern: legacy.actionPattern,
    boundaries: legacy.boundaries,
    risks: legacy.risks,
    solvedLoop: {
      problem: legacy.applicability,
      action: legacy.actionPattern,
      verification: 'Previous V2 distilled guidance produced usable outcomes.',
      noCorrection: 'No immediate correction marker was carried from legacy artifact.',
    },
    provenance: legacy.provenanceTurns.map(item => ({
      filePath: item.sourceFilePath,
      turn: item.turn,
      role: item.role,
      unitByteRange: {
        start: item.start,
        end: item.end,
      },
    })),
    generatedAt: now(),
    sourceUnit: {
      filePath: legacy.sourceFilePath,
      byteRange: legacy.sourceByteRange,
      generatedAt: legacy.sourceUnitGeneratedAt,
    },
  };

  const [completion, settlement] = buildLegacyEvidenceRefs(legacy);
  const sourceEvidence = buildLegacySourceEvidence(legacy, completion, settlement);

  const bundleIdInput = [legacy.filePath, legacy.capabilityId, legacy.sourceFilePath].join('::');
  const bundleId = `legacy-v3:${crypto.createHash('sha256').update(bundleIdInput).digest('hex').slice(0, 16)}`;

  const relatedCurrentSkills = Object.values(skillEvolution.getRegistry().capabilities).map(record => ({
    handle: record.handle,
    revision: record.revision,
    routingName: record.routingName,
    description: record.description,
    guidanceHash: record.guidanceHash,
  }));

  return {
    bundleId,
    episode: candidate,
    completionEvidence: [{ ref: completion }],
    settlementEvidence: [{ ref: settlement }],
    boundedContinuity: [],
    referencedSkills: skillEvolution.getReferencedSkillSnapshots(),
    relatedCurrentSkills,
    sourceEvidence,
  };
}

function buildLegacyEvidenceRefs(legacy: LegacyParsedSkill): [string, string] {
  const completionRef = makeEvidenceRef(
    legacy.provenanceTurns[0]?.sourceFilePath || legacy.sourceFilePath,
    legacy.provenanceTurns[0]?.turn || 1,
    legacy.provenanceTurns[0]?.role || 'problem-action',
    legacy.provenanceTurns[0]?.start || legacy.sourceByteRange.start,
    legacy.provenanceTurns[0]?.end || legacy.sourceByteRange.end,
  );
  const settlementRef = makeEvidenceRef(
    legacy.provenanceTurns[1]?.sourceFilePath || legacy.sourceFilePath,
    legacy.provenanceTurns[1]?.turn || 2,
    legacy.provenanceTurns[1]?.role || 'verification',
    legacy.provenanceTurns[1]?.start || legacy.sourceByteRange.start,
    legacy.provenanceTurns[1]?.end || legacy.sourceByteRange.end,
  );

  const distinctCompletion = completionRef === settlementRef
    ? `${completionRef}:primary`
    : completionRef;
  const distinctSettlement = completionRef === settlementRef
    ? `${settlementRef}:secondary`
    : settlementRef;

  return [distinctCompletion, distinctSettlement];
}

function buildLegacySourceEvidence(
  legacy: LegacyParsedSkill,
  completionRef: string,
  settlementRef: string,
): BoundedSourceEvidence[] {
  return [
    makeBoundedSourceEvidence(
      legacy.provenanceTurns[0] ?? {
        turn: 1,
        role: 'problem-action',
        start: legacy.sourceByteRange.start,
        end: legacy.sourceByteRange.end,
        sourceFilePath: legacy.sourceFilePath,
      },
      completionRef,
      'problem-action',
    ),
    makeBoundedSourceEvidence(
      legacy.provenanceTurns[1] ?? {
        turn: 2,
        role: 'verification',
        start: legacy.sourceByteRange.start,
        end: legacy.sourceByteRange.end,
        sourceFilePath: legacy.sourceFilePath,
      },
      settlementRef,
      'verification',
    ),
  ];
}

function makeBoundedSourceEvidence(
  provenance: LegacyParsedSkill['provenanceTurns'][number],
  ref: string,
  role: BoundedSourceEvidence['role'],
): BoundedSourceEvidence {
  return {
    ref,
    sourceFilePath: provenance.sourceFilePath,
    turn: provenance.turn,
    byteRange: { start: provenance.start, end: provenance.end },
    role,
    content: readBoundedLegacySource(provenance.sourceFilePath, provenance.start, provenance.end),
  };
}

function readBoundedLegacySource(sourceFilePath: string, start: number, end: number): string {
  const offset = Math.max(0, start);
  const length = Math.min(MAX_LEGACY_SOURCE_EVIDENCE_BYTES, Math.max(0, end - offset));
  if (length === 0) return '';

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(sourceFilePath, 'r');
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function makeEvidenceRef(
  sourceFilePath: string,
  turn: number,
  role: 'problem-action' | 'verification',
  start: number,
  end: number,
): string {
  return `${sourceFilePath}#${turn}:${role}:${start}-${end}`;
}

function parseRenderedBody(body: string): {
  title: string;
  applicability: string;
  actionPattern: string;
  boundaries: string[];
  risks: string[];
} {
  const title = extractTitle(body);
  const guidanceSection = extractSection(body, '## Capability Guidance', '## Boundaries') ?? '';
  const boundariesSection = extractSection(body, '## Boundaries', '## Risks') ?? '';
  const risksSection = extractSection(body, '## Risks', '## Traceability Contract') ?? '';

  const applicability = extractLabeledBlock(guidanceSection, '**Applicability**')
    .replace(/^\*\*Applicability\*\*\s*/u, '').trim();
  const actionPattern = extractLabeledBlock(guidanceSection, '**Action Pattern**')
    .replace(/^\*\*Action Pattern\*\*\s*/u, '').trim();

  return {
    title: title || 'Legacy distilled capability',
    applicability: stripIndent(applicability || 'Legacy applicability remains to be reviewed.'),
    actionPattern: stripIndent(actionPattern || 'Legacy action pattern remains to be reviewed.'),
    boundaries: extractBulletItems(boundariesSection).slice(),
    risks: extractBulletItems(risksSection).slice(),
  };
}

function extractTitle(body: string): string {
  const match = body.match(/^#\s+([^\r\n]+)/mu);
  return match?.[1]?.trim() ?? '';
}

function extractSection(body: string, startMarker: string, nextMarker: string): string | null {
  const startIndex = body.indexOf(startMarker);
  if (startIndex < 0) return null;
  const contentStart = body.indexOf('\n', startIndex + startMarker.length);
  if (contentStart < 0) return null;

  const nextIndex = body.indexOf(nextMarker, contentStart);
  if (nextIndex < 0) {
    return body.slice(contentStart + 1).trim();
  }

  return body.slice(contentStart + 1, nextIndex).trim();
}

function extractLabeledBlock(block: string, marker: string): string {
  const pattern = new RegExp(`${escapeRegExp(marker)}\\s*\\n([\\s\\S]*?)(?=\\*\\*|##|$)`, 'u');
  const match = block.match(pattern);
  return (match?.[1] ?? '').trim();
}

function extractBulletItems(block: string): string[] {
  return block
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(line => line.length > 0);
}

function stripIndent(text: string): string {
  return text.replace(/\r\n?/gu, '\n').trim();
}

function parseProvenanceRefs(
  body: string,
  fallbackSourceFilePath: string,
  fallbackRange: { start: number; end: number },
): Array<{ turn: number; role: 'problem-action' | 'verification'; start: number; end: number; sourceFilePath: string }> {
  const parsed: Array<{ turn: number; role: 'problem-action' | 'verification'; start: number; end: number; sourceFilePath: string }> = [];
  const regex = /`([^`]+)` turn (\d+) \((problem-action|verification)\)\s*[—-]\s*byte range (\d+)\u2013?(\d+)/gu;
  for (const match of body.matchAll(regex)) {
    const sourceFilePath = match[1] ?? fallbackSourceFilePath;
    const turn = Number(match[2]);
    const role = match[3] as 'problem-action' | 'verification';
    const start = Number(match[4]);
    const end = Number(match[5]);
    if (Number.isFinite(turn) && Number.isFinite(start) && Number.isFinite(end)) {
      parsed.push({
        sourceFilePath,
        turn,
        role,
        start,
        end,
      });
    }
  }

  if (parsed.length === 0) {
    const normalized = normalizeRange(fallbackRange);
    parsed.push(
      {
        sourceFilePath: fallbackSourceFilePath,
        turn: 1,
        role: 'problem-action',
        start: normalized.start,
        end: normalized.end,
      },
      {
        sourceFilePath: fallbackSourceFilePath,
        turn: 2,
        role: 'verification',
        start: normalized.start,
        end: normalized.end,
      },
    );
  }

  return parsed;
}

function listLegacyDistilledSkillFiles(rootDir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listLegacyDistilledSkillFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === 'SKILL.md') {
      results.push(fullPath);
    }
  }
  return results;
}

function deleteLegacyArtifact(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  const snapshotDir = path.dirname(filePath);
  const capabilityDir = path.dirname(snapshotDir);

  removeIfEmpty(snapshotDir);
  removeIfEmpty(capabilityDir);
}

function removeIfEmpty(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    return;
  }
  const entries = fs.readdirSync(dirPath);
  if (entries.length === 0) {
    fs.rmdirSync(dirPath);
  }
}

function toString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toSafeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeRange(range: { start: number; end: number }): { start: number; end: number } {
  const start = Math.max(0, range.start);
  const end = Math.max(start, range.end);
  return { start, end };
}

function sanitizeLegacySlug(value: string): string {
  return value
    .replace(/\.[\\/]/gu, '-')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32) || 'legacy';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
