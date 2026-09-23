import * as fs from 'fs';
import * as path from 'path';
import { readActiveBotDefinition } from './revocation';
import type { BotSkillRef } from '../bot-definition/types';
import { readSkillHubInstallMarker } from '../skillhub/install-marker';
import type { ToolExecutionContext } from '../types/tool';
import { PathResolver } from '../utils/path-resolver';
import { TurnSkillSnapshotLease } from '../skills/turn-skill-snapshot';
import {
  collectBotSkillPackageFiles,
  computeBotSkillPackageHash,
  readBotSkillLocalMarker,
} from './local-manifest';
import { Logger } from '../utils/logger';

export interface TrustedBotSkillScriptInvocation {
  scriptPath: string;
  args: string[];
  skillId: string;
  skillName: string;
  version: string;
}

export type TrustedBotSkillScriptDecision =
  | { ok: true; invocation: TrustedBotSkillScriptInvocation }
  | { ok: false; reason: string };

/**
 * Returns true when a direct Node command points at a preserved Skill
 * snapshot.  Pending snapshots and deleted-Skill trash are recovery evidence,
 * not runnable workspaces.  Keeping this check separate from the normal
 * trusted-entrypoint resolver is intentional: ordinary user scripts keep
 * their existing shell fallback, while stale Skill evidence cannot be
 * resurrected by a model-generated absolute path.
 */
export function isRevokedBotSkillSnapshotCommand(
  command: unknown,
  context: ToolExecutionContext,
  options: { cwd?: unknown; target?: unknown } = {},
): boolean {
  if (!isTrustedLocalCatsCoRuntime(context)) return false;
  const target = stringValue(options.target).toLowerCase();
  if (target && target !== 'agent_self') return false;
  const runtimeRoot = PathResolver.getRuntimeDataRoot();
  const evidenceRoots = [
    path.join(runtimeRoot, 'data', 'bot-skills', 'local-pending'),
    path.join(runtimeRoot, 'data', 'bot-skills', 'trash'),
  ];
  const executionDirectory = resolveExecutionDirectory(options.cwd, context.workingDirectory);
  if (!executionDirectory) return false;
  return resolveShellScriptEntryPaths(String(command), executionDirectory)
    .some(scriptPath => evidenceRoots.some(root => isPathInside(scriptPath, root)));
}

const CONNECTOR_ENV_NAMES = [
  'CATSCO_SHIMO_CONNECTOR_URL',
  'CATSCO_ACTOR_TOKEN',
  'CATSCO_SKILL_ID',
] as const;

/**
 * Removes connector capabilities from the shared Runtime environment and
 * injects one only when the verified SkillHub package id matches the grant.
 */
export function withTrustedBotSkillConnectorEnvironment(
  invocation: TrustedBotSkillScriptInvocation | undefined,
  context: ToolExecutionContext,
  environment: NodeJS.ProcessEnv,
  now = Date.now(),
): NodeJS.ProcessEnv {
  const isolated = { ...environment };
  for (const name of CONNECTOR_ENV_NAMES) delete isolated[name];
  if (!invocation) return isolated;

  // TODO(connectors): only the `shimo` provider has a value mapping today. When
  // a second provider lands, map its grant to that provider's own env names
  // instead of silently ignoring the grant.
  const grant = [...(context.skillConnectorGrants || [])]
    .filter(candidate => (
      candidate.provider === 'shimo'
      && candidate.skillId === invocation.skillId
      && candidate.expiresAt > now
      && safeConnectorURL(candidate.connectorUrl)
      && Boolean(candidate.actorToken)
    ))
    .sort((left, right) => right.expiresAt - left.expiresAt)[0];
  if (!grant) {
    if (invocation.skillId.includes('/shimo-') || invocation.skillName.toLowerCase().includes('shimo')) {
      Logger.warning(
        `[CatsCompany][shimo_connector] trusted script has no matching grant: `
          + `skill=${invocation.skillId} grant_count=${context.skillConnectorGrants?.length || 0}`,
      );
    }
    return isolated;
  }

  isolated.CATSCO_SHIMO_CONNECTOR_URL = grant.connectorUrl;
  isolated.CATSCO_ACTOR_TOKEN = grant.actorToken;
  isolated.CATSCO_SKILL_ID = grant.skillId;
  return isolated;
}

/**
 * Resolve the deliberately narrow compatibility path for script-backed formal
 * Bot Skills. The model still calls execute_shell, but accepted commands never
 * reach a shell: ShellTool spawns the verified Node entrypoint directly.
 */
export function resolveTrustedBotSkillScriptInvocation(
  command: unknown,
  context: ToolExecutionContext,
  options: { cwd?: unknown; target?: unknown } = {},
): TrustedBotSkillScriptDecision {
  if (!isTrustedLocalCatsCoRuntime(context)) {
    return denied('The current CatsCo turn is not a trusted local Bot runtime.');
  }
  if (stringValue(options.target)) {
    return denied('Verified Bot Skill scripts can only run on the current Bot body, without a target override.');
  }

  const tokens = tokenizeDirectCommand(command);
  if (!tokens || tokens.length < 2 || !isNodeCommand(tokens[0])) {
    return denied('The command is not one direct Node.js script invocation.');
  }

  const executionDirectory = resolveExecutionDirectory(options.cwd, context.workingDirectory);
  if (!executionDirectory) {
    return denied('The command working directory is missing or unavailable.');
  }
  const scriptPath = path.resolve(executionDirectory, tokens[1]);
  if (!['.js', '.cjs', '.mjs'].includes(path.extname(scriptPath).toLowerCase())) {
    return denied('The requested entrypoint is not a JavaScript file.');
  }

  const skillsRoot = path.resolve(
    context.turnSkillSnapshot instanceof TurnSkillSnapshotLease
      ? context.turnSkillSnapshot.snapshot.rootPath
      : PathResolver.getSkillsPath(),
  );
  const relative = path.relative(skillsRoot, scriptPath);
  const segments = relative.split(path.sep).filter(Boolean);
  if (
    !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || segments.length < 3
    || segments[1] !== 'scripts'
  ) {
    return denied('The requested entrypoint is outside an installed Bot Skill scripts directory.');
  }

  const skillDir = path.join(skillsRoot, segments[0]);
  if (!isSafeRegularFileWithin(skillDir, scriptPath)) {
    return denied('The requested Skill entrypoint is missing, unsafe, or linked outside its package.');
  }

  const installMarker = readSkillHubInstallMarker(skillDir);
  const localMarker = readBotSkillLocalMarker(skillDir);
  if (!isCompleteVerifiedInstallMarker(installMarker) || !localMarker?.reference) {
    return denied('The Skill is not a verified SkillHub package materialized for the current Bot.');
  }

  let contentHash: string;
  try {
    // Snapshot trees are immutable. Validate the copied package without the
    // legacy scanner's marker-creation side effect.
    contentHash = computeBotSkillPackageHash(collectBotSkillPackageFiles(skillDir));
  } catch {
    return denied('The installed Skill package failed local integrity validation.');
  }
  const reference = localMarker.reference;
  if (reference.contentHash !== contentHash) {
    return denied('The installed Skill package no longer matches its cloud-bound content hash.');
  }
  if (
    installMarker.skillId !== reference.skillId
    || installMarker.version !== reference.version
    || installMarker.installName !== segments[0]
  ) {
    return denied('The SkillHub install identity does not match the Bot-bound Skill reference.');
  }

  const agentId = stringValue(context.executionScope?.agentId);
  const definition = readActiveBotDefinition(agentId);
  if (!definition?.skills?.some(candidate => sameSkillReference(candidate, reference))) {
    return denied('The verified Skill is not enabled in the current Bot definition.');
  }

  return {
    ok: true,
    invocation: {
      scriptPath,
      args: [scriptPath, ...tokens.slice(2)],
      skillId: reference.skillId,
      skillName: installMarker.name,
      version: reference.version,
    },
  };
}

function isTrustedLocalCatsCoRuntime(context: ToolExecutionContext): boolean {
  if (context.deviceRpcReceiver) return false;
  const scope = context.executionScope;
  const localDevice = context.localDeviceGrant;
  if (
    !scope
    || scope.source !== 'catscompany'
    || scope.identityTrust !== 'server_canonical'
    || !scope.isTrusted
    || !localDevice
    || localDevice.source !== 'catscompany'
  ) {
    return false;
  }
  const ownerSelf = sameIdentity(scope.actorUserId, localDevice.ownerUserId)
    && (!scope.deviceOwnerUserId || sameIdentity(scope.deviceOwnerUserId, localDevice.ownerUserId));
  const agentLocalBody = Boolean(scope.agentBodyId && scope.agentBodyId === localDevice.bodyId);
  return ownerSelf || agentLocalBody;
}

function tokenizeDirectCommand(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let tokenStarted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      const closing = quote === 'single' ? "'" : '"';
      if (character === closing) {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (character === '\\' && value[index + 1] === closing) {
        current += closing;
        tokenStarted = true;
        index += 1;
        continue;
      }
      current += character;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    if (character === "'") {
      quote = 'single';
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = 'double';
      tokenStarted = true;
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (quote) return null;
  if (tokenStarted) tokens.push(current);
  return tokens;
}

function isNodeCommand(value: string): boolean {
  const name = path.basename(value).toLowerCase();
  return name === 'node' || name === 'node.exe';
}

function resolveExecutionDirectory(value: unknown, fallback: string): string | undefined {
  if (value !== undefined && value !== null && typeof value !== 'string') return undefined;
  const requested = stringValue(value) || fallback;
  const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(fallback, requested);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isSafeRegularFileWithin(root: string, candidate: string): boolean {
  try {
    const rootStat = fs.lstatSync(root);
    const candidateStat = fs.lstatSync(candidate);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) return false;
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realCandidate);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

interface ResolvedShellSegment {
  entries: string[];
  cwd?: string;
}

function resolveShellScriptEntryPaths(
  command: string,
  cwd: string,
  inheritedAssignments: Map<string, string> = new Map(),
): string[] {
  const tokens = tokenizeShellCommand(command);
  const assignments = new Map(inheritedAssignments);
  const entries: string[] = [];
  let segment: string[] = [];
  let currentCwd = path.resolve(cwd);

  const flush = (): void => {
    if (segment.length > 0) {
      const resolved = resolveSegmentScriptEntries(segment, assignments, currentCwd);
      entries.push(...resolved.entries);
      if (resolved.cwd) currentCwd = resolved.cwd;
    }
    segment = [];
  };

  for (const token of tokens) {
    if (token === ';' || token === '&&' || token === '||' || token === '|' || token === '(' || token === ')') {
      flush();
      continue;
    }
    segment.push(token);
  }
  flush();
  return entries;
}

function resolveSegmentScriptEntries(
  segment: string[],
  assignments: Map<string, string>,
  cwd: string,
): ResolvedShellSegment {
  let index = 0;
  while (index < segment.length) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(segment[index]);
    if (!match) break;
    assignments.set(match[1], expandShellVariables(match[2], assignments));
    index += 1;
  }
  if (index >= segment.length) return { entries: [] };

  const commandAssignments = new Map(assignments);
  const commandIndex = unwrapShellCommandPrefix(segment, index, commandAssignments);
  if (commandIndex === undefined) return { entries: [] };

  const executable = path.basename(segment[commandIndex]).toLowerCase();
  if (executable === 'cd' || executable === 'cd.exe') {
    const directoryIndex = firstNonOptionIndex(segment, commandIndex + 1);
    if (directoryIndex === undefined) return { entries: [] };
    const requested = expandShellVariables(segment[directoryIndex], commandAssignments);
    return {
      entries: [],
      cwd: path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(cwd, requested),
    };
  }

  if (isShellWrapper(executable)) {
    const commandArgumentIndex = findShellCommandArgumentIndex(segment, commandIndex + 1);
    if (commandArgumentIndex === undefined) return { entries: [] };
    return {
      entries: resolveShellScriptEntryPaths(
        expandShellVariables(segment[commandArgumentIndex], commandAssignments),
        cwd,
        commandAssignments,
      ),
    };
  }

  let scriptIndex: number | undefined;
  if (executable === 'node' || executable === 'node.exe' || executable === 'bun' || executable === 'bun.exe') {
    const inlineCodeIndex = firstInlineCodeArgumentIndex(segment, commandIndex + 1);
    if (inlineCodeIndex !== undefined) {
      return {
        entries: resolveInlineScriptEvidencePaths(segment[inlineCodeIndex], commandAssignments, cwd),
      };
    }
    scriptIndex = firstScriptArgumentIndex(segment, commandIndex + 1);
  } else if (executable === 'npx' || executable === 'npx.cmd' || executable === 'bunx' || executable === 'bunx.exe') {
    const runnerIndex = firstNonOptionIndex(segment, commandIndex + 1);
    if (runnerIndex !== undefined && isKnownScriptRunner(segment[runnerIndex])) {
      scriptIndex = firstScriptArgumentIndex(segment, runnerIndex + 1);
    }
  }
  if (scriptIndex === undefined) return { entries: [] };

  const expanded = expandShellVariables(segment[scriptIndex], commandAssignments);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(cwd, expanded);
  const substitutionEntries = resolveCommandSubstitutionPaths(expanded, commandAssignments, cwd);
  return { entries: [resolved, ...substitutionEntries] };
}

function unwrapShellCommandPrefix(
  segment: string[],
  start: number,
  assignments: Map<string, string>,
): number | undefined {
  let index = start;
  for (;;) {
    const executable = path.basename(segment[index] || '').toLowerCase();
    if (executable === 'env' || executable === 'env.exe') {
      index += 1;
      while (index < segment.length) {
        if (segment[index] === '--') {
          index += 1;
          break;
        }
        if (segment[index].startsWith('-')) {
          index += 1;
          continue;
        }
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(segment[index]);
        if (!assignment) break;
        assignments.set(assignment[1], expandShellVariables(assignment[2], assignments));
        index += 1;
      }
      if (index >= segment.length) return undefined;
      continue;
    }
    if (executable === 'sudo' || executable === 'sudo.exe' || executable === 'command' || executable === 'exec') {
      index += 1;
      while (index < segment.length && segment[index].startsWith('-')) index += 1;
      if (index >= segment.length) return undefined;
      continue;
    }
    return index;
  }
}

function isShellWrapper(value: string): boolean {
  return [
    'bash', 'bash.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe',
    'dash', 'dash.exe', 'ksh', 'ksh.exe',
  ].includes(value);
}

function findShellCommandArgumentIndex(segment: string[], start: number): number | undefined {
  for (let index = start; index < segment.length; index += 1) {
    const option = segment[index];
    const isCommandOption = option === '--command'
      || option === '-c'
      || (option.startsWith('-') && !option.startsWith('--') && option.includes('c'));
    if (isCommandOption) {
      return segment[index + 1] ? index + 1 : undefined;
    }
  }
  return undefined;
}

function isKnownScriptRunner(value: string): boolean {
  const runner = path.basename(value).toLowerCase();
  return [
    'node', 'node.exe', 'tsx', 'tsx.cmd', 'ts-node', 'ts-node.cmd',
    'esbuild', 'esbuild.cmd', 'vite-node', 'vite-node.cmd', 'jiti', 'jiti.cmd',
  ].includes(runner);
}

function firstInlineCodeArgumentIndex(segment: string[], start: number): number | undefined {
  for (let index = start; index < segment.length; index += 1) {
    if (segment[index] === '-e' || segment[index] === '--eval' || segment[index] === '-p' || segment[index] === '--print') {
      return segment[index + 1] ? index + 1 : undefined;
    }
  }
  return undefined;
}

function resolveInlineScriptEvidencePaths(
  value: string,
  assignments: Map<string, string>,
  cwd: string,
): string[] {
  const entries: string[] = [];
  const literal = /(['"])(.*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = literal.exec(value)) !== null) {
    const expanded = expandShellVariables(match[2], assignments);
    if (!expanded.includes('/') && !expanded.includes('\\') && !expanded.startsWith('.')) continue;
    entries.push(path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded));
  }
  return entries;
}

function resolveCommandSubstitutionPaths(
  value: string,
  assignments: Map<string, string>,
  cwd: string,
): string[] {
  const entries: string[] = [];
  const pattern = /\$\(([^()]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const inner = expandShellVariables(match[1], assignments);
    const tokens = tokenizeShellCommand(inner);
    for (const token of tokens) {
      if (token === ';' || token === '&&' || token === '||' || token === '|') continue;
      const expanded = expandShellVariables(token, assignments);
      if (!expanded.includes('/') && !expanded.includes('\\') && !expanded.startsWith('.')) continue;
      entries.push(path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded));
    }
  }
  return entries;
}

function firstScriptArgumentIndex(segment: string[], start: number): number | undefined {
  for (let index = start; index < segment.length; index += 1) {
    const value = segment[index];
    if (value === '--') return segment[index + 1] ? index + 1 : undefined;
    if (value === '-e' || value === '--eval' || value === '-p' || value === '--print') return undefined;
    if (value.startsWith('-')) continue;
    return index;
  }
  return undefined;
}

function firstNonOptionIndex(segment: string[], start: number): number | undefined {
  for (let index = start; index < segment.length; index += 1) {
    if (segment[index] === '--') return segment[index + 1] ? index + 1 : undefined;
    if (!segment[index].startsWith('-')) return index;
  }
  return undefined;
}

function expandShellVariables(value: string, assignments: Map<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => (
    assignments.get(braced || plain) ?? ''
  ));
}

function tokenizeShellCommand(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let tokenStarted = false;
  const push = (): void => {
    if (tokenStarted) tokens.push(current);
    current = '';
    tokenStarted = false;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      const closing = quote === 'single' ? "'" : '"';
      if (character === closing) {
        quote = undefined;
        tokenStarted = true;
      } else if (character === '\\' && quote === 'double' && value[index + 1] === closing) {
        current += closing;
        tokenStarted = true;
        index += 1;
      } else {
        current += character;
        tokenStarted = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? 'single' : 'double';
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    if (character === ';' || character === '|' || character === '(' || character === ')') {
      push();
      if (character === '(' || character === ')') {
        tokens.push(character);
        continue;
      }
      const doubled = value[index + 1] === character;
      if (doubled) index += 1;
      tokens.push(doubled ? `${character}${character}` : character);
      continue;
    }
    if (character === '&' && value[index + 1] === '&') {
      push();
      tokens.push('&&');
      index += 1;
      continue;
    }
    if (character === '\\' && value[index + 1]) {
      current += value[index + 1];
      tokenStarted = true;
      index += 1;
      continue;
    }
    current += character;
    tokenStarted = true;
  }
  push();
  return tokens;
}

function isCompleteVerifiedInstallMarker(value: ReturnType<typeof readSkillHubInstallMarker>): value is NonNullable<typeof value> {
  return Boolean(
    value
    && /^[a-f0-9]{64}$/i.test(stringValue(value.packageChecksumSha256))
    && value.signature?.algorithm === 'ed25519'
    && stringValue(value.signature.keyId)
    && stringValue(value.signature.signature),
  );
}

function sameSkillReference(left: BotSkillRef, right: BotSkillRef): boolean {
  return left.source === 'skillhub'
    && right.source === 'skillhub'
    && left.skillId === right.skillId
    && left.version === right.version
    && left.contentHash === right.contentHash;
}

function sameIdentity(left: unknown, right: unknown): boolean {
  const normalizedLeft = stringValue(left).toLowerCase();
  return Boolean(normalizedLeft && normalizedLeft === stringValue(right).toLowerCase());
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeConnectorURL(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:'
      || (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(hostname));
  } catch {
    return false;
  }
}

function denied(reason: string): TrustedBotSkillScriptDecision {
  return { ok: false, reason };
}
