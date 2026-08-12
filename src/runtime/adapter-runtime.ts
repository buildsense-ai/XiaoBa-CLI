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

  return {
    profile,
    services,
    sessionManagerOptions: {
      ttl: options.sessionTTL,
      systemPromptProviderFactory,
      skillReloadHandler: createSkillLoader(services, options.skillLoadMode ?? 'warn'),
    },
    loadSkills: createSkillLoader(services, options.skillLoadMode ?? 'warn'),
  };
}

function createSkillLoader(
  services: AgentServices,
  mode: AdapterSkillLoadMode,
): () => Promise<void> {
  return async () => {
    if (mode === 'fail-fast') {
      await services.skillManager.loadSkills();
      Logger.info(`已加载 ${services.skillManager.getAllSkills().length} 个 skills`);
    } else {
      await RuntimeFactory.loadSkills(services.skillManager);
    }
    // Read the hook from the shared service object at call time. Adapters can
    // attach lifecycle observers after constructing the runtime bundle, while
    // every reload path still gets the same notification.
    await services.onSkillsReloaded?.();
  };
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
