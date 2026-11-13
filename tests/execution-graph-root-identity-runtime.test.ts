import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationRunner } from '../src/core/conversation-runner';
import type { Message } from '../src/types';

const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7 };
const sessionId = 'execution-root-identity-runtime';
const episodeId = 'same-episode-after-restart';

test('runtime root identity is unique, persisted on transcript messages, and leaves older history unknown', async () => {
  const captured: Array<{ input: Message[]; event: any }> = [];
  const run = async (input: Message[]): Promise<Message[]> => {
    const runner = new ConversationRunner({
      chat: async () => ({ content: 'acknowledged', toolCalls: [], usage }),
    } as any, {
      getToolDefinitions: () => [],
      executeTool: async () => { throw new Error('unexpected tool execution'); },
    } as any, {
      stream: false,
      episodeId,
      toolExecutionContext: { sessionId },
    });
    const result = await runner.run(input, {
      onExecutionGraphEvent: event => captured.push({ input, event }),
    } as any);
    return result.messages;
  };

  const original: Message = { role: 'user', content: 'same text', __episodeId: episodeId, __episodeInputKind: 'root' };
  const firstMessages = await run([original]);
  const firstRef = captured[0].event.input_manifest.items[0].ref;
  const serializedRestore = JSON.parse(JSON.stringify(firstMessages)) as Message[];
  const restoredRoot = serializedRestore.find(message => message.__episodeInputKind === 'root')!;
  assert.equal(restoredRoot.__executionNodeRef, firstRef, 'assigned identity is stored on the retained transcript message');

  const distinctPending: Message = { role: 'user', content: 'same text', __episodeId: episodeId, __episodeInputKind: 'pending' };
  await run([distinctPending]);
  const pendingRef = captured[1].event.input_manifest.items[0].ref;

  assert.notEqual(firstRef, pendingRef, 'different root/pending messages at the same array index get distinct refs');
  assert.equal(distinctPending.__executionNodeRef, pendingRef, 'identity is assigned once to the actual transcript message');

  await run(serializedRestore);
  assert.equal(captured[2].event.input_manifest.items.find((item: any) => item.kind === 'query')?.ref, firstRef,
    'restored identity remains byte-exact on a later provider request');

  const historical: Message = { role: 'user', content: 'older message', __episodeId: episodeId };
  await run([historical]);
  const historicalItem = captured[3].event.input_manifest.items[0];
  assert.equal(historicalItem.identity_state, 'unknown', 'unproven history is not retroactively assigned a confident identity');
  assert.match(historicalItem.ref, /^unknown-session-node:/);
  assert.equal(historical.__executionNodeRef, undefined);

  const legacy: Message = { role: 'user', content: 'legacy', __episodeId: episodeId, __episodeInputKind: 'root', __executionNodeRef: 'legacy:root-ref/v0' };
  await run([legacy]);
  assert.equal(captured[4].event.input_manifest.items[0].ref, 'legacy:root-ref/v0');
  assert.equal(legacy.__executionNodeRef, 'legacy:root-ref/v0');
});
