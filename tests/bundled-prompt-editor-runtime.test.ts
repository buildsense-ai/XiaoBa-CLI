import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = path.resolve(__dirname, '..');

test('packaged prompt helper runs without Dashboard from CLI, desktop and Worker layouts', { timeout: 60000 }, async t => {
  assert.ok(fs.existsSync(path.join(repo, 'dist/skills/prompt-editor-command.js')), 'Compile before testing');
  for (const layout of ['cli-app', 'desktop/resources/app', 'CatsCo.app/Contents/Resources/app', 'worker/releases/test/app']) {
    await t.test(layout, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-package-'));
      let server: http.Server | undefined;
      try {
        const app = path.join(root, layout);
        const data = path.join(root, '用户 数据');
        const cwd = path.join(root, 'unrelated-cwd');
        fs.mkdirSync(data); fs.mkdirSync(cwd);
        fs.cpSync(path.join(repo, 'dist'), path.join(app, 'dist'), { recursive: true });
        fs.cpSync(path.join(repo, 'skills/catsco-prompt-editor'), path.join(app, 'skills/catsco-prompt-editor'), { recursive: true });
        fs.cpSync(path.join(repo, 'prompts'), path.join(app, 'prompts'), { recursive: true });
        const env = { ...process.env, NODE_PATH: path.join(repo, 'node_modules'),
          XIAOBA_USER_DATA_DIR: data, XIAOBA_RUNTIME_ROOT: data, XIAOBA_APP_ROOT: app };
        const script = path.join(app, 'skills/catsco-prompt-editor/scripts/prompt.cjs');
        const call = async (...args: string[]) => JSON.parse((await run(process.execPath,
          [script, '--root', data, ...args], { cwd, env })).stdout);
        const input = path.join(data, '请求.json');
        const writeRequest = (state: any, content?: string) => {
          fs.writeFileSync(input, JSON.stringify({ botId: state.botId, expectedHash: state.expectedHash,
            expectedRevision: state.expectedRevision, ...(content !== undefined ? { content } : {}) }));
        };

        // Fresh subprocess for every call: no reliance on an in-memory coordinator.
        const initial = await call('show');
        assert.equal(initial.botId, null); assert.equal(initial.selected, 'default');
        assert.deepEqual(fs.readdirSync(data), []);
        writeRequest(initial, 'Local custom rules');
        const local = await call('set', input);
        assert.equal(local.cloudVerified, false); assert.equal(local.localMatches, true);
        writeRequest(await call('show'));
        assert.equal((await call('reset', input)).content, initial.defaultContent);
        assert.equal(fs.existsSync(path.join(data, 'prompt-overrides/system-prompt.md')), false);

        // Real HTTP transport, synthetic cloud authority; no production users or credentials.
        let revision = 3;
        let prompt: any = { selected: 'default' };
        let patchCount = 0;
        server = http.createServer(async (req, res) => {
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'PATCH') {
            if (req.url !== '/api/bots/definition/prompt?uid=982' || req.headers.authorization !== 'Bearer test-owner') {
              res.writeHead(403).end('{}'); return;
            }
            let raw = ''; for await (const part of req) raw += part;
            const body = JSON.parse(raw);
            if (body.revision !== revision) { res.writeHead(409).end('{}'); return; }
            prompt = body.prompt; revision++; patchCount++;
            res.end(JSON.stringify({ revision })); return;
          }
          if (req.url !== '/api/bot/definition' || req.headers.authorization !== 'ApiKey test-bot') {
            res.writeHead(403).end('{}'); return;
          }
          res.end(JSON.stringify({ uid: 982, configured: true, revision, definition: {
            schema: 'xiaoba.bot-definition.v1', botId: '982',
            model: { kind: 'catalog', modelId: 'deepseek-v4-flash' }, prompt,
          } }));
        });
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
        const address = server.address() as import('node:net').AddressInfo;
        fs.mkdirSync(path.join(data, '.xiaoba'), { recursive: true });
        fs.writeFileSync(path.join(data, '.xiaoba/catsco.json'), JSON.stringify({ version: 1,
          endpoints: { httpBaseUrl: `http://127.0.0.1:${address.port}` },
          account: { uid: '38', token: 'test-owner' },
          currentBot: { uid: '982', boundByUserUid: '38', apiKey: 'test-bot', bindingSource: 'test' },
        }));
        writeRequest(await call('show'), 'Persisted cloud rules');
        const saved = await call('set', input);
        assert.equal(saved.cloudWritten, true); assert.equal(saved.cloudVerified, true); assert.equal(saved.localMatches, true);
        assert.equal((await call('show')).content, 'Persisted cloud rules');
        writeRequest(await call('show'));
        const reset = await call('reset', input);
        assert.equal(reset.selected, 'default'); assert.equal(reset.localMatches, true);
        assert.equal(reset.customContent, 'Persisted cloud rules');
        assert.equal(patchCount, 2);
        assert.deepEqual(fs.readdirSync(cwd), []);
        assert.equal(fs.existsSync(path.join(app, 'data')), false);
      } finally {
        if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
        await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    });
  }
});
