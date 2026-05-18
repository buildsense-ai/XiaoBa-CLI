/**
 * CatsCo 统一配置管理模块
 * 
 * 设计目标：
 * 1. 统一配置存储到 ~/.xiaoba/config.json（而不是分散的 .env）
 * 2. 支持多机器人管理
 * 3. 支持多设备管理
 * 4. 持久化机器人名称
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dotenv from 'dotenv';

// ============== 类型定义 ==============

export interface CatsCoAccount {
  token: string;
  uid: string;
  username: string;
  displayName: string;
}

export interface CatsCoBot {
  uid: string;
  name: string;
  apiKey?: string;
  isDefault: boolean;
  createdAt?: string;
}

export interface CatsCoDevice {
  id: string;
  name: string;
  platform: string;
  botName: string;
  isOnline: boolean;
  lastActiveAt?: string;
  isCurrent: boolean;
}

export interface CatsCoConfigV2 {
  version: number;
  account?: CatsCoAccount;
  currentBot?: {
    uid: string;
    name: string;
    apiKey: string;
  };
  botList: CatsCoBot[];
  preferences: {
    autoConnect: boolean;
    switchConfirmEnabled: boolean;
    workingDirectory?: string;
  };
}

// ============== 常量 ==============

const CONFIG_VERSION = 2;
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.xiaoba');
const DEFAULT_CONFIG_FILE = path.join(DEFAULT_CONFIG_DIR, 'config.json');

// ============== 核心功能 ==============

export class CatsCoConfigManager {
  private static config: CatsCoConfigV2 | null = null;
  private static configFile: string = DEFAULT_CONFIG_FILE;

  /**
   * 初始化配置管理器
   */
  static initialize(customPath?: string): void {
    this.configFile = customPath || DEFAULT_CONFIG_FILE;
    this.config = null; // 强制重新加载
  }

  /**
   * 获取配置（带缓存）
   */
  static getConfig(): CatsCoConfigV2 {
    if (!this.config) {
      this.config = this.loadConfig();
    }
    return this.config;
  }

  /**
   * 获取配置（只读，不带缓存）
   */
  static getConfigReadonly(): CatsCoConfigV2 {
    return this.loadConfig();
  }

  /**
   * 保存配置
   */
  static saveConfig(config: CatsCoConfigV2): void {
    this.ensureConfigDir();
    
    // 原子写入：先写临时文件再 rename
    const tempFile = `${this.configFile}.tmp`;
    const content = JSON.stringify(config, null, 2);
    
    fs.writeFileSync(tempFile, content, 'utf-8');
    fs.renameSync(tempFile, this.configFile);
    
    // 更新缓存
    this.config = config;
  }

  /**
   * 更新配置（合并）
   */
  static updateConfig(updates: Partial<CatsCoConfigV2>): CatsCoConfigV2 {
    const current = this.getConfig();
    const updated: CatsCoConfigV2 = {
      ...current,
      ...updates,
      preferences: {
        ...current.preferences,
        ...(updates.preferences || {}),
      },
    };
    this.saveConfig(updated);
    return updated;
  }

  // ============== 账号管理 ==============

  /**
   * 保存账号信息
   */
  static saveAccount(account: CatsCoAccount): void {
    this.updateConfig({ account });
  }

  /**
   * 获取账号信息
   */
  static getAccount(): CatsCoAccount | undefined {
    return this.getConfig().account;
  }

  /**
   * 清除账号信息
   */
  static clearAccount(): void {
    this.updateConfig({ account: undefined });
  }

  // ============== 机器人管理 ==============

  /**
   * 保存当前机器人
   */
  static saveCurrentBot(bot: { uid: string; name: string; apiKey: string }): void {
    const config = this.getConfig();
    
    // 更新 botList 中的记录
    const botList = [...config.botList];
    const existingIndex = botList.findIndex(b => b.uid === bot.uid);
    
    if (existingIndex >= 0) {
      botList[existingIndex] = {
        ...botList[existingIndex],
        name: bot.name,
        apiKey: bot.apiKey,
      };
    } else {
      botList.push({
        uid: bot.uid,
        name: bot.name,
        apiKey: bot.apiKey,
        isDefault: true,
        createdAt: new Date().toISOString(),
      });
    }

    // 更新 currentBot
    this.updateConfig({
      currentBot: bot,
      botList,
    });
  }

  /**
   * 获取机器人列表
   */
  static getBotList(): CatsCoBot[] {
    return this.getConfig().botList;
  }

  /**
   * 获取当前机器人
   */
  static getCurrentBot(): { uid: string; name: string; apiKey: string } | undefined {
    return this.getConfig().currentBot;
  }

  /**
   * 设置默认机器人
   */
  static setDefaultBot(uid: string): void {
    const config = this.getConfig();
    const botList = config.botList.map(bot => ({
      ...bot,
      isDefault: bot.uid === uid,
    }));
    this.updateConfig({ botList });
  }

  /**
   * 删除机器人
   */
  static removeBot(uid: string): void {
    const config = this.getConfig();
    const botList = config.botList.filter(bot => bot.uid !== uid);
    const currentBot = config.currentBot?.uid === uid ? undefined : config.currentBot;
    this.updateConfig({ botList, currentBot });
  }

  /**
   * 重命名机器人
   */
  static renameBot(uid: string, newName: string): void {
    const config = this.getConfig();
    const botList = config.botList.map(bot => 
      bot.uid === uid ? { ...bot, name: newName } : bot
    );
    const currentBot = config.currentBot?.uid === uid 
      ? { ...config.currentBot, name: newName }
      : config.currentBot;
    this.updateConfig({ botList, currentBot });
  }

  // ============== 偏好设置 ==============

  /**
   * 更新偏好设置
   */
  static updatePreferences(preferences: Partial<CatsCoConfigV2['preferences']>): void {
    const current = this.getConfig();
    const mergedPreferences = {
      ...current.preferences,
      ...preferences,
    };
    this.updateConfig({ preferences: mergedPreferences });
  }

  /**
   * 获取偏好设置
   */
  static getPreferences(): CatsCoConfigV2['preferences'] {
    return this.getConfig().preferences;
  }

  // ============== 工具方法 ==============

  /**
   * 从 .env 文件读取 CatsCo 相关配置（兼容性）
   */
  static readEnvConfig(): {
    token?: string;
    uid?: string;
    username?: string;
    displayName?: string;
    botUid?: string;
    apiKey?: string;
    httpBaseUrl?: string;
    serverUrl?: string;
  } {
    const envPath = path.join(process.cwd(), '.env');
    const envVars: Record<string, string> = {};
    
    if (fs.existsSync(envPath)) {
      const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
      Object.assign(envVars, parsed);
    }

    return {
      token: envVars['CATSCO_USER_TOKEN'] || envVars['CATSCOMPANY_USER_TOKEN'],
      uid: envVars['CATSCO_USER_UID'] || envVars['CATSCOMPANY_USER_UID'],
      username: envVars['CATSCO_USER_NAME'] || envVars['CATSCOMPANY_USER_NAME'],
      displayName: envVars['CATSCO_USER_DISPLAY_NAME'] || envVars['CATSCOMPANY_USER_DISPLAY_NAME'],
      botUid: envVars['CATSCO_BOT_UID'] || envVars['CATSCOMPANY_BOT_UID'],
      apiKey: envVars['CATSCO_API_KEY'] || envVars['CATSCOMPANY_API_KEY'],
      httpBaseUrl: envVars['CATSCO_HTTP_BASE_URL'] || envVars['CATSCOMPANY_HTTP_BASE_URL'],
      serverUrl: envVars['CATSCO_SERVER_URL'] || envVars['CATSCOMPANY_SERVER_URL'],
    };
  }

  /**
   * 迁移 .env 配置到新的 config.json
   */
  static migrateFromEnv(): CatsCoConfigV2 {
    const envConfig = this.readEnvConfig();
    const config = this.getConfig();

    // 如果 config.json 已经有账号信息，不需要迁移
    if (config.account && config.currentBot) {
      return config;
    }

    const newConfig: CatsCoConfigV2 = {
      ...config,
      version: CONFIG_VERSION,
      account: envConfig.token ? {
        token: envConfig.token,
        uid: envConfig.uid || '',
        username: envConfig.username || '',
        displayName: envConfig.displayName || '',
      } : config.account,
      currentBot: envConfig.botUid && envConfig.apiKey ? {
        uid: envConfig.botUid,
        name: 'CatsCo', // 默认名称，后续从服务端获取
        apiKey: envConfig.apiKey,
      } : config.currentBot,
      preferences: config.preferences || {
        autoConnect: true,
        switchConfirmEnabled: true,
      },
    };

    this.saveConfig(newConfig);
    return newConfig;
  }

  /**
   * 清除所有配置
   */
  static clearAll(): void {
    this.saveConfig({
      version: CONFIG_VERSION,
      botList: [],
      preferences: {
        autoConnect: true,
        switchConfirmEnabled: true,
      },
    });
  }

  // ============== 私有方法 ==============

  private static ensureConfigDir(): void {
    const dir = path.dirname(this.configFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private static loadConfig(): CatsCoConfigV2 {
    this.ensureConfigDir();

    if (!fs.existsSync(this.configFile)) {
      return this.getDefaultConfig();
    }

    try {
      const content = fs.readFileSync(this.configFile, 'utf-8');
      const parsed = JSON.parse(content);
      
      // 版本检查和迁移
      if (parsed.version !== CONFIG_VERSION) {
        return this.migrateConfig(parsed);
      }

      return parsed;
    } catch {
      return this.getDefaultConfig();
    }
  }

  private static getDefaultConfig(): CatsCoConfigV2 {
    return {
      version: CONFIG_VERSION,
      botList: [],
      preferences: {
        autoConnect: true,
        switchConfirmEnabled: true,
      },
    };
  }

  private static migrateConfig(oldConfig: any): CatsCoConfigV2 {
    // 从旧版本迁移
    const newConfig: CatsCoConfigV2 = {
      version: CONFIG_VERSION,
      account: oldConfig.account,
      currentBot: oldConfig.currentBot,
      botList: oldConfig.botList || [],
      preferences: {
        autoConnect: oldConfig.preferences?.autoConnect ?? true,
        switchConfirmEnabled: oldConfig.preferences?.switchConfirmEnabled ?? true,
        workingDirectory: oldConfig.preferences?.workingDirectory,
      },
    };

    this.saveConfig(newConfig);
    return newConfig;
  }
}

// ============== 便捷导出 ==============

export const catscoConfig = CatsCoConfigManager;
export default CatsCoConfigManager;
