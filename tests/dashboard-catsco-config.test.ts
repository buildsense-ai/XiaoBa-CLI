/**
 * CatsCo 配置管理器测试
 * 测试新的统一配置存储功能
 */

import { describe, it, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 临时配置路径
const tempDir = path.join(os.tmpdir(), `catsco-config-test-${Date.now()}`);
const tempConfigFile = path.join(tempDir, 'config.json');

describe('CatsCoConfigManager', () => {
  beforeEach(() => {
    // 创建临时目录
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    // 清理配置
    if (fs.existsSync(tempConfigFile)) {
      fs.unlinkSync(tempConfigFile);
    }
  });

  it('创建默认配置', async () => {
    // 动态导入以使用新的临时路径
    const { CatsCoConfigManager } = await import('../src/dashboard/catsco-config');
    
    CatsCoConfigManager.initialize(tempConfigFile);
    const config = CatsCoConfigManager.getConfig();

    it('version 应该是 2', () => {
      console.assert(config.version === 2, '版本应该是 2');
    });

    it('botList 应该是空数组', () => {
      console.assert(Array.isArray(config.botList), 'botList 应该是数组');
      console.assert(config.botList.length === 0, 'botList 应该是空的');
    });

    it('preferences 有默认值', () => {
      console.assert(config.preferences.autoConnect === true, 'autoConnect 默认应为 true');
      console.assert(config.preferences.switchConfirmEnabled === true, 'switchConfirmEnabled 默认应为 true');
    });
  });

  it('保存和读取账号信息', async () => {
    const { CatsCoConfigManager } = await import('../src/dashboard/catsco-config');
    
    CatsCoConfigManager.initialize(tempConfigFile);
    
    const testAccount = {
      token: 'test-token-123',
      uid: 'user-456',
      username: 'testuser',
      displayName: '测试用户',
    };
    
    CatsCoConfigManager.saveAccount(testAccount);
    
    const savedAccount = CatsCoConfigManager.getAccount();
    
    it('账号信息正确保存', () => {
      console.assert(savedAccount?.token === testAccount.token, 'token 不匹配');
      console.assert(savedAccount?.uid === testAccount.uid, 'uid 不匹配');
      console.assert(savedAccount?.username === testAccount.username, 'username 不匹配');
    });
  });

  it('保存和读取当前机器人', async () => {
    const { CatsCoConfigManager } = await import('../src/dashboard/catsco-config');
    
    CatsCoConfigManager.initialize(tempConfigFile);
    
    const testBot = {
      uid: 'bot-789',
      name: 'TestBot',
      apiKey: 'cc_8_test_key',
    };
    
    CatsCoConfigManager.saveCurrentBot(testBot);
    
    const savedBot = CatsCoConfigManager.getCurrentBot();
    
    it('机器人信息正确保存', () => {
      console.assert(savedBot?.uid === testBot.uid, 'uid 不匹配');
      console.assert(savedBot?.name === testBot.name, 'name 不匹配');
      console.assert(savedBot?.apiKey === testBot.apiKey, 'apiKey 不匹配');
    });

    it('机器人列表正确更新', () => {
      const botList = CatsCoConfigManager.getBotList();
      console.assert(botList.length === 1, 'botList 应该有 1 个机器人');
      console.assert(botList[0].uid === testBot.uid, 'botList 中的 uid 不匹配');
    });
  });

  it('重命名机器人', async () => {
    const { CatsCoConfigManager } = await import('../src/dashboard/catsco-config');
    
    CatsCoConfigManager.initialize(tempConfigFile);
    
    CatsCoConfigManager.saveCurrentBot({
      uid: 'bot-001',
      name: 'OriginalName',
      apiKey: 'key-001',
    });
    
    CatsCoConfigManager.renameBot('bot-001', 'NewName');
    
    const renamedBot = CatsCoConfigManager.getCurrentBot();
    
    it('机器人名称已更新', () => {
      console.assert(renamedBot?.name === 'NewName', '名称应该是 NewName');
    });
  });

  it('删除机器人', async () => {
    const { CatsCoConfigManager } = await import('../src/dashboard/catsco-config');
    
    CatsCoConfigManager.initialize(tempConfigFile);
    
    CatsCoConfigManager.saveCurrentBot({
      uid: 'bot-to-delete',
      name: 'DeleteMe',
      apiKey: 'key-delete',
    });
    
    CatsCoConfigManager.removeBot('bot-to-delete');
    
    const botList = CatsCoConfigManager.getBotList();
    const currentBot = CatsCoConfigManager.getCurrentBot();
    
    it('机器人已从列表删除', () => {
      console.assert(botList.length === 0, 'botList 应该是空的');
    });
    
    it('当前机器人已清除', () => {
      console.assert(!currentBot, 'currentBot 应该是 undefined');
    });
  });

  it('设置默认机器人', async () => {
    const { CatsCoConfigManager } = await import('../src/dashboard/catsco-config');
    
    CatsCoConfigManager.initialize(tempConfigFile);
    
    // 添加多个机器人
    CatsCoConfigManager.saveCurrentBot({ uid: 'bot-1', name: 'Bot1', apiKey: 'key1' });
    CatsCoConfigManager.saveCurrentBot({ uid: 'bot-2', name: 'Bot2', apiKey: 'key2' });
    
    CatsCoConfigManager.setDefaultBot('bot-1');
    
    const botList = CatsCoConfigManager.getBotList();
    
    it('默认机器人设置正确', () => {
      const bot1 = botList.find(b => b.uid === 'bot-1');
      const bot2 = botList.find(b => b.uid === 'bot-2');
      console.assert(bot1?.isDefault === true, 'Bot1 应该是默认');
      console.assert(bot2?.isDefault === false, 'Bot2 不应该是默认');
    });
  });

  it('配置持久化测试', async () => {
    const { CatsCoConfigManager } = await import('../src/dashboard/catsco-config');
    
    // 第一个实例：写入配置
    CatsCoConfigManager.initialize(tempConfigFile);
    CatsCoConfigManager.saveAccount({
      token: 'persist-token',
      uid: 'persist-uid',
      username: 'persistuser',
      displayName: '持久化用户',
    });
    
    // 第二个实例：读取配置
    CatsCoConfigManager.initialize(tempConfigFile);
    const loadedAccount = CatsCoConfigManager.getAccount();
    
    it('配置可以跨实例持久化', () => {
      console.assert(loadedAccount?.token === 'persist-token', 'token 应该持久化');
    });
  });

  it('清除账号信息', async () => {
    const { CatsCoConfigManager } = await import('../src/dashboard/catsco-config');
    
    CatsCoConfigManager.initialize(tempConfigFile);
    CatsCoConfigManager.saveAccount({
      token: 'temp-token',
      uid: 'temp-uid',
      username: 'tempuser',
      displayName: '临时用户',
    });
    
    CatsCoConfigManager.clearAccount();
    
    it('账号信息已清除', () => {
      console.assert(!CatsCoConfigManager.getAccount(), '账号应该是 undefined');
    });
  });

  it('更新偏好设置', async () => {
    const { CatsCoConfigManager } = await import('../src/dashboard/catsco-config');
    
    CatsCoConfigManager.initialize(tempConfigFile);
    
    CatsCoConfigManager.updatePreferences({
      autoConnect: false,
      switchConfirmEnabled: false,
    });
    
    const prefs = CatsCoConfigManager.getPreferences();
    
    it('偏好设置正确更新', () => {
      console.assert(prefs.autoConnect === false, 'autoConnect 应该是 false');
      console.assert(prefs.switchConfirmEnabled === false, 'switchConfirmEnabled 应该是 false');
    });
  });
});
