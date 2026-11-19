import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { ChatResponse, Message } from '../src/types';
import { ToolCall, ToolDefinition } from '../src/types/tool';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function makeToolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

class NoInjectMemoryBranchAI {
  calls: Message[][] = [];

  isToolCallingSupported(): boolean {
    return true;
  }

  async chat(messages: Message[], _tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    return {
      content: null,
      toolCalls: [makeToolCall('finish_1', 'finish_memory_search', {
        summary: 'No extra memory worth injecting.',
        evidence: [],
        inject: false,
      })],
      usage,
    };
  }
}

class InvalidThenRecoveringMemoryBranchAI {
  calls: Message[][] = [];
  isToolCallingSupported(): boolean { return true; }
  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const finishDefinition = tools?.find(tool => tool.name === 'finish_memory_search');
    assert.deepEqual(finishDefinition?.parameters.required, ['summary', 'evidence', 'inject']);
    if (this.calls.length === 1) return { content: null, toolCalls: [{ id: 'finish_bad_json', type: 'function', function: { name: 'finish_memory_search', arguments: '{bad json' } }], usage };
    const lastTool = [...messages].reverse().find(message => message.role === 'tool');
    assert.match(String(lastTool?.content || ''), /Correct format/);
    return { content: null, toolCalls: [makeToolCall('finish_recovered', 'finish_memory_search', { summary: 'No extra memory worth injecting.', evidence: [], inject: false })], usage };
  }
}

class RepeatedInvalidFinishMemoryBranchAI {
  calls: Message[][] = [];
  isToolCallingSupported(): boolean { return true; }
  async chat(messages: Message[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    return { content: null, toolCalls: [makeToolCall(`finish_invalid_${this.calls.length}`, 'finish_memory_search', { summary: 'No useful memory.', evidence: { invalid: true }, inject: false })], usage };
  }
}

class InvalidFinishWithStrayTextMemoryBranchAI {
  calls: Message[][] = [];
  isToolCallingSupported(): boolean { return true; }
  async chat(messages: Message[]): Promise<ChatResponse> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    if (this.calls.length === 3) return { content: 'I am done.', toolCalls: [], usage };
    return { content: null, toolCalls: [makeToolCall(`finish_invalid_${this.calls.length}`, 'finish_memory_search', { summary: 'No useful memory.', evidence: { invalid: true }, inject: false })], usage };
  }
}

describe('memory sidecar branch', () => {
  let testRoot: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    previousUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-memory-sidecar-'));
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserDataDir;
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('available CatsLog with unrelated candidates cannot borrow local archive evidence', async () => {
    const dir = path.join(testRoot, 'logs/sessions/chat/2026-06-09');
    fs.mkdirSync(dir, {recursive:true});
    fs.writeFileSync(path.join(dir,'demo.jsonl'), JSON.stringify({entry_type:'turn',turn:1,timestamp:'2026-06-09T00:00:00Z',session_type:'chat',session_id:'demo',user:{text:'retention'},assistant:{text:'LOCAL_ONLY_CANARY',tool_calls:[]},tokens:{prompt:1,completion:1}}));
    const queue = new InMemorySyntheticObservationQueue();
    let calls = 0;
    const aiService = {isToolCallingSupported: () => true, chat: async (messages: Message[], tools: ToolDefinition[]) => {
      assert.doesNotMatch(JSON.stringify(messages), /LOCAL_ONLY_CANARY/);
      assert.ok(!tools.some(t=>['memory_search','memory_read_turn','memory_neighbors'].includes(t.name)));
      const args = ++calls === 1 ? {summary:'unverified',inject:true,evidence:['chat/2026-06-09/demo.jsonl#1']} : {summary:'No verified evidence.',inject:false,evidence:[]};
      return {content:null,toolCalls:[makeToolCall('finish'+calls,'finish_memory_search',args)],usage};
    }};
    await startMemorySidecarBranch({sessionKey:'test-session', input:'retention', recentMessages:[], workingDirectory:testRoot, catslogMemory:{isAvailable:()=>true} as any, aiService:aiService as any,queue}).done;
    assert.equal(calls,2);
    assert.equal(queue.size(),0);
  });

  test('suppresses observations when branch finishes with inject false', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new NoInjectMemoryBranchAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      catslogMemory: { isAvailable: () => true } as any,
      input: 'quick question with no useful prior memory',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });

    await handle.done;

    assert.equal(queue.drain().length, 0);
    assert.equal(aiService.calls.length, 1);
    assert.match(readBranchLogs(testRoot), /suppressed_observation/);
  });

  test('passes repeated activation delta and treats prior refs as advisory context', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new NoInjectMemoryBranchAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      catslogMemory: { isAvailable: () => true } as any,
      input: 'original task',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
      activationContext: {
        taskAnchor: 'original task',
        deltaSinceLastRun: [{ role: 'user', content: 'newer correction wins' }],
        previousInjections: [{
          summary: 'The earlier phase used the same evidence for another conclusion.',
          refs: ['chat/2026-06-09/demo.jsonl#1'],
        }],
      },
    });

    await handle.done;

    const system = String(aiService.calls[0].find(message => message.role === 'system')?.content || '');
    const payload = JSON.parse(String(aiService.calls[0].find(message => message.role === 'user')?.content));
    assert.equal(payload.current_user_input, 'original task');
    assert.deepEqual(payload.delta_since_last_run, [{ role: 'user', content: 'newer correction wins' }]);
    assert.deepEqual(payload.previous_injections[0].refs, ['chat/2026-06-09/demo.jsonl#1']);
    assert.match(system, /refs 黑名单/);
    assert.match(system, /最新用户内容为准/);
  });


  test('returns recoverable feedback for malformed final arguments and exits after correction', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new InvalidThenRecoveringMemoryBranchAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      catslogMemory: { isAvailable: () => true } as any,
      input: 'recover malformed final tool call',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });

    await handle.done;

    assert.equal(aiService.calls.length, 2);
    assert.equal(queue.drain().length, 0);
    const secondCall = aiService.calls[1];
    const failedCall = secondCall.find(message => message.role === 'assistant')?.tool_calls?.[0];
    const failedResult = secondCall.find(message => message.role === 'tool');
    assert.equal(failedCall?.id, failedResult?.tool_call_id);
    assert.match(readBranchLogs(testRoot), /suppressed_observation/);
  });

  test('bounds repeated invalid finalization and logs an explicit terminal state', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new RepeatedInvalidFinishMemoryBranchAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      catslogMemory: { isAvailable: () => true } as any,
      input: 'repeat invalid final tool calls',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });

    await handle.done;

    assert.equal(aiService.calls.length, 3);
    assert.deepEqual(aiService.calls.map(messages => messages.length), [2, 4, 6]);
    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.match(logs, /invalid_finalization_exhausted/);
    assert.ok(Buffer.byteLength(logs, 'utf8') < 100_000);
  });

  test('keeps invalid finalization budget across stray-output reminder restarts', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = new InvalidFinishWithStrayTextMemoryBranchAI();
    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      catslogMemory: { isAvailable: () => true } as any,
      input: 'bound invalid finalization across reminder restarts',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });

    await handle.done;

    assert.equal(aiService.calls.length, 6);
    assert.equal(queue.drain().length, 0);
    const logs = readBranchLogs(testRoot);
    assert.equal(countLogEvents(logs, 'invalid_finalization_exhausted'), 1);
    assert.equal(countLogEvents(logs, 'suppressed_observation'), 1);
    assert.equal(countLogEvents(logs, 'cancelled_before_finish'), 0);
  });

  test('cancelled branch does not publish late memory observations', async () => {
    const queue = new InMemorySyntheticObservationQueue();
    const aiService = {
      isToolCallingSupported: () => true,
      chat: (_messages: Message[], _tools?: ToolDefinition[], options?: { signal?: AbortSignal }) => {
        return new Promise<ChatResponse>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    };

    const handle = startMemorySidecarBranch({
      sessionKey: 'test-session',
      catslogMemory: { isAvailable: () => true } as any,
      input: 'quick question',
      recentMessages: [],
      workingDirectory: testRoot,
      aiService: aiService as any,
      queue,
    });

    handle.cancel();
    await handle.done;
    assert.equal(queue.drain().length, 0);
  });
});

function readBranchLogs(root: string): string {
  const branchRoot = path.join(root, 'logs', 'branches', 'memory');
  if (!fs.existsSync(branchRoot)) return '';
  const chunks: string[] = [];
  for (const dateDir of fs.readdirSync(branchRoot)) {
    const fullDateDir = path.join(branchRoot, dateDir);
    for (const fileName of fs.readdirSync(fullDateDir)) {
      chunks.push(fs.readFileSync(path.join(fullDateDir, fileName), 'utf-8'));
    }
  }
  return chunks.join('\n');
}

function countLogEvents(logs: string, eventType: string): number {
  return logs.split('\n').filter(line => line.includes(`"event_type":"${eventType}"`)).length;
}
