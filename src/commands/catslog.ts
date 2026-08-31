import { Command } from 'commander';
import type {
  CatscoSkillsQuery,
  CatscoSkillsResponse,
  CatscoSkillOutcomeInput,
  CatscoSkillTraceMode,
} from '../utils/catsco-log-agent-client';
import { isSafeCatsLogSkillHandle } from '../utils/catsco-log-agent-client';
import { CatsLogMemoryProvider } from '../utils/catslog-memory-provider';
import type { CatsLogMemoryBackend } from '../utils/catslog-memory-provider';

/**
 * Options shared by the small, local CatsLog CLI facade.  The command only
 * prints the server response as data; it never prints or accepts a bearer
 * token as part of the normal Skills workflow.
 */
export interface CatslogCliRuntimeOptions {
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
  backend?: CatsLogMemoryBackend;
  output?: Pick<NodeJS.WritableStream, 'write'>;
}

export interface CatslogSkillsCommandOptions extends CatslogCliRuntimeOptions,
  Partial<CatscoSkillsQuery> {
  /** Commander-friendly alias for includeContent. */
  content?: boolean;
  /** Commander-friendly alias for includeTrace. */
  trace?: CatscoSkillTraceMode;
}

export interface CatslogOutcomeCommandOptions extends CatslogCliRuntimeOptions {
  retrievalReceipt?: string;
  routeId?: string;
  hop?: number;
  edgeKey?: string;
  feedback?: CatscoSkillOutcomeInput['feedback'];
}

/** Register the documented `catsco catslog skills|outcome` commands. */
export function registerCatslogCommand(program: Command): void {
  const catslog = program
    .command('catslog')
    .description('Read device-bound CatsLog Skills and report explicit outcomes');

  catslog
    .command('skills')
    .description('Read this device-bound agent\'s Runtime Learning Skills')
    .option('--handle <handle>', 'Read one exact Skill handle')
    .option('--search <terms>', 'Search Skill handles and descriptions')
    .option('--content', 'Include untrusted Skill markdown content')
    .option('--trace <mode>', 'Trace mode: none, summary, or full')
    .option('--limit <count>', 'Maximum Skills to return', parseNumberOption)
    .option('--cursor <cursor>', 'Continue an opaque CatsLog page')
    .action(async (options: Record<string, unknown>) => {
      const trace = options.trace as string | undefined;
      if (trace !== undefined && !isTraceMode(trace)) {
        throw new Error('--trace must be one of: none, summary, full');
      }
      const limit = options.limit as number | undefined;
      validateLimit(limit, 100, '--limit');
      await catslogSkillsCommand({
        ...(asOptionalString(options.handle) ? { handle: asOptionalString(options.handle) } : {}),
        ...(asOptionalString(options.search) ? { search: asOptionalString(options.search) } : {}),
        includeContent: options.content === true,
        ...(trace !== undefined ? { includeTrace: trace as CatscoSkillTraceMode } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(asOptionalString(options.cursor) ? { cursor: asOptionalString(options.cursor) } : {}),
      });
    });

  catslog
    .command('outcome <handle> <revision> <outcome>')
    .description('Report succeeded, failed, or corrected after using a Skill revision')
    .option('--receipt <receipt>', 'Optional retrieval receipt for precise attribution')
    .option('--route-id <routeId>', 'Route attribution (requires --receipt)')
    .option('--hop <hop>', 'Route hop, 0-2', parseNumberOption)
    .option('--edge-key <edgeKey>', 'Route edge attribution (requires --receipt)')
    .action(async (
      handle: string,
      revision: string,
      outcome: string,
      options: Record<string, unknown>,
    ) => {
      await catslogSkillOutcomeCommand(handle, revision, outcome, {
        retrievalReceipt: asOptionalString(options.receipt),
        routeId: asOptionalString(options.routeId),
        hop: options.hop as number | undefined,
        edgeKey: asOptionalString(options.edgeKey),
      });
    });
}

/**
 * Read the shared Skills catalog through the provider's device-bound
 * capability.  `content` and `trace` are aliases kept for the CLI spelling;
 * callers embedding this function may use the wire-shaped fields directly.
 */
export async function catslogSkillsCommand(
  options: CatslogSkillsCommandOptions = {},
): Promise<CatscoSkillsResponse> {
  const {
    workingDirectory,
    env,
    backend,
    output,
    content,
    trace,
    ...wireOptions
  } = options;
  const provider = backend ?? new CatsLogMemoryProvider(workingDirectory ?? process.cwd(), { env });
  if (typeof provider.readSkills !== 'function') {
    throw new Error('CatsLog Skills catalog capability is unavailable');
  }
  const query: CatscoSkillsQuery = {
    ...wireOptions,
    ...(content !== undefined ? { includeContent: content === true } : {}),
    ...(trace !== undefined ? { includeTrace: trace } : {}),
  };
  validateSkillsQuery(query);
  const result = await provider.readSkills(query);
  writeJSON(result, output);
  return result;
}

/**
 * Report a terminal Skill outcome.  An explicit CLI invocation is itself the
 * user's opt-in for the legacy no-receipt v1 signal; route/feedback metadata
 * still requires a receipt and is rejected by the provider if omitted.
 */
export async function catslogSkillOutcomeCommand(
  handle: string,
  revision: number | string,
  outcome: string,
  options: CatslogOutcomeCommandOptions = {},
): Promise<void> {
  const normalizedHandle = requireNonEmptyString(handle, 'handle');
  if (!isSafeCatsLogSkillHandle(normalizedHandle)) {
    throw new Error('handle must be a safe path-free CatsLog Skill handle');
  }
  const normalizedRevision = parsePositiveInteger(revision, 'revision');
  if (!isOutcome(outcome)) {
    throw new Error('outcome must be succeeded, failed, or corrected');
  }
  if (options.hop !== undefined && (!Number.isSafeInteger(options.hop) || options.hop < 0 || options.hop > 2)) {
    throw new Error('hop must be an integer from 0 to 2');
  }
  const provider = options.backend ?? new CatsLogMemoryProvider(
    options.workingDirectory ?? process.cwd(),
    { env: options.env, allowSkillOutcomeWrites: true },
  );
  if (typeof provider.reportSkillOutcome !== 'function') {
    throw new Error('CatsLog Skill outcome capability is unavailable');
  }
  await provider.reportSkillOutcome({
    handle: normalizedHandle,
    revision: normalizedRevision,
    outcome,
    ...(options.retrievalReceipt ? { retrievalReceipt: options.retrievalReceipt } : {}),
    ...(options.routeId ? { routeId: options.routeId } : {}),
    ...(options.hop !== undefined ? { hop: options.hop } : {}),
    ...(options.edgeKey ? { edgeKey: options.edgeKey } : {}),
    ...(options.feedback ? { feedback: options.feedback } : {}),
    requireReceipt: Boolean(options.retrievalReceipt),
  }, undefined);
  writeJSON({
    content_trust: 'untrusted_skill_feedback',
    status: 'accepted',
    handle: normalizedHandle,
    revision: normalizedRevision,
    outcome,
  }, options.output);
}

function validateSkillsQuery(query: CatscoSkillsQuery): void {
  if (query.limit !== undefined) validateLimit(query.limit, 100, 'limit');
  if (query.includeTrace !== undefined && !isTraceMode(query.includeTrace)) {
    throw new Error('includeTrace must be none, summary, or full');
  }
}

function validateLimit(value: unknown, max: number, name: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
}

function parseNumberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid integer: ${value}`);
  return parsed;
}

function parsePositiveInteger(value: number | string, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be provided`);
  return value.trim();
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isTraceMode(value: unknown): value is CatscoSkillTraceMode {
  return value === 'none' || value === 'summary' || value === 'full';
}

function isOutcome(value: unknown): value is CatscoSkillOutcomeInput['outcome'] {
  return value === 'succeeded' || value === 'failed' || value === 'corrected';
}

function writeJSON(value: unknown, output?: Pick<NodeJS.WritableStream, 'write'>): void {
  (output ?? process.stdout).write(`${JSON.stringify(value, null, 2)}\n`);
}
