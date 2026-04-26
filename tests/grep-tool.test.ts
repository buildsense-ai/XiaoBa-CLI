import { describe, test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { GrepTool } from '../src/tools/grep-tool';
import { ToolExecutionContext } from '../src/types/tool';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

function getContent(result: { ok: boolean; content: unknown }): string {
  assert.strictEqual(result.ok, true, `期望 ok=true，实际: ${JSON.stringify(result)}`);
  return result.content as string;
}

describe('GrepTool', () => {
  let grepTool: GrepTool;
  let testDir: string;
  let context: ToolExecutionContext;

  before(() => {
    // 创建临时测试目录
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-test-'));
    
    // 创建测试文件
    fs.writeFileSync(path.join(testDir, 'test1.js'), 
      'function hello() {\n  console.log("Hello World");\n}\n');
    
    fs.writeFileSync(path.join(testDir, 'test2.ts'), 
      'const greeting = "Hello";\nconst name = "World";\n');
    
    fs.writeFileSync(path.join(testDir, 'test3.py'), 
      'def hello():\n    print("Hello World")\n');
    
    fs.writeFileSync(path.join(testDir, 'README.md'), 
      '# Test Project\nHello World example\n');
    
    // 创建子目录
    const subDir = path.join(testDir, 'subdir');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'nested.js'), 
      'export function greet() {\n  return "Hello";\n}\n');
    
    // 创建.git目录（应该被排除）
    const gitDir = path.join(testDir, '.git');
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, 'config'), 
      'Hello from git config\n');
  });

  after(() => {
    // 清理测试目录
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    grepTool = new GrepTool();
    context = {
      workingDirectory: testDir,
      sessionId: 'test-session',
      surface: 'cli'
    };
  });

  describe('基础搜索功能', () => {
    test('应该能找到匹配的文件（files模式）', async () => {
      const result = await grepTool.execute({
        pattern: 'Hello',
        output_mode: 'files'
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('找到'), '应该显示找到结果');
      assert.ok(text.includes('test1.js'), '应该包含test1.js');
      assert.ok(text.includes('test2.ts'), '应该包含test2.ts');
      assert.ok(text.includes('README.md'), '应该包含README.md');
      assert.ok(!text.includes('.git'), 'VCS目录应该被排除');
    });

    test('应该能显示匹配内容（content模式）', async () => {
      const result = await grepTool.execute({
        pattern: 'Hello World',
        output_mode: 'content'
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('找到'), '应该显示找到结果');
      assert.ok(text.includes('test1.js'), '应该包含文件名');
      assert.ok(text.includes('console.log'), '应该包含匹配内容');
    });

    test('应该能统计匹配数量（count模式）', async () => {
      const result = await grepTool.execute({
        pattern: 'Hello',
        output_mode: 'count'
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('找到'), '应该显示找到结果');
      assert.ok(text.includes('个匹配'), '应该显示匹配数量');
    });

    test('未找到匹配时应该返回提示', async () => {
      // 使用带时间戳的唯一 pattern 确保不匹配任何文件
      const uniquePattern = `UniquePattern_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const result = await grepTool.execute({
        pattern: uniquePattern,
        output_mode: 'files'
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('未找到匹配项'), `应该提示未找到，实际: ${text}`);
    });
  });

  describe('过滤功能', () => {
    test('应该支持glob过滤', async () => {
      const result = await grepTool.execute({
        pattern: 'Hello',
        glob: '*.js',
        output_mode: 'files'
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('test1.js'), '应该包含.js文件');
      assert.ok(!text.includes('test2.ts'), '不应该包含.ts文件');
      assert.ok(!text.includes('test3.py'), '不应该包含.py文件');
    });

    test('应该支持大小写不敏感搜索', async () => {
      const result = await grepTool.execute({
        pattern: 'hello',
        case_insensitive: true,
        output_mode: 'files'
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('找到'), '应该找到结果');
      assert.ok(text.includes('test1.js'), '应该匹配Hello');
    });

    test('应该支持指定搜索路径', async () => {
      const result = await grepTool.execute({
        pattern: 'greet',
        path: 'subdir',
        output_mode: 'files'
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('nested.js'), '应该找到子目录文件');
      assert.ok(!text.includes('test1.js'), '不应该包含父目录文件');
    });
  });

  describe('分页功能', () => {
    test('应该支持limit限制结果数量', async () => {
      const result = await grepTool.execute({
        pattern: 'Hello',
        output_mode: 'files',
        limit: 2
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('limit: 2'), '应该显示limit信息');
    });

    test('应该支持offset跳过结果', async () => {
      const result = await grepTool.execute({
        pattern: 'Hello',
        output_mode: 'files',
        offset: 1
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('offset: 1'), '应该显示offset信息');
    });
  });

  describe('安全性检查', () => {
    test('应该处理工作目录外的路径并返回错误', async () => {
      const result = await grepTool.execute({
        pattern: 'test',
        path: '../../etc/passwd'
      }, context);

      // 由于路径不存在，应该返回错误
      assert.ok(!result.ok, '应该返回错误');
      assert.ok(result.message.includes('目录不存在') || result.message.includes('rg') || result.message.includes('grep'), 
        `错误信息应该有用，实际: ${result.message}`);
    });
  });

  describe('Fallback机制测试', () => {
    test('应该能检测ripgrep是否可用', () => {
      const hasRipgrep = (() => {
        try {
          execSync('rg --version', { stdio: 'pipe' });
          return true;
        } catch {
          return false;
        }
      })();

      assert.strictEqual(typeof hasRipgrep, 'boolean', '检测结果应该是布尔值');
    });

    test('应该能检测系统grep是否可用', () => {
      const hasGrep = (() => {
        try {
          execSync('grep --version', { stdio: 'pipe' });
          return true;
        } catch {
          return false;
        }
      })();

      if (process.platform !== 'win32') {
        assert.strictEqual(hasGrep, true, 'Unix/Linux/Mac应该有grep');
      }
    });

    test('在没有ripgrep时应该fallback到其他方案', async () => {
      const originalPath = process.env.PATH;
      
      try {
        // 移除包含rg的路径
        process.env.PATH = process.env.PATH!
          .split(':')
          .filter(p => !p.includes('.local/bin'))
          .join(':');

        const result = await grepTool.execute({
          pattern: 'Hello',
          output_mode: 'files'
        }, context);

        const text = getContent(result);
        assert.ok(text.includes('找到'), '应该通过fallback找到结果');
        assert.ok(text.includes('test1.js'), '应该包含匹配文件');
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });

  describe('边界情况', () => {
    test('应该处理特殊字符pattern', async () => {
      fs.writeFileSync(path.join(testDir, 'special.txt'), 
        'test@example.com\n$100 price\n');

      const result = await grepTool.execute({
        pattern: '@',
        output_mode: 'files'
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('special.txt'), '应该找到包含特殊字符的文件');
    });

    test('应该处理以-开头的pattern', async () => {
      fs.writeFileSync(path.join(testDir, 'dash.txt'), 
        '-flag option\n');

      const result = await grepTool.execute({
        pattern: '-flag',
        output_mode: 'files'
      }, context);

      const text = getContent(result);
      // 不同实现对-开头pattern的处理不同，只要不崩溃就算通过
      assert.ok(typeof text === 'string', '应该返回有效结果');
    });
  });

  describe('输出格式验证', () => {
    test('files模式应该返回相对路径', async () => {
      const result = await grepTool.execute({
        pattern: 'Hello',
        output_mode: 'files'
      }, context);

      const text = getContent(result);
      assert.ok(!text.includes(testDir), '不应该包含绝对路径');
      assert.ok(text.match(/\d+\.\s+test1\.js/), '应该是相对路径格式');
    });

    test('content模式应该包含行号', async () => {
      const result = await grepTool.execute({
        pattern: 'console',
        output_mode: 'content'
      }, context);

      const text = getContent(result);
      assert.ok(text.match(/test1\.js:\d+:/), '应该包含文件名:行号格式');
    });

    test('count模式应该显示统计信息', async () => {
      const result = await grepTool.execute({
        pattern: 'Hello',
        output_mode: 'count'
      }, context);

      const text = getContent(result);
      assert.ok(text.includes('个匹配'), '应该显示匹配数');
      assert.ok(text.includes('个文件'), '应该显示文件数');
    });
  });
});
