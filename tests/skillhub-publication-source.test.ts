import { afterEach, beforeEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { SkillHubThinRpcHandler, SKILLHUB_THIN_RPC_TOOLS } from '../src/catscompany/skillhub-rpc';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import {
  PUBLICATION_SOURCE_PROBE, PublicationSourceError, describePublicationSource,
  findPublicationSource, publicationSourceProbeEnabled,
} from '../src/skillhub/publication-source';
import { withBotSkillWorkspaceLock } from '../src/bot-skills/lock';
import { capabilitiesForCatsCompanyRuntimeRole } from '../src/catscompany';

let root: string;
let skills: string;
let source: string;
let handler: SkillHubThinRpcHandler;
const binding = { botUid: '42', ownerUid: '7', bodyId: 'body-42', installationId: 'install-42' };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-source-test-'));
  skills = path.join(root, 'skills'); source = path.join(skills, 'demo');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\n# Demo');
  new BotSkillWorkspaceService(root, skills).activate('42');
  createCatsCoLocalConfigService({ runtimeRoot: root }).save({
    version: 1, currentBot: { uid: '42', apiKey: 'test-key', boundByUserUid: '7' },
    account: { uid: '7', token: 'test-token', username: 'owner' },
    device: { bodyId: binding.bodyId, installationId: binding.installationId, deviceId: 'legacy-device' },
  });
  handler = new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function descriptor() { return describePublicationSource(skills, source, binding); }
function request(overrides: Record<string, unknown> = {}): any {
  return {
    type: 'request', request_id: 'pubdelivery_abcdefghijklmnopqrstuvwx',
    target_owner_user_id: 'usr7', target_device_id: binding.installationId,
    device_id: binding.installationId, tool_name: PUBLICATION_SOURCE_PROBE,
    expires_at: Date.now() + 30_000, payload: { bot_uid: '42', ...descriptor() }, ...overrides,
  };
}
const codeIs = (code: string) => (error: any): boolean => {
  assert.equal(error.code, code);
  assert.ok(!error.message.includes(root));
  return true;
};

test('default-off capability and reserved disabled execution', async () => {
  const previous = process.env.XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED;
  try {
    for (const value of ['', 'false', 'yes', '1', 'TRUE']) {
      process.env.XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED = value;
      const enabled = value === '1' || value === 'TRUE';
      assert.equal(publicationSourceProbeEnabled(), enabled);
      const h = new SkillHubThinRpcHandler({ runtimeRoot: root });
      assert.equal(h.supports(PUBLICATION_SOURCE_PROBE), enabled);
      for (const role of ['server', 'desktop'] as const) assert.equal(capabilitiesForCatsCompanyRuntimeRole(role).includes(PUBLICATION_SOURCE_PROBE), enabled);
      if (!enabled) await assert.rejects(h.execute(request()), codeIs('publication.runtime_unsupported'));
    }
  } finally {
    if (previous === undefined) delete process.env.XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED;
    else process.env.XIAOBA_SKILLHUB_PUBLICATION_PROBE_ENABLED = previous;
  }
});

test('listing exposes separate selectors and probe returns only the exact CatsCo receipt', async () => {
  const listed = await handler.execute(request({ request_id: 'list-1', tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace, payload: { bot_uid: '42' } }));
  const item = (listed.skills as any[])[0];
  assert.deepEqual(item.publication_source, descriptor());
  assert.notEqual(item.local_skill_id, item.publication_source.local_skill_id);
  const before = fs.readFileSync(path.join(source, 'SKILL.md'));
  const req = request();
  assert.deepEqual(await handler.execute(req), { schema_version: 1, ...descriptor() });
  // New handler models process restart: no cached listing or receipt required.
  assert.deepEqual(await new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: true }).execute(req), { schema_version: 1, ...descriptor() });
  assert.deepEqual(fs.readFileSync(path.join(source, 'SKILL.md')), before);
  assert.deepEqual(fs.readdirSync(source), ['SKILL.md']);
  const legacy = new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: false });
  const oldListing = await legacy.execute(request({ request_id: 'list-2', tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace, payload: { bot_uid: '42' } }));
  assert.equal((oldListing.skills as any[])[0].publication_source, undefined);
  assert.equal(oldListing.workspace_revision, listed.workspace_revision);
});

test('malformed metadata is not a source rejection and scripts are never executed', async () => {
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: [broken YAML\n---\n');
  const listed = await handler.execute(request({ request_id: 'invalid-list', tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace, payload: { bot_uid: '42' } }));
  const item = (listed.skills as any[])[0];
  assert.equal(item.can_share, false);
  assert.deepEqual(item.publication_source, descriptor());
  // Probe raw bytes directly, including an executable-looking frontmatter tag.
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---js\nthrow new Error("must never execute")\n---\n');
  fs.writeFileSync(path.join(source, 'run.js'), 'throw new Error("must never execute")');
  fs.writeFileSync(path.join(source, 'skill.json'), '{invalid json');
  assert.deepEqual(await handler.execute(request()), { schema_version: 1, ...descriptor() });
});

test('listing resolves the publication binding once for all Skills', async t => {
  for (const name of ['second', 'third']) {
    const dir = path.join(skills, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: demo\n---\n# Demo`);
  }
  const bindingRead = t.mock.method(handler as any, 'publicationBinding');
  const listed = await handler.execute(request({ request_id: 'binding-list', tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace, payload: { bot_uid: '42' } }));
  assert.equal(bindingRead.mock.callCount(), 1);
  assert.equal((listed.skills as any[]).length, 3);
  assert.ok((listed.skills as any[]).every(item => item.publication_source));
});

test('same request ID cannot replay stale content or a changed runtime binding', async () => {
  const req = request();
  await handler.execute(req);
  const id = (req.payload as any).local_skill_id;
  fs.appendFileSync(path.join(source, 'SKILL.md'), '\nchanged');
  assert.equal(descriptor().local_skill_id, id);
  await assert.rejects(handler.execute(req), codeIs('publication.source_changed'));
  const fresh = request(); await handler.execute(fresh);
  const config = createCatsCoLocalConfigService({ runtimeRoot: root });
  config.save({ ...config.load(), device: { bodyId: 'new-body', installationId: binding.installationId } });
  await assert.rejects(handler.execute(fresh), codeIs('publication.source_changed'));
});

test('rejects wrong scope, malformed payloads, expired requests and legacy selectors', async () => {
  const req = request();
  for (const [patch, code] of [
    [{ target_owner_user_id: 'usr8' }, 'OWNER_MISMATCH'],
    [{ target_owner_user_id: '7' }, 'OWNER_MISMATCH'],
    [{ target_device_id: 'other' }, 'DEVICE_MISMATCH'],
    [{ device_id: 'other' }, 'DEVICE_MISMATCH'],
    [{ type: 'result' }, 'INVALID_REQUEST'], [{ result: {} }, 'INVALID_REQUEST'],
    [{ request_id: 'browser-request' }, 'INVALID_REQUEST'],
    [{ expires_at: Date.now() - 1 }, 'REQUEST_EXPIRED'],
    [{ expires_at: Date.now() + 120_000 }, 'INVALID_REQUEST'],
    [{ payload: { ...req.payload, bot_uid: '43' } }, 'BOT_NOT_ACTIVE'],
    [{ payload: { ...req.payload, path: source } }, 'INVALID_REQUEST'],
    [{ payload: { ...req.payload, local_skill_id: '../secret' } }, 'INVALID_REQUEST'],
    [{ payload: { ...req.payload, workspace_generation: 'legacy' } }, 'INVALID_REQUEST'],
  ] as const) {
    await assert.rejects(handler.execute({ ...req, ...patch }), codeIs(code));
  }
  fs.unlinkSync(path.join(source, 'SKILL.md'));
  await assert.rejects(handler.execute(req), codeIs('publication.source_missing'));
});

test('source identity is path-scoped; renamed directories do not redirect requests', async () => {
  const req = request();
  fs.renameSync(source, path.join(skills, 'renamed'));
  await assert.rejects(handler.execute(req), codeIs('publication.source_missing'));
});

test('unsafe links, hardlinks, oversized files and depth fail closed without raw errors', () => {
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'secret');
  const link = path.join(source, 'link');
  fs.symlinkSync(outside, link, 'junction');
  assert.throws(descriptor, codeIs('publication.source_unsafe'));
  fs.unlinkSync(link);
  fs.linkSync(path.join(outside, 'secret'), path.join(source, 'hardlink'));
  assert.throws(descriptor, codeIs('publication.source_unsafe'));
  fs.unlinkSync(path.join(source, 'hardlink'));
  fs.writeFileSync(path.join(source, 'large'), Buffer.alloc(5 * 1024 * 1024 + 1));
  assert.throws(descriptor, codeIs('publication.source_unsafe'));
  fs.unlinkSync(path.join(source, 'large'));
  fs.mkdirSync(path.join(source, ...Array(34).fill('nested')), { recursive: true });
  assert.throws(descriptor, codeIs('publication.source_unsafe'));
});

test('listing and probe share the global discovery budget, including unrelated files', async () => {
  const id = descriptor().local_skill_id;
  assert.equal(findPublicationSource(skills, id, () => {}), source);
  assert.throws(() => findPublicationSource(skills, id, () => { throw new PublicationSourceError('publication.runtime_unavailable'); }), codeIs('publication.runtime_unavailable'));
  const other = path.join(skills, 'other'); fs.mkdirSync(other);
  for (let i = 0; i < 4100; i++) fs.writeFileSync(path.join(other, String(i)), '');
  assert.throws(() => findPublicationSource(skills, id, () => {}), codeIs('publication.source_unsafe'));
  const listed = await handler.execute(request({ request_id: 'large-list', tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace, payload: { bot_uid: '42' } }));
  assert.equal((listed.skills as any[]).length, 1);
  assert.equal((listed.skills as any[])[0].publication_source, undefined);
  assert.equal((listed.skills as any[])[0].publication_source_error, 'publication.source_unsafe');
  await assert.rejects(handler.execute(request()), codeIs('publication.source_unsafe'));
});

test('optional selectors cannot break a legacy entry near the 48 KiB wire limit', async () => {
  const legacy = new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: false });
  const listRequest = (id: string) => request({ request_id: id, tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace, payload: { bot_uid: '42' } });
  const write = (size: number) => fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: demo\ndescription: demo\nskillhub_author: ${'x'.repeat(size)}\n---\n# Demo`);
  write(1);
  const initial = await legacy.execute(listRequest('size-1'));
  write(1 + 48 * 1024 - Buffer.byteLength(JSON.stringify(initial)) - 1);
  const oldPage = await legacy.execute(listRequest('size-2'));
  const newPage = await handler.execute(listRequest('size-3'));
  assert.equal(Buffer.byteLength(JSON.stringify(oldPage)), 48 * 1024 - 1);
  assert.deepEqual(newPage, oldPage);
  assert.equal((newPage.skills as any[])[0].publication_source, undefined);
});

test('optional observations preserve multi-entry legacy pagination and actual wire size', async () => {
  for (let i = 0; i < 120; i++) {
    const dir = path.join(skills, `demo-${i}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: demo-${i}\ndescription: ${'x'.repeat(500)}\n---\n# Demo`);
  }
  const legacy = new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: false });
  let offset = 0;
  let pages = 0;
  do {
    const req = request({ request_id: `page-${offset}`, tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace, payload: { bot_uid: '42', offset } });
    const oldPage = await legacy.execute(req);
    const newPage = await handler.execute(req);
    assert.equal(newPage.next_offset, oldPage.next_offset);
    assert.equal(newPage.workspace_revision, oldPage.workspace_revision);
    assert.ok(Buffer.byteLength(JSON.stringify(newPage)) <= 48 * 1024);
    assert.deepEqual((newPage.skills as any[]).map(({ publication_source, publication_source_error, ...skill }) => skill), oldPage.skills);
    offset = newPage.next_offset as number;
    pages++;
  } while (offset !== null);
  assert.ok(pages > 1);
});

test('optional observations cannot reject a legacy snapshot near 16 MiB', () => {
  const legacy = new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: false });
  const snapshot = (h: SkillHubThinRpcHandler) => (h as any).createWorkspaceSnapshot('42', '42', skills, Date.now());
  // Snapshot canonical serialization retains undefined properties as null.
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, (_key, item) => item === undefined ? null : item));
  const write = (dir: string, size: number) => fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\ndescription: demo\nskillhub_author: ${'x'.repeat(size)}\n---\n# Demo`);
  for (let i = 0; i < 8; i++) {
    const dir = path.join(skills, `large-${i}`);
    fs.mkdirSync(dir);
    write(dir, 1_900_000);
  }
  write(source, 1);
  const initial = snapshot(legacy);
  const size = 1 + 16 * 1024 * 1024 - bytes(initial.skills) - 1;
  write(source, size);
  const oldSnapshot = snapshot(legacy);
  const newSnapshot = snapshot(handler);
  assert.equal(bytes(oldSnapshot.skills), 16 * 1024 * 1024 - 1);
  assert.deepEqual(newSnapshot.skills, oldSnapshot.skills);
  assert.equal(newSnapshot.revision, oldSnapshot.revision);
  write(source, size + 2);
  for (const h of [legacy, handler]) assert.throws(() => snapshot(h), codeIs('WORKSPACE_TOO_LARGE'));
});

test('fingerprint refuses an earlier file changed while later bytes are read', () => {
  fs.writeFileSync(path.join(source, 'a'), 'before');
  fs.writeFileSync(path.join(source, 'z'), Buffer.alloc(128 * 1024));
  let checks = 0;
  let mutated = false;
  assert.throws(() => describePublicationSource(skills, source, binding, () => {
    // Enumeration checks (4), then sorted reads of SKILL.md and a precede z.
    if (++checks === 12) {
      fs.appendFileSync(path.join(source, 'a'), 'after'); mutated = true;
    }
  }), codeIs('publication.source_changed'));
  assert.equal(mutated, true);
});

test('waiting probes have bounded concurrency and recheck binding after the lock', async () => {
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(r => { entered = r; });
  const lock = withBotSkillWorkspaceLock(root, async () => { entered(); await new Promise<void>(r => { release = r; }); });
  await enteredPromise;
  const req = request();
  const one = handler.execute(req);
  const two = handler.execute({ ...req, request_id: 'pubprobe_abcdefghijklmnopqrstuvwx' });
  const rejected = Promise.all([
    assert.rejects(one, codeIs('BOT_NOT_ACTIVE')),
    assert.rejects(two, codeIs('BOT_NOT_ACTIVE')),
  ]);
  try {
    await assert.rejects(handler.execute(req), codeIs('publication.runtime_unavailable'));
    const config = createCatsCoLocalConfigService({ runtimeRoot: root });
    config.save({ ...config.load(), currentBot: { uid: '43', apiKey: 'other', boundByUserUid: '7' } });
  } finally { release(); await lock; }
  await rejected;
});
