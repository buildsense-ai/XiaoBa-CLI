import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { Server } from 'http';
import { createApiRouter } from '../src/dashboard/routes/api';

describe('dashboard timetable task API', () => {
  let testRoot: string;
  let originalCwd: string;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-timetable-api-'));
    process.chdir(testRoot);

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter({ getAll: () => [] } as any));
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('creates a timetable task from a teacher message and persists it', async () => {
    const createResponse = await fetch(`${baseUrl}/api/timetable/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '王老师周三下午不能排，先帮我检查七年级课表资料。',
      }),
    });
    const created = await createResponse.json() as any;

    assert.equal(createResponse.status, 201);
    assert.equal(created.ok, true);
    assert.match(created.task.id, /^tt_/);
    assert.equal(created.task.status, 'collecting_requirements');
    assert.equal(created.task.inputs[0].content, '王老师周三下午不能排，先帮我检查七年级课表资料。');
    assert.equal(created.task.requirements[0].text, '王老师周三下午不能排，先帮我检查七年级课表资料。');
    assert.deepEqual(created.task.conflicts, []);
    assert.deepEqual(created.task.artifacts, []);

    const listResponse = await fetch(`${baseUrl}/api/timetable/tasks`);
    const list = await listResponse.json() as any;
    assert.equal(listResponse.status, 200);
    assert.equal(list.tasks.length, 1);
    assert.equal(list.tasks[0].id, created.task.id);

    const storedPath = path.join(testRoot, 'data', 'timetable', 'tasks.json');
    assert.equal(fs.existsSync(storedPath), true);
    assert.match(fs.readFileSync(storedPath, 'utf-8'), /王老师周三下午不能排/);
  });

  test('appends teacher messages to an existing timetable task', async () => {
    const createResponse = await fetch(`${baseUrl}/api/timetable/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '先建立一个排课任务。' }),
    });
    const created = await createResponse.json() as any;

    const appendResponse = await fetch(`${baseUrl}/api/timetable/tasks/${created.task.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '七年级活动课尽量放第六节。' }),
    });
    const appended = await appendResponse.json() as any;

    assert.equal(appendResponse.status, 200);
    assert.equal(appended.task.inputs.length, 2);
    assert.equal(appended.task.inputs[1].content, '七年级活动课尽量放第六节。');
    assert.equal(appended.task.requirements[1].text, '七年级活动课尽量放第六节。');
  });

  test('keeps simple greetings as chat messages instead of timetable requirements', async () => {
    const createResponse = await fetch(`${baseUrl}/api/timetable/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });
    const created = await createResponse.json() as any;

    assert.equal(createResponse.status, 201);
    assert.equal(created.task.inputs.length, 1);
    assert.equal(created.task.inputs[0].content, '你好');
    assert.equal(created.task.requirements.length, 0);
    assert.match(created.task.missingInformation[0], /直接告诉我要排哪个年级/);
  });

  test('uploads timetable source files and attaches them to teacher messages', async () => {
    const uploadResponse = await fetch(`${baseUrl}/api/timetable/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{
          name: '七年级课表.csv',
          type: 'text/csv',
          size: 17,
          dataBase64: Buffer.from('班级,课程\n1班,语文\n', 'utf-8').toString('base64'),
        }],
      }),
    });
    const uploaded = await uploadResponse.json() as any;

    assert.equal(uploadResponse.status, 201);
    assert.equal(uploaded.files.length, 1);
    assert.equal(uploaded.files[0].name, '七年级课表.csv');
    assert.match(uploaded.files[0].id, /^ttu_/);
    assert.equal(fs.existsSync(path.join(testRoot, uploaded.files[0].path)), true);

    const createResponse = await fetch(`${baseUrl}/api/timetable/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '请先看这个课表资料。',
        attachments: uploaded.files,
      }),
    });
    const created = await createResponse.json() as any;

    assert.equal(createResponse.status, 201);
    assert.equal(created.task.inputs[0].attachments[0].name, '七年级课表.csv');
  });

  test('rejects empty timetable task messages', async () => {
    const response = await fetch(`${baseUrl}/api/timetable/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 400);
    assert.match(data.error, /message is required/);
  });
});

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}
