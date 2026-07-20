import { AgentServices, AgentSession, SystemPromptProvider } from '../core/agent-session';
import { SkillManager } from '../skills/skill-manager';
import { ToolManager } from '../tools/tool-manager';
import { AIService } from '../utils/ai-service';
import { resolveActiveBotLLMConfig } from '../bot-definition/llm-config-resolver';
import { loadBranchAgentConfig, resolveMemoryBranchModelOverride } from '../core/branch-agent-config';
import { Logger } from '../utils/logger';
import { PromptManager } from '../utils/prompt-manager';
import { PromptComposer } from './prompt-composer';
import { composeSessionSystemPromptProvider } from '../core/session-system-prompt';
import {
  RuntimeProfile,
  assertValidRuntimeProfile,
  resolveDefaultRuntimeProfile,
} from './runtime-profile';

export interface RuntimeSessionBundle {
  profile: RuntimeProfile;
  services: AgentServices;
  session: AgentSession;
}

export interface CreateSessionOptions {
  profile?: RuntimeProfile;
  sessionKey?: string;
  sessionType?: string;
  loadSkills?: boolean;
}

export class RuntimeFactory {
  static async createSession(options: CreateSessionOptions = {}): Promise<RuntimeSessionBundle> {
    const profile = options.profile ?? resolveDefaultRuntimeProfile();
    const services = await this.createServices(profile, {
      loadSkills: options.loadSkills,
    });
    const sessionKey = options.sessionKey ?? profile.surface;
    const sessionType = options.sessionType ?? profile.surface;
    const session = new AgentSession(sessionKey, services, sessionType);
    session.setSystemPromptProvider(this.createSessionSystemPromptProvider(
      profile,
      sessionKey,
      sessionType,
    ));

    return {
      profile,
      services,
      session,
    };
  }

  static async createServices(
    profile: RuntimeProfile,
    options: { loadSkills?: boolean } = {},
  ): Promise<AgentServices> {
    const services = this.createServicesSync(profile);

    if (options.loadSkills ?? profile.skills.enabled) {
      await this.loadSkills(services.skillManager);
    }

    return services;
  }

  static createServicesSync(profile: RuntimeProfile): AgentServices {
    assertValidRuntimeProfile(profile);

    // A per-surface runtime profile may still carry old model fields. Once a
    // CatsCo bot is bound, let ConfigManager resolve its Definition instead of
    // allowing that profile to override the bot identity.
    const modelOverride = resolveActiveBotLLMConfig() ? {} : profile.model;

    const aiService = new AIService(modelOverride);
    const branchConfig = loadBranchAgentConfig();
    const memoryBranchOverride = resolveMemoryBranchModelOverride(branchConfig);
    const memoryBranchModelSource = branchConfig.branches.memorySearch.model.kind;

    return {
      aiService,
      memoryBranch: {
        enabled: branchConfig.branches.memorySearch.enabled,
        modelSource: memoryBranchModelSource,
        aiService: memoryBranchOverride ? new AIService(memoryBranchOverride) : aiService,
      },
      toolManager: new ToolManager(profile.workingDirectory, {}, {
        enabledToolNames: profile.tools.enabled,
      }),
      skillManager: new SkillManager(),
    };
  }

  static createSystemPromptProvider(profile: RuntimeProfile): SystemPromptProvider {
    const promptProfile = this.snapshotProfile(profile);
    return () => PromptComposer.composeSystemPromptFromProfile({
      promptsDir: PromptManager.getPromptsDir(),
      profile: promptProfile,
    });
  }

  static createSessionSystemPromptProvider(
    profile: RuntimeProfile,
    sessionKey: string,
    sessionType?: string,
  ): SystemPromptProvider {
    return composeSessionSystemPromptProvider(
      this.createSystemPromptProvider(profile),
      { sessionKey, sessionType },
    );
  }

  static async loadSkills(skillManager: SkillManager): Promise<void> {
    try {
      await skillManager.loadSkills();
      const skillCount = skillManager.getAllSkills().length;
      if (skillCount > 0) {
        Logger.info(`已加载 ${skillCount} 个 skills`);
      }
    } catch (error: any) {
      Logger.warning(`Skills 加载失败: ${error.message}`);
    }
  }

  private static snapshotProfile(profile: RuntimeProfile): RuntimeProfile {
    return {
      id: profile.id,
      displayName: profile.displayName,
      surface: profile.surface,
      workingDirectory: profile.workingDirectory,
      model: { ...profile.model },
      prompt: { ...profile.prompt },
      tools: { enabled: [...profile.tools.enabled] },
      skills: { ...profile.skills },
      logging: { ...profile.logging },
    };
  }
}
