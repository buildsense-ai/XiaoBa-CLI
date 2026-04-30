import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../src/tools/read-tool';
import { ShellTool } from '../src/tools/bash-tool';

test('read_file returns agent-directed reader guidance for current-turn images', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-read-image-'));
  const imagePath = path.join(tmpDir, 'current.png');
  fs.writeFileSync(imagePath, Buffer.from('not-a-real-image'));

  try {
    const tool = new ReadTool();
    const result = await tool.execute(
      { file_path: imagePath },
      {
        workingDirectory: tmpDir,
        conversationHistory: [],
        supportsDirectImageInput: false,
        currentUserText: '帮我看看图里都是什么东西',
        currentTurnAttachments: [
          { fileName: 'current.png', localPath: imagePath, type: 'image' },
        ],
      },
    );

    assert.equal(result.ok, true);
    assert.equal(typeof result.content, 'string');
    assert.match(String(result.content), /image attached in the current user turn/);
    assert.match(String(result.content), /帮我看看图里都是什么东西/);
    assert.match(String(result.content), /vision-analysis|advanced-reader/);
    assert.match(String(result.content), /native tool call to the `skill` tool/);
    assert.match(String(result.content), /Do not call any reader Python script directly/);
    assert.match(String(result.content), /Do not guess from the file name/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('read_file refuses older images when current-turn image context is available', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-read-image-'));
  const currentPath = path.join(tmpDir, 'current.png');
  const oldPath = path.join(tmpDir, 'old.png');
  fs.writeFileSync(currentPath, Buffer.from('current'));
  fs.writeFileSync(oldPath, Buffer.from('old'));

  try {
    const tool = new ReadTool();
    const result = await tool.execute(
      { file_path: oldPath },
      {
        workingDirectory: tmpDir,
        conversationHistory: [],
        supportsDirectImageInput: false,
        currentUserText: '看这张图',
        currentTurnAttachments: [
          { fileName: 'current.png', localPath: currentPath, type: 'image' },
        ],
      },
    );

    assert.equal(result.ok, true);
    assert.match(String(result.content), /not one of the images attached in the current user turn/);
    assert.match(String(result.content), /current\.png/);
    assert.match(String(result.content), /older image from conversation history/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('execute_shell blocks reader scripts unless the matching skill is active', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-shell-'));

  try {
    const tool = new ShellTool();
    const result = await tool.execute(
      {
        command: 'python "C:/Users/test/AppData/Roaming/xiaoba-cli/skills/vision-analysis/scripts/invoke_reader_api.py" "image.png"',
      },
      {
        workingDirectory: tmpDir,
        conversationHistory: [],
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'SKILL_NOT_ACTIVATED');
    assert.match(result.message, /native skill tool/);
    assert.match(result.message, /"vision-analysis"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
