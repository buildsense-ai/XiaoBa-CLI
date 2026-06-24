import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/core/agent-turn-controller.ts'), 'utf-8');

test('AgentTurnController forwards thinking callbacks to ConversationRunner', () => {
  assert.match(source, /onThinking:\s*callbacks\?\.onThinking/);
  assert.match(source, /onAssistantText:\s*callbacks\?\.onAssistantText/);
});
