import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentServices,
  SystemPromptProvider,
} from '../core/agent-session';
import { MessageSessionManagerOptions } from '../core/message-session-manager';
import { Logger } from '../utils/logger';
import {
  RuntimeProfile,
  RuntimeSurface,
} from './runtime-profile';
import { resolveRuntimeProfileFromConfig } from './runtime-profile-config';
import { RuntimeFactory } from './runtime-factory';
import { SKILLHUB_INSTALL_MARKER_FILE } from '../skillhub/install-marker';

export type AdapterPromptSnapshotMode = 'fixed' | 'mutable-identity';
export type AdapterSkillLoadMode = 'warn' | 'fail-fast';

export interface AdapterRuntimeOptions {
  surface: RuntimeSurface;
  sessionTTL?: number;
  workingDirectory?: string;
  promptSnapshotMode?: AdapterPromptSnapshotMode;
  skillLoadMode?: AdapterSkillLoadMode;
}

export interface AdapterRuntimeBundle {
  profile: RuntimeProfile;
  services: AgentServices;
  sessionManagerOptions: MessageSessionManagerOptions;
  loadSkills: () => Promise<void>;
}

type SkillLoadNotificationMode = 'await-observer' | 'background-on-change';

interface SkillLoadState {
  signature?: string;
}

export function createAdapterRuntime(options: AdapterRuntimeOptions): AdapterRuntimeBundle {
  const { profile } = resolveRuntimeProfileFromConfig({
    surface: options.surface,
    ...(options.workingDirectory !== undefined ? { workingDirectory: options.workingDirectory } : {}),
  });
  const services = RuntimeFactory.createServicesSync(profile);
  const systemPromptProviderFactory = createPromptProviderFactory(
    profile,
    options.promptSnapshotMode ?? 'fixed',
  );
  const skillLoadState: SkillLoadState = {};

  return {
    profile,
    services,
    sessionManagerOptions: {
      ttl: options.sessionTTL,
      systemPromptProviderFactory,
      // Every turn reloads the transient Skills list. Only a real inventory
      // change notifies the runtime, and that observer is never awaited on
      // this chat-critical path.
      skillReloadHandler: createSkillLoader(
        services,
        options.skillLoadMode ?? 'warn',
        skillLoadState,
        'background-on-change',
      ),
    },
    loadSkills: createSkillLoader(
      services,
      options.skillLoadMode ?? 'warn',
      skillLoadState,
      'await-observer',
    ),
  };
}

function createSkillLoader(
  services: AgentServices,
  mode: AdapterSkillLoadMode,
  state: SkillLoadState,
  notificationMode: SkillLoadNotificationMode,
): () => Promise<void> {
  return async () => {
    if (mode === 'fail-fast') {
      await services.skillManager.loadSkills();
      Logger.info(`已加载 ${services.skillManager.getAllSkills().length} 个 skills`);
    } else {
      await RuntimeFactory.loadSkills(services.skillManager);
    }
    const changed = updateSkillLoadSignature(services, state);
    // Read the hook from the shared service object at call time. Adapters can
    // attach lifecycle observers after constructing the runtime bundle.
    if (notificationMode === 'await-observer') {
      await services.onSkillsReloaded?.();
    } else if (changed) {
      notifySkillsReloadedInBackground(services);
    }
  };
}

function updateSkillLoadSignature(services: AgentServices, state: SkillLoadState): boolean {
  const signature = JSON.stringify(
    services.skillManager.getAllSkills().map((skill) => {
      const filePath = String(skill.filePath || '');
      return {
        name: String(skill.metadata.name || '').trim(),
        description: String(skill.metadata.description || '').trim(),
        userInvocable: skill.metadata.userInvocable !== false,
        filePath,
        skillFileRevision: fileRevision(filePath),
        skillHubMarkerRevision: filePath
          ? fileRevision(path.join(path.dirname(filePath), SKILLHUB_INSTALL_MARKER_FILE))
          : '',
      };
    }).sort((left, right) => (
      `${left.name}\u0000${left.filePath}`.localeCompare(`${right.name}\u0000${right.filePath}`)
    )),
  );
  const changed = state.signature !== signature;
  state.signature = signature;
  return changed;
}

// SkillManager has already synchronously parsed SKILL.md for this reload. The
// cheap stat revisions also cover content and SkillHub package-marker updates
// without adding file hashing or network work to the chat-critical path.
function fileRevision(filePath: string): string {
  if (!filePath) return '';
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return '';
  }
}

function notifySkillsReloadedInBackground(services: AgentServices): void {
  const observer = services.onSkillsReloaded;
  if (!observer) return;
  void Promise.resolve()
    .then(() => observer())
    .catch((error: unknown) => {
    Logger.warning(`Skills 重新加载后的后台观察失败: ${error instanceof Error ? error.message : String(error)}`);
    });
}

function createPromptProviderFactory(
  profile: RuntimeProfile,
  mode: AdapterPromptSnapshotMode,
): (sessionKey: string) => SystemPromptProvider {
  if (mode === 'fixed') {
    const provider = RuntimeFactory.createSystemPromptProvider(profile);
    return () => provider;
  }

  const workingDirectory = profile.workingDirectory;
  return () => RuntimeFactory.createSystemPromptProvider({
    ...profile,
    workingDirectory,
    model: { ...profile.model },
    prompt: { ...profile.prompt },
    tools: { enabled: [...profile.tools.enabled] },
    skills: { ...profile.skills },
    logging: { ...profile.logging },
  });
}
