import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GrepTool } from '../src/tools/grep-tool';
import { MAX_GREP_OUTPUT_CHARS } from '../src/tools/grep-output';

test('public GrepTool caps local JSONL previews and declares truncation', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-bound-integration-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'log.jsonl'), 'needle ' + 'x'.repeat(71000) + '\n');
  // Use a controlled native-output fixture so rg max-columns cannot hide the
  // oversized line and make this test pass without exercising the boundary.
  fs.writeFileSync(path.join(bin, 'rg'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'grep'), `#!/bin/sh\nprintf 'log.jsonl:1:'\ncat ${JSON.stringify(path.join(root, 'log.jsonl'))}\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  try {
    const result = await new GrepTool().execute({ pattern: 'needle', path: root, output_mode: 'content', backend_timing: true }, {
      workingDirectory: root, surface: 'cli', abortSignal: AbortSignal.timeout(3000),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(typeof result.content, 'string');
      const text = String(result.content);
      assert.ok(text.length <= MAX_GREP_OUTPUT_CHARS);
      assert.match(text, /log\.jsonl:1:/);
      assert.match(text, /截断/);
      assert.doesNotMatch(text, /未找到匹配项/);
    }
  } finally {
    process.env.PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public GrepTool caps remote text too and rejects malformed nontext results', async () => {
  let malformed = false;
  const context: any = {
    workingDirectory: '/tmp', surface: 'catscompany',
    targetRoutes: {
      routes: [{ userId: 'other-user', userName: 'other', ownerUserId: 'owner', deviceId: 'device', label: 'other', os: 'linux', status: 'ready' }],
      byUserId: new Map([['other-user', [{ userId: 'other-user', ownerUserId: 'owner', deviceId: 'device', label: 'other', os: 'linux', status: 'ready' }]]]),
      byName: new Map(),
    },
    thinToolRpc: { executeTool: async () => ({ ok: true, content: malformed ? [{ type: 'text', text: 'unexpected blocks' }] : 'remote.jsonl:1:needle ' + 'x'.repeat(70000) }) },
  };
  const first = await new GrepTool().execute({ pattern: 'needle', target: 'other-user' }, context);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.ok(String(first.content).length <= MAX_GREP_OUTPUT_CHARS);
    assert.match(String(first.content), /截断/);
  }
  malformed = true;
  const second = await new GrepTool().execute({ pattern: 'needle', target: 'other-user' }, context);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.errorCode, 'TOOL_EXECUTION_ERROR');
});
