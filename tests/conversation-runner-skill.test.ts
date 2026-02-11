import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRunner } from '../src/core/conversation-runner';
import {
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutor,
  ToolResult,
} from '../src/types/tool';

class MockToolExecutor implements ToolExecutor {
  public readonly allowedSnapshots: Array<{ toolName: string; allowedToolNames?: string[] }> = [];

  constructor(private tools: ToolDefinition[]) {}

  getToolDefinitions(): ToolDefinition[] {
    return this.tools;
  }

  async executeTool(
    toolCall: ToolCall,
    _messages?: any[],
    context?: Partial<ToolExecutionContext>,
  ): Promise<ToolResult> {
    this.allowedSnapshots.push({
      toolName: toolCall.function.name,
      allowedToolNames: context?.allowedToolNames,
    });

    if (toolCall.function.name === 'skill') {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: 'skill',
        content: JSON.stringify({
          __type__: 'skill_activation',
          skillName: 'demo',
          prompt: 'follow demo instructions',
          toolPolicy: {
            allowedTools: ['read_file'],
          },
        }),
      };
    }

    if (
      toolCall.function.name === 'execute_bash' &&
      context?.allowedToolNames &&
      !context.allowedToolNames.includes('execute_bash')
    ) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        name: 'execute_bash',
        content: '执行被阻止：工具 "execute_bash" 不在当前 skill 允许列表中',
        ok: false,
        errorCode: 'TOOL_NOT_ALLOWED_BY_SKILL_POLICY',
        retryable: false,
      };
    }

    return {
      tool_call_id: toolCall.id,
      role: 'tool',
      name: toolCall.function.name,
      content: 'ok',
    };
  }
}

test('conversation runner applies skill activation and shrinks tool set', async () => {
  const toolDefs: ToolDefinition[] = [
    {
      name: 'skill',
      description: 'skill tool',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'read_file',
      description: 'read tool',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'execute_bash',
      description: 'bash tool',
      parameters: { type: 'object', properties: {} },
    },
  ];

  const calledTools: string[][] = [];
  let callCount = 0;

  const mockAI = {
    async chat(_messages: any[], tools?: ToolDefinition[]) {
      calledTools.push((tools || []).map(item => item.name));

      callCount += 1;
      if (callCount === 1) {
        return {
          content: 'activate skill',
          toolCalls: [
            {
              id: 'skill-call-1',
              type: 'function',
              function: {
                name: 'skill',
                arguments: JSON.stringify({ skill: 'demo' }),
              },
            },
          ],
        };
      }

      return {
        content: 'done',
      };
    },
    async chatStream(): Promise<any> {
      throw new Error('not used in this test');
    },
  } as any;

  const runner = new ConversationRunner(mockAI, new MockToolExecutor(toolDefs), {
    stream: false,
    enableCompression: false,
  });

  const result = await runner.run([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ]);

  assert.equal(result.response, 'done');
  assert.equal(calledTools.length, 2);

  // First turn: full tool set
  assert.deepEqual(calledTools[0], ['skill', 'read_file', 'execute_bash']);

  // Second turn after skill activation: filtered by allowed-tools (+ essential skill)
  assert.deepEqual(calledTools[1], ['skill', 'read_file']);

  // Activation should inject a skill system prompt into the message flow
  const hasSkillSystemPrompt = result.messages.some(
    (msg) => msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('[skill:demo]')
  );
  assert.equal(hasSkillSystemPrompt, true);
});

test('conversation runner applies skill tool policy immediately within the same turn', async () => {
  const toolDefs: ToolDefinition[] = [
    {
      name: 'skill',
      description: 'skill tool',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'read_file',
      description: 'read tool',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'execute_bash',
      description: 'bash tool',
      parameters: { type: 'object', properties: {} },
    },
  ];

  let callCount = 0;
  const mockAI = {
    async chat() {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: 'activate then run bash',
          toolCalls: [
            {
              id: 'skill-call-2',
              type: 'function',
              function: {
                name: 'skill',
                arguments: JSON.stringify({ skill: 'demo' }),
              },
            },
            {
              id: 'bash-call-1',
              type: 'function',
              function: {
                name: 'execute_bash',
                arguments: JSON.stringify({ command: 'echo hello' }),
              },
            },
          ],
        };
      }
      return { content: 'done' };
    },
    async chatStream(): Promise<any> {
      throw new Error('not used in this test');
    },
  } as any;

  const executor = new MockToolExecutor(toolDefs);
  const runner = new ConversationRunner(mockAI, executor, {
    stream: false,
    enableCompression: false,
  });

  const result = await runner.run([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ]);

  assert.equal(result.response, 'done');

  const executeSnapshot = executor.allowedSnapshots.find(item => item.toolName === 'execute_bash');
  assert.notEqual(executeSnapshot, undefined);
  assert.equal(executeSnapshot?.allowedToolNames?.includes('execute_bash'), false);

  const blockedToolMessage = result.messages.find(
    (msg) => msg.role === 'tool' && msg.name === 'execute_bash'
  );
  assert.notEqual(blockedToolMessage, undefined);
  assert.equal(
    blockedToolMessage?.content.includes('不在当前 skill 允许列表中'),
    true,
  );
});
