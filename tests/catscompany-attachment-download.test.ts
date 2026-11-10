import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ReadableStream } from 'node:stream/web';
import type { TestContext } from 'node:test';
import { CatsClient } from '../src/catscompany/client';
import { MessageSender } from '../src/catscompany/message-sender';
import { Logger } from '../src/utils/logger';

async function serve(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function client(base = 'https://platform.example', connectorToken?: string): CatsClient {
  return new CatsClient({
    serverUrl: base.replace(/^http/, 'ws'),
    httpBaseUrl: base,
    apiKey: 'private-api-key',
    connectorToken,
  });
}

function destination(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cats-attachment-download-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'saved.txt');
}

for (const identity of ['ApiKey private-api-key', 'DeviceConnector private-connector-token']) {
  test(`downloads legacy relative and absolute uploads with ${identity.split(' ')[0]}`, async t => {
    const requests: Array<{ url: string; auth: string | undefined }> = [];
    const base = await serve(t, (req, res) => {
      requests.push({ url: req.url!, auth: req.headers.authorization });
      res.end('private attachment');
    });
    const bot = client(base, identity.startsWith('DeviceConnector') ? 'private-connector-token' : undefined);
    // An explicit sender URL or key must never replace the client's trusted origin or identity.
    const sender = new MessageSender(bot, base, 'unused-sender-key');
    const target = destination(t);
    for (const url of ['/uploads/files/legacy.txt?token=signed', `${base}/uploads/images/legacy.png`]) {
      const targetPath = url.startsWith('http') ? path.relative(process.cwd(), target) : target;
      assert.equal(await sender.downloadFile(url, 'old-name.txt', { targetPath }), target);
      assert.equal(fs.readFileSync(target, 'utf8'), 'private attachment');
      assert.deepEqual(fs.readdirSync(path.dirname(target)), ['saved.txt']);
    }
    assert.deepEqual(requests, [
      { url: '/uploads/files/legacy.txt?token=signed', auth: identity },
      { url: '/uploads/images/legacy.png', auth: identity },
    ]);
  });
}

test('keeps external attachments anonymous even with a sender base override', async t => {
  const seen: Array<string | undefined> = [];
  const external = await serve(t, (req, res) => {
    seen.push(req.headers.authorization);
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers['x-catsco-runtime-credential'], undefined);
    res.end('public');
  });
  const sender = new MessageSender(client(), external, 'sender-secret');
  const target = destination(t);
  assert.equal(await sender.downloadFile(`${external}/uploads/public.txt`, 'public.txt', { targetPath: target }), target);
  assert.equal(await sender.downloadFile('/uploads/public.txt', 'public.txt', { targetPath: target }), target);
  assert.deepEqual(seen, [undefined, undefined]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'public');
});

test('only authenticates the exact platform origin and uploads path', async t => {
  const requests: Array<{ url: string; auth: string | null }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, auth: new Headers(init.headers).get('authorization') });
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    return new Response('ok');
  });
  const bot = client();
  for (const url of [
    'https://platform.example/uploads/a',
    'https://platform.example/api/a',
    'https://platform.example/uploads-evil/a',
    'https://platform.example/uploads/../api/a',
    'https://platform.example/uploads/%2e%2e/api/a',
    'https://platform.example/uploads/%2f..%2fapi/a',
    'https://platform.example/uploads/%252e%252e/api/a',
    'https://platform.example.evil/uploads/a',
    'https://evil.example/uploads/a',
    'https://platform.example:444/uploads/a',
    'http://platform.example/uploads/a',
  ]) {
    const response = await bot.fetchAttachment(url, AbortSignal.timeout(1000));
    await response.body?.cancel();
  }
  assert.equal(requests[0].auth, 'ApiKey private-api-key');
  assert.ok(requests.slice(1).every(request => request.auth === null));
  for (const url of ['file:///uploads/a', 'https://user:secret@platform.example/uploads/a']) {
    await assert.rejects(bot.fetchAttachment(url, AbortSignal.timeout(1000)), /Unsupported attachment URL/);
  }
  assert.equal(requests.length, 11);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`follows ${status} within uploads and strips credentials on cross-origin redirects`, async t => {
    const seen: Array<{ scope: string; auth: string | undefined }> = [];
    const external = await serve(t, (req, res) => {
      seen.push({ scope: 'external', auth: req.headers.authorization });
      res.end('redirected attachment');
    });
    const base = await serve(t, (req, res) => {
      seen.push({ scope: req.url!, auth: req.headers.authorization });
      res.writeHead(status, { Location: req.url === '/uploads/start' ? '/uploads/next' : `${external}/uploads/end` });
      res.end();
    });
    const target = destination(t);
    assert.equal(await new MessageSender(client(base, 'private-connector-token')).downloadFile(
      '/uploads/start', 'redirect.txt', { targetPath: target },
    ), target);
    assert.deepEqual(seen, [
      { scope: '/uploads/start', auth: 'DeviceConnector private-connector-token' },
      { scope: '/uploads/next', auth: 'DeviceConnector private-connector-token' },
      { scope: 'external', auth: undefined },
    ]);
    assert.equal(fs.readFileSync(target, 'utf8'), 'redirected attachment');
  });
}

test('redirects cannot gain or regain credentials after leaving trusted uploads', async t => {
  for (const locations of [
    ['https://external.example/a', 'https://platform.example/uploads/end'],
    ['https://platform.example/api/a', 'https://platform.example/uploads/end'],
  ]) {
    const seen: Array<string | null> = [];
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('authorization'));
      return seen.length <= locations.length
        ? new Response(null, { status: 302, headers: { location: locations[seen.length - 1] } })
        : new Response('ok');
    });
    const response = await client().fetchAttachment('https://platform.example/uploads/start', AbortSignal.timeout(1000));
    await response.body?.cancel();
    assert.deepEqual(seen, ['ApiKey private-api-key', null, null]);
    t.mock.restoreAll();
  }
  const seen: Array<string | null> = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers).get('authorization'));
    return seen.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://platform.example/uploads/end' } })
      : new Response('ok');
  });
  const response = await client().fetchAttachment('https://external.example/start', AbortSignal.timeout(1000));
  await response.body?.cancel();
  assert.deepEqual(seen, [null, null]);
});

test('bounds redirect loops and cancels intermediate response bodies', async t => {
  let requests = 0;
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      status: 302, headers: { location: '/uploads/loop' },
    });
  });
  await assert.rejects(client().fetchAttachment('https://platform.example/uploads/loop', AbortSignal.timeout(1000)), /Too many/);
  assert.equal(requests, 6);
  assert.equal(cancelled, 6);
});

test('preserves default download directory, basename, and relative targetPath behavior', async t => {
  const expected = path.join(process.cwd(), 'tmp', 'downloads', '12345_old.txt');
  t.after(() => fs.rmSync(expected, { force: true }));
  t.mock.method(Date, 'now', () => 12345);
  t.mock.method(globalThis, 'fetch', async () => new Response('legacy'));
  assert.equal(await new MessageSender(client()).downloadFile('/uploads/a', '../old.txt'), expected);
  assert.equal(await new MessageSender(client()).downloadFile('/uploads/a', 'ignored.txt', {
    targetPath: path.join('tmp', 'downloads', '12345_old.txt'),
  }), expected);
  assert.equal(fs.readFileSync(expected, 'utf8'), 'legacy');
});

test('HTTP and fetch errors return null without logging signed URLs', async t => {
  const logs: string[] = [];
  t.mock.method(Logger, 'error', (message: string) => { logs.push(message); });
  const target = destination(t);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'existing file');
  const signed = 'https://platform.example/uploads/a?token=do-not-log';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('forbidden', { status: 403 }));
  const sender = new MessageSender(client());
  assert.equal(await sender.downloadFile(signed, 'a', { targetPath: target }), null);
  fetchMock.mock.mockImplementation(async () => { throw new Error(`failure fetching ${signed}`); });
  assert.equal(await sender.downloadFile(signed, 'a', { targetPath: target }), null);
  assert.ok(logs.some(line => line.includes('HTTP 403')));
  assert.ok(logs.every(line => !line.includes('do-not-log') && !line.includes('https://')));
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing file');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['saved.txt']);
});

test('rejects declared sizes above 300 MiB before writing a temporary file', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': String(300 * 1024 * 1024 + 1) } }));
  const target = destination(t);
  assert.equal(await new MessageSender(client()).downloadFile('/uploads/large', 'large', { targetPath: target }), null);
  assert.equal(cancelled, true);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
});

test('enforces the streaming limit even when the declared length is smaller and cleans partial files', async t => {
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  let chunks = 0;
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
      if (++chunks === 100) controller.close();
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': '1' } }));
  const target = destination(t);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'existing file');
  assert.equal(await new MessageSender(client()).downloadFile('/uploads/large', 'large', { targetPath: target }), null);
  assert.ok(chunks >= 76);
  assert.equal(cancelled, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing file');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['saved.txt']);
});

test('uses one two-minute timeout through redirects and body consumption, cleaning a stalled part file', async t => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    deadlines.push(ms);
    return originalTimeout(100);
  });
  let bodyStarted = false;
  const base = await serve(t, (req, res) => {
    if (req.url === '/uploads/start') {
      res.writeHead(302, { location: '/uploads/stalled' });
      res.end();
    } else {
      bodyStarted = true;
      res.writeHead(200);
      res.write('partial');
    }
  });
  const target = destination(t);
  assert.equal(await new MessageSender(client(base)).downloadFile('/uploads/start', 'stalled', { targetPath: target }), null);
  assert.ok(deadlines.includes(120_000));
  assert.equal(bodyStarted, true);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), []);
});

test('cleans temporary files on a stream failure without replacing the target', async t => {
  let pulls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      if (++pulls === 1) controller.enqueue(Buffer.from('partial'));
      else controller.error(new Error('interrupted stream'));
    },
  })));
  const target = destination(t);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'existing file');
  assert.equal(await new MessageSender(client()).downloadFile('/uploads/a', 'a', { targetPath: target }), null);
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing file');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['saved.txt']);
});

test('historical repair hint is sent only to trusted platform uploads', async t => {
  const requests: Array<{ url: string; auth?: string }> = [];
  const base = await serve(t, (req, res) => {
    requests.push({ url: req.url!, auth: req.headers.authorization });
    res.end('private bytes');
  });
  const bot = client(base);
  const sender = new MessageSender(bot, base, 'unused-sender-key');
  assert.equal(await sender.downloadFile('/uploads/files/legacy.txt?preview=1', 'old.txt', {
    targetPath: destination(t), messageId: 42,
  }) !== null, true);
  assert.equal(requests[0].url, '/uploads/files/legacy.txt?preview=1&message_id=42');
  assert.equal(requests[0].auth, 'ApiKey private-api-key');
  await (await bot.fetchAttachment(`${base}/external/file.txt`, AbortSignal.timeout(1000), 42)).body?.cancel();
  assert.equal(requests[1].url, '/external/file.txt');
  assert.equal(requests[1].auth, undefined);
});
