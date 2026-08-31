import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  catslogSkillOutcomeCommand,
  catslogSkillsCommand,
  registerCatslogCommand,
} from '../src/commands/catslog';
import type { CatsLogMemoryBackend } from '../src/utils/catslog-memory-provider';
import type {
  CatscoSkillsQuery,
  CatscoSkillsResponse,
  CatscoSkillOutcomeInput,
} from '../src/utils/catsco-log-agent-client';
import { Command } from 'commander';

class FakeCatsLogCliBackend implements CatsLogMemoryBackend {
  catalogQueries: CatscoSkillsQuery[] = [];
  outcomes: Array<CatscoSkillOutcomeInput & { requireReceipt?: boolean }> = [];

  async retrieveSkillMemory() {
    return { items: [] };
  }

  async recallMemory() {
    return { session_available: false, session: { records: [] } };
  }

  async readSkills(query: CatscoSkillsQuery): Promise<CatscoSkillsResponse> {
    this.catalogQueries.push(query);
    return {
      content_trust: 'untrusted_runtime_skill',
      skills: [{ handle: 'release-playbook', revision: 3 }],
    };
  }

  async reportSkillOutcome(input: CatscoSkillOutcomeInput & { requireReceipt?: boolean }): Promise<void> {
    this.outcomes.push(input);
  }

  supportsSkillOutcomes(): boolean {
    return true;
  }
}

describe('catslog CLI commands', () => {
  test('reads the device-bound Skills catalog and emits data without credentials', async () => {
    const backend = new FakeCatsLogCliBackend();
    const output: string[] = [];
    const result = await catslogSkillsCommand({
      backend,
      search: 'release',
      content: true,
      trace: 'summary',
      limit: 7,
      cursor: 'opaque-cursor',
      output: { write: (value: string) => { output.push(value); return true; } },
    });

    assert.deepEqual(backend.catalogQueries, [{
      search: 'release',
      includeContent: true,
      includeTrace: 'summary',
      limit: 7,
      cursor: 'opaque-cursor',
    }]);
    assert.equal(result.skills?.[0]?.handle, 'release-playbook');
    assert.equal(JSON.parse(output.join('')).content_trust, 'untrusted_runtime_skill');
    assert.equal(output.join('').includes('token'), false);
  });

  test('keeps the explicit CLI outcome path compatible with no-receipt v1 reports', async () => {
    const backend = new FakeCatsLogCliBackend();
    const output: string[] = [];
    await catslogSkillOutcomeCommand('release-playbook', '3', 'succeeded', {
      backend,
      output: { write: (value: string) => { output.push(value); return true; } },
    });

    assert.deepEqual(backend.outcomes, [{
      handle: 'release-playbook',
      revision: 3,
      outcome: 'succeeded',
      requireReceipt: false,
    }]);
    assert.deepEqual(JSON.parse(output.join('')), {
      content_trust: 'untrusted_skill_feedback',
      status: 'accepted',
      handle: 'release-playbook',
      revision: 3,
      outcome: 'succeeded',
    });
  });

  test('registers the documented nested commands', () => {
    const program = new Command();
    registerCatslogCommand(program);
    const catslog = program.commands.find(command => command.name() === 'catslog');
    assert.ok(catslog);
    assert.deepEqual(catslog.commands.map(command => command.name()), ['skills', 'outcome']);
  });
});
