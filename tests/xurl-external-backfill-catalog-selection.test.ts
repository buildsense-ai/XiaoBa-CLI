/**
 * Catalog-selection seam for explicit xURL external backfill.
 *
 * Selection uses structured catalog metadata (firstEventIdentity.revision as
 * Updated At). Missing/invalid timestamps fail closed (exclude + count).
 */

import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { XurlExternalBackfillSource } from '../src/utils/xurl-session-log-source';
import {
  writeFakeXurl,
  writeScenario,
  type FakeXurlScenario,
} from './helpers/xurl-rendered-fixtures';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const PROVIDER = 'codex';
const SOURCE_ID = 'external-codex';

test('selectCatalogResourcesByUpdatedSince keeps only threads with valid Updated At within the cutoff', () => {
  const env = setupEnv();
  writeScenario(env.scenarioPath, catalogScenario({
    threads: [
      thread('recent-a', '2026-07-15T12:00:00.000Z'),
      thread('recent-b', '2026-07-14T00:00:00.000Z'),
      thread('old', '2026-06-01T00:00:00.000Z'),
      thread('missing-updated'),
      thread('invalid-updated', 'not-a-date'),
    ],
  }));

  const source = createSource(env);
  const selection = source.selectCatalogResourcesByUpdatedSince(new Date('2026-07-10T00:00:00.000Z'));

  assert.deepEqual(
    selection.selected.map(resource => resource.resourceRef).sort(),
    ['recent-a', 'recent-b'],
  );
  assert.equal(selection.excludedMissingUpdatedAt, 1);
  assert.equal(selection.excludedInvalidUpdatedAt, 1);
  assert.equal(selection.excludedBeforeCutoff, 1);
  assert.equal(selection.discoveredCount, 5);
  assert.equal(
    selection.selected.every(resource => resource.firstEventIdentity?.revision != null),
    true,
  );
});

test('selectCatalogResourcesByUpdatedSince reads official Updated At into firstEventIdentity.revision', () => {
  const env = setupEnv();
  writeScenario(env.scenarioPath, {
    discover: {
      rawStdout: [
        '---',
        'uri: agents://codex?limit=100',
        'provider: codex',
        'version: xurl-test 1.0.0',
        'queried_at: 2026-07-16T00:00:00.000Z',
        'next:',
        '---',
        '',
        '# Threads',
        '- Matched: `2`',
        '',
        '## 1. `agents://codex/official-recent`',
        '- Provider: `codex`',
        '- Thread ID: `official-recent`',
        '- Updated At: `2026-07-15T18:00:00.000Z`',
        '',
        '## 2. `agents://codex/official-old`',
        '- Provider: `codex`',
        '- Thread ID: `official-old`',
        '- Updated At: `2026-01-01T00:00:00.000Z`',
        '',
      ].join('\n'),
    },
  });

  const source = createSource(env);
  const selection = source.selectCatalogResourcesByUpdatedSince(new Date('2026-07-10T00:00:00.000Z'));
  assert.deepEqual(selection.selected.map(resource => resource.resourceRef), ['official-recent']);
  assert.equal(selection.selected[0]?.firstEventIdentity?.revision, '2026-07-15T18:00:00.000Z');
  assert.equal(selection.excludedBeforeCutoff, 1);
});

test('accepts official Unix-second Updated At values and expands the catalog until complete', () => {
  const env = setupEnv();
  const firstHundred = Array.from({ length: 100 }, (_, index) => (
    thread(`thread-${String(index).padStart(3, '0')}`, '1784240000')
  ));
  writeScenario(env.scenarioPath, {
    discover: {
      byLimit: {
        '100': catalogScenario({ threads: firstHundred }).discover!.catalog!,
        '200': catalogScenario({
          threads: [
            ...firstHundred,
            thread('thread-100', '1784240000'),
            thread('old-boundary', '1750000000'),
          ],
        }).discover!.catalog!,
      },
    },
  });

  const source = createSource(env);
  const selection = source.selectCatalogResourcesByUpdatedSince(new Date('2026-07-10T00:00:00.000Z'));

  assert.equal(selection.discoveredCount, 102);
  assert.equal(selection.selected.length, 101);
  assert.equal(selection.selected.some(resource => resource.resourceRef === 'thread-100'), true);
  assert.equal(selection.excludedBeforeCutoff, 1);
  assert.equal(selection.excludedInvalidUpdatedAt, 0);
});

test('fails closed when an expanding catalog reaches its cap without proving completeness', () => {
  const env = setupEnv();
  const threads = Array.from({ length: 200 }, (_, index) => (
    thread(`thread-${String(index).padStart(3, '0')}`, '1784240000')
  ));
  writeScenario(env.scenarioPath, {
    discover: {
      byLimit: {
        '100': catalogScenario({ threads: threads.slice(0, 100) }).discover!.catalog!,
        '200': catalogScenario({ threads }).discover!.catalog!,
      },
    },
  });

  const source = new XurlExternalBackfillSource({
    command: env.commandPath,
    provider: PROVIDER,
    sourceId: SOURCE_ID,
    env: {
      ...process.env,
      XURL_SCENARIO_PATH: env.scenarioPath,
      XURL_LOG_PATH: env.logPath,
    },
    maxActivationCatalog: 200,
  });

  assert.throws(
    () => source.selectCatalogResourcesByUpdatedSince(new Date('2026-07-10T00:00:00.000Z')),
    /cap without covering cutoff/i,
  );
});

function setupEnv(): {
  readonly root: string;
  readonly commandPath: string;
  readonly scenarioPath: string;
  readonly logPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-backfill-catalog-'));
  tempRoots.push(root);
  const commandPath = path.join(root, 'fake-xurl.js');
  const scenarioPath = path.join(root, 'scenario.json');
  const logPath = path.join(root, 'invocations.jsonl');
  writeFakeXurl(commandPath);
  return { root, commandPath, scenarioPath, logPath };
}

function createSource(env: {
  commandPath: string;
  scenarioPath: string;
  logPath: string;
}): XurlExternalBackfillSource {
  return new XurlExternalBackfillSource({
    command: env.commandPath,
    provider: PROVIDER,
    sourceId: SOURCE_ID,
    env: {
      ...process.env,
      XURL_SCENARIO_PATH: env.scenarioPath,
      XURL_LOG_PATH: env.logPath,
    },
  });
}

function catalogScenario(options: {
  threads: Array<{ threadId: string; revision?: string }>;
}): FakeXurlScenario {
  return {
    discover: {
      catalog: {
        provider: PROVIDER,
        next: null,
        threads: options.threads.map(item => ({
          threadId: item.threadId,
          branch: item.threadId,
          ordinal: 0,
          fingerprint: `fp-${item.threadId}`,
          ...(item.revision ? { revision: item.revision } : {}),
        })),
      },
    },
  };
}

function thread(threadId: string, revision?: string): { threadId: string; revision?: string } {
  return revision === undefined ? { threadId } : { threadId, revision };
}
