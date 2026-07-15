import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';
import { ChatConfig } from '../types';
import { normalizeReasoningEffort } from './reasoning-effort';
import { normalizeOpenAIApiMode } from './openai-api-mode';
import { resolveActiveBotLLMConfig } from '../bot-definition/llm-config-resolver';
import { PathResolver } from './path-resolver';

// 加载环境变量（静默模式）
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.xiaoba');
const DEFAULT_CONFIG_FILE = path.join(DEFAULT_CONFIG_DIR, 'config.json');

export class ConfigManager {
  private static mergeConfig(base: ChatConfig, override?: Partial<ChatConfig>): ChatConfig {
    if (!override) {
      return base;
    }

    return {
      ...base,
      ...override,
      feishu: {
        ...(base.feishu || {}),
        ...(override.feishu || {}),
      },
      catscompany: {
        ...(base.catscompany || {}),
        ...(override.catscompany || {}),
      },
      weixin: {
        ...(base.weixin || {}),
        ...(override.weixin || {}),
      },
    };
  }

  private static ensureConfigDir(): void {
    const configDir = path.dirname(this.getConfigFilePath());
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
  }

  private static loadUserConfigFile(): Partial<ChatConfig> {
    const configFile = this.getConfigFilePath();
    if (!fs.existsSync(configFile)) {
      return {};
    }

    try {
      const content = fs.readFileSync(configFile, 'utf-8');
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  private static getConfigFilePath(): string {
    const explicitPath = process.env.XIAOBA_CONFIG_PATH?.trim();
    return explicitPath ? path.resolve(explicitPath) : DEFAULT_CONFIG_FILE;
  }

  static getConfig(): ChatConfig {
    this.ensureConfigDir();
    return this.applyActiveBotDefinition(this.mergeConfig(
      this.mergeConfig(this.getDefaultConfig(), this.loadUserConfigFile()),
      this.getExplicitModelEnvConfig(),
    ));
  }

  static getConfigReadonly(): ChatConfig {
    return this.applyActiveBotDefinition(this.mergeConfig(
      this.mergeConfig(this.getDefaultConfig(), this.loadUserConfigFile()),
      this.getExplicitModelEnvConfig(),
    ));
  }

  static saveConfig(config: ChatConfig): void {
    this.ensureConfigDir();
    const merged = this.mergeConfig(this.loadUserConfigFile() as ChatConfig, config);
    fs.writeFileSync(this.getConfigFilePath(), JSON.stringify(merged, null, 2));
  }

  static getDefaultConfig(): ChatConfig {
    const apiUrl = process.env.GAUZ_LLM_API_BASE || 'https://api.openai.com/v1';
    const model = process.env.GAUZ_LLM_MODEL || 'gpt-3.5-turbo';

    // 自动检测 provider
    let provider: 'openai' | 'anthropic' = 'openai';
    if (process.env.GAUZ_LLM_PROVIDER) {
      provider = process.env.GAUZ_LLM_PROVIDER as 'openai' | 'anthropic';
    } else if (apiUrl.includes('anthropic') || apiUrl.includes('claude') || model.includes('claude')) {
      provider = 'anthropic';
    }

    return {
      apiUrl,
      apiKey: process.env.GAUZ_LLM_API_KEY,
      model,
      temperature: 0.7,
      provider,
      openaiApiMode: normalizeOpenAIApiMode(process.env.GAUZ_LLM_OPENAI_API_MODE) ?? 'chat_completions',
      feishu: {
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
        botOpenId: process.env.FEISHU_BOT_OPEN_ID,
        botAliases: (process.env.FEISHU_BOT_ALIASES || 'CatsCo,catsco,小八,xiaoba')
          .split(',')
          .map(item => item.trim())
          .filter(Boolean),
      },
      catscoLogUpload: {
        enabled: process.env.CATSCO_LOG_UPLOAD_ENABLED !== 'false',
        serverUrl: process.env.CATSCO_LOG_API_BASE_URL || 'https://logs.catsco.fun:8000',
        intervalMinutes: parseInt(process.env.CATSCO_LOG_UPLOAD_INTERVAL_MINUTES || '30'),
      },
    };
  }

  private static getExplicitModelEnvConfig(): Partial<ChatConfig> {
    const override: Partial<ChatConfig> = {};
    const provider = process.env.GAUZ_LLM_PROVIDER?.trim();
    const apiUrl = process.env.GAUZ_LLM_API_BASE?.trim();
    const apiKey = process.env.GAUZ_LLM_API_KEY?.trim();
    const model = process.env.GAUZ_LLM_MODEL?.trim();
    const maxTokens = this.parsePositiveIntegerEnv(
      process.env.GAUZ_LLM_MAX_OUTPUT_TOKENS,
      process.env.GAUZ_LLM_MAX_TOKENS,
    );
    const contextWindowTokens = this.parsePositiveIntegerEnv(
      process.env.GAUZ_LLM_CONTEXT_WINDOW_TOKENS,
      process.env.GAUZ_LLM_CONTEXT_TOKENS,
    );
    const reasoningEffort = normalizeReasoningEffort(process.env.GAUZ_LLM_REASONING_EFFORT);
    const openaiApiMode = normalizeOpenAIApiMode(process.env.GAUZ_LLM_OPENAI_API_MODE);

    if (provider === 'openai' || provider === 'anthropic') {
      override.provider = provider;
    }
    if (apiUrl) {
      override.apiUrl = apiUrl;
    }
    if (apiKey) {
      override.apiKey = apiKey;
    }
    if (model) {
      override.model = model;
    }
    if (maxTokens !== undefined) {
      override.maxTokens = maxTokens;
    }
    if (contextWindowTokens !== undefined) {
      override.contextWindowTokens = contextWindowTokens;
    }
    if (reasoningEffort !== undefined) {
      override.reasoningEffort = reasoningEffort;
    }
    if (openaiApiMode !== undefined) {
      override.openaiApiMode = openaiApiMode;
    }

    return override;
  }

  /**
   * A bound bot resolves its model entirely from the local BotDefinition
   * cache and (for catalog models) device-local relay material. Legacy .env
   * remains only as a one-time migration source when that material is absent.
   */
  private static applyActiveBotDefinition(config: ChatConfig): ChatConfig {
    const resolved = resolveActiveBotLLMConfig({ runtimeRoot: PathResolver.getRuntimeDataRoot() });
    if (!resolved) return config;
    return {
      ...this.withoutModelConfig(config),
      ...resolved.config,
    };
  }

  /**
   * Once a bot is bound, its Definition owns every model-affecting field.
   * Keeping a legacy value here as a partial fallback would let one device's
   * stale .env silently alter a different bot.
   */
  private static withoutModelConfig(config: ChatConfig): ChatConfig {
    const next = { ...config };
    delete next.apiKey;
    delete next.apiUrl;
    delete next.model;
    delete next.provider;
    delete next.temperature;
    delete next.maxTokens;
    delete next.contextWindowTokens;
    delete next.reasoningEffort;
    delete next.openaiApiMode;
    return next;
  }

  private static parsePositiveIntegerEnv(...values: Array<string | undefined>): number | undefined {
    for (const value of values) {
      const text = value?.trim();
      if (!text) continue;
      const parsed = Number(text);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
      }
    }
    return undefined;
  }
}
