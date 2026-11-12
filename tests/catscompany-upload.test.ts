import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CatsClient } from '../src/catscompany/client';
import { Logger } from '../src/utils/logger';

for (const connectorToken of [undefined, 'connector-secret']) {
  test(`rollback retains authenticated multipart uploads (${connectorToken ? 'connector' : 'API key'})`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cats-upload-rollback-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'attachment.txt');
    fs.writeFileSync(file, 'attachment bytes');
    const logs: string[] = [];
    t.mock.method(Logger, 'info', (message: string) => { logs.push(message); });
    const result = { url: '/uploads/files/attachment.txt?token=do-not-log', name: 'attachment.txt', size: 16 };
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      requests++;
      assert.equal(url, 'https://platform.example/api/upload?type=file');
      assert.equal(init.method, 'POST');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), connectorToken ? 'DeviceConnector connector-secret' : 'ApiKey api-secret');
      assert.match(headers.get('content-type')!, /^multipart\/form-data; boundary=/);
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as any) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      assert.equal(body.length, Number(headers.get('content-length')));
      assert.match(body.toString(), /filename="attachment.txt"/);
      assert.match(body.toString(), /attachment bytes/);
      return Response.json(result);
    });
    const bot = new CatsClient({
      serverUrl: 'wss://platform.example',
      httpBaseUrl: 'https://platform.example',
      apiKey: 'api-secret',
      connectorToken,
    });
    assert.deepEqual(await bot.uploadFile(file), result);
    assert.equal(requests, 1);
    assert.ok(logs.every(line => !line.includes('do-not-log') && !line.includes(result.url)));
  });
}
