/**
 * CatsCo 配置管理器测试
 * 测试新的统一配置存储功能
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tempDir: string;
let tempConfigFile: string;

async function loadConfigManager() {
  return import('../src/dashboard/catsco-config');
}

describe('CatsCoConfigManager', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-config-test-'));
    tempConfigFile = path.join(tempDir, 'config.json');
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('创建默认配置', async () => {
    const { CatsCoConfigManager } = await loadConfigManager();

    CatsCoConfigManager.initialize(tempConfigFile);
    const config = CatsCoConfigManager.getConfig();

    assert.equal(config.version, 2);
    assert.deepEqual(config.botList, []);
    assert.equal(config.preferences.autoConnect, true);
    assert.equal(config.preferences.switchConfirmEnabled, true);
  });

  it('保存和读取账号信息', async () => {
    const { CatsCoConfigManager } = await loadConfigManager();

    CatsCoConfigManager.initialize(tempConfigFile);
    const testAccount = {
      token: 'test-token-123',
      uid: 'user-456',
      username: 'testuser',
      displayName: '测试用户',
    };

    CatsCoConfigManager.saveAccount(testAccount);

    assert.deepEqual(CatsCoConfigManager.getAccount(), testAccount);
  });

  it('保存和读取当前机器人', async () => {
    const { CatsCoConfigManager } = await loadConfigManager();

    CatsCoConfigManager.initialize(tempConfigFile);
    const testBot = {
      uid: 'bot-789',
      name: 'TestBot',
      apiKey: 'cc_8_test_key',
    };

    CatsCoConfigManager.saveCurrentBot(testBot);

    assert.deepEqual(CatsCoConfigManager.getCurrentBot(), testBot);
    assert.equal(CatsCoConfigManager.getBotList().length, 1);
    assert.equal(CatsCoConfigManager.getBotList()[0].uid, testBot.uid);
  });

  it('重命名机器人', async () => {
    const { CatsCoConfigManager } = await loadConfigManager();

    CatsCoConfigManager.initialize(tempConfigFile);
    CatsCoConfigManager.saveCurrentBot({
      uid: 'bot-001',
      name: 'OriginalName',
      apiKey: 'key-001',
    });

    CatsCoConfigManager.renameBot('bot-001', 'NewName');

    assert.equal(CatsCoConfigManager.getCurrentBot()?.name, 'NewName');
  });

  it('删除机器人', async () => {
    const { CatsCoConfigManager } = await loadConfigManager();

    CatsCoConfigManager.initialize(tempConfigFile);
    CatsCoConfigManager.saveCurrentBot({
      uid: 'bot-to-delete',
      name: 'DeleteMe',
      apiKey: 'key-delete',
    });

    CatsCoConfigManager.removeBot('bot-to-delete');

    assert.deepEqual(CatsCoConfigManager.getBotList(), []);
    assert.equal(CatsCoConfigManager.getCurrentBot(), undefined);
  });

  it('设置默认机器人', async () => {
    const { CatsCoConfigManager } = await loadConfigManager();

    CatsCoConfigManager.initialize(tempConfigFile);
    CatsCoConfigManager.saveCurrentBot({ uid: 'bot-1', name: 'Bot1', apiKey: 'key1' });
    CatsCoConfigManager.saveCurrentBot({ uid: 'bot-2', name: 'Bot2', apiKey: 'key2' });

    CatsCoConfigManager.setDefaultBot('bot-1');

    const botList = CatsCoConfigManager.getBotList();
    assert.equal(botList.find(bot => bot.uid === 'bot-1')?.isDefault, true);
    assert.equal(botList.find(bot => bot.uid === 'bot-2')?.isDefault, false);
  });

  it('配置持久化测试', async () => {
    const { CatsCoConfigManager } = await loadConfigManager();

    CatsCoConfigManager.initialize(tempConfigFile);
    CatsCoConfigManager.saveAccount({
      token: 'persist-token',
      uid: 'persist-uid',
      username: 'persistuser',
      displayName: '持久化用户',
    });

    CatsCoConfigManager.initialize(tempConfigFile);

    assert.equal(CatsCoConfigManager.getAccount()?.token, 'persist-token');
  });

  it('清除账号信息', async () => {
    const { CatsCoConfigManager } = await loadConfigManager();

    CatsCoConfigManager.initialize(tempConfigFile);
    CatsCoConfigManager.saveAccount({
      token: 'temp-token',
      uid: 'temp-uid',
      username: 'tempuser',
      displayName: '临时用户',
    });

    CatsCoConfigManager.clearAccount();

    assert.equal(CatsCoConfigManager.getAccount(), undefined);
  });

  it('更新偏好设置', async () => {
    const { CatsCoConfigManager } = await loadConfigManager();

    CatsCoConfigManager.initialize(tempConfigFile);
    CatsCoConfigManager.updatePreferences({
      autoConnect: false,
      switchConfirmEnabled: false,
    });

    const prefs = CatsCoConfigManager.getPreferences();
    assert.equal(prefs.autoConnect, false);
    assert.equal(prefs.switchConfirmEnabled, false);
  });
});
