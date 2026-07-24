import * as fs from 'fs';
import * as path from 'path';
import { PathResolver } from '../utils/path-resolver';
import { Logger } from '../utils/logger';
import { loadSkillHubConfig } from './config';
import { DEFAULT_SKILLHUB_SKILLS, DefaultSkillHubSkill } from './default-skills';
import { SkillHubService } from './service';

const STATE_SCHEMA = 'xiaoba.default_skills.v1';

type DefaultSkillBootstrapStateName =
  | 'installed'
  | 'user_removed'
  | 'user_disabled'
  | 'name_conflict'
  | 'failed';

interface DefaultSkillBootstrapItemState {
  state: DefaultSkillBootstrapStateName;
  skillId: string;
  version: string;
  installName: string;
  relativePath?: string;
  updatedAt: string;
  installedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

interface DefaultSkillBootstrapStateFile {
  schema: typeof STATE_SCHEMA;
  items: Record<string, DefaultSkillBootstrapItemState>;
}

export interface DefaultSkillBootstrapResult {
  key: string;
  state: DefaultSkillBootstrapStateName | 'skipped';
  action: 'installed' | 'skipped' | 'recorded';
  reason?: string;
}

export interface DefaultSkillBootstrapOptions {
  skills?: DefaultSkillHubSkill[];
  service?: Pick<SkillHubService, 'install'>;
  now?: () => Date;
  skillsRoot?: string;
  statePath?: string;
}

let bootstrapInFlight: Promise<DefaultSkillBootstrapResult[]> | null = null;

export function bootstrapDefaultSkillHubSkillsOnce(
  options: DefaultSkillBootstrapOptions = {},
): Promise<DefaultSkillBootstrapResult[]> {
  if (!bootstrapInFlight) {
    bootstrapInFlight = bootstrapDefaultSkillHubSkills(options)
      .finally(() => {
        bootstrapInFlight = null;
      });
  }
  return bootstrapInFlight;
}

export async function bootstrapDefaultSkillHubSkills(
  options: DefaultSkillBootstrapOptions = {},
): Promise<DefaultSkillBootstrapResult[]> {
  const defaults = (options.skills ?? DEFAULT_SKILLHUB_SKILLS).filter(isValidDefaultSkill);
  if (!defaults.length) return [];

  const skillsRoot = path.resolve(options.skillsRoot ?? PathResolver.getSkillsPath());
  const service = options.service ?? new SkillHubService({ skillsRoot });
  const now = options.now ?? (() => new Date());
  const statePath = options.statePath ?? getDefaultSkillBootstrapStatePath();
  const state = readStateFile(statePath);
  const results: DefaultSkillBootstrapResult[] = [];
  let changed = false;

  for (const item of defaults) {
    const itemState = state.items[item.key];
    const targetDir = resolveSkillDirectory(item.installName, skillsRoot);
    const activeSkillFile = path.join(targetDir, 'SKILL.md');
    const disabledSkillFile = `${activeSkillFile}.disabled`;

    if (itemState?.state === 'user_removed' || itemState?.state === 'user_disabled' || itemState?.state === 'name_conflict') {
      results.push({ key: item.key, state: itemState.state, action: 'skipped', reason: itemState.state });
      continue;
    }

    if (itemState?.state === 'installed') {
      if (fs.existsSync(activeSkillFile)) {
        results.push({ key: item.key, state: 'installed', action: 'skipped', reason: 'already_installed' });
        continue;
      }
      if (fs.existsSync(disabledSkillFile)) {
        state.items[item.key] = nextState(item, 'user_disabled', now);
        changed = true;
        results.push({ key: item.key, state: 'user_disabled', action: 'recorded', reason: 'disabled_after_install' });
        continue;
      }
      state.items[item.key] = nextState(item, 'user_removed', now);
      changed = true;
      results.push({ key: item.key, state: 'user_removed', action: 'recorded', reason: 'removed_after_install' });
      continue;
    }

    if (fs.existsSync(targetDir)) {
      state.items[item.key] = {
        ...nextState(item, 'name_conflict', now),
        relativePath: path.relative(skillsRoot, targetDir),
      };
      changed = true;
      results.push({ key: item.key, state: 'name_conflict', action: 'recorded', reason: 'local_same_name_exists' });
      continue;
    }

    const attemptedAt = now().toISOString();
    try {
      const installed = await service.install(item.skillId, item.version);
      state.items[item.key] = {
        ...nextState(item, 'installed', now),
        relativePath: path.relative(skillsRoot, installed.skill.path),
        installedAt: attemptedAt,
        lastAttemptAt: attemptedAt,
      };
      changed = true;
      results.push({ key: item.key, state: 'installed', action: 'installed' });
    } catch (error: any) {
      const code = String(error?.code || '');
      state.items[item.key] = {
        ...nextState(item, code === 'TARGET_CONFLICT' ? 'name_conflict' : 'failed', now),
        lastAttemptAt: attemptedAt,
        lastError: error?.message || String(error),
      };
      changed = true;
      results.push({
        key: item.key,
        state: state.items[item.key].state,
        action: 'recorded',
        reason: state.items[item.key].lastError,
      });
    }
  }

  if (changed) writeStateFile(statePath, state);
  return results;
}

export function getDefaultSkillBootstrapStatePath(): string {
  return path.join(loadSkillHubConfig().dataDir, 'default-skills-state.json');
}

function isValidDefaultSkill(item: DefaultSkillHubSkill): boolean {
  return Boolean(
    String(item?.key || '').trim()
    && String(item?.skillId || '').trim()
    && String(item?.version || '').trim()
    && String(item?.installName || '').trim(),
  );
}

function nextState(
  item: DefaultSkillHubSkill,
  state: DefaultSkillBootstrapStateName,
  now: () => Date,
): DefaultSkillBootstrapItemState {
  return {
    state,
    skillId: item.skillId,
    version: item.version,
    installName: item.installName,
    updatedAt: now().toISOString(),
  };
}

function readStateFile(filePath: string): DefaultSkillBootstrapStateFile {
  try {
    if (!fs.existsSync(filePath)) return { schema: STATE_SCHEMA, items: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DefaultSkillBootstrapStateFile;
    if (parsed?.schema === STATE_SCHEMA && parsed.items && typeof parsed.items === 'object') {
      return { schema: STATE_SCHEMA, items: parsed.items };
    }
  } catch (error: any) {
    Logger.warning(`Failed to read default SkillHub state: ${error?.message || String(error)}`);
  }
  return { schema: STATE_SCHEMA, items: {} };
}

function writeStateFile(filePath: string, state: DefaultSkillBootstrapStateFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function resolveSkillDirectory(installName: string, skillsRoot?: string): string {
  const root = path.resolve(skillsRoot ?? PathResolver.getSkillsPath());
  const target = path.resolve(root, installName);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe default Skill install name: ${installName}`);
  }
  return target;
}
