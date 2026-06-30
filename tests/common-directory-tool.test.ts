import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
import { CommonDirectoryTool, normalizeCommonDirectory, resolveCommonDirectory } from '../src/tools/common-directory-tool';

describe('CommonDirectoryTool', () => {
  test('normalizes English and Chinese common directory aliases', () => {
    assert.equal(normalizeCommonDirectory('desktop'), 'desktop');
    assert.equal(normalizeCommonDirectory('my desktop'), 'desktop');
    assert.equal(normalizeCommonDirectory('\u684c\u9762'), 'desktop');
    assert.equal(normalizeCommonDirectory('Downloads'), 'downloads');
    assert.equal(normalizeCommonDirectory('downloads folder'), 'downloads');
    assert.equal(normalizeCommonDirectory('\u4e0b\u8f7d\u6587\u4ef6\u5939'), 'downloads');
    assert.equal(normalizeCommonDirectory('\u7167\u7247'), 'pictures');
    assert.equal(normalizeCommonDirectory('\u7528\u6237\u76ee\u5f55'), 'home');
  });

  test('rejects unsupported semantic folders instead of guessing', async () => {
    const tool = new CommonDirectoryTool();
    const result = await tool.execute({ directory: '\u516c\u53f8\u9879\u76ee' }, {
      workingDirectory: os.homedir(),
      conversationHistory: [],
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.match(result.message, /Unknown common directory/);
  });

  test('resolves home and temp to existing platform paths', async () => {
    const home = resolveCommonDirectory('home');
    const temp = resolveCommonDirectory('temp');

    assert.equal(home.path, os.homedir());
    assert.equal(home.exists, true);
    assert.equal(temp.path, os.tmpdir());
    assert.equal(temp.exists, true);
  });

  test('returns a concise path result for agent follow-up file operations', async () => {
    const tool = new CommonDirectoryTool();
    const result = await tool.execute({ directory: 'home' }, {
      workingDirectory: os.homedir(),
      conversationHistory: [],
    });

    assert.equal(result.ok, true);
    assert.match(result.content as string, /Resolved common directory:/);
    assert.match(result.content as string, /kind: home/);
    assert.match(result.content as string, /Use this exact path only with the same tool target/);
    assert.match(result.content as string, /call resolve_common_directory again on the new target/);
    assert.match(result.content as string, /call glob with this path/);
    assert.match(result.content as string, /call write_file with a file_path under this path/);
    assert.match(result.content as string, /pass this path as execute_shell\.cwd/);
    assert.match(result.content as string, /Do not use execute_shell/);
  });
});
