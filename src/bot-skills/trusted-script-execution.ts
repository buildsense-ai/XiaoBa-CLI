import * as fs from 'fs';
import * as path from 'path';
import { FileBotDefinitionRepository } from '../bot-definition/repository';
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

function readActiveBotDefinition(agentId: string) {
  if (!agentId) return undefined;
  try {
    const repository = new FileBotDefinitionRepository({ runtimeRoot: PathResolver.getRuntimeDataRoot() });
    return repository.readCache(agentId) ?? repository.readCanonical(agentId);
  } catch {
    return undefined;
  }
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

function denied(reason: string): TrustedBotSkillScriptDecision {
  return { ok: false, reason };
}
