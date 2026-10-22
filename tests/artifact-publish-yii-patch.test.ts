import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

// Apply the deliverable patch to the exact installed Yii 1.0.7 CLI, then test
// real HTTP payloads against a loopback mock. Never load production credentials.
let root: string;
let server: http.Server;
let baseURL: string;
let lookupStatus = 404;
let publishStatus = 201;
let lookupID = 'test-app';
const requests: { method: string; body: any }[] = [];
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yii-artifact-patch-'));
  fs.mkdirSync(path.join(root, 'connector'));
  fs.copyFileSync(path.resolve('tests/fixtures/yii-artifact-publish-1.0.7/artifact-cli.mjs'), path.join(root, 'connector/artifact-cli.mjs'));
  execFileSync('git', ['apply', '--include=connector/artifact-cli.mjs', path.resolve('docs/artifact-publish-yii-followup.patch')], { cwd: root });
  fs.writeFileSync(path.join(root, 'connector/credential.mjs'), `export const resolveBotCredential = () => ({baseUrl:process.env.TEST_BASE,botUid:'836'}); export const authHeader = () => ({});`);
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'state/id_ed25519.pub'), 'ssh-ed25519 YWJjZA== test-fixture');
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method!, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      res.writeHead(lookupStatus); res.end(JSON.stringify({ id: lookupID }));
    } else {
      res.writeHead(publishStatus);
      res.end(JSON.stringify(publishStatus === 400 ? { error: 'artifact_source_message_required' } : { id: 'test-app', remote_port: 21000 }));
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
after(async () => {
  if (server) await new Promise<void>(r => server.close(() => r()));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
async function run(source: Record<string, string> = {}, extra: string[] = []) {
  requests.length = 0;
  const env = { ...process.env, TEST_BASE: baseURL, ARTIFACT_STATE_DIR: path.join(root, 'state') };
  delete env.CATSCO_ARTIFACT_SOURCE_TOPIC_ID;
  delete env.CATSCO_ARTIFACT_SOURCE_MESSAGE_ID;
  const child = spawn(process.execPath, [path.join(root, 'connector/artifact-cli.mjs'), 'publish', 'test-app', '测试', '18763', ...extra], { env: { ...env, ...source } });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; }); child.stdout.resume();
  const code = await new Promise<number | null>((r, reject) => { child.on('error', reject); child.on('close', r); });
  return { code, stderr };
}
test('new application sends exact runtime source fields', async () => {
  const result = await run({ CATSCO_ARTIFACT_SOURCE_TOPIC_ID: 'grp_test', CATSCO_ARTIFACT_SOURCE_MESSAGE_ID: '123' });
  assert.equal(result.code, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.source_topic_id, 'grp_test');
  assert.equal(requests[0].body.source_message_id, 123);
});
test('missing source cannot create an app', async () => {
  lookupStatus = 404;
  assert.equal((await run()).code, 2);
  assert.deepEqual(requests.map(r => r.method), ['GET']);
});
test('updates to existing apps need no new source', async () => {
  lookupStatus = 200; lookupID = 'test-app';
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requests.map(r => r.method), ['GET', 'POST']);
  assert.equal(requests[1].body.source_topic_id, undefined);
});
test('lookup failures and mismatched app identities never become a create', async () => {
  for (const status of [401, 403, 500]) {
    lookupStatus = status;
    assert.equal((await run()).code, 1);
    assert.deepEqual(requests.map(r => r.method), ['GET']);
  }
  lookupStatus = 200; lookupID = 'other-app';
  assert.equal((await run()).code, 1);
  assert.deepEqual(requests.map(r => r.method), ['GET']);
});
test('partial, invalid and unsafe integer source is rejected before HTTP', async () => {
  for (const source of [
    { CATSCO_ARTIFACT_SOURCE_TOPIC_ID: 'grp_test' },
    { CATSCO_ARTIFACT_SOURCE_MESSAGE_ID: '123' },
    ...['0', '-1', '1.5', '9007199254740992', 'NaN'].map(value => ({ CATSCO_ARTIFACT_SOURCE_TOPIC_ID: 'grp_test', CATSCO_ARTIFACT_SOURCE_MESSAGE_ID: value })),
  ]) {
    assert.equal((await run(source)).code, 2);
    assert.equal(requests.length, 0);
  }
});
test('source command-line overrides are not accepted', async () => {
  assert.equal((await run({}, ['64', '--source_topic_id', 'forged'])).code, 2);
  assert.equal(requests.length, 0);
});
test('server source rejection is preserved without retry or old-channel fallback', async () => {
  publishStatus = 400;
  const result = await run({ CATSCO_ARTIFACT_SOURCE_TOPIC_ID: 'grp_test', CATSCO_ARTIFACT_SOURCE_MESSAGE_ID: '123' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /artifact_source_message_required/);
  assert.equal(requests.length, 1);
});
