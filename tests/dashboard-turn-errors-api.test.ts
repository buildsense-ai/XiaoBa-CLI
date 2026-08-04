import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import express, { Router } from 'express';
import { registerTurnErrorRoutes } from '../src/dashboard/routes/turn-errors';

describe('turn error dashboard API', () => {
  let root = '';
  let server: http.Server;
  let baseUrl = '';
  const originalRuntimeRoot = process.env.XIAOBA_USER_DATA_DIR;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-turn-error-api-'));
    process.env.XIAOBA_USER_DATA_DIR = root;
    const logDir = path.join(root, 'logs', 'sessions', 'catscompany', '2026-08-02');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'session.jsonl'), `${JSON.stringify({
      entry_type: 'runtime',
      timestamp: new Date().toISOString(),
      session_id: 'cc_group:grp_1',
      session_type: 'catscompany',
      level: 'ERROR',
      message: 'interrupted',
      event: {
        type: 'turn_error',
        payload: {
          category: 'provider_rejected',
          error_code: 'provider_rejected_400',
          classification_confidence: 'low',
          error_fingerprint: 'fingerprint400',
        },
      },
    })}\n`);

    const app = express();
    const router = Router();
    registerTurnErrorRoutes(router);
    app.use('/api', router);
    server = await new Promise(resolve => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to TCP');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    if (originalRuntimeRoot === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalRuntimeRoot;
  });

  test('returns the interruption report with bounded query parameters', async () => {
    const response = await fetch(`${baseUrl}/api/observability/turn-errors?days=9999&limit=9999`);
    assert.equal(response.status, 200);
    const report = await response.json() as any;
    assert.equal(report.window_days, 365);
    assert.equal(report.totals.interruptions, 1);
    assert.equal(report.recent.length, 1);
    assert.equal(report.recent[0].category, 'provider_rejected');
  });

  test('ships a standalone local dashboard page', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'dashboard', 'turn-errors.html'), 'utf8');
    assert.match(html, /对话中断监控/);
    assert.match(html, /错误来源/);
    assert.match(html, /本地首个堆栈位置/);
    assert.match(html, /关联 Attempt/);
    assert.match(html, /cache-trace\.html/);
    assert.match(html, /\/api\/observability\/turn-errors/);
  });
});
