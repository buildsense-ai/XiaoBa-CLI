import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SubAgentSession } from '../src/core/sub-agent-session';
import { ToolManager } from '../src/tools/tool-manager';
import type { Message } from '../src/types';

test('ordinary subagent uses full-coverage durable checkpoints instead of legacy truncation', async t => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-subagent-checkpoint-'));
  t.after(() => fs.rmSync(workingDirectory, { recursive: true, force: true }));
  const originalExecuteTool = ToolManager.prototype.executeTool;
  t.after(() => { ToolManager.prototype.executeTool = originalExecuteTool; });
  ToolManager.prototype.executeTool = async function executeCheckpointEvidence(call: any) {
    return {
      role: 'tool',
      tool_call_id: call.id,
      name: call.function.name,
      content: `HEAD_SENTINEL\n${'x'.repeat(120_000)}\nTAIL_SENTINEL`,
      ok: true,
    };
  };

  const checkpointRequests: Message[][] = [];
  const primaryRequests: Message[][] = [];
  let primaryCount = 0;
  const usage = { promptTokens: 1_000, completionTokens: 20, totalTokens: 1_020 };
  const aiService = {
    getConfig: () => ({
      provider: 'openai',
      model: 'subagent-checkpoint-test',
      contextWindowTokens: 32_000,
      maxTokens: 2_048,
    }),
    chatStream: async (
      messages: Message[],
      _tools: unknown[],
      callbacks: { onText?: (text: string) => void },
      options: any,
    ) => {
      if (options?.requestKind === 'checkpoint_compaction') {
        checkpointRequests.push(messages.map(message => ({ ...message })));
        const summary = 'HEAD_SENTINEL and TAIL_SENTINEL are both preserved; read_file completed.';
        callbacks.onText?.(summary);
        return { content: summary, toolCalls: [], usage };
      }
      primaryRequests.push(messages.map(message => ({ ...message })));
      primaryCount++;
      if (primaryCount === 1) {
        return {
          content: null,
          toolCalls: [{
            id: 'subagent-large-result',
            type: 'function',
            function: { name: 'read_file', arguments: '{"file_path":"evidence.txt"}' },
          }],
          usage,
        };
      }
      const final = 'subagent checkpoint passed';
      callbacks.onText?.(final);
      return { content: final, toolCalls: [], usage };
    },
  } as any;
  const session = new SubAgentSession('full-coverage-checkpoint', aiService, {
    getSkill() { return undefined; },
  } as any, {
    agentType: 'explorer',
    taskDescription: 'verify subagent checkpoint coverage',
    userMessage: 'Read the evidence, preserve both sentinels, and finish.',
    allowedTools: ['read_file'],
    workingDirectory,
  });
  t.after(() => session.close());

  await session.run();

  assert.equal(session.status, 'completed');
  assert.ok(checkpointRequests.length > 0);
  const checkpointSource = JSON.stringify(checkpointRequests);
  assert.match(checkpointSource, /HEAD_SENTINEL/);
  assert.match(checkpointSource, /TAIL_SENTINEL/);
  assert.doesNotMatch(checkpointSource, /已截断|已省略|\.\.\.\[共\s*\d+\s*字符\]/u);
  assert.equal(primaryRequests.length, 2);
  const resumedRequest = JSON.stringify(primaryRequests[1]);
  assert.match(resumedRequest, /HEAD_SENTINEL/);
  assert.match(resumedRequest, /TAIL_SENTINEL/);
  assert.doesNotMatch(resumedRequest, /已截断|已省略|\.\.\.\[共\s*\d+\s*字符\]/u);

  const checkpointPath = path.join(
    session.temporaryDirectory,
    '.xiaoba-continuation-checkpoint.json',
  );
  const checkpointStat = fs.statSync(checkpointPath);
  assert.ok(checkpointStat.size > 0);
  if (process.platform !== 'win32') {
    assert.equal(checkpointStat.mode & 0o777, 0o600);
  }
});
