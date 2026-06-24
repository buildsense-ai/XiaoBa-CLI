import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPromptTraceSnapshot,
  listPromptFiles,
  toPromptTurnMetadata,
} from '../src/utils/prompt-observability';

describe('prompt-observability', () => {
  test('builds deterministic prompt file and turn metadata hashes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-observability-'));
    try {
      fs.mkdirSync(path.join(root, 'transient'), { recursive: true });
      fs.writeFileSync(path.join(root, 'system-prompt.md'), 'Base prompt\n', 'utf-8');
      fs.writeFileSync(path.join(root, 'runtime-context.md'), 'Runtime prompt\n', 'utf-8');
      fs.writeFileSync(path.join(root, 'transient', 'plan.md'), 'Plan prompt\n', 'utf-8');

      const snapshot = buildPromptTraceSnapshot({
        promptsDir: root,
        systemPrompt: 'Base prompt\n\nRuntime prompt',
        source: 'test',
        loadedFiles: ['system-prompt.md', 'runtime-context.md'],
        env: { CATSCO_PROMPT_VERSION: 'v-test' } as any,
        now: new Date('2026-06-17T00:00:00.000Z'),
      });

      assert.equal(snapshot.source, 'test');
      assert.equal(snapshot.prompt_version, 'v-test');
      assert.match(snapshot.prompts_dir, /^custom:[a-f0-9]{12}$/);
      assert.equal(snapshot.generated_at, '2026-06-17T00:00:00.000Z');
      assert.deepStrictEqual(
        snapshot.bundle.files.map(file => file.path),
        ['runtime-context.md', 'system-prompt.md', 'transient/plan.md'],
      );
      assert.equal(snapshot.loaded_files.join(','), 'runtime-context.md,system-prompt.md');
      assert.match(snapshot.system.sha256, /^[a-f0-9]{64}$/);
      assert.equal(snapshot.system.short_hash.length, 12);
      assert.match(snapshot.bundle.sha256, /^[a-f0-9]{64}$/);

      const turn = toPromptTurnMetadata(snapshot);
      assert.deepStrictEqual(turn, {
        source: 'test',
        prompt_version: 'v-test',
        system_hash: snapshot.system.short_hash,
        system_chars: snapshot.system.chars,
        bundle_hash: snapshot.bundle.short_hash,
        bundle_file_count: 3,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not mark prompts as overridden when override directory is unsafe', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-prompt-observability-unsafe-'));
    const previous = process.env.XIAOBA_PROMPT_OVERRIDES_DIR;
    try {
      process.env.XIAOBA_PROMPT_OVERRIDES_DIR = root;
      fs.writeFileSync(path.join(root, 'system-prompt.md'), 'Base prompt\n', 'utf-8');

      const files = listPromptFiles(root);

      assert.equal(files.length, 1);
      assert.equal(files[0].path, 'system-prompt.md');
      assert.equal(files[0].overridden, undefined);
    } finally {
      if (previous === undefined) {
        delete process.env.XIAOBA_PROMPT_OVERRIDES_DIR;
      } else {
        process.env.XIAOBA_PROMPT_OVERRIDES_DIR = previous;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
