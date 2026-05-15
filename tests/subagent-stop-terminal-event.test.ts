import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/core/sub-agent-session.ts'), 'utf-8');

test('SubAgentSession emits terminal events only once and does not complete after stop', () => {
  assert.match(source, /private terminalEventEmitted = false/);
  assert.match(source, /private emitTerminalEvent\(type: SubAgentEventType, summary: string, payload\?: Record<string, unknown>\): void \{/);
  assert.match(source, /if \(this\.terminalEventEmitted\) return/);
  assert.match(source, /if \(this\.stopped\) \{[\s\S]*?this\.status = 'stopped'[\s\S]*?this\.emitTerminalEvent\('agent_stopped'/);
  assert.doesNotMatch(source, /this\.emitEvent\('agent_stopped'/);
});
