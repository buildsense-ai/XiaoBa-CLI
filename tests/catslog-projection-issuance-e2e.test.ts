import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as providers from '../src/utils/catslog-memory-provider';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { fixtureBranch, fixtureRead, fixtureRef } from './helpers/catslog-projection-reference-fixture';

// Deliberately optional until the RED run: baseline accepts by ref alone.
const issuance = (response: unknown): string | undefined => (providers as any).getSourceReferenceIssuance?.(response);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function withProvider(run: (f: any) => Promise<void>, late = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-issuance-'));
  const statePath = path.join(root, 'data/catsco-log-agent-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const state = { schemaVersion: 1, deviceId: 'synthetic-device', skillToken: 'synthetic-A', skillTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(), uploaded: {} };
  const save = (token: string) => fs.writeFileSync(statePath, JSON.stringify({ ...state, skillToken: token }));
  save(state.skillToken);
  const seen = deferred(), release = deferred();
  const requests: Array<{ path?: string; token?: string; body: any }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ path: req.url, token: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/catsco/agent/branch') {
      if (late && req.headers.authorization === 'Bearer synthetic-A') { seen.resolve(); await release.promise; }
      // Even a repeated server request_id cannot alias local issuances.
      return res.end(JSON.stringify(fixtureBranch(fixtureRef(), 'repeated-server-id')));
    }
    if (req.url === '/catsco/agent/knowledge/source/read') return res.end(JSON.stringify(fixtureRead()));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const provider = new providers.CatsLogMemoryProvider(root, { env: { CATSCO_LOG_API_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}` } });
  try { await run({ provider, save, requests, seen, release, root }); }
  finally { release.resolve(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(root, { recursive: true, force: true }); }
}
const read = (provider: any, response: any, ref = fixtureRef()) => provider.readSourceMemoryProjection({ projectionRef: ref, issuanceId: issuance(response) });

test('same ref rediscovered after token rotation keeps old and new issuances separate', async () => {
  await withProvider(async ({ provider, save, requests }: any) => {
    const a = await provider.branch({}); save('synthetic-B'); const b = await provider.branch({});
    await assert.rejects(read(provider, a), /capability changed|issuance/i);
    await read(provider, b);
    const reads = requests.filter((r: any) => r.path.endsWith('/source/read'));
    assert.deepEqual(reads.map((r: any) => r.token), ['Bearer synthetic-B']);
    assert.deepEqual(reads[0].body, { projection_ref: fixtureRef() });
    assert.ok(!JSON.stringify(a).includes(String(issuance(a))));
    assert.notEqual(issuance(a), issuance(b));
  });
});
test('late old discovery cannot invalidate a newer valid issuance', async () => {
  await withProvider(async ({ provider, save, seen, release, requests }: any) => {
    const pending = provider.branch({}); await seen.promise; save('synthetic-B');
    const b = await provider.branch({}); release.resolve(); const a = await pending;
    await assert.rejects(read(provider, a), /capability changed|issuance/i);
    await read(provider, b);
    assert.deepEqual(requests.filter((r: any) => r.path.endsWith('/source/read')).map((r: any) => r.token), ['Bearer synthetic-B']);
  }, true);
});
test('same-token independent issuances both work; missing handle and foreign ref fail before HTTP', async () => {
  await withProvider(async ({ provider, requests }: any) => {
    const a = await provider.branch({}), b = await provider.branch({});
    await read(provider, a); await read(provider, b);
    await assert.rejects(provider.readSourceMemoryProjection({ projectionRef: fixtureRef() }), /issuance|capability changed/i);
    await assert.rejects(read(provider, a, fixtureRef('b'.repeat(64))), /issuance|capability changed/i);
    assert.equal(requests.filter((r: any) => r.path.endsWith('/source/read')).length, 2);
  });
});
test('actual sidecar does not upgrade its original candidate after a replacement-token search', async () => {
  await withProvider(async ({ provider, save, requests, root }: any) => {
    const queue = new InMemorySyntheticObservationQueue(); let turn = 0;
    const inputs: any[] = [];
    const ai = { isToolCallingSupported: () => true, async chat(messages: any[]) {
      inputs.push(messages); turn++;
      let name: string, args: any;
      if (turn === 1) { save('synthetic-B'); name = 'memory_remote_search'; args = { keywords: ['Meridian'] }; }
      else if (turn === 2) { name = 'memory_source_read'; args = { ref: fixtureRef() }; }
      else { name = 'finish_memory_search'; args = { summary: 'Unavailable after identity change.', evidence: [], inject: false }; }
      return { content: null, toolCalls: [{ id: `step-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    } };
    await startMemorySidecarBranch({ sessionKey: 'issuance-e2e', input: 'Recall Meridian', recentMessages: [], workingDirectory: root, aiService: ai as any, catslogMemory: provider, queue, logEnabled: false }).done;
    assert.equal(requests.filter((r: any) => r.path.endsWith('/source/read')).length, 0);
    assert.equal(queue.drain().length, 0);
    assert.ok(!JSON.stringify(inputs).includes('synthetic-A'));
    fs.writeFileSync('/tmp/xiaoba-review-issuance-artifact.json', JSON.stringify({ schema: 'xiaoba.review.issuance.v1', branch_requests: requests.length, source_reads: 0, stale_run_delivered: false, external_provider_calls: 0 }), { mode: 0o600 });
  });
});
