import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { MondayMemoryTransport, memoryUploadDestination } from '../src/utils/monday-memory-transport';

async function receiver(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { endpoint: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('defaults to two verified HTTPS names; custom internal endpoints have no implicit public fallback', () => {
  assert.deepEqual(memoryUploadDestination({}), { endpoint: 'https://memory.catsco.cn:18443', fallbackEndpoints: ['https://memory.catsco.cc:18443'] });
  assert.deepEqual(memoryUploadDestination({ XIAOBA_MEMORY_UPLOAD_URL: 'http://10.0.0.11/' }), { endpoint: 'http://10.0.0.11', fallbackEndpoints: [] });
  assert.throws(() => memoryUploadDestination({ XIAOBA_MEMORY_UPLOAD_URL: 'https://example.com/path' }), /invalid Monday memory URL/);
  assert.throws(() => memoryUploadDestination({ XIAOBA_MEMORY_UPLOAD_FALLBACK_URL: 'https://user:pass@example.com' }), /invalid Monday memory URL/);
});

test('switches after a lost POST response, verifies the backup dataset and replays identical bytes without authorization', async () => {
  const accepted: string[] = [], backup: string[] = [];
  let primaryGets = 0, backupGets = 0;
  const primary = await receiver(async (req, res) => {
    if (req.method === 'GET') { primaryGets++; res.end('{"dataset_id":"same"}'); return; }
    assert.equal(req.headers.authorization, undefined);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    accepted.push(Buffer.concat(chunks).toString());
    req.socket.destroy();
  });
  const secondary = await receiver(async (req, res) => {
    if (req.method === 'GET') { backupGets++; res.end('{"dataset_id":"same"}'); return; }
    assert.equal(req.headers.authorization, undefined);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    backup.push(Buffer.concat(chunks).toString());
    res.end('{"next_offset":12}');
  });
  try {
    const transport = new MondayMemoryTransport({ endpoint: primary.endpoint, fallbackEndpoints: [secondary.endpoint] });
    assert.equal(await transport.connect('same'), 'same');
    const body = JSON.stringify({ dataset_id: 'same', source_id: 'unchanged', stream_id: 'unchanged', record_offset: 0 });
    assert.deepEqual(await transport.post('/v1/bots/365/ingest/batches', body), { next_offset: 12 });
    assert.deepEqual(accepted, [body]); assert.deepEqual(backup, [body]);
    assert.equal(backupGets, 1);
    await transport.connect('same');
    assert.equal(primaryGets, 1, 'the failing primary is not retried on every cycle');
  } finally { await primary.close(); await secondary.close(); }
});

test('falls back on an unavailable primary but never posts to a backup with a different dataset', async () => {
  let backupPosts = 0;
  const primary = await receiver((_req, res) => { res.statusCode = 503; res.end('{}'); });
  const secondary = await receiver((req, res) => { if (req.method === 'POST') backupPosts++; res.end('{"dataset_id":"different"}'); });
  try {
    const transport = new MondayMemoryTransport({ endpoint: primary.endpoint, fallbackEndpoints: [secondary.endpoint] });
    await assert.rejects(transport.connect('expected'), /dataset changed/);
    assert.equal(backupPosts, 0);
    await assert.rejects(transport.post('/v1/bots/365/ingest/batches', '{}'), /has not verified/);
  } finally { await primary.close(); await secondary.close(); }
});

test('does not use a backup to bypass request errors, rate limits, invalid JSON or invalid dataset responses', async () => {
  for (const mode of [400, 401, 403, 409, 413, 429, 'json', 'dataset'] as const) {
    let backupRequests = 0;
    const primary = await receiver((_req, res) => {
      res.statusCode = typeof mode === 'number' ? mode : 200;
      res.end(mode === 'json' ? '{' : '{}');
    });
    const secondary = await receiver((_req, res) => { backupRequests++; res.end('{"dataset_id":"same"}'); });
    try {
      const transport = new MondayMemoryTransport({ endpoint: primary.endpoint, fallbackEndpoints: [secondary.endpoint] });
      await assert.rejects(transport.connect('same'));
      assert.equal(backupRequests, 0, String(mode));
    } finally { await primary.close(); await secondary.close(); }
  }
});

test('rejects a backup dataset mismatch after an uncertain POST without sending log content to it', async () => {
  let backupPosts = 0;
  const primary = await receiver((req, res) => { if (req.method === 'GET') res.end('{"dataset_id":"same"}'); else req.socket.destroy(); });
  const secondary = await receiver((req, res) => { if (req.method === 'POST') backupPosts++; res.end('{"dataset_id":"other"}'); });
  try {
    const transport = new MondayMemoryTransport({ endpoint: primary.endpoint, fallbackEndpoints: [secondary.endpoint] });
    await transport.connect('same');
    await assert.rejects(transport.post('/v1/bots/365/ingest/batches', '{"private":"log"}'), /dataset changed/);
    assert.equal(backupPosts, 0);
  } finally { await primary.close(); await secondary.close(); }
});

test('rechecks the primary after backoff and renews backoff if that probe still fails', async context => {
  let now = 1000, healthy = false, primaryGets = 0, primaryPosts = 0;
  context.mock.method(Date, 'now', () => now);
  const primary = await receiver((req, res) => {
    if (req.method === 'GET') primaryGets++; else primaryPosts++;
    res.statusCode = healthy ? 200 : 503;
    res.end(req.method === 'GET' ? '{"dataset_id":"same"}' : '{}');
  });
  const secondary = await receiver((req, res) => res.end(req.method === 'GET' ? '{"dataset_id":"same"}' : '{}'));
  try {
    const transport = new MondayMemoryTransport({ endpoint: primary.endpoint, fallbackEndpoints: [secondary.endpoint] });
    await transport.connect('same');
    now += 15 * 60 * 1000 + 1;
    await transport.connect('same');
    await transport.post('/v1/bots/365/ingest/manifests', '{}');
    assert.equal(primaryGets, 2); assert.equal(primaryPosts, 0);
    healthy = true;
    now += 15 * 60 * 1000 + 1;
    await transport.connect('same');
    await transport.post('/v1/bots/365/ingest/manifests', '{}');
    assert.equal(primaryGets, 3); assert.equal(primaryPosts, 1);
  } finally { await primary.close(); await secondary.close(); }
});
