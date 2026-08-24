import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { ReviewDecisionState } from './review-runtime-types';

export interface ReviewEnvelopeSnapshot {
  findingId: string;
  reviewState: ReviewDecisionState;
  recommendation?: 'ISSUE' | 'CLOSE' | null;
  nextEvidenceAction?: string;
  stopCondition?: string;
}

export interface ReviewEnvelopeCommitResult {
  snapshot: ReviewEnvelopeSnapshot;
  validatorOutput: string;
  syncOutput?: string;
}

export interface ReviewEnvelopeGatewayOptions {
  workspace: string;
  skillDirectory: string;
  pythonExecutable?: string;
}

export class ReviewEnvelopeGateway {
  readonly workspace: string;
  private readonly skillDirectory: string;
  private readonly pythonExecutable: string;

  constructor(options: ReviewEnvelopeGatewayOptions) {
    this.workspace = path.resolve(options.workspace);
    this.skillDirectory = path.resolve(options.skillDirectory);
    this.pythonExecutable = options.pythonExecutable || 'python3';
  }

  listFindingEnvelopes(): string[] {
    const root = path.join(this.workspace, 'findings');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name))
      .filter(dir => fs.existsSync(path.join(dir, 'finding.json')))
      .sort();
  }

  resolveEnvelopePath(envelopePath: string): string {
    const resolved = path.resolve(envelopePath);
    const findingsRoot = path.join(this.workspace, 'findings');
    const relative = path.relative(findingsRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Envelope must be a child of ${findingsRoot}`);
    }
    if (!fs.existsSync(path.join(resolved, 'finding.json'))) {
      throw new Error(`Envelope finding.json is missing: ${resolved}`);
    }
    return resolved;
  }

  readSnapshot(envelopePath: string): ReviewEnvelopeSnapshot {
    const resolved = this.resolveEnvelopePath(envelopePath);
    const finding = readJson(path.join(resolved, 'finding.json'));
    const decision = readJson(path.join(resolved, 'decision.json'));
    const findingId = requireString(finding.findingId, 'finding.findingId');
    const reviewState = parseReviewState(decision.reviewState ?? finding.reviewState);
    const recommendation = decision.recommendation === 'ISSUE' || decision.recommendation === 'CLOSE'
      ? decision.recommendation
      : null;
    return {
      findingId,
      reviewState,
      recommendation,
      nextEvidenceAction: optionalString(decision.nextEvidenceAction),
      stopCondition: optionalString(decision.stopCondition),
    };
  }

  validate(envelopePath: string, expectedFindingId: string): Omit<ReviewEnvelopeCommitResult, 'syncOutput'> {
    const resolved = this.resolveEnvelopePath(envelopePath);
    const before = this.readSnapshot(resolved);
    if (before.findingId !== expectedFindingId) {
      throw new Error(`Envelope belongs to ${before.findingId}, expected ${expectedFindingId}`);
    }

    const validator = path.join(this.skillDirectory, 'scripts', 'validate-envelope.py');
    const validation = run(this.pythonExecutable, [validator, resolved]);
    if (validation.status !== 0) {
      throw new Error(`Envelope validation failed: ${compact(validation.output)}`);
    }
    return {
      snapshot: this.readSnapshot(resolved),
      validatorOutput: compact(validation.output),
    };
  }

  sync(expectedFindingId: string): string {
    const manager = path.join(this.skillDirectory, 'scripts', 'finding_manager.py');
    const sync = run(this.pythonExecutable, [
      manager,
      '--workspace', this.workspace,
      'sync', expectedFindingId,
    ]);
    if (sync.status !== 0) {
      throw new Error(`Finding Pool sync failed: ${compact(sync.output)}`);
    }
    return compact(sync.output);
  }

  validateAndSync(envelopePath: string, expectedFindingId: string): ReviewEnvelopeCommitResult {
    const validation = this.validate(envelopePath, expectedFindingId);
    return {
      ...validation,
      syncOutput: this.sync(expectedFindingId),
    };
  }
}

function run(command: string, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    shell: false,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.error) throw result.error;
  return { status: result.status, output };
}

function readJson(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch (error: any) {
    throw new Error(`Invalid JSON ${filePath}: ${error?.message || error}`);
  }
}

function parseReviewState(value: unknown): ReviewDecisionState {
  if (value === 'INCOMPLETE' || value === 'COMPLETE_ISSUE' || value === 'COMPLETE_CLOSE') return value;
  throw new Error(`Invalid reviewState: ${String(value)}`);
}

function requireString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1200);
}
