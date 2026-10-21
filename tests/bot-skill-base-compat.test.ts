import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotSkillBaseStore } from '../src/bot-skills/base-store';

const BOT_ID = '1597';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const BASE_SCHEMA = 'xiaoba.bot-skill-sync-base.v2';

function baseFile(root: string, botId = BOT_ID): string {
  return path.join(root, 'data', 'bot-skills', 'sync-base', `${botId}.json`);
}

function writeRawBase(root: string, value: unknown, botId = BOT_ID): string {
  const target = baseFile(root, botId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  return target;
}

function skillhubEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    localSkillId: 'public-7798cc093b5c574b07b00a2e5bdb1412',
    name: 'web-search',
    installName: 'web-search',
    contentHash: HASH_A,
    reference: {
      source: 'skillhub',
      skillId: 'lin/web-search',
      version: '1.0.2',
      contentHash: HASH_A,
    },
    origin: { skillId: 'lin/web-search', version: '1.0.2' },
    ...overrides,
  };
}

/**
 * A local Skill entry exactly as the pre-`canonicalizeBotSkillRefs` build wrote
 * it: `reference` carries `source: 'local'` and only a contentHash.
 */
function localEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    localSkillId: 'private-cdb4c6f1d33dcd6d99af1e7024f69a50',
    name: 'academic-db',
    installName: 'academic-db',
    contentHash: HASH_B,
    reference: { source: 'local', contentHash: HASH_B },
    origin: { source: 'local', version: 'v1' },
    ...overrides,
  };
}

function captureWarnings(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(value => String(value)).join(' '));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
}

describe('Bot Skill sync Base compatibility', () => {
  const roots: string[] = [];
  const restores: Array<() => void> = [];

  function newStore(): { root: string; store: BotSkillBaseStore } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-base-'));
    roots.push(root);
    return { root, store: new BotSkillBaseStore(root) };
  }

  function warnings(): { messages: string[]; restore: () => void } {
    const captured = captureWarnings();
    restores.push(captured.restore);
    return captured;
  }

  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('no Base file reads as undefined', () => {
    const { store } = newStore();
    assert.equal(store.read(BOT_ID), undefined);
  });

  test('a SkillHub-only Base is still read and sorted', () => {
    const { root, store } = newStore();
    writeRawBase(root, {
      schema: BASE_SCHEMA,
      botId: BOT_ID,
      definitionRevision: 5,
      updatedAt: '2026-10-21T04:26:42.000Z',
      skills: [
        skillhubEntry({ localSkillId: 'public-zzz', name: 'zzz', installName: 'zzz' }),
        skillhubEntry(),
      ],
    });
    const value = store.read(BOT_ID);
    assert.ok(value, 'valid Base must still be readable');
    assert.equal(value.definitionRevision, 5);
    assert.deepEqual(value.skills.map(entry => entry.localSkillId), [
      'public-7798cc093b5c574b07b00a2e5bdb1412',
      'public-zzz',
    ]);
  });

  // Regression for the production incident on 2026-10-21 (bot 1597): the
  // Base written by the previous build listed 15 local Skills, which made
  // every model switch fail closed with "Bot Skill sync Base is invalid".
  test('a Base carrying local Skills degrades to "no Base" instead of failing closed', () => {
    const { root, store } = newStore();
    const target = writeRawBase(root, {
      schema: BASE_SCHEMA,
      botId: BOT_ID,
      definitionRevision: 4,
      updatedAt: '2026-10-14T12:16:03.242Z',
      skills: [skillhubEntry(), localEntry()],
    });
    const log = warnings();
    const value = store.read(BOT_ID);
    assert.equal(value, undefined, 'unusable entries must not throw');
    assert.match(log.messages.join('\n'), /invalid skill entries/);
    assert.ok(fs.existsSync(target), 'the unreadable Base is kept for operators');
  });

  test('unreadable JSON degrades to "no Base"', () => {
    const { root, store } = newStore();
    writeRawBase(root, '{ this is not json');
    const log = warnings();
    assert.equal(store.read(BOT_ID), undefined);
    assert.match(log.messages.join('\n'), /unreadable JSON/);
  });

  test('an unknown schema degrades to "no Base"', () => {
    const { root, store } = newStore();
    writeRawBase(root, {
      schema: 'xiaoba.bot-skill-sync-base.v99',
      botId: BOT_ID,
      definitionRevision: 1,
      updatedAt: '2026-10-21T00:00:00.000Z',
      skills: [skillhubEntry()],
    });
    const log = warnings();
    assert.equal(store.read(BOT_ID), undefined);
    assert.match(log.messages.join('\n'), /unsupported schema/);
  });

  // Identity is a correctness boundary, not a format one: diffing another
  // Bot's Base against this workspace would attribute foreign Skills to us.
  test('a Base belonging to another Bot still fails loudly', () => {
    const { root, store } = newStore();
    writeRawBase(root, {
      schema: BASE_SCHEMA,
      botId: '1344',
      definitionRevision: 1,
      updatedAt: '2026-10-14T12:16:03.242Z',
      skills: [skillhubEntry()],
    });
    assert.throws(() => store.read(BOT_ID), /belongs to a different Bot/);
  });

  test('a v1 Base is migrated', () => {
    const { root, store } = newStore();
    writeRawBase(root, {
      schema: 'xiaoba.bot-skill-sync-base.v1',
      botId: BOT_ID,
      cloudRevision: 7,
      updatedAt: '2026-10-01T00:00:00.000Z',
      skills: [skillhubEntry()],
    });
    const value = store.read(BOT_ID);
    assert.ok(value);
    assert.equal(value.definitionRevision, 7);
    assert.equal(value.schema, BASE_SCHEMA);
  });

  // The write path stays strict: a Base may only claim Cloud (SkillHub)
  // ownership, so a local Skill can never become deletable through it.
  test('write rejects local entries so Cloud ownership stays SkillHub-only', () => {
    const { store } = newStore();
    assert.throws(
      () => store.write({
        schema: BASE_SCHEMA,
        botId: BOT_ID,
        definitionRevision: 1,
        updatedAt: '2026-10-21T00:00:00.000Z',
        skills: [localEntry() as never],
      }),
      /Bot Skill sync base is invalid/i,
    );
  });
});
