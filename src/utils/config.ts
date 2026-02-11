import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';
import { ChatConfig } from '../types';

// 加载环境变量（静默模式）
dotenv.config({ quiet: true });

const CONFIG_DIR = path.join(os.homedir(), '.xiaoba');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export class ConfigManager {
  private static ensureConfigDir(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  static getConfig(): ChatConfig {
    this.ensureConfigDir();

    if (!fs.existsSync(CONFIG_FILE)) {
      return this.getDefaultConfig();
    }

    try {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      return this.getDefaultConfig();
    }
  }

  static saveConfig(config: ChatConfig): void {
    this.ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }

  static getDefaultConfig(): ChatConfig {
    const apiUrl = process.env.GAUZ_LLM_API_BASE || 'https://api.openai.com/v1/chat/completions';
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
      memory: {
        enabled: process.env.GAUZ_MEM_ENABLED === 'true' || false,
        baseUrl: process.env.GAUZ_MEM_BASE_URL || 'http://43.139.19.144:1235',
        projectId: process.env.GAUZ_MEM_PROJECT_ID || 'XiaoBa',
        userId: process.env.GAUZ_MEM_USER_ID || 'guowei',
        agentId: process.env.GAUZ_MEM_AGENT_ID || 'XiaoBa',
      },
      feishu: {
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
        botOpenId: process.env.FEISHU_BOT_OPEN_ID,
        botAliases: (process.env.FEISHU_BOT_ALIASES || '小八,xiaoba')
          .split(',')
          .map(item => item.trim())
          .filter(Boolean),
      },
    };
  }
}
