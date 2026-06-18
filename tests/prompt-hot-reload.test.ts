import { after, afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('prompt hot reload', { concurrency: false }, () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-hot-reload-'));
    process.chdir(testRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await new Promise(resolve => setTimeout(resolve, 150));
    await removeTempDir(testRoot);
  });

  after(async () => {
    await new Promise(resolve => setTimeout(resolve, 500));
    await removeAllPromptHotReloadTempDirs();
  });

  test('reloads the primary system prompt before the next user message in the same session', async () => {
    const { AgentSession } = loadAgentSessionModules();
    const systemPromptsSeen: string[] = [];
    let currentPrompt = 'system v1';

    const session = new AgentSession('user:prompt-hot-reload-basic', buildMockServices({
      aiService: {
        getConfig: () => ({ provider: 'anthropic', model: 'test-model', contextWindowTokens: 64_000 }),
        async chatStream(messages: any[]) {
          systemPromptsSeen.push(primarySystemPrompt(messages));
          return { content: 'ok', toolCalls: [] };
        },
      },
    }));
    session.setSystemPromptProvider(() => currentPrompt);

    try {
      await session.handleMessage('first');
      currentPrompt = 'system v2';
      await session.handleMessage('second');

      assert.deepEqual(systemPromptsSeen, ['system v1', 'system v2']);
      assert.equal(
        (session as any).messages.filter((message: any) => message.role === 'system').length,
        1,
      );
      assert.equal(primarySystemPrompt((session as any).messages), 'system v2');
    } finally {
      await session.cleanup();
    }
  });

  test('does not change the system prompt in the middle of a tool loop', async () => {
    const { AgentSession } = loadAgentSessionModules();
    const systemPromptsSeen: string[] = [];
    let currentPrompt = 'system v1';
    let aiCalls = 0;

    const session = new AgentSession('user:prompt-hot-reload-tool-loop', buildMockServices({
      aiService: {
        getConfig: () => ({ provider: 'anthropic', model: 'test-model', contextWindowTokens: 64_000 }),
        isToolCallingSupported: () => true,
        async chatStream(messages: any[]) {
          aiCalls++;
          systemPromptsSeen.push(primarySystemPrompt(messages));
          if (aiCalls === 1) {
            currentPrompt = 'system v2';
            return {
              content: null,
              toolCalls: [{
                id: 'tool-1',
                type: 'function',
                function: { name: 'capture_context', arguments: '{}' },
              }],
            };
          }
          return { content: 'done', toolCalls: [] };
        },
      },
      toolManager: {
        getToolDefinitions() {
          return [{
            name: 'capture_context',
            description: 'Capture context',
            parameters: { type: 'object', properties: {} },
          }];
        },
        async executeTool(toolCall: any) {
          return {
            tool_call_id: toolCall.id,
            role: 'tool',
            name: toolCall.function.name,
            content: 'captured',
            ok: true,
          };
        },
      },
    }));
    session.setSystemPromptProvider(() => currentPrompt);

    try {
      const first = await session.handleMessage('run tool');
      assert.equal(first.text, 'done');
      assert.deepEqual(systemPromptsSeen, ['system v1', 'system v1']);

      await session.handleMessage('next turn');
      assert.equal(systemPromptsSeen[2], 'system v2');
    } finally {
      await session.cleanup();
    }
  });
});

function loadAgentSessionModules(): any {
  delete require.cache[require.resolve('../src/core/agent-session')];
  delete require.cache[require.resolve('../src/utils/prompt-manager')];
  delete require.cache[require.resolve('../src/utils/session-turn-logger')];
  return require('../src/core/agent-session');
}

function buildMockServices(overrides: any = {}): any {
  return {
    aiService: overrides.aiService ?? {
      getConfig: () => ({ provider: 'anthropic', model: 'test-model', contextWindowTokens: 64_000 }),
      async chatStream() {
        return { content: 'ok', toolCalls: [] };
      },
    },
    toolManager: overrides.toolManager ?? {
      setContextDefaults() {},
      getToolDefinitions() { return []; },
      executeTool() { throw new Error('not expected'); },
    },
    skillManager: {
      getSkill() { return undefined; },
      getUserInvocableSkills() { return []; },
      getAutoInvocableSkills() { return []; },
      findAutoInvocableSkillByText() { return undefined; },
      loadSkills: async () => {},
    },
  };
}

function primarySystemPrompt(messages: any[]): string {
  const message = messages.find(item => (
    item.role === 'system'
    && typeof item.content === 'string'
    && !item.content.startsWith('[transient_')
  ));
  return message?.content ?? '';
}

async function removeTempDir(directory: string): Promise<void> {
  if (!directory || !fs.existsSync(directory)) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
      if (!fs.existsSync(directory)) return;
      throw new Error(`directory still exists after rm: ${directory}`);
    } catch (error: any) {
      if (attempt === 9) {
        console.warn(`[prompt-hot-reload.test] temp cleanup skipped: ${error?.message || error}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

async function removeAllPromptHotReloadTempDirs(): Promise<void> {
  const tempRoot = path.resolve(os.tmpdir());
  const entries = fs.readdirSync(tempRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('xiaoba-prompt-hot-reload-'))
    .map(entry => path.join(tempRoot, entry.name));
  for (const entry of entries) {
    const resolved = path.resolve(entry);
    if (!resolved.startsWith(tempRoot + path.sep)) continue;
    await removeTempDir(resolved);
  }
}
