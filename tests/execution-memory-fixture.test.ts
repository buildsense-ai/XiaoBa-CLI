import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runExecutionMemoryFixture, decodeSharedRuntime } from '../scripts/execution-memory-fixture';
import { resolveExecutionFixtureConfig } from '../src/core/execution-memory-fixture-config';

const fixtureToken = ['fixture', 'test', 'token'].join('-');
const anchor = { kind: 'source_memory_projection_node' as const, source_projection_ref: `ref_${'a'.repeat(64)}`, revision: 'b'.repeat(64), id: 'c'.repeat(64) };
const validBEnv = (anchorFile: string, directory: string) => ({
  CATSLOG_EXECUTION_FIXTURE_ROLE: 'session_b',
  CATSLOG_EXECUTION_SESSION_ID: 'verification-session-b',
  CATSLOG_EXECUTION_FIXTURE_PATH: path.join(directory, 'session-b.jsonl'),
  CATSLOG_GRAPH_API: 'http://127.0.0.1:43123',
  CATSLOG_GRAPH_TOKEN: fixtureToken,
  CATSLOG_PROJECTION_ANCHOR_FILE: anchorFile,
});

test('session_a config needs no CatsLog URL, token, or anchor', () => {
  const config = resolveExecutionFixtureConfig({
    CATSLOG_EXECUTION_FIXTURE_ROLE: 'session_a',
    CATSLOG_EXECUTION_SESSION_ID: 'session-a-test',
    CATSLOG_EXECUTION_FIXTURE_PATH: '/tmp/session-a-runtime.jsonl',
  });
  assert.equal(config.role, 'session_a');
  assert.equal(config.sessionId, 'session-a-test');
  assert.equal(config.fixturePath, '/tmp/session-a-runtime.jsonl');
  assert.equal(config.baseUrl, undefined);
  assert.equal(config.token, undefined);
  assert.equal(config.anchor, undefined);
});

test('session_b requires authenticated source config and a typed anchor', () => {
  assert.throws(() => resolveExecutionFixtureConfig({
    CATSLOG_EXECUTION_FIXTURE_ROLE: 'session_b',
    CATSLOG_EXECUTION_SESSION_ID: 'session-b-test',
    CATSLOG_EXECUTION_FIXTURE_PATH: '/tmp/session-b-runtime.jsonl',
  }), /base URL, token, and typed projection anchor/i);
});

test('session_b resolves verifier environment aliases and exact typed anchor file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-fixture-config-'));
  try {
    const anchorFile = path.join(directory, 'anchor.json');
    fs.writeFileSync(anchorFile, JSON.stringify(anchor));
    const config = resolveExecutionFixtureConfig(validBEnv(anchorFile, directory));
    assert.equal(config.sessionId, 'verification-session-b');
    assert.equal(config.baseUrl, 'http://127.0.0.1:43123');
    assert.equal(config.anchor?.id, anchor.id);
    assert.equal(config.anchor?.revision, anchor.revision);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('session_b accepts output-prefixed projection anchor IDs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-fixture-config-output-'));
  try {
    const outputAnchor = { ...anchor, id: `output-${'c'.repeat(64)}` };
    const anchorFile = path.join(directory, 'anchor.json');
    fs.writeFileSync(anchorFile, JSON.stringify(outputAnchor));
    const config = resolveExecutionFixtureConfig(validBEnv(anchorFile, directory));
    assert.deepEqual(config.anchor, outputAnchor);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('fixture config rejects unknown roles and malformed anchors', () => {
  assert.throws(() => resolveExecutionFixtureConfig({ CATSLOG_EXECUTION_FIXTURE_ROLE: 'other' }), /role/i);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-fixture-invalid-'));
  try {
    const anchorFile = path.join(directory, 'anchor.json');
    fs.writeFileSync(anchorFile, JSON.stringify({ ...anchor, id: 'not-a-stable-id' }));
    assert.throws(() => resolveExecutionFixtureConfig(validBEnv(anchorFile, directory)), /anchor/i);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('compiled fixture runs A before source publication, then reads and consumes an exact typed node in B', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-fixture-e2e-'));
  const sessionAPath = path.join(directory, 'session-a-runtime.jsonl');
  const sessionAId = `fixture-session-a-${Date.now()}`;
  await runExecutionMemoryFixture({ role: 'session_a', sessionId: sessionAId, fixturePath: sessionAPath });
  const aRows = fs.readFileSync(sessionAPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const aRequests = fs.readFileSync(`${sessionAPath}.requests.jsonl`, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const aPayloads = aRows.map(row => row.event.payload);
  const checkpointIndex = aRows.findIndex(row => row.event.type === 'execution_graph_checkpoint');
  const firstCallIndex = aRows.findIndex(row => row.event.payload?.type === 'successful_model_call');
  assert.ok(checkpointIndex >= 0 && checkpointIndex < firstCallIndex, 'Session A runtime bytes prove persistence before the provider request');
  const aCall = aRequests[0];
  assert.equal(aPayloads[firstCallIndex].input_manifest_encoding, 'shared-input-manifest/1');
  assert.equal(typeof aPayloads[firstCallIndex].input_manifest_epoch, 'string');
  assert.equal(aPayloads[firstCallIndex].input_manifest_reset, true);
  assert.ok(aPayloads[firstCallIndex].input_manifest.items.every((item: any) => item.definition));
  assert.ok(aCall.input_manifest.items.every((item: any) => /^[a-f0-9]{64}$/.test(item.content_sha256)));
  assert.equal(aCall.checkpoint_consumptions.length, 1);
  assert.equal(aCall.checkpoint_consumptions[0].summary_sha256,
    aCall.input_manifest.items.find((item: any) => item.kind === 'checkpoint_summary').content_sha256);
  assert.equal(aPayloads[checkpointIndex].covered_node_refs_complete, false, 'unprovable prior history stays incomplete');

  let sourceReadRequests = 0;
  let receivedAuthorization = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    sourceReadRequests++;
    receivedAuthorization = request.headers.authorization === `Bearer ${fixtureToken}`;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/catsco/agent/knowledge/source/read');
    assert.deepEqual(body.anchor, anchor);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      source: { anchor, status: 'read', role: 'knowledge', speaker: 'knowledge', occurred_at: null,
        text: 'This exact source text stays out of additive metadata.', coverage: 'complete', truncated: false,
        redacted: false, missing: false, revoked: false, conditions: ['preserve the verified condition'],
        omissions: ['no claim beyond the pinned node'] },
      before: [], after: [], before_exhausted: true, after_exhausted: true, context_truncated: false,
      served_at: '2026-11-04T00:00:00.000Z',
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const sessionBPath = path.join(directory, 'session-b-runtime.jsonl');
    const sessionBId = `fixture-session-b-${Date.now()}`;
    await runExecutionMemoryFixture({ role: 'session_b', sessionId: sessionBId, fixturePath: sessionBPath,
      baseUrl: `http://127.0.0.1:${address.port}`, token: fixtureToken, anchor });
    assert.equal(sourceReadRequests, 1);
    assert.equal(receivedAuthorization, true);
    const bRows = fs.readFileSync(sessionBPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const bCalls = fs.readFileSync(`${sessionBPath}.requests.jsonl`, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const decodedRows = decodeSharedRuntime(bRows);
    assert.ok(bRows.some(row => row.event.payload?.input_manifest_encoding === 'shared-input-manifest/1'));
    assert.ok(bRows.some(row => row.event.payload?.input_manifest_reset === true));
    assert.ok(bRows.some(row => row.event.payload?.input_manifest?.items?.some((item: any) => item.ref)));
    assert.ok(decodedRows.filter(row => row.event.payload?.type === 'successful_model_call').every(row =>
      !('input_manifest_encoding' in row.event.payload) && !('input_manifest_epoch' in row.event.payload) && !('input_manifest_reset' in row.event.payload)));
    const compactBytes = fs.readFileSync(sessionBPath).byteLength;
    const fullBytes = Buffer.byteLength(`${decodedRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    const logicalCalls = bCalls;
    const compactCalls = bRows.filter(row => row.event.payload?.type === 'successful_model_call').map(row => row.event.payload);
    const refs = logicalCalls.flatMap((call: any) => call.input_manifest.items.map((item: any) => item.ref)).sort();
    const byteArtifact = {
      encoding: 'shared-input-manifest/1', full_runtime_bytes: fullBytes, shared_runtime_bytes: compactBytes,
      bytes_saved: fullBytes - compactBytes, shared_percent_reduction: Number(((fullBytes - compactBytes) * 100 / fullBytes).toFixed(2)),
      successful_calls: logicalCalls.length,
      logical_input_refs_sha256: refs.map((ref: string) => createHash('sha256').update(ref).digest('hex')).sort(),
      compact_definition_count: compactCalls.reduce((n: number, call: any) => n + call.input_manifest.items.filter((item: any) => item.definition).length, 0),
      compact_reference_count: compactCalls.reduce((n: number, call: any) => n + call.input_manifest.items.filter((item: any) => item.ref).length, 0),
    };
    const reportPath = '/tmp/catslog-three-layer-luna/reports/shared-input-manifest-byte-comparison.json';
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(byteArtifact, null, 2)}\n`, { mode: 0o600 });
    assert.ok(byteArtifact.bytes_saved > 0, 'actual emitted fixture bytes demonstrate sharing');
    assert.equal(new Set(refs).size, new Set(byteArtifact.logical_input_refs_sha256).size, 'decoded ref count matches logical manifest');
    assert.equal(bCalls.length, 2);
    const consumingCall = bCalls[1];
    assert.equal(consumingCall.memory_node_inputs.length, 1);
    const binding = consumingCall.memory_node_inputs[0];
    assert.deepEqual(binding.anchor, anchor);
    assert.equal(binding.input_node_ref, 'provider-result:fixture-exact-source-read');
    assert.equal(consumingCall.input_manifest.items.find((item: any) => item.ref === binding.input_node_ref).sha256, binding.input_sha256);
    assert.equal(typeof consumingCall.model_call_id, 'string');
    assert.ok(fs.existsSync(`${sessionBPath}.graph-summary.sha256`));
    for (const file of [sessionBPath, `${sessionBPath}.turn.jsonl`, `${sessionBPath}.requests.jsonl`, `${sessionBPath}.graph-summary.json`]) {
      const artifact = fs.readFileSync(file, 'utf8');
      const containsSourceText = artifact.includes('This exact source text stays out');
      if (containsSourceText && file.endsWith('.turn.jsonl')) {
        const turnEntries = artifact.trim().split(/\r?\n/).map(line => JSON.parse(line));
        assert.fail(`safe turn output contains source text fields: ${JSON.stringify(turnEntries.map(entry => ({
        entry_type: entry.entry_type, user_has_source: JSON.stringify(entry.user ?? {}).includes('This exact source text stays out'),
        assistant_has_source: JSON.stringify(entry.assistant ?? {}).includes('This exact source text stays out'),
        assistant_fields: Object.fromEntries(Object.entries(entry.assistant ?? {}).map(([key, value]) => [key, {
          type: typeof value, has_source: (JSON.stringify(value) ?? '').includes('This exact source text stays out'),
          array_length: Array.isArray(value) ? value.length : undefined,
        }])),
        })))}`);
      }
      assert.equal(containsSourceText, false, `artifact ${path.basename(file)} excludes source bytes`);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
