import {
  AgentSession,
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
  profileConfigPath?: string;
  promptSnapshotMode?: AdapterPromptSnapshotMode;
  skillLoadMode?: AdapterSkillLoadMode;
}

export interface AdapterRuntimeBundle {
  profile: RuntimeProfile;
  services: AgentServices;
  sessionManagerOptions: MessageSessionManagerOptions;
  injectSessionContext: (session: AgentSession) => void;
  loadSkills: () => Promise<void>;
}

export function createAdapterRuntime(options: AdapterRuntimeOptions): AdapterRuntimeBundle {
  const { profile } = resolveRuntimeProfileFromConfig({
    surface: options.surface,
    workingDirectory: options.workingDirectory ?? process.cwd(),
    configPath: options.profileConfigPath,
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
      includeSurfacePrompt: profile.prompt.surfaceInfo !== false,
      skillReloadHandler: profile.skills.enabled
        ? createSkillLoader(services, options.skillLoadMode ?? 'warn')
        : async () => {},
    },
    injectSessionContext: (session) => RuntimeFactory.injectPromptContextFiles(session, profile),
    loadSkills: profile.skills.enabled
      ? createSkillLoader(services, options.skillLoadMode ?? 'warn')
      : async () => {},
  };
}

function createSkillLoader(
  services: AgentServices,
  mode: AdapterSkillLoadMode,
): () => Promise<void> {
  if (mode === 'fail-fast') {
    return async () => {
      await services.skillManager.loadSkills();
      Logger.info(`已加载 ${services.skillManager.getAllSkills().length} 个 skills`);
    };
  }

  return () => RuntimeFactory.loadSkills(services.skillManager);
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
    branding: { ...profile.branding },
  });
}
