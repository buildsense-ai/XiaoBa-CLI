import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsCompanyBot } from '../src/catscompany';

describe('CatsCompany tool confirmation prompts', () => {
  test('parses only explicit approval phrases as approval', () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;

    assert.equal(bot.parseToolConfirmationAnswer('确认执行'), 'approve');
    assert.equal(bot.parseToolConfirmationAnswer('同意'), 'approve');
    assert.equal(bot.parseToolConfirmationAnswer('我不确认'), 'deny');
    assert.equal(bot.parseToolConfirmationAnswer('不是确认'), 'deny');
    assert.equal(bot.parseToolConfirmationAnswer('别执行'), 'deny');
    assert.equal(bot.parseToolConfirmationAnswer('确认一下是什么操作'), 'unknown');
  });

  test('includes operation target in confirmation prompt', () => {
    const bot = Object.create(CatsCompanyBot.prototype) as any;
    const prompt = bot.formatToolConfirmationPrompt({
      toolName: 'write_file',
      risk: 'medium',
      reason: '工具会修改本机文件，需要用户确认。',
      args: { file_path: 'C:/Users/Annika/Desktop/hello.txt', content: '你好' },
      surface: 'catscompany',
      workingDirectory: 'C:/Users/Annika',
    });

    assert.match(prompt, /write_file/);
    assert.match(prompt, /风险等级：中/);
    assert.match(prompt, /file_path=C:\/Users\/Annika\/Desktop\/hello\.txt/);
    assert.match(prompt, /确认执行/);
  });
});
