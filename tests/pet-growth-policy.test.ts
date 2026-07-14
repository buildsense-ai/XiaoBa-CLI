import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

test('visible assistant replies are not automatically treated as meaningful completed tasks', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'core', 'agent-turn-controller.ts'),
    'utf8',
  );
  const finalResponseBlock = source.match(/if \(finalResponseVisible\) \{[\s\S]*?\n    \}/)?.[0] || '';

  assert.match(finalResponseBlock, /recordPetTurnCompletion\('message_completed'\)/);
  assert.doesNotMatch(finalResponseBlock, /recordPetTurnCompletion\('task_completed'\)/);
});
