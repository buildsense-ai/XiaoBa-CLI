import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BOT_SKILL_SYNC_BASE_SCHEMA } from '../src/bot-skills/types';
import { FileBotSkillSyncBaseStore } from '../src/bot-skills/base-store';
import {
  botSkillReferencesEqual,
  cloudSnapshotMatchesBase,
  localSnapshotMatchesBase,
} from '../src/bot-skills/canonical';

describe('Bot Skill sync base', () => {
  let runtimeRoot: string;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-base-'));
  });

  afterEach(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('round-trips a normalized per-Skill Local/Cloud mapping atomically', () => {
    const store = new FileBotSkillSyncBaseStore({
      runtimeRoot,
      authority: 'https://cats.example/user-1',
    });
    store.write({
      schema: BOT_SKILL_SYNC_BASE_SCHEMA,
      botId: 'bot-a',
      workspaceId: 'workspace-a',
      authority: 'https://cats.example/user-1',
      definitionETag: '"definition-3"',
      entries: [
        {
          localSkillId: 'local-b',
          localContentHash: 'b'.repeat(64),
          cloudSkillId: 'private/b',
          cloudVersion: 'hash-b',
        },
        {
          localSkillId: 'local-a',
          localContentHash: 'a'.repeat(64),
          cloudSkillId: 'public/a',
          cloudVersion: '1.0.0',
        },
      ],
      updatedAt: '2026-07-24T00:00:00.000Z',
    });

    const result = store.read('bot-a', 'workspace-a');

    assert.equal(result.kind, 'valid');
    if (result.kind === 'valid') {
      assert.deepStrictEqual(result.base.entries.map(entry => entry.localSkillId), ['local-a', 'local-b']);
      assert.equal(result.base.definitionETag, '"definition-3"');
    }
  });

  test('keeps missing, corrupt, workspace mismatch, and authority mismatch distinct from a valid Base', () => {
    const store = new FileBotSkillSyncBaseStore({ runtimeRoot, authority: 'authority-a' });
    assert.equal(store.read('bot-a').kind, 'missing');

    fs.mkdirSync(path.dirname(store.getPath('bot-a')), { recursive: true });
    fs.writeFileSync(store.getPath('bot-a'), '{broken');
    assert.equal(store.read('bot-a').kind, 'corrupt');

    store.write({
      schema: BOT_SKILL_SYNC_BASE_SCHEMA,
      botId: 'bot-a',
      workspaceId: 'workspace-a',
      authority: 'authority-a',
      entries: [],
      updatedAt: '2026-07-24T00:00:00.000Z',
    });
    assert.equal(store.read('bot-a', 'workspace-b').kind, 'corrupt');

    const otherAuthority = new FileBotSkillSyncBaseStore({ runtimeRoot, authority: 'authority-b' });
    assert.equal(otherAuthority.read('bot-a').kind, 'missing');
  });

  test('compares Local and Cloud independently and ignores reference ordering', () => {
    const base = {
      entries: [
        {
          localSkillId: 'local-a',
          localContentHash: 'a'.repeat(64),
          cloudSkillId: 'cloud/a',
          cloudVersion: '1',
        },
        {
          localSkillId: 'local-b',
          localContentHash: 'b'.repeat(64),
          cloudSkillId: 'cloud/b',
          cloudVersion: '2',
        },
      ],
    };
    const local = [
      {
        localSkillId: 'local-b',
        contentHash: 'b'.repeat(64),
        name: 'b',
        directoryName: 'b',
        directoryPath: '/b',
        skillFilePath: '/b/SKILL.md',
      },
      {
        localSkillId: 'local-a',
        contentHash: 'a'.repeat(64),
        name: 'a',
        directoryName: 'a',
        directoryPath: '/a',
        skillFilePath: '/a/SKILL.md',
      },
    ];

    assert.equal(localSnapshotMatchesBase(local, base), true);
    assert.equal(cloudSnapshotMatchesBase([
      { skillId: 'cloud/b', version: '2' },
      { skillId: 'cloud/a', version: '1' },
    ], base), true);
    assert.equal(botSkillReferencesEqual(
      [{ skillId: 'b', version: '2' }, { skillId: 'a', version: '1' }],
      [{ skillId: 'a', version: '1' }, { skillId: 'b', version: '2' }],
    ), true);

    assert.equal(localSnapshotMatchesBase([{ ...local[0], contentHash: 'c'.repeat(64) }, local[1]], base), false);
    assert.equal(cloudSnapshotMatchesBase([{ skillId: 'cloud/a', version: '9' }], base), false);
  });
});
