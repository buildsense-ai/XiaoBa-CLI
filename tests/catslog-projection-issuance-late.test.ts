import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as providers from '../src/utils/catslog-memory-provider';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { startMemorySidecarBranch } from '../src/core/sidecar-memory-branch';
import { InMemorySyntheticObservationQueue } from '../src/core/synthetic-observation';
import { fixtureBranch, fixtureRead, fixtureRef } from './helpers/catslog-projection-reference-fixture';

// Failure modes, declared before the behaviour they guard:
//
// F1 A branch discovery issued under capability A that resolves AFTER the state
//    rotated to capability B must register nothing. The read path pins every ref
//    to the token and base it was discovered under, so a stale registration makes
//    a ref look issued while every read of it fails.
// F2 That stale discovery must not invalidate a newer valid issuance of the SAME
//    ref. Before the guard, A's late response overwrote the map entry and the ref
//    discovered under B stopped being readable.
// F3 The automatic memory branch must not upgrade its original candidate after a
//    replacement-token search: zero source/read requests, zero observations, and
//    no stale token anywhere in the model inputs.
// F4 A failed capability read keeps its status and a short machine error code;
//    the upstream body never reaches the message, and a body with no machine code
//    leaves no payload at all.

const REF = fixtureRef();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

interface Fixture {
  provider: any;
  save: (token: string) => void;
  requests: any[];
  root: string;
  releaseStale: () => void;
}

async function withProvider(
  run: (fixture: Fixture) => Promise<void>,
  options: { holdFirstBranch?: boolean } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-issuance-late-'));
  const statePath = path.join(root, 'data/catsco-log-agent-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const base = {
    schemaVersion: 1, deviceId: 'synthetic-device', skillToken: 'synthetic-A',
    skillTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), uploaded: {},
  };
  const save = (token: string) => fs.writeFileSync(statePath, JSON.stringify({ ...base, skillToken: token }));
  save(base.skillToken);
  const seen = deferred();
  const released = deferred();
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ path: req.url, token: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/catsco/agent/branch') {
      if (options.holdFirstBranch && req.headers.authorization === 'Bearer synthetic-A') {
        seen.resolve();
        await released.promise;
      }
      return res.end(JSON.stringify(fixtureBranch(REF, 'repeated-server-id')));
    }
    if (req.url === '/catsco/agent/knowledge/source/read') return res.end(JSON.stringify(fixtureRead()));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const provider = new providers.CatsLogMemoryProvider(root, {
    env: { CATSCO_LOG_API_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}` },
  });
  try {
    await run({ provider, save, requests, root, releaseStale: () => released.resolve() });
  } finally {
    released.resolve();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const readRef = (provider: any) => provider.readSourceMemoryProjection({ projectionRef: REF });

test('F1/F2 a late discovery from a replaced capability registers nothing and keeps the newer issuance readable', async () => {
  await withProvider(async ({ provider, save, requests, releaseStale }) => {
    const staleDiscovery = provider.branch({});
    await new Promise(r => setTimeout(r, 50));
    save('synthetic-B');
    await provider.branch({});
    await readRef(provider);
    releaseStale();
    await staleDiscovery;
    await readRef(provider);
    const reads = requests.filter(request => String(request.path).endsWith('/source/read'));
    assert.equal(reads.length, 2, 'both reads used the current issuance');
    assert.deepEqual(reads.map(request => request.token), ['Bearer synthetic-B', 'Bearer synthetic-B']);
    assert.deepEqual(reads[0].body, { projection_ref: REF });
    const staleTokenWrites = reads.filter(request => request.token === 'Bearer synthetic-A');
    assert.equal(staleTokenWrites.length, 0, 'a replaced capability never reached the read route');
  }, { holdFirstBranch: true });
});

test('F3 the branch does not upgrade its candidate after a replacement-token search', async () => {
  await withProvider(async ({ provider, save, requests, root }) => {
    const queue = new InMemorySyntheticObservationQueue();
    const inputs: any[] = [];
    let turn = 0;
    const ai = {
      isToolCallingSupported: () => true,
      async chat(messages: any[]) {
        inputs.push(messages);
        turn++;
        let name: string;
        let args: any;
        if (turn === 1) { name = 'memory_remote_search'; args = { keywords: ['Meridian'] }; }
        else if (turn === 2) { save('synthetic-B'); name = 'memory_source_read'; args = { ref: REF }; }
        else { name = 'finish_memory_search'; args = { summary: 'Unavailable after identity change.', evidence: [], inject: false }; }
        return {
          content: null,
          toolCalls: [{ id: `step-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };
    await startMemorySidecarBranch({
      sessionKey: 'issuance-late', input: 'Recall Meridian', recentMessages: [], workingDirectory: root,
      aiService: ai as any, catslogMemory: provider, queue, logEnabled: false,
    }).done;
    const reads = requests.filter(request => String(request.path).endsWith('/source/read'));
    const observations = queue.drain();
    assert.equal(reads.length, 0, 'the stale candidate must not be read');
    assert.equal(observations.length, 0, 'no observation may be delivered');
    assert.equal(JSON.stringify(inputs).includes('synthetic-A'), false, 'stale token reached model input');
    fs.writeFileSync('/tmp/xiaoba-review-issuance-late-artifact.json', JSON.stringify({
      schema: 'xiaoba.review.issuance_late.v1',
      branch_requests: requests.filter(request => String(request.path).endsWith('/branch')).length,
      source_reads: reads.length,
      observations_delivered: observations.length,
      stale_token_in_model_input: false,
      external_provider_calls: 0,
    }, null, 2), { mode: 0o600 });
  });
});

test('F4 failed capability reads keep a machine code and never echo the upstream body', async () => {
  const bodies = [
    { status: 500, body: JSON.stringify({ extension: 'SECRET_BODY_' + 'x'.repeat(4096) }) },
    { status: 404, body: JSON.stringify({ error: 'not_found' }) },
  ];
  for (const mode of bodies) {
    const server = http.createServer((req, res) => {
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = mode.status;
      res.end(mode.body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as any).port}`;
      const error: any = await new CatscoLogAgentClient(base)
        .branch({ token: 'synthetic-capability' }).then(() => null, (e: any) => e);
      assert.ok(error, 'a failed branch read must reject');
      assert.equal(error.status, mode.status);
      assert.equal(error.message.includes('SECRET_BODY_'), false, 'upstream body leaked into the message');
      const parsed = JSON.parse(mode.body);
      if (parsed.error) assert.deepEqual(error.payload, { error: parsed.error });
      else assert.equal(error.payload, undefined, 'unbounded error text must not be retained as payload');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    }
  }
});
