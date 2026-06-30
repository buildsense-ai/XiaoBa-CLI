import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { createApiRouter } from '../src/dashboard/routes/api';

describe('dashboard session log API', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalSkillsDir: string | undefined;
  let originalUserDataDir: string | undefined;
  let server: Server | undefined;
  let baseUrl = '';

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalSkillsDir = process.env.XIAOBA_SKILLS_DIR;
    originalUserDataDir = process.env.XIAOBA_ELECTRON_USER_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-session-logs-'));
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'test-skills');
    process.env.XIAOBA_ELECTRON_USER_DATA_DIR = testRoot;
    process.chdir(testRoot);
    writeSessionLog({
      type: 'chat',
      file: 'chat_demo.jsonl',
      entries: [
        {
          entry_type: 'turn',
          turn: 1,
          timestamp: new Date().toISOString(),
          session_id: 'chat:demo',
          session_type: 'chat',
          user: { text: 'please inspect the failing shell command' },
          assistant: {
            text: 'The shell command failed: command not found',
            tool_calls: [{
              id: 'tool-1',
              name: 'execute_shell',
              arguments: { command: 'grep missing' },
              result: 'command not found',
              duration_ms: 12,
            }],
          },
          tokens: { prompt: 10, completion: 5 },
        },
        {
          entry_type: 'runtime',
          timestamp: new Date().toISOString(),
          session_id: 'chat:demo',
          session_type: 'chat',
          level: 'error',
          message: 'runtime error while running shell',
        },
      ],
    });
    writeSessionLog({
      type: 'weixin',
      file: 'weixin_demo.jsonl',
      entries: [{
        entry_type: 'turn',
        turn: 1,
        timestamp: new Date().toISOString(),
        session_id: 'weixin:demo',
        session_type: 'weixin',
        user: { text: 'hello' },
        assistant: { text: 'ok', tool_calls: [] },
        tokens: { prompt: 1, completion: 1 },
      }],
    });

    const app = express();
    app.use(express.json({ limit: '25mb' }));
    app.use('/api', createApiRouter({ getAll: () => [], getService: () => null } as any));
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterEach(async () => {
    if (server) await close(server);
    process.chdir(originalCwd);
    if (originalSkillsDir === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsDir;
    if (originalUserDataDir === undefined) delete process.env.XIAOBA_ELECTRON_USER_DATA_DIR;
    else process.env.XIAOBA_ELECTRON_USER_DATA_DIR = originalUserDataDir;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('lists recent session logs with safe file ids and summary counts', async () => {
    const response = await get('/api/sessions/recent?days=7&type=chat');

    assert.equal(response.status, 200);
    assert.equal(response.body.sessions.length, 1);
    const session = response.body.sessions[0];
    assert.equal(session.sessionId, 'chat:demo');
    assert.equal(session.sessionType, 'chat');
    assert.equal(session.turns, 1);
    assert.equal(session.toolCalls, 1);
    assert.equal(session.failures, 1);
    assert.equal(session.runtimeErrors, 1);
    assert.equal(typeof session.fileId, 'string');
    assert.equal(session.fileId.includes('/'), false);
    assert.equal(Object.hasOwn(session, 'absolutePath'), false);
  });

  test('reads one session log by file id without accepting raw paths', async () => {
    const recent = await get('/api/sessions/recent?days=7&type=chat');
    const fileId = recent.body.sessions[0].fileId;
    const detail = await get(`/api/sessions/${encodeURIComponent(fileId)}`);

    assert.equal(detail.status, 200);
    assert.equal(detail.body.session.sessionId, 'chat:demo');
    assert.equal(detail.body.entries.length, 2);
    assert.equal(detail.body.entries[0].assistant.tool_calls[0].name, 'execute_shell');

    const rawPath = await get('/api/sessions/..%2Fsecret.jsonl');
    assert.equal(rawPath.status, 404);
  });

  test('pet skill recommendations suggest SkillHub searches without installing automatically', async () => {
    const response = await get('/api/pet/skill-recommendations?days=7');

    assert.equal(response.status, 200);
    assert.equal(response.body.recommendations.length, 1);
    const recommendation = response.body.recommendations[0];
    assert.equal(recommendation.action, 'skillhub_search');
    assert.match(recommendation.title, /Shell/);
    assert.match(recommendation.searchQuery, /shell/i);
    assert.match(recommendation.reason, /1/);
    assert.equal(recommendation.autoInstall, false);
  });

  test('pet skill drafts generate local skill markdown and require confirmation before install', async () => {
    const draftResponse = await get('/api/pet/skill-drafts?days=7');

    assert.equal(draftResponse.status, 200);
    assert.equal(draftResponse.body.drafts.length, 1);
    const draft = draftResponse.body.drafts[0];
    assert.equal(draft.action, 'create_local_skill');
    assert.equal(draft.requiresConfirmation, true);
    assert.equal(draft.autoInstall, false);
    assert.equal(draft.name, 'shell-recovery-workflow');
    assert.match(draft.skillMarkdown, /name: shell-recovery-workflow/);
    assert.match(draft.skillMarkdown, /PowerShell/);
    assert.match(draft.reason, /shell/i);

    const skillsRoot = path.join(testRoot, 'custom-skills');
    process.env.XIAOBA_SKILLS_DIR = skillsRoot;
    assert.equal(fs.existsSync(path.join(skillsRoot, 'shell-recovery-workflow', 'SKILL.md')), false);

    const applyResponse = await post('/api/pet/skill-drafts/apply', { id: draft.id });

    assert.equal(applyResponse.status, 200);
    assert.equal(applyResponse.body.ok, true);
    assert.equal(applyResponse.body.skill.name, 'shell-recovery-workflow');
    assert.equal(applyResponse.body.skill.action, 'created');
    assert.equal(applyResponse.body.skill.autoInstall, false);
    const installedPath = path.join(skillsRoot, 'shell-recovery-workflow', 'SKILL.md');
    assert.equal(fs.existsSync(installedPath), true);
    assert.match(fs.readFileSync(installedPath, 'utf8'), /x-catsco-generated: true/);
  });

  test('pet skill drafts expand to debugging, user preference, and common task workflows', async () => {
    writeSessionLog({
      type: 'chat',
      file: 'expanded_signals.jsonl',
      entries: [
        {
          entry_type: 'turn',
          turn: 1,
          timestamp: new Date().toISOString(),
          session_id: 'chat:expanded',
          session_type: 'chat',
          user: { text: '以后回答请用简短清单，不要长篇解释，记住这个偏好' },
          assistant: { text: '记住了', tool_calls: [] },
          tokens: { prompt: 10, completion: 3 },
        },
        {
          entry_type: 'turn',
          turn: 2,
          timestamp: new Date().toISOString(),
          session_id: 'chat:expanded',
          session_type: 'chat',
          user: { text: '帮我整理日报' },
          assistant: { text: '日报整理失败: missing template', tool_calls: [] },
          tokens: { prompt: 10, completion: 3 },
        },
        {
          entry_type: 'turn',
          turn: 3,
          timestamp: new Date().toISOString(),
          session_id: 'chat:expanded',
          session_type: 'chat',
          user: { text: '再帮我整理日报' },
          assistant: { text: '日报已整理', tool_calls: [] },
          tokens: { prompt: 10, completion: 3 },
        },
        {
          entry_type: 'turn',
          turn: 4,
          timestamp: new Date().toISOString(),
          session_id: 'chat:expanded',
          session_type: 'chat',
          user: { text: '继续排查刚才的失败' },
          assistant: { text: 'failed again with TypeError', tool_calls: [] },
          tokens: { prompt: 10, completion: 3 },
        },
        {
          entry_type: 'runtime',
          timestamp: new Date().toISOString(),
          session_id: 'chat:expanded',
          session_type: 'chat',
          level: 'error',
          message: 'Unhandled TypeError in runtime loop',
        },
        {
          entry_type: 'runtime',
          timestamp: new Date().toISOString(),
          session_id: 'chat:expanded',
          session_type: 'chat',
          level: 'error',
          message: 'Repeated runtime error while formatting output',
        },
      ],
    });

    const response = await get('/api/pet/skill-drafts?days=7');

    assert.equal(response.status, 200);
    const drafts = response.body.drafts;
    const names = drafts.map((draft: any) => draft.name).sort();
    assert.deepEqual(names, [
      'common-task-workflow',
      'debugging-triage-workflow',
      'shell-recovery-workflow',
      'user-preference-workflow',
    ]);
    for (const draft of drafts) {
      assert.equal(draft.requiresConfirmation, true);
      assert.equal(draft.autoInstall, false);
      assert.match(draft.skillMarkdown, /x-catsco-generated: true/);
    }
    assert.match(drafts.find((draft: any) => draft.name === 'debugging-triage-workflow').skillMarkdown, /runtime error/i);
    assert.match(drafts.find((draft: any) => draft.name === 'user-preference-workflow').skillMarkdown, /简短清单/);
    assert.match(drafts.find((draft: any) => draft.name === 'common-task-workflow').skillMarkdown, /整理日报/);
  });

  test('pet daily report filters noise and surfaces confirmation-gated skill candidates', async () => {
    writeSessionLog({
      type: 'chat',
      file: 'daily_report_signals.jsonl',
      entries: [
        {
          entry_type: 'turn',
          turn: 1,
          timestamp: new Date().toISOString(),
          session_id: 'chat:daily',
          session_type: 'chat',
          user: { text: 'hello thanks just testing' },
          assistant: { text: 'ok', tool_calls: [] },
          tokens: { prompt: 2, completion: 1 },
        },
        {
          entry_type: 'turn',
          turn: 2,
          timestamp: new Date().toISOString(),
          session_id: 'chat:daily',
          session_type: 'chat',
          user: { text: 'Please generate my daily report from the webapp usage' },
          assistant: {
            text: 'Completed the daily report companion plan and added log analysis.',
            tool_calls: [{
              id: 'tool-report',
              name: 'execute_shell',
              arguments: { command: 'npm test' },
              result: 'tests passed',
              duration_ms: 10,
            }],
          },
          tokens: { prompt: 12, completion: 9 },
        },
        {
          entry_type: 'turn',
          turn: 3,
          timestamp: new Date().toISOString(),
          session_id: 'chat:daily',
          session_type: 'chat',
          user: { text: 'From now on, keep these reports concise and in Chinese.' },
          assistant: { text: 'Noted for future daily reports.', tool_calls: [] },
          tokens: { prompt: 10, completion: 4 },
        },
        {
          entry_type: 'runtime',
          timestamp: new Date().toISOString(),
          session_id: 'chat:daily',
          session_type: 'chat',
          level: 'error',
          message: 'Runtime error while generating a draft report',
        },
      ],
    });

    const response = await get('/api/pet/daily-report?days=7');

    assert.equal(response.status, 200);
    assert.equal(response.body.report.requiresConfirmation, true);
    assert.equal(response.body.report.autoSave, false);
    assert.equal(response.body.report.metrics.sessions, 3);
    assert.equal(response.body.report.noise.filteredTurns >= 1, true);
    assert.match(response.body.report.summary, /daily report/i);
    assert.match(response.body.report.reportMarkdown, /Completed the daily report companion/i);
    assert.doesNotMatch(response.body.report.reportMarkdown, /hello thanks just testing/i);
    assert.match(response.body.report.sections.preferences.join('\n'), /concise/i);
    assert.match(response.body.report.sections.failures.join('\n'), /Runtime error/i);
    assert.equal(response.body.report.skillCandidates.length >= 1, true);
    assert.equal(response.body.report.skillCandidates[0].requiresConfirmation, true);
    assert.equal(response.body.report.skillCandidates[0].autoInstall, false);
  });

  test('pet daily report saves only after explicit confirmation', async () => {
    const date = new Date().toISOString().slice(0, 10);
    writeSessionLog({
      type: 'chat',
      file: 'daily_report_save.jsonl',
      entries: [
        {
          entry_type: 'turn',
          turn: 1,
          timestamp: new Date().toISOString(),
          session_id: 'chat:save-report',
          session_type: 'chat',
          user: { text: 'Please generate a daily report and suggest useful skill candidates' },
          assistant: {
            text: 'Completed a useful daily report draft with skill candidate suggestions.',
            tool_calls: [],
          },
          tokens: { prompt: 12, completion: 9 },
        },
      ],
    });
    const reportPath = path.join(testRoot, 'reports', 'daily', `${date}.md`);
    assert.equal(fs.existsSync(reportPath), false);

    const previewResponse = await get(`/api/pet/daily-report?days=7&date=${date}`);

    assert.equal(previewResponse.status, 200);
    assert.equal(previewResponse.body.report.autoSave, false);
    assert.equal(fs.existsSync(reportPath), false);

    const saveResponse = await post('/api/pet/daily-report/save', { date });

    assert.equal(saveResponse.status, 200);
    assert.equal(saveResponse.body.ok, true);
    assert.equal(saveResponse.body.report.date, date);
    assert.equal(saveResponse.body.report.autoSave, false);
    assert.equal(saveResponse.body.saved.path, reportPath);
    assert.equal(fs.existsSync(reportPath), true);
    const savedMarkdown = fs.readFileSync(reportPath, 'utf8');
    assert.match(savedMarkdown, /Daily Report/);
    assert.match(savedMarkdown, /Completed a useful daily report draft/);
  });

  async function get(urlPath: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${urlPath}`);
    return { status: res.status, body: await res.json() };
  }

  async function post(urlPath: string, body: any): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  function writeSessionLog(input: { type: string; file: string; entries: any[] }): void {
    const date = new Date().toISOString().slice(0, 10);
    const dir = path.join(testRoot, 'logs', 'sessions', input.type, date);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, input.file),
      input.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );
  }
});

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
