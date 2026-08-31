import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import type {
  BotSkillAppliedMarker,
  BotSkillActivationAckInspection,
  BotSkillActivationJournal,
} from '../src/bot-skills/activation-state';
import {
  BotSkillActivationAckWorker,
  isBotSkillActivationAckWorkerEnabled,
} from '../src/bot-skills/activation-ack-worker';

describe('Bot Skill activation ACK worker E3', () => {
  test('is disabled unless the dedicated flag is explicitly true', () => {
    assert.equal(isBotSkillActivationAckWorkerEnabled({}), false);
    assert.equal(isBotSkillActivationAckWorkerEnabled({
      XIAOBA_SKILL_MUTATION_ACTIVATION_ACK_WORKER_ENABLED: 'false',
    }), false);
    assert.equal(isBotSkillActivationAckWorkerEnabled({
      XIAOBA_SKILL_MUTATION_ACTIVATION_ACK_WORKER_ENABLED: ' TRUE ',
    }), true);
  });

  test('ACKs only a locally applied journal and persists acked after an exact response', async () => {
    const fixture = createFixture();
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), init };
      return activationResponse(fixture.journal);
    }) as typeof fetch;
    const worker = createWorker(fixture, { fetchImpl });

    const result = await worker.pollOnce();

    assert.deepEqual(result, { status: 'acked', mutationId: '101' });
    assert.equal(fixture.markAckedCalls, 1);
    assert.equal(captured?.url, 'https://app.catsco.cc/api/bot/skill-mutations/101/activation');
    const headers = captured?.init?.headers as Record<string, string>;
    assert.equal(headers['X-CatsCo-Runtime-Credential'], 'runtime-credential');
    assert.equal(headers['X-API-Key'], undefined);
    assert.deepEqual(JSON.parse(String(captured?.init?.body)), {
      appliedDefinitionRevision: 12,
      skillSetHash: fixture.journal.skillSetHash,
      result: 'applied',
    });
    assert.equal(String(captured?.init?.body).includes('body-prod-1'), false);
    assert.equal(String(captured?.init?.body).includes('skillsRoot'), false);
  });

  test('retries a lost ACK with backoff and relies on server idempotency', async () => {
    const fixture = createFixture();
    let now = 1_000;
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      if (requests === 1) throw new Error('network unavailable');
      return activationResponse(fixture.journal, true);
    }) as typeof fetch;
    const worker = createWorker(fixture, { fetchImpl, now: () => now });

    assert.deepEqual(await worker.pollOnce(), {
      status: 'retry_scheduled', warningCode: 'ACK_RETRYABLE', mutationId: '101',
    });
    assert.equal(fixture.markAckedCalls, 0);
    assert.equal((await worker.pollOnce()).status, 'backoff');
    assert.equal(requests, 1);

    now += 5_000;
    assert.equal((await worker.pollOnce()).status, 'acked');
    assert.equal(requests, 2);
    assert.equal(fixture.markAckedCalls, 1);
  });

  test('coalesces concurrent polls into one Runtime-authenticated ACK request', async () => {
    const fixture = createFixture();
    let requests = 0;
    let release!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    const worker = createWorker(fixture, {
      fetchImpl: (async () => {
        requests += 1;
        return response;
      }) as typeof fetch,
    });

    const first = worker.pollOnce();
    const second = worker.pollOnce();
    assert.equal(first, second);
    release(activationResponse(fixture.journal));
    assert.equal((await first).status, 'acked');
    assert.equal((await second).status, 'acked');
    assert.equal(requests, 1);
    assert.equal(fixture.markAckedCalls, 1);
  });

  test('never marks acked when Runtime identity or server facts conflict', async () => {
    const wrongBody = createFixture({ runtimeBodyIdHash: crypto.createHash('sha256').update('other-body').digest('hex') });
    let requests = 0;
    const identityWorker = createWorker(wrongBody, {
      fetchImpl: (async () => {
        requests += 1;
        return activationResponse(wrongBody.journal);
      }) as typeof fetch,
    });
    assert.deepEqual(await identityWorker.pollOnce(), {
      status: 'blocked', warningCode: 'RUNTIME_IDENTITY_MISMATCH', mutationId: '101',
    });
    assert.equal(requests, 0);
    assert.equal(wrongBody.markAckedCalls, 0);

    const conflict = createFixture();
    const conflictWorker = createWorker(conflict, {
      fetchImpl: (async () => new Response('{}', { status: 409 })) as typeof fetch,
    });
    assert.deepEqual(await conflictWorker.pollOnce(), {
      status: 'blocked', warningCode: 'ACTIVATION_FACT_CONFLICT', mutationId: '101',
    });
    assert.equal(conflict.markAckedCalls, 0);

    const wrongResponse = createFixture();
    const wrongResponseWorker = createWorker(wrongResponse, {
      fetchImpl: (async () => new Response(JSON.stringify({
        mutation_id: 101,
        status: 'active',
        applied_definition_revision: 13,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    });
    assert.deepEqual(await wrongResponseWorker.pollOnce(), {
      status: 'blocked', warningCode: 'ACK_RESPONSE_INVALID', mutationId: '101',
    });
    assert.equal(wrongResponse.markAckedCalls, 0);
  });

  test('does not ACK a journal that still needs local apply or has invalid evidence', async () => {
    const pending = createFixture({ recoveryStatus: 'resume_local_apply' });
    let requests = 0;
    const pendingWorker = createWorker(pending, {
      fetchImpl: (async () => {
        requests += 1;
        return activationResponse(pending.journal);
      }) as typeof fetch,
    });
    assert.deepEqual(await pendingWorker.pollOnce(), { status: 'local_apply_pending' });
    assert.equal(requests, 0);

    const invalid = createFixture({ recoverError: true });
    const invalidWorker = createWorker(invalid, {
      fetchImpl: (async () => {
        requests += 1;
        return activationResponse(invalid.journal);
      }) as typeof fetch,
    });
    assert.deepEqual(await invalidWorker.pollOnce(), {
      status: 'blocked', warningCode: 'STATE_INVALID', mutationId: undefined,
    });
    assert.equal(requests, 0);
  });
});

interface FixtureOptions {
  runtimeBodyIdHash?: string;
  recoveryStatus?: 'retry_ack' | 'resume_local_apply';
  recoverError?: boolean;
}

function createFixture(options: FixtureOptions = {}) {
  const bodyIdHash = options.runtimeBodyIdHash
    ?? crypto.createHash('sha256').update('body-prod-1').digest('hex');
  const journal: BotSkillActivationJournal = {
    schema: 'xiaoba.bot-skill-activation-journal.v2' as BotSkillActivationJournal['schema'],
    botId: '42',
    skillsRoot: 'C:\\runtime\\skills',
    stage: 'C:\\runtime\\.bot-skills-stage-101',
    backup: 'C:\\runtime\\.bot-skills-backup-101',
    skills: [],
    phase: options.recoveryStatus === 'resume_local_apply' ? 'live_switched' : 'locally_applied',
    definitionRevision: 12,
    skillSetHash: crypto.createHash('sha256').update('[]').digest('hex'),
    mutationId: '101',
    runtimeBodyIdHash: bodyIdHash,
    startedAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:01.000Z',
  };
  const marker: BotSkillAppliedMarker = {
    schema: 'xiaoba.bot-skill-applied.v1' as BotSkillAppliedMarker['schema'],
    botId: journal.botId,
    definitionRevision: journal.definitionRevision,
    skillSetHash: journal.skillSetHash,
    mutationId: journal.mutationId,
    runtimeBodyIdHash: journal.runtimeBodyIdHash,
    skills: journal.skills,
    appliedAt: '2026-08-26T00:00:01.000Z',
  };
  const fixture = {
    journal,
    markAckedCalls: 0,
    store: {
      inspectForAck(): BotSkillActivationAckInspection {
        if (options.recoverError) throw new Error('unsafe path should not be exposed');
        return options.recoveryStatus === 'resume_local_apply'
          ? { status: 'not_ready', journal }
          : { status: 'retry_ack', journal, marker };
      },
      markAcked(): BotSkillActivationJournal {
        fixture.markAckedCalls += 1;
        return { ...journal, phase: 'acked' };
      },
    },
  };
  return fixture;
}

function createWorker(
  fixture: ReturnType<typeof createFixture>,
  overrides: Partial<ConstructorParameters<typeof BotSkillActivationAckWorker>[0]> = {},
): BotSkillActivationAckWorker {
  return new BotSkillActivationAckWorker({
    runtimeRoot: 'C:\\runtime',
    skillsRoot: fixture.journal.skillsRoot,
    botId: '42',
    bodyId: 'body-prod-1',
    installationId: 'install-prod-1',
    activationAckCredential: 'runtime-credential',
    httpBaseUrl: 'https://app.catsco.cc/',
    stateStore: fixture.store,
    pollIntervalMs: 5_000,
    ...overrides,
  });
}

function activationResponse(journal: BotSkillActivationJournal, idempotent = false): Response {
  return new Response(JSON.stringify({
    mutation_id: 101,
    status: 'active',
    applied_definition_revision: journal.definitionRevision,
    desired_definition_revision: journal.definitionRevision,
    idempotent,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
