import * as dotenv from 'dotenv';
import { ChatConfig } from '../types';

// 加载环境变量（静默模式）
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

export class ConfigManager {
  static getConfig(): ChatConfig {
    return this.getDefaultConfig();
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
