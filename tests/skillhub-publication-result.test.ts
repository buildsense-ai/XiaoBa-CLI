import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmPublicationResult, publicationFilesMatch, type PublicationProbe } from '../src/skillhub/publication-result';
import { applySkillHubLocalMetadata } from '../src/skillhub/local-skill-metadata';

test('waits through not-ready reads and returns success only after confirmation', async () => {
  let clock = 0, calls = 0, notices = 0;
  const result = await confirmPublicationResult({ now: () => clock, wait: async ms => { clock += ms; },
    probe: async () => ++calls < 3 ? { status: 'unverified', reason: 'not_ready' } : { status: 'published' },
    followUp: async () => { notices++; }, foregroundMs: 10_000 });
  assert.equal(result.status, 'published'); assert.equal(result.following, undefined);
  assert.equal(calls, 3); assert.equal(notices, 0);
});

test('foreground timeout continues read-only follow-up and sends one eventual result', async () => {
  let clock = 0, calls = 0, release!: () => void;
  const resumed = new Promise<void>(resolve => { release = resolve; });
  let delivered!: (result: PublicationProbe) => void;
  const notice = new Promise<PublicationProbe>(resolve => { delivered = resolve; });
  const result = await confirmPublicationResult({ now: () => clock, foregroundMs: 2, backgroundMs: 10,
    wait: async ms => { clock += ms; if (clock > 2) await resumed; },
    probe: async () => ++calls === 1 ? { status: 'unverified', reason: 'not_ready' } : { status: 'published' },
    followUp: async outcome => { delivered(outcome); } });
  assert.equal(result.status, 'unverified'); assert.equal(result.following, true);
  release(); assert.equal((await notice).status, 'published'); assert.equal(calls, 2);
});

test('read failures remain uncertain and background deadline reports uncertainty', async () => {
  let clock = 0, delivered!: (result: PublicationProbe) => void;
  const notice = new Promise<PublicationProbe>(resolve => { delivered = resolve; });
  const result = await confirmPublicationResult({ now: () => clock, foregroundMs: 2, backgroundMs: 3,
    wait: async ms => { clock += ms; }, probe: async () => { throw new Error('offline'); },
    followUp: async outcome => { delivered(outcome); } });
  assert.equal(result.following, true); assert.equal((await notice).status, 'unverified');
});

test('verification failure is terminal and cancellation never schedules a follow-up', async () => {
  let notices = 0, calls = 0;
  const failed = await confirmPublicationResult({ probe: async () => ({ status: 'verification_failed', reason: 'bad_signature' }),
    followUp: async () => { notices++; } });
  assert.equal(failed.status, 'verification_failed'); assert.equal(notices, 0);
  const controller = new AbortController(); controller.abort();
  const stopped = await confirmPublicationResult({ signal: controller.signal,
    probe: async () => { calls++; return { status: 'published' }; }, followUp: async () => { notices++; } });
  assert.equal(stopped.status, 'unverified'); assert.equal(stopped.following, undefined); assert.equal(calls, 0);
});

test('no channel or exhausted retention budget never promises follow-up', async () => {
  for (const options of [{}, { retainedBytes: 65 * 1024 * 1024, followUp: async () => {} }]) {
    const result = await confirmPublicationResult({ ...options, foregroundMs: 0, probe: async () => ({ status: 'published' }) });
    assert.equal(result.status, 'unverified'); assert.equal(result.following, undefined);
  }
});

test('publication content comparison permits tracking metadata, rejects changed body and extra files', () => {
  const raw = '---\nname: sample\ndescription: example\n---\n\nBody\n';
  const source = [{ path: 'SKILL.md', contentBase64: Buffer.from(raw).toString('base64') }];
  const text = applySkillHubLocalMetadata(raw, { author: 'alice', version: '1.0.2', uploadedAt: '2026-11-09T00:00:00.000Z' });
  const file = (value: string) => ({ path: 'SKILL.md', contentBase64: Buffer.from(value).toString('base64'), size: Buffer.byteLength(value), sha256: '' });
  assert.equal(publicationFilesMatch(source, [file(text)], '1.0.2'), true);
  assert.equal(publicationFilesMatch(source, [file(text.replace('Body', 'Changed'))], '1.0.2'), false);
  assert.equal(publicationFilesMatch(source, [file(text)], '1.0.3'), false);
  assert.equal(publicationFilesMatch(source, [file(text), { ...file('extra'), path: 'extra.txt' }], '1.0.2'), false);
});
