import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const agentSessionSource = readFileSync(join(process.cwd(), 'src/core/agent-session.ts'), 'utf-8');
const catsCompanySource = readFileSync(join(process.cwd(), 'src/catscompany/index.ts'), 'utf-8');

test('AgentSession interrupt also stops background subagents', () => {
  const interruptBlock = agentSessionSource.match(/requestInterrupt\(\): void \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(interruptBlock, /this\.stopSubAgents\('用户请求中止'\)/);
  assert.match(interruptBlock, /this\.activeAbortController\?\.abort\(\)/);
});

test('CatsCompany cancel events reach AgentSession even when main turn is idle', () => {
  const cancelBlock = catsCompanySource.match(/private handleCancelMessage\(ctx: MessageContext\): void \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(cancelBlock, /if \(!session\.isBusy\(\)\) \{[\s\S]*?session\.requestInterrupt\(\)/);
});
