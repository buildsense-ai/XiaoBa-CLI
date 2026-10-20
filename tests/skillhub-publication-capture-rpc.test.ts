import { afterEach, beforeEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { SkillHubThinRpcHandler, SKILLHUB_THIN_RPC_TOOLS } from '../src/catscompany/skillhub-rpc';
import { CatsCompanyBot, capabilitiesForCatsCompanyRuntimeRole } from '../src/catscompany';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import { withBotSkillWorkspaceLock } from '../src/bot-skills/lock';
import { describePublicationSource } from '../src/skillhub/publication-source';
import { PUBLICATION_CAPTURE, publicationCaptureEnabled, PublicationCaptureStore } from '../src/skillhub/publication-capture';

let root: string, skills: string, source: string, spool: string;
const binding = { botUid: '42', ownerUid: '7', bodyId: 'body-42', installationId: 'install-42' };
const entry = 'pubentry_' + 'a'.repeat(32);
const handler = (options = {}) => new SkillHubThinRpcHandler({
  runtimeRoot: root, publicationProbeEnabled: true, publicationCaptureEnabled: true, ...options,
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-capture-rpc-'));
  skills = path.join(root, 'skills'); source = path.join(skills, 'demo');
  spool = path.join(root, 'data', 'skillhub-publications');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\nprivate-source-text');
  new BotSkillWorkspaceService(root, skills).activate('42');
  createCatsCoLocalConfigService({ runtimeRoot: root }).save({
    version: 1, currentBot: { uid: '42', apiKey: 'private-bot-key', boundByUserUid: '7' },
    account: { uid: '7', username: 'owner', token: 'private-owner-token' },
    device: { bodyId: binding.bodyId, installationId: binding.installationId },
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function request(overrides: Record<string, unknown> = {}): any {
  return { type: 'request', request_id: 'pubcapture_abcdefghijklmnopqrstuvwx', tool_name: PUBLICATION_CAPTURE,
    target_owner_user_id: 'usr7', target_device_id: 'install-42', device_id: 'install-42',
    expires_at: Date.now() + 25_000,
    payload: { entry_id: entry, bot_uid: '42', ...describePublicationSource(skills, source, binding) }, ...overrides };
}
function code(expected: string) {
  return (e: any) => {
    assert.equal(e.code, expected);
    for (const secret of [root, 'private-source-text', 'private-bot-key', 'private-owner-token']) {
      assert.ok(!e.message.includes(secret));
    }
    return true;
  };
}

test('capture capability requires both gates; explicit disabled handlers cannot write', async () => {
  const names = ['XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED', 'XIAOBA_SKILLHUB_PUBLICATION_CAPTURE_ENABLED'];
  const previous = names.map(n => process.env[n]);
  try {
    for (const [probe, capture, enabled] of [
      ['', '', false], ['true', '', false], ['', 'true', false], ['true', 'yes', false],
      ['1', 'true', true], ['TRUE', '1', true],
    ] as const) {
      process.env[names[0]] = probe; process.env[names[1]] = capture;
      assert.equal(publicationCaptureEnabled(), enabled);
      const h = new SkillHubThinRpcHandler({ runtimeRoot: root });
      assert.equal(h.supports(PUBLICATION_CAPTURE), enabled);
      for (const role of ['server', 'desktop'] as const) {
        assert.equal(capabilitiesForCatsCompanyRuntimeRole(role).includes(PUBLICATION_CAPTURE), enabled);
      }
      if (!enabled) await assert.rejects(h.execute(request()), code('publication.runtime_unsupported'));
    }
    for (const options of [{ enabled: false }, { publicationCaptureEnabled: false }, { publicationProbeEnabled: false }]) {
      await assert.rejects(handler(options).execute(request()), code('publication.runtime_unsupported'));
    }
    assert.ok(!Object.values(SKILLHUB_THIN_RPC_TOOLS).includes(PUBLICATION_CAPTURE as any));
    assert.ok(!fs.existsSync(spool));
  } finally {
    names.forEach((n, i) => { if (previous[i] === undefined) delete process.env[n]; else process.env[n] = previous[i]; });
  }
});

test('real RPC freezes raw bytes, returns only six scalars and replays after restart and source removal', async () => {
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---js\nthrow new Error("never run")\n---\nprivate-source-text');
  fs.writeFileSync(path.join(source, 'bytes.bin'), Buffer.from([0, 255, 128]));
  const req = request();
  const receipt = await handler().execute(req);
  assert.deepEqual(Object.keys(receipt).sort(), ['candidateRevision', 'entryId', 'requestBytes', 'requestHash', 'schemaVersion', 'sourceSnapshotHash']);
  assert.ok(Object.values(receipt).every(v => typeof v === 'string' || typeof v === 'number'));
  assert.equal(receipt.entryId, entry);
  const storage = new PublicationCaptureStore({ runtimeRoot: root, enabled: true });
  const input = { entryId: entry, binding, source: { local_skill_id: req.payload.local_skill_id, workspace_generation: req.payload.workspace_generation } };
  const bytes = await storage.readRequest(input, () => {});
  const files = JSON.parse(bytes.toString()).source.files;
  assert.equal(Buffer.from(files.find((f: any) => f.path === 'SKILL.md').contentBase64, 'base64').toString(), fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'));
  assert.ok(!JSON.stringify(receipt).includes('private-source-text'));
  fs.rmSync(source, { recursive: true });
  assert.deepEqual(await handler().execute({ ...req, request_id: 'pubcapture_secondrequestabcdefghijkl' }), receipt);
  assert.deepEqual(await storage.readRequest(input, () => {}), bytes);
  assert.deepEqual(fs.readdirSync(spool), [`${entry}.json`]);
});

test('strict capture envelope rejects user-like IDs, authority substitutions and extra fields', async () => {
  const req = request();
  for (const [patch, expected] of [
    [{ type: 'result' }, 'INVALID_REQUEST'], [{ result: {} }, 'INVALID_REQUEST'],
    [{ error: { code: 'x' } }, 'INVALID_REQUEST'], [{ request_id: 'user-request' }, 'INVALID_REQUEST'],
    [{ request_id: 'pubdelivery_abcdefghijklmnopqrstuvwx' }, 'INVALID_REQUEST'],
    [{ expires_at: Date.now() - 1 }, 'REQUEST_EXPIRED'],
    [{ expires_at: String(Date.now() + 25_000) }, 'INVALID_REQUEST'],
    [{ expires_at: Date.now() + 90_000 }, 'INVALID_REQUEST'],
    [{ target_owner_user_id: 'usr8' }, 'OWNER_MISMATCH'], [{ target_owner_user_id: '7' }, 'OWNER_MISMATCH'],
    [{ target_device_id: 'other' }, 'DEVICE_MISMATCH'], [{ device_id: undefined }, 'DEVICE_MISMATCH'],
    [{ device_id: 'other' }, 'DEVICE_MISMATCH'],
    [{ payload: { ...req.payload, bot_uid: '43' } }, 'BOT_NOT_ACTIVE'],
    [{ payload: { ...req.payload, entry_id: '../escape' } }, 'INVALID_REQUEST'],
    [{ payload: { ...req.payload, local_skill_id: 'local-skill-1' } }, 'INVALID_REQUEST'],
    [{ payload: { ...req.payload, workspace_generation: 'workspace-v1' } }, 'INVALID_REQUEST'],
    [{ payload: { ...req.payload, path: source } }, 'INVALID_REQUEST'],
    [{ payload: { ...req.payload, owner_uid: '7' } }, 'INVALID_REQUEST'],
    [{ payload: { ...req.payload, upload_token: 'secret' } }, 'INVALID_REQUEST'],
  ] as const) {
    await assert.rejects(handler().execute({ ...req, ...patch }), code(expected));
  }
  assert.ok(!fs.existsSync(spool));
});

test('uncaptured changed source is rejected and captured entry cannot be replaced', async () => {
  const h = handler(), req = request();
  fs.appendFileSync(path.join(source, 'SKILL.md'), '\nchanged');
  await assert.rejects(h.execute(req), code('publication.source_changed'));
  const fresh = request();
  const receipt = await h.execute(fresh);
  fs.appendFileSync(path.join(source, 'SKILL.md'), '\nagain');
  await assert.rejects(h.execute(request()), code('publication.capture_conflict'));
  assert.deepEqual(await h.execute(fresh), receipt);
  await assert.rejects(h.execute({ ...fresh, expires_at: Date.now() - 1 }), code('REQUEST_EXPIRED'));
});

test('account fallback, incomplete identity and active connectors cannot capture', async () => {
  const config = createCatsCoLocalConfigService({ runtimeRoot: root });
  const original = config.load(), req = request();
  for (const patch of [
    { currentBot: { ...original.currentBot!, boundByUserUid: undefined } },
    { device: { installationId: binding.installationId } },
    { device: { ...original.device!, connectorToken: 'private-connector-token' } },
  ]) {
    config.save({ ...original, ...patch });
    await assert.rejects(handler().execute(req), code('publication.runtime_unsupported'));
    assert.ok(!fs.existsSync(spool));
  }
});

test('bounded captures recheck owner after waiting for the workspace lock and release slots', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const lock = withBotSkillWorkspaceLock(root, async () => { entered(); await new Promise<void>(r => { release = r; }); });
  await ready;
  const h = handler(), req = request();
  const one = h.execute(req), two = h.execute(req);
  const rejected = Promise.all([one, two].map(p => assert.rejects(p, code('publication.runtime_unavailable'))));
  const config = createCatsCoLocalConfigService({ runtimeRoot: root });
  const original = config.load();
  try {
    await assert.rejects(h.execute(req), code('publication.runtime_unavailable'));
    config.save({ ...original, currentBot: { ...original.currentBot!, boundByUserUid: '8' } });
  } finally { release(); await lock; }
  await rejected;
  assert.ok(!fs.existsSync(spool));
  config.save(original);
  assert.equal((await h.execute(req)).entryId, entry);
});

test('capture shutdown during a lock wait cannot write a candidate', async () => {
  let entered!: () => void, release!: () => void, shutdown = false;
  const ready = new Promise<void>(r => { entered = r; });
  const lock = withBotSkillWorkspaceLock(root, async () => { entered(); await new Promise<void>(r => { release = r; }); });
  await ready;
  const operation = assert.rejects(handler({ isShuttingDown: () => shutdown }).execute(request()), code('publication.runtime_unavailable'));
  shutdown = true;
  release(); await lock; await operation;
  assert.ok(!fs.existsSync(spool));
});

test('expired lock wait and changed body reject capture without retaining a candidate', async t => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const lock = withBotSkillWorkspaceLock(root, async () => { entered(); await new Promise<void>(r => { release = r; }); });
  await ready;
  const h = handler();
  const now = Date.now();
  const operation = assert.rejects(h.execute(request({ expires_at: now + 1_000 })), code('publication.runtime_unavailable'));
  const clock = t.mock.method(Date, 'now', () => now + 2_000);
  release(); await lock;
  await operation;
  clock.mock.restore();
  assert.ok(!fs.existsSync(spool));
  const req = request();
  const config = createCatsCoLocalConfigService({ runtimeRoot: root });
  config.save({ ...config.load(), device: { bodyId: 'other-body', installationId: binding.installationId } });
  await assert.rejects(h.execute(req), code('publication.source_changed'));
  assert.deepEqual(fs.readdirSync(spool), []);
});

test('retained replay checks current owner and workspace; account session is not authority', async () => {
  const h = handler(), req = request();
  const config = createCatsCoLocalConfigService({ runtimeRoot: root });
  const original = config.load();
  config.save({ ...original, account: undefined });
  const receipt = await h.execute(req);
  config.save({ ...original, currentBot: { ...original.currentBot!, boundByUserUid: '8' } });
  await assert.rejects(h.execute(req), code('OWNER_MISMATCH'));
  config.save(original);
  const activePath = path.join(root, 'data', 'bot-skills', 'active.json');
  const active = fs.readFileSync(activePath);
  fs.writeFileSync(activePath, JSON.stringify({ ...JSON.parse(active.toString()), activeBotId: '43' }));
  await assert.rejects(h.execute(req), code('publication.runtime_unavailable'));
  fs.writeFileSync(activePath, active);
  assert.deepEqual(await h.execute(req), receipt);
});

test('adapter reserves capture even when disabled; it never falls back to model tools', async () => {
  const bot = Object.create(CatsCompanyBot.prototype) as any;
  bot.shuttingDown = false;
  bot.skillHubThinRpc = handler({ publicationCaptureEnabled: false });
  bot.executeLocalThinToolRpcTool = () => { throw new Error('generic tool fallback must not run'); };
  let response: any;
  bot.bot = { sendThinToolRpcResult: async (r: any) => { response = r; } };
  await bot.handleThinToolRpcRequest(request());
  assert.equal(response.error.code, 'publication.runtime_unsupported');
  assert.equal(response.result, undefined);
  assert.ok(!fs.existsSync(spool));
  assert.equal(bot.normalizeDeviceRpcOperation(PUBLICATION_CAPTURE), undefined);
});
