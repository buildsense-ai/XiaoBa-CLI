import { AgentServices, AgentSession, SystemPromptProvider } from '../core/agent-session';
import { SkillManager } from '../skills/skill-manager';
import { TurnSkillSnapshotStore } from '../skills/turn-skill-snapshot';
import { ToolManager } from '../tools/tool-manager';
import { AIService } from '../utils/ai-service';
import { resolveActiveBotLLMConfig } from '../bot-definition/llm-config-resolver';
import { loadBranchAgentConfig, resolveMemoryBranchModelOverride } from '../core/branch-agent-config';
import { Logger } from '../utils/logger';
import { PromptManager } from '../utils/prompt-manager';
import { PromptComposer } from './prompt-composer';
import { composeSessionSystemPromptProvider } from '../core/session-system-prompt';
import { PathResolver } from '../utils/path-resolver';
import { CatsLogMemoryProvider } from '../utils/catslog-memory-provider';
import { CatsCoMcpToolBridge } from '../mcp/mcp-tool-bridge';
import { createSdkMcpBridgeClientFactory } from '../mcp/mcp-sdk-client';
import { createCatsCoLocalConfigService } from '../catscompany/local-config';
import { serviceRunReceiptRouter } from '../catscompany/service-run-receipts';
import { FileBotDefinitionRepository } from '../bot-definition/repository';
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
    // Keep a lazy provider attached to long-lived adapter runtimes. The
    // branch re-checks its current capability before every turn, so a login,
    // token rotation, or explicit disable after startup is observed without
    // reconstructing the adapter service graph.
    //
    // The provider lifetime is deliberately independent of the automatic
    // branch switch: the native `catslog_knowledge_recall` tool shares this
    // provider and must work when the memory-search branch is off (and the
    // branch must work if recall is ever disabled). Each consumer re-checks
    // its own availability per call.
    const catslogMemory = branchConfig.branches.memorySearch.enabled
      || profile.tools.enabled.includes('catslog_knowledge_recall')
      || CatsLogMemoryProvider.shouldExposeKnowledgeRecall(
        PathResolver.getRuntimeDataRoot(process.env, profile.workingDirectory),
      )
      ? new CatsLogMemoryProvider(
        // CatsLog credentials live under the runtime data root (the same root
        // used by Dashboard login/logout). Fall back to the profile cwd for
        // standalone CLI runtimes that do not configure a data root.
        PathResolver.getRuntimeDataRoot(process.env, profile.workingDirectory),
      )
      : undefined;

    const toolManager = new ToolManager(profile.workingDirectory, {}, {
      enabledToolNames: profile.tools.enabled,
      ...(catslogMemory ? { catslogKnowledge: catslogMemory } : {}),
    });
    const mcpToolBridge = this.createMcpToolBridge(toolManager, profile);

    return {
      aiService,
      memoryBranch: {
        enabled: branchConfig.branches.memorySearch.enabled,
        modelSource: memoryBranchModelSource,
        aiService: memoryBranchOverride ? new AIService(memoryBranchOverride) : aiService,
        budget: { ...branchConfig.branches.memorySearch.budget },
      },
      ...(catslogMemory ? { catslogMemory } : {}),
      ...(mcpToolBridge ? { mcpToolBridge } : {}),
      toolManager,
      skillManager: new SkillManager(),
      turnSkillSnapshotStore: this.createTurnSkillSnapshotStore(),
    };
  }

  /** CatsCo MCP 工具桥：把平台 `/api/mcp` 上的远程工具注册为本地工具（增量能力，失败不阻断）。 */
  private static createMcpToolBridge(
    toolManager: ToolManager,
    profile: RuntimeProfile,
  ): CatsCoMcpToolBridge | undefined {
    if (process.env.CATSCO_MCP_TOOL_BRIDGE === '0') return undefined;
    try {
      const runtimeRoot = PathResolver.getRuntimeDataRoot(process.env, profile.workingDirectory);
      const localConfig = createCatsCoLocalConfigService({ runtimeRoot });
      const botDefinitions = new FileBotDefinitionRepository({ runtimeRoot });
      const explicitUrl = process.env.CATSCO_MCP_URL?.trim();
      const bridge = new CatsCoMcpToolBridge({
        toolManager,
        createClient: createSdkMcpBridgeClientFactory(),
        // 当前 Agent 的工具清单：读 bot definition 的 serviceAgents（云端同步落本地缓存）。
        // 读不到（未绑定 bot/定义未配置）→ undefined = 账号可见全部（兼容）。
        resolveAgentSlugs: () => {
          try {
            const botUid = String(localConfig.getAuthState().botUid ?? '').trim();
            if (!botUid) return undefined;
            const definition = botDefinitions.readCache(botUid) ?? botDefinitions.readCanonical(botUid);
            const list = definition?.serviceAgents;
            if (!Array.isArray(list)) return undefined;
            return list.map((slug) => String(slug).trim()).filter((slug) => slug.length > 0);
          } catch {
            return undefined;
          }
        },
        // 平台 bot 身份：随 tools/call 上报 bot_uid，平台据此做归属/清单校验并落会话（设计 P1b）。
        resolveBotUid: () => {
          try {
            const raw = localConfig.getAuthState().botUid;
            const botUid = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
            return Number.isFinite(botUid) && botUid > 0 ? botUid : undefined;
          } catch {
            return undefined;
          }
        },
        resolveEndpoint: () => {
          const auth = localConfig.getAuthState();
          const token = (auth.token ?? '').trim();
          if (!token) return null;
          const base = (auth.httpBaseUrl ?? '').replace(/\/+$/, '');
          const url = explicitUrl || (base ? `${base}/api/mcp` : '');
          if (!url) return null;
          return { url, token };
        },
        // 长任务：平台先回 running 句柄，终态通过 WS 回执推送（至少一次 + receipt_id 幂等）。
        // 登记到进程级路由，CatsCompany 服务收到回执时据此唤醒原会话。
        onRunPending: info => {
          try {
            serviceRunReceiptRouter.track(info);
          } catch (error: any) {
            Logger.warning(`CatsCo 回执登记失败: ${error?.message ?? error}`);
          }
        },
      });
      bridge.refreshInBackground();
      return bridge;
    } catch (error: any) {
      // 工具桥是增量能力：初始化异常不得影响主流程。
      Logger.warning(`CatsCo Agent 工具桥初始化失败，已跳过: ${error?.message ?? error}`);
      return undefined;
    }
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

  private static createTurnSkillSnapshotStore(): TurnSkillSnapshotStore | undefined {
    // Keep the new consistency boundary unreachable by default until the
    // staged Skill write/activation path has completed canary verification.
    // This avoids changing any existing Skill editing or tool permission flow.
    if (process.env.XIAOBA_TURN_SKILL_SNAPSHOT_ENABLED !== '1') return undefined;
    try {
      return new TurnSkillSnapshotStore({
        runtimeRoot: PathResolver.getRuntimeDataRoot(),
        skillsRoot: PathResolver.getSkillsPath(),
      });
    } catch (error: any) {
      // Snapshotting is a consistency enhancement. A damaged or unusual legacy
      // data root must not disable chat, tools, or the existing live Skill path.
      Logger.warning(`Turn Skill 快照初始化失败，继续使用兼容路径: ${error.message}`);
      return undefined;
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
