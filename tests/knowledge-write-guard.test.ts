import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteTool } from '../src/tools/write-tool';
import { EditTool } from '../src/tools/edit-tool';
import { isManagedKnowledgePath } from '../src/skills/knowledge-write-guard';

test('local file tools cannot bypass knowledge revisions, while request files remain writable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-guard-'));
  const prior = process.env.XIAOBA_USER_DATA_DIR;
  process.env.XIAOBA_USER_DATA_DIR = root;
  try {
    const context: any = { workingDirectory: root, workspaceRoot: root };
    const file = path.join(root, 'knowledge', 'documents', 'KB-test.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'original');
    const write = await new WriteTool().execute({ file_path: file, content: 'overwritten' }, context);
    const edit = await new EditTool().execute({ file_path: file, old_string: 'original', new_string: 'changed' }, context);
    assert.equal(write.ok, false);
    assert.equal(edit.ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'original');
    assert.equal((await new WriteTool().execute({ file_path: 'request.json', content: '{}' }, context)).ok, true);
    assert.equal(isManagedKnowledgePath(path.join(root, 'knowledge-other', 'doc.md')), false);
    assert.equal(isManagedKnowledgePath(path.join(root, 'knowledge', '..', 'request.json')), false);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(path.join(root, 'knowledge'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await new WriteTool().execute({ file_path: path.join(alias, 'new.md'), content: 'bypass' }, context)).ok, false);
    assert.equal(fs.existsSync(path.join(root, 'knowledge', 'new.md')), false);
  } finally {
    if (prior === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
