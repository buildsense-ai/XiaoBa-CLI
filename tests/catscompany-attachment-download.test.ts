import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ReadableStream } from 'node:stream/web';
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

for (const connectorToken of [undefined, 'private-connector-token']) {
  test(`legacy relative and absolute uploads stay anonymous (${connectorToken ? 'connector' : 'API key'})`, async t => {
    const requests: Array<{ url: string; auth: string | undefined }> = [];
    const base = await serve(t, (req, res) => {
      requests.push({ url: req.url!, auth: req.headers.authorization });
      assert.equal(req.headers['x-api-key'], undefined);
      assert.equal(req.headers['x-catsco-runtime-credential'], undefined);
      res.end('legacy attachment');
    });
    const sender = new MessageSender(client(base, connectorToken), undefined, 'unused-sender-key');
    const target = destination(t);
    for (const url of ['/uploads/files/legacy.txt?token=signed', `${base}/uploads/images/legacy.png`]) {
      const targetPath = url.startsWith('http') ? path.relative(process.cwd(), target) : target;
      assert.equal(await sender.downloadFile(url, 'old-name.txt', { targetPath }), target);
      assert.equal(fs.readFileSync(target, 'utf8'), 'legacy attachment');
      assert.deepEqual(fs.readdirSync(path.dirname(target)), ['saved.txt']);
    }
    assert.deepEqual(requests, [
      { url: '/uploads/files/legacy.txt?token=signed', auth: undefined },
      { url: '/uploads/images/legacy.png', auth: undefined },
    ]);
  });
}

test('external URLs and explicit sender base overrides remain anonymous', async t => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const external = await serve(t, (req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers['x-catsco-runtime-credential'], undefined);
    res.end('public');
  });
  const sender = new MessageSender(client(), external, 'sender-secret');
  const target = destination(t);
  assert.equal(await sender.downloadFile(`${external}/uploads/public.txt?preview=1`, 'public.txt', { targetPath: target }), target);
  assert.equal(await sender.downloadFile('/uploads/public.txt', 'public.txt', { targetPath: target }), target);
  assert.deepEqual(seen, [
    { url: '/uploads/public.txt?preview=1', auth: undefined },
    { url: '/uploads/public.txt', auth: undefined },
  ]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'public');
});

test('uses plain legacy fetch without Authorization, message_id hints or private download options', async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    requests.push(url);
    assert.equal(init, undefined);
    return new Response('legacy');
  });
  const sender = new MessageSender(client('https://platform.example', 'connector-secret'), undefined, 'sender-secret');
  const target = destination(t);
  for (const url of ['/uploads/a?preview=1', 'https://platform.example/uploads/b', 'https://external.example/c?signature=signed']) {
    // Even an old untyped caller cannot opt back into the reverted historical hint.
    assert.equal(await sender.downloadFile(url, 'a', { targetPath: target, messageId: 42 } as any), target);
  }
  assert.deepEqual(requests, [
    'https://platform.example/uploads/a?preview=1',
    'https://platform.example/uploads/b',
    'https://external.example/c?signature=signed',
  ]);
  assert.equal('fetchAttachment' in client(), false);
});

test('legacy automatic redirects remain anonymous on both origins', async t => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const external = await serve(t, (req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    res.end('redirected');
  });
  const base = await serve(t, (req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    res.writeHead(302, { location: `${external}/uploads/end?signature=signed` });
    res.end();
  });
  const target = destination(t);
  assert.equal(await new MessageSender(client(base, 'connector-secret')).downloadFile('/uploads/start', 'a', { targetPath: target }), target);
  assert.deepEqual(seen, [
    { url: '/uploads/start', auth: undefined },
    { url: '/uploads/end?signature=signed', auth: undefined },
  ]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'redirected');
});

test('preserves default directory, basename and relative targetPath without leaving temporary files', async t => {
  const cwd = process.cwd();
  const root = path.dirname(path.dirname(destination(t)));
  process.chdir(root);
  try {
    const expected = path.join(root, 'tmp', 'downloads', '12345_old.txt');
    t.mock.method(Date, 'now', () => 12345);
    t.mock.method(globalThis, 'fetch', async () => new Response('legacy'));
    const sender = new MessageSender(client());
    assert.equal(await sender.downloadFile('/uploads/a', '../old.txt'), expected);
    assert.equal(await sender.downloadFile('/uploads/a', 'ignored.txt', {
      targetPath: path.join('tmp', 'downloads', '12345_old.txt'),
    }), expected);
    assert.equal(fs.readFileSync(expected, 'utf8'), 'legacy');
    assert.deepEqual(fs.readdirSync(path.dirname(expected)), ['12345_old.txt']);
  } finally {
    process.chdir(cwd);
  }
});

test('HTTP and fetch errors preserve the target, clean up and redact signed source URLs', async t => {
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

test('body read failures return null without replacing a target or leaking URL credentials', async t => {
  const logs: string[] = [];
  t.mock.method(Logger, 'error', (message: string) => { logs.push(message); });
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('partial'));
      controller.error(new Error('interrupted https://platform.example/uploads/a?token=do-not-log'));
    },
  })));
  const target = destination(t);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'existing file');
  assert.equal(await new MessageSender(client()).downloadFile('/uploads/a', 'a', { targetPath: target }), null);
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing file');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['saved.txt']);
  assert.ok(logs.every(line => !line.includes('do-not-log') && !line.includes('https://')));
});

test('rename failure removes the written part file and preserves the existing target directory', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('legacy'));
  const target = destination(t);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'existing.txt'), 'keep');
  assert.equal(await new MessageSender(client()).downloadFile('/uploads/a', 'a', { targetPath: target }), null);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['saved.txt']);
  assert.equal(fs.readFileSync(path.join(target, 'existing.txt'), 'utf8'), 'keep');
});

test('successful upload and download logs do not disclose source URLs or signed query credentials', async t => {
  const logs: string[] = [];
  t.mock.method(Logger, 'info', (message: string) => { logs.push(message); });
  const signed = 'https://platform.example/uploads/a?token=do-not-log';
  const target = destination(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('legacy'));
  const bot = client();
  t.mock.method(bot, 'uploadFile', async () => ({ url: signed, name: 'a.txt', size: 6 }));
  t.mock.method(bot, 'sendStructuredMessage', async () => 123);
  const sender = new MessageSender(bot);
  assert.equal(await sender.downloadFile(signed, 'a.txt', { targetPath: target }), target);
  await sender.sendFile('grp_42', target, 'a.txt');
  assert.ok(logs.some(line => line.includes('文件上传成功')));
  assert.ok(logs.some(line => line.includes('文件已下载')));
  assert.ok(logs.every(line => !line.includes('do-not-log') && !line.includes('https://')));
});
