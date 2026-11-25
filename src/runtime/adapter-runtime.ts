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
    services,
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
  services?: AgentServices,
): (sessionKey: string) => SystemPromptProvider {
  // MCP server instructions 是受限注入的尾部块：每次渲染同步快照，不进 profile 快照。
  const mcpClientManager = services?.mcpClientManager;
  const withInstructions = (provider: SystemPromptProvider): SystemPromptProvider =>
    RuntimeFactory.withMcpServerInstructions(provider, mcpClientManager);
  if (mode === 'fixed') {
    const provider = RuntimeFactory.createSystemPromptProvider(profile);
    return () => withInstructions(provider);
  }

  const workingDirectory = profile.workingDirectory;
  return () => withInstructions(RuntimeFactory.createSystemPromptProvider({
    ...profile,
    workingDirectory,
    model: { ...profile.model },
    prompt: { ...profile.prompt },
    tools: { enabled: [...profile.tools.enabled] },
    skills: { ...profile.skills },
    logging: { ...profile.logging },
  }));
}
