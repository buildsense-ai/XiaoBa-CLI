import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCatsLogProjectionFixture, syntheticProjectionDocument, DEFAULT_ROOT_REF } from './helpers/catslog-projection-fixture';
import { runActualFlow, assertPositiveFlow, poolRef } from './helpers/catslog-projection-harness';
const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = process.env.XIAOBA_PROJECTION_TARGET_ROOT ?? ownRoot;
const question = 'For Meridian, what did we decide about staging, owner approval, the inclusive date boundary, and the withheld metric?';
async function scenario(fixtureOptions: any, runOptions: any, check: (run: any, fixture: any) => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-independent-'));
  const fixture = await startCatsLogProjectionFixture(fixtureOptions);
  const old = process.env.XIAOBA_USER_DATA_DIR;
  process.env.XIAOBA_USER_DATA_DIR = root;
  try {
    const run = await runActualFlow({ targetRoot, root, baseUrl: fixture.baseUrl, token: fixture.token, question, keyword: 'Meridian', signal: AbortSignal.timeout(10_000), ...runOptions,
      ...(runOptions.cancelRead ? { cancelAtRead: fixture.readStarted } : {}) });
    await check(run, fixture);
  } finally {
    if (old === undefined) delete process.env.XIAOBA_USER_DATA_DIR; else process.env.XIAOBA_USER_DATA_DIR = old;
    await fixture.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
function active(run: any) { assert.ok(run.requests.some((r: any) => r.path.endsWith('/branch')), 'actual session remote lane missing [strict RED]'); }
function suppressed(run: any) { active(run); assert.equal(run.delivered.size, 0); assert.equal(run.retained.length, 0); assert.equal(run.observations.length, 0, 'undelivered pool ref injected'); }

test('actual session -> real provider/client HTTP -> full branch and MAIN input; uppercase Go envelope', async () => {
  await scenario({}, {}, (run, fixture) => { assertPositiveFlow(run, question, DEFAULT_ROOT_REF); assert.equal(fixture.bootstraps, 0); });
});
test('natural full question misses literal ILIKE; fake model keyword search discovers and reads an actual ref', async () => {
  await scenario({ hideRecency: true }, { forceSearch: true }, (run, fixture) => {
    assertPositiveFlow(run, question, DEFAULT_ROOT_REF);
    assert.deepEqual(fixture.requests.filter((r: any) => r.path.endsWith('/branch')).map((r: any) => r.body.query_text), ['', 'Meridian']);
    assert.equal(run.branchCalls[0].tools.includes('memory_remote_search'), true);
  });
});
for (const itemKind of ['note', 'episode']) test(`kind spoof ${itemKind} mentioning a valid ref never expands`, async () => {
  await scenario({ itemKind }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); });
});
test('source_reference on a non-agent_memory branch never expands', async () => {
  await scenario({ branchSource: 'skill' }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); });
});
test('source_reference with item.source=skill inside agent_memory never expands', async () => {
  await scenario({ itemSource: 'skill' }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); });
});
for (const advertisedRef of ['https://attacker.invalid/read', 'ref_SHORT', `ref_${'A'.repeat(64)}`, 'file:../../etc/passwd']) test(`unsafe locator ${advertisedRef.slice(0, 30)} never reaches source/read`, async () => {
  await scenario({ advertisedRef }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); });
});
for (const failureStatus of [401, 403, 404, 409, 500]) test(`HTTP ${failureStatus}: explicit reference_only, no injected metadata, bounded calls`, async () => {
  await scenario({ failureStatus }, { citeUndelivered: true }, (run, fixture) => {
    suppressed(run); assert.ok(fixture.reads >= 1 && fixture.reads <= 2);
    const packs = run.branchCalls.map((c: any) => JSON.stringify(c.messages)).join('\n');
    assert.match(packs, /reference_only/); assert.doesNotMatch(packs, /synthetic untrusted server error/);
  });
});
for (const mode of ['stale', 'malformed']) test(`${mode} expansion fails closed after real read`, async () => {
  await scenario({ [mode]: true }, { citeUndelivered: true }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 1); });
});
test('401 on an issued projection never bootstraps/replays the ref under a replacement capability', async () => {
  await scenario({ rotateOnRead: true }, { loginToken: 'synthetic-user-login', citeUndelivered: true }, (run, fixture) => {
    suppressed(run); assert.equal(fixture.bootstraps, 0); assert.equal(fixture.reads, 1);
  });
});
test('token rotation between discovery and read fails closed before HTTP, no cross-identity replay', async () => {
  await scenario({}, { citeUndelivered: true, beforeSourceRead(root: string) {
    const filename = path.join(root, 'data/catsco-log-agent-state.json');
    const state = JSON.parse(fs.readFileSync(filename, 'utf8')); state.skillToken = 'synthetic-replacement-identity';
    fs.writeFileSync(filename, JSON.stringify(state), { mode: 0o600 });
  } }, (run, fixture) => { suppressed(run); assert.equal(fixture.reads, 0); assert.equal(fixture.bootstraps, 0); });
});
test('cancel after actual source/read starts aborts transport, no late observation', async () => {
  await scenario({ delayRead: true }, { cancelRead: true }, (run, fixture) => {
    active(run); assert.equal(fixture.reads, 1); assert.equal(run.observations.length, 0); assert.equal(run.delivered.size, 0);
    assert.ok(run.requests.some((r: any) => r.path.endsWith('/source/read') && r.error_class));
  });
});
test('oversize qualifiers omit the WHOLE view with explicit degradation', async () => {
  const document = syntheticProjectionDocument(); document.conditions = ['alpha'.repeat(1400), 'omega'.repeat(1400), 'zeta'.repeat(1400)];
  await scenario({ document }, { citeUndelivered: true }, (run, fixture) => {
    suppressed(run); assert.equal(fixture.reads, 1);
    const visible = JSON.stringify(run.branchCalls); assert.match(visible, /semantic_view_over_budget/);
    assert.ok(!visible.includes(document.conditions[0]), 'partial view leaked into branch context');
  });
});
test('one shared call/view budget across multiple locators, raw pages excluded', async () => {
  const document = syntheticProjectionDocument(); document.nodes[0].text = 'bounded-node-'.repeat(600);
  await scenario({ count: 6, document }, { readAll: true }, (run, fixture) => {
    assertPositiveFlow(run, question, DEFAULT_ROOT_REF); assert.ok(fixture.reads <= 2);
    assert.ok([...run.delivered.values()].reduce((n: number, v: any) => n + JSON.stringify(v).length, 0) <= 16_000);
    assert.ok(run.delivered.size < fixture.identities.length);
  });
});
for (const finishRef of [`ref_${'b'.repeat(64)}`, 'kb:KB-11111111-1111-1111-1111-111111111111', 'catslog:skill:unopened@1', 'unopened-stream#1']) test(`finish cannot open undeclared grammar/undelivered ref ${finishRef.slice(0, 35)}`, async () => {
  await scenario({}, { finishRef }, run => { active(run); assert.equal(run.observations.length, 0, 'finish widened unrelated ref grammar'); });
});
test('pool refs delivered/retained/cited are subsets of the observed set, not its reverse', async () => {
  await scenario({ count: 6 }, {}, run => {
    assertPositiveFlow(run, question); assert.ok(run.observed.length > run.retained.length);
    for (const ref of [...run.delivered.keys(), ...run.retained.map((e: any) => e.ref), ...run.cited]) assert.ok(poolRef(ref) && run.observed.includes(ref));
  });
});
