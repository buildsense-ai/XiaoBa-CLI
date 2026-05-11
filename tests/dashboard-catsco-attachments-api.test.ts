import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import { createLocalFileGrant } from '../src/dashboard/local-file-grants';
import { createApiRouter } from '../src/dashboard/routes/api';

async function listen(app: express.Express): Promise<Server> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

describe('dashboard CatsCo attachment API', () => {
  let testRoot: string;
  let originalCwd: string;
  let dashboardServer: Server | undefined;
  let catsServer: Server | undefined;
  const envKeys = ['CATSCO_HTTP_BASE_URL', 'CATSCO_USER_TOKEN', 'CATSCO_API_KEY'];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-catsco-attachments-'));
    process.chdir(testRoot);
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    if (dashboardServer) await new Promise<void>(resolve => dashboardServer!.close(() => resolve()));
    if (catsServer) await new Promise<void>(resolve => catsServer!.close(() => resolve()));
    dashboardServer = undefined;
    catsServer = undefined;
    process.chdir(originalCwd);
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('streams a local file to CatsCo and sends the attachment as the user', async () => {
    const uploaded: { auth?: string; bytes: number } = { bytes: 0 };
    let sentBody: any;
    let sentAuth = '';

    const catsApp = express();
    catsApp.post('/api/upload', (req, res) => {
      uploaded.auth = String(req.headers.authorization || '');
      req.on('data', chunk => {
        uploaded.bytes += Buffer.byteLength(chunk);
      });
      req.on('end', () => {
        res.json({ url: '/uploads/report.pdf', name: 'report.pdf', size: 11 });
      });
    });
    catsApp.post('/api/messages/send', express.json(), (req, res) => {
      sentAuth = String(req.headers.authorization || '');
      sentBody = req.body;
      res.json({ seq_id: 42 });
    });
    catsServer = await listen(catsApp);

    process.env.CATSCO_HTTP_BASE_URL = serverUrl(catsServer);
    process.env.CATSCO_USER_TOKEN = 'user-token';
    process.env.CATSCO_API_KEY = 'agent-key';

    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({ getAll: () => [] } as any));
    dashboardServer = await listen(dashboardApp);

    const filePath = path.join(testRoot, 'report.pdf');
    fs.writeFileSync(filePath, 'hello world');
    const grant = createLocalFileGrant(filePath);

    const response = await fetch(`${serverUrl(dashboardServer)}/api/cats/messages/send-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic_id: 'p2p_1_2',
        file_token: grant.token,
        file_name: 'spoof.png',
      }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.type, 'file');
    assert.equal(data.file.name, 'report.pdf');
    assert.equal(uploaded.auth, 'Bearer user-token');
    assert.ok(uploaded.bytes > 11);
    assert.equal(sentAuth, 'Bearer user-token');
    assert.deepEqual(sentBody, {
      topic_id: 'p2p_1_2',
      type: 'file',
      content: {
        type: 'file',
        payload: {
          url: '/uploads/report.pdf',
          name: 'report.pdf',
          size: 11,
        },
      },
    });
  });

  test('rejects raw local paths before calling CatsCo', async () => {
    process.env.CATSCO_USER_TOKEN = 'user-token';
    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({ getAll: () => [] } as any));
    dashboardServer = await listen(dashboardApp);

    const response = await fetch(`${serverUrl(dashboardServer)}/api/cats/messages/send-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic_id: 'p2p_1_2',
        file_path: path.join(testRoot, 'missing.txt'),
      }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 400);
    assert.equal(data.error, 'topic_id and file_token are required');
  });

  test('does not retry failed uploads with the agent API key', async () => {
    const uploadAuthHeaders: string[] = [];
    const catsApp = express();
    catsApp.post('/api/upload', (req, res) => {
      uploadAuthHeaders.push(String(req.headers.authorization || ''));
      req.resume();
      res.status(403).json({ error: 'forbidden' });
    });
    catsServer = await listen(catsApp);

    process.env.CATSCO_HTTP_BASE_URL = serverUrl(catsServer);
    process.env.CATSCO_USER_TOKEN = 'user-token';
    process.env.CATSCO_API_KEY = 'agent-key';

    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({ getAll: () => [] } as any));
    dashboardServer = await listen(dashboardApp);

    const filePath = path.join(testRoot, 'report.pdf');
    fs.writeFileSync(filePath, 'hello world');
    const grant = createLocalFileGrant(filePath);

    const response = await fetch(`${serverUrl(dashboardServer)}/api/cats/messages/send-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic_id: 'p2p_1_2',
        file_token: grant.token,
        file_name: 'report.pdf',
      }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 403);
    assert.match(data.error, /Upload failed/);
    assert.deepEqual(uploadAuthHeaders, ['Bearer user-token']);
  });

  test('does not retry failed message sends with the agent API key', async () => {
    const uploadAuthHeaders: string[] = [];
    const messageAuthHeaders: string[] = [];
    const catsApp = express();
    catsApp.post('/api/upload', (req, res) => {
      uploadAuthHeaders.push(String(req.headers.authorization || ''));
      req.resume();
      res.json({ url: '/uploads/report.pdf', name: 'report.pdf', size: 11 });
    });
    catsApp.post('/api/messages/send', express.json(), (req, res) => {
      messageAuthHeaders.push(String(req.headers.authorization || ''));
      res.status(403).json({ error: 'message forbidden' });
    });
    catsServer = await listen(catsApp);

    process.env.CATSCO_HTTP_BASE_URL = serverUrl(catsServer);
    process.env.CATSCO_USER_TOKEN = 'user-token';
    process.env.CATSCO_API_KEY = 'agent-key';

    const dashboardApp = express();
    dashboardApp.use(express.json());
    dashboardApp.use('/api', createApiRouter({ getAll: () => [] } as any));
    dashboardServer = await listen(dashboardApp);

    const filePath = path.join(testRoot, 'report.pdf');
    fs.writeFileSync(filePath, 'hello world');
    const grant = createLocalFileGrant(filePath);

    const response = await fetch(`${serverUrl(dashboardServer)}/api/cats/messages/send-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic_id: 'p2p_1_2',
        file_token: grant.token,
      }),
    });
    const data = await response.json() as any;

    assert.equal(response.status, 403);
    assert.equal(data.error, 'message forbidden');
    assert.deepEqual(uploadAuthHeaders, ['Bearer user-token']);
    assert.deepEqual(messageAuthHeaders, ['Bearer user-token']);
  });
});
