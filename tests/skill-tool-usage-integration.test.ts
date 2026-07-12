import { beforeEach, afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolManager } from '../src/tools/tool-manager';
import { LearningEpisodeStore, extractLearningEpisodes } from '../src/utils/learning-episode';
import { SkillUsageCurator } from '../src/utils/skill-usage-curator';
import { SkillUsageLedger } from '../src/utils/skill-usage-ledger';
import { DistillationUnit } from '../src/utils/distillation-unit';

describe('SkillTool usage wiring', () => {
  let testRoot: string;
  let originalRuntimeRoot: string | undefined;
  let originalSkillsDir: string | undefined;
  let originalLedgerPath: string | undefined;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-tool-usage-'));
    originalRuntimeRoot = process.env.XIAOBA_RUNTIME_ROOT;
    originalSkillsDir = process.env.XIAOBA_SKILLS_DIR;
    originalLedgerPath = process.env.XIAOBA_SKILL_USAGE_LEDGER_FILE;
    process.env.XIAOBA_RUNTIME_ROOT = testRoot;
    process.env.XIAOBA_SKILL_USAGE_LEDGER_FILE = 'data/skill-usage-ledger.jsonl';
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');

    writeSkill(testRoot, 'generated-distilled/cap-generated', 'generated-demo', 'Generated demo guidance');
    writeSkill(testRoot, 'manual/demo', 'manual-demo', 'Manual demo guidance');
  });

  afterEach(() => {
    restoreEnv('XIAOBA_RUNTIME_ROOT', originalRuntimeRoot);
    restoreEnv('XIAOBA_SKILLS_DIR', originalSkillsDir);
    restoreEnv('XIAOBA_SKILL_USAGE_LEDGER_FILE', originalLedgerPath);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('records a real generated SkillTool load, excludes manual loads, and associates the same episode outcome', async () => {
    const episodeId = 'episode:1:stable';
    const manager = new ToolManager(testRoot, {}, { enabledToolNames: ['skill'] });

    const generatedResult = await manager.executeTool(skillCall('generated-demo'), [], {
      sessionId: 'runtime-session-1',
      episodeId,
    });
    assert.equal(generatedResult.ok, true);
    const generatedPath = path.join(testRoot, 'skills', 'generated-distilled', 'cap-generated', 'SKILL.md');
    const generatedContentBefore = fs.readFileSync(generatedPath, 'utf8');

    const manualResult = await manager.executeTool(skillCall('manual-demo'), [], {
      sessionId: 'runtime-session-1',
      episodeId,
    });
    assert.equal(manualResult.ok, true);

    const uncorrelatedGeneratedResult = await manager.executeTool(skillCall('generated-demo'), [], {
      sessionId: 'runtime-session-1',
    });
    assert.equal(uncorrelatedGeneratedResult.ok, true);

    const ledger = new SkillUsageLedger(path.join(testRoot, 'data', 'skill-usage-ledger.jsonl'));
    const loads = ledger.listFacts().filter(fact => fact.kind === 'generated-skill-load');
    assert.equal(loads.length, 1);
    assert.equal(loads[0]!.episodeId, episodeId);
    assert.equal(loads[0]!.runtimeSessionId, 'runtime-session-1');
    assert.equal(loads[0]!.skill.capabilityHandle, 'cap-generated');
    assert.equal(loads[0]!.skill.routingName, 'generated-demo');

    const episodeStore = new LearningEpisodeStore(path.join(testRoot, 'data', 'learning-episodes.json'));
    const extracted = extractLearningEpisodes(episodeUnit(episodeId, String(generatedResult.content))).episodes;
    episodeStore.upsert(extracted);
    const episode = episodeStore.settle({ now: new Date('2026-07-10T04:00:00.000Z') }).episodes[episodeId];
    assert.equal(episode?.status, 'eligible');
    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(testRoot, 'data', 'curator-state.json'),
      intervalMs: 24 * 60 * 60 * 1000,
    });
    const outcomes = curator.observeEpisode(episode!);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.loadFactId, loads[0]!.factId);
    assert.equal(outcomes[0]!.episodeId, episodeId);
    assert.equal(outcomes[0]!.outcome, 'verified-success');

    const ledgerText = fs.readFileSync(path.join(testRoot, 'data', 'skill-usage-ledger.jsonl'), 'utf8');
    assert.doesNotMatch(ledgerText, /caused|followed|complied/i);
    assert.equal(fs.readFileSync(generatedPath, 'utf8'), generatedContentBefore);
  });

  test('schedules contradiction evidence without mutating the generated skill', async () => {
    const episodeId = 'episode:3:stable';
    const manager = new ToolManager(testRoot, {}, { enabledToolNames: ['skill'] });
    const result = await manager.executeTool(skillCall('generated-demo'), [], {
      sessionId: 'runtime-session-1',
      episodeId,
    });
    assert.equal(result.ok, true);

    const generatedPath = path.join(testRoot, 'skills', 'generated-distilled', 'cap-generated', 'SKILL.md');
    const generatedContentBefore = fs.readFileSync(generatedPath, 'utf8');
    const ledger = new SkillUsageLedger(path.join(testRoot, 'data', 'skill-usage-ledger.jsonl'));
    const curator = new SkillUsageCurator({
      ledger,
      statePath: path.join(testRoot, 'data', 'curator-state.json'),
      intervalMs: 24 * 60 * 60 * 1000,
    });

    const [episode] = extractLearningEpisodes(episodeUnit(episodeId, String(result.content), true)).episodes;
    assert.equal(episode?.status, 'contradicted');
    const [outcome] = curator.observeEpisode(episode!);
    assert.equal(outcome?.outcome, 'contradicted');
    assert.equal(curator.pendingExpeditedWakes().length, 1);
    assert.equal(fs.readFileSync(generatedPath, 'utf8'), generatedContentBefore);
  });

  test('keeps the runtime episode identity when Learning Episode extraction settles later', () => {
    const episodeId = 'episode:2:stable';
    const unit = {
      filePath: '/logs/session.jsonl',
      newTurns: [{
        entry_type: 'turn' as const,
        turn: 1,
        episode_id: episodeId,
        timestamp: '2026-07-10T00:00:00.000Z',
        session_id: 'runtime-session-1',
        session_type: 'chat',
        user: { text: 'Deliver the generated guidance.' },
        assistant: {
          text: 'done',
          tool_calls: [{ id: 'call-1', name: 'send_file', arguments: {}, result: 'sent' }],
        },
        tokens: { prompt: 1, completion: 1 },
      }],
      continuityTurns: [],
      byteRange: { start: 0, end: 100 },
      generatedAt: '2026-07-10T00:00:00.000Z',
    } satisfies DistillationUnit;

    const [episode] = extractLearningEpisodes(unit).episodes;
    assert.equal(episode?.agentTurnEpisodeId, episodeId);
    assert.equal(episode?.episodeId, episodeId);
  });
});

function skillCall(skill: string) {
  return {
    id: `call-${skill}`,
    type: 'function' as const,
    function: { name: 'skill', arguments: JSON.stringify({ skill }) },
  };
}

function writeSkill(root: string, relativeDirectory: string, name: string, body: string): void {
  const directory = path.join(root, 'skills', relativeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    '---',
    '',
    body,
  ].join('\n'), 'utf8');
}

function episodeUnit(episodeId: string, skillResult: string, withContradiction = false): DistillationUnit {
  const turns: DistillationUnit['newTurns'] = [{
    entry_type: 'turn' as const,
    turn: 1,
    episode_id: episodeId,
    timestamp: '2026-07-10T00:00:00.000Z',
    session_id: 'runtime-session-1',
    session_type: 'chat',
    user: { text: 'Deliver the generated guidance.' },
    assistant: {
      text: 'done',
      tool_calls: [
        { id: 'skill-call', name: 'skill', arguments: { skill: 'generated-demo' }, result: skillResult },
        { id: 'delivery-call', name: 'send_file', arguments: {}, result: 'sent' },
      ],
    },
    tokens: { prompt: 1, completion: 1 },
  }];
  if (withContradiction) {
    turns.push({
      entry_type: 'turn' as const,
      turn: 2,
      timestamp: '2026-07-10T00:01:00.000Z',
      session_id: 'runtime-session-1',
      session_type: 'chat',
      user: { text: 'That guidance was wrong.' },
      assistant: { text: '', tool_calls: [] },
      tokens: { prompt: 1, completion: 1 },
    });
  }
  return {
    filePath: '/logs/session.jsonl',
    newTurns: turns,
    continuityTurns: [],
    byteRange: { start: 0, end: 100 },
    generatedAt: '2026-07-10T00:00:00.000Z',
  } satisfies DistillationUnit;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
