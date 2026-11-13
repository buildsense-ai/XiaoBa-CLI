import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { CatsLogMemoryProvider } from '../src/utils/catslog-memory-provider';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { fixtureBranch } from './helpers/catslog-projection-reference-fixture';

async function withServer(mode: string, run: (base: string) => Promise<void>) {
  const server = http.createServer((req, res) => {
    req.resume(); res.setHeader('Content-Type', 'application/json');
    if (mode === 'redirect') { res.writeHead(302, { Location: '/unexpected' }); return res.end(); }
    const text = mode === 'small' ? JSON.stringify(fixtureBranch()) : JSON.stringify({ ...fixtureBranch(), extension: 'SECRET_BODY_' + 'x'.repeat(3 * 1024 * 1024) });
    if (mode === 'error') res.statusCode = 500;
    if (mode === 'length' || mode === 'error') res.setHeader('Content-Length', String(Buffer.byteLength(text)));
    if (mode === 'stream') { for (let i = 0; i < text.length; i += 65536) res.write(text.slice(i, i + 65536)); return res.end(); }
    res.end(text);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try { await run(`http://127.0.0.1:${(server.address() as any).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
for (const mode of ['length', 'stream']) test(`real HTTP branch rejects oversized ${mode} before envelope admission`, async () => {
  await withServer(mode, async base => {
    const client = new CatscoLogAgentClient(base);
    await assert.rejects(client.branch({ token: 'synthetic-capability' }), /byte budget/);
  });
});
test('branch HTTP errors cancel body and retain status without copying upstream text', async () => {
  await withServer('error', async base => {
    await assert.rejects(new CatscoLogAgentClient(base).branch({ token: 'synthetic-capability' }), (e: any) => e.status === 500 && !e.message.includes('SECRET_BODY_') && e.payload === undefined);
  });
});
test('bounded branch transport refuses redirects', async () => {
  await withServer('redirect', async base => { await assert.rejects(new CatscoLogAgentClient(base).branch({ token: 'synthetic-capability' }), /fetch failed/); });
});
test('small valid branch response remains usable', async () => {
  await withServer('small', async base => { const response = await new CatscoLogAgentClient(base).branch({ token: 'synthetic-capability' }); assert.equal(response.branches.length, 1); });
});
test('automatic oversized prefetch falls back without remote candidate or evidence', async () => {
  await withServer('stream', async base => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-bound-'));
    fs.mkdirSync(path.join(root, 'data')); fs.writeFileSync(path.join(root, 'data/catsco-log-agent-state.json'), JSON.stringify({ schemaVersion: 1, deviceId: 'synthetic-device', skillToken: 'synthetic-capability', skillTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(), uploaded: {} }));
    const provider = new CatsLogMemoryProvider(root, { env: { CATSCO_LOG_API_BASE_URL: base } });
    const queue = new InMemorySyntheticObservationQueue(); let sawUnavailable = false;
    try {
      const ai = { isToolCallingSupported: () => true, async chat(messages: any[]) {
        sawUnavailable = messages.some(m => { try { return JSON.parse(m.content).status === 'unavailable'; } catch { return false; } });
        return { content: null, toolCalls: [{ id: 'finish', type: 'function', function: { name: 'finish_memory_search', arguments: JSON.stringify({ summary: 'Local-only fallback.', evidence: [], inject: false }) } }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      } };
      await startMemorySidecarBranch({ sessionKey: 'branch-bound', input: 'Use local memory', recentMessages: [], workingDirectory: root, catslogMemory: provider, aiService: ai as any, queue, logEnabled: false }).done;
      assert.equal(sawUnavailable, true); assert.equal(queue.drain().length, 0);
      fs.writeFileSync('/tmp/xiaoba-review-branch-bound-artifact.json', JSON.stringify({ schema: 'xiaoba.review.branch_bound.v1', oversized_prefetch_unavailable: sawUnavailable, observations: 0, external_provider_calls: 0 }), { mode: 0o600 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
