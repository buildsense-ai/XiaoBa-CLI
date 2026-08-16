import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  LEARNING_EPISODE_SCHEMA_VERSION,
  buildLearningEpisodeCandidate,
  type LearningEpisode,
  type SemanticObservation,
} from '../src/utils/learning-episode';

function makeEpisode(semanticObservations: SemanticObservation[]): LearningEpisode {
  return {
    schemaVersion: LEARNING_EPISODE_SCHEMA_VERSION,
    episodeId: 'episode-review-hints-001',
    runtimeSessionId: 'session-review-hints',
    sourceFilePath: '/logs/sessions/chat/review-hints.jsonl',
    deliveryTurn: 1,
    completionEvidence: [{
      ref: '/logs/sessions/chat/review-hints.jsonl#turn-1:assistant-response',
      sourceFilePath: '/logs/sessions/chat/review-hints.jsonl',
      turn: 1,
      kind: 'assistant-response',
      detail: 'Completed the requested task.',
    }],
    contradictionSignals: [],
    sourceEvidence: [{
      ref: '/logs/sessions/chat/review-hints.jsonl#turn-1:assistant-response',
      role: 'problem-action',
      content: 'User:\nComplete the requested task.\n\nAssistant:\nCompleted the requested task.',
      sourceFilePath: '/logs/sessions/chat/review-hints.jsonl',
      turn: 1,
    }],
    semanticObservations,
    settlementDeadline: '2026-07-24T00:00:00.000Z',
    status: 'eligible',
  } satisfies LearningEpisode;
}

function candidateFor(...values: string[]) {
  return buildLearningEpisodeCandidate(makeEpisode(values.map((value, index) => ({
    kind: 'user-intent',
    value,
    sourceRefs: [`turn-${index + 1}#user-intent`],
  }))));
}

describe('Learning Episode candidate review hints', () => {
  test('preserves dynamic Current Skill inventory boundaries', () => {
    const candidate = candidateFor(
      '列出当前实际注册的 Skills 并交付清单，数量和启用状态来自当前 registry。',
    );

    assert.ok(candidate.boundaries.some(boundary => /single authoritative Current Skill Registry/i.test(boundary)));
    assert.ok(candidate.boundaries.some(boundary => /verify discovered Skill directories.*active\/enabled state/i.test(boundary)));
    assert.ok(candidate.risks.some(risk => /Dynamic inventories may change/i.test(risk)));
  });

  test('preserves investor-transcript analysis boundaries', () => {
    const candidate = candidateFor(
      '分析用户提供的投资者交流会文字稿，区分事实和观点并引用材料边界。',
    );

    assert.ok(candidate.boundaries.some(boundary => /input requirements.*analysis dimensions.*fact\/opinion separation.*citation/i.test(boundary)));
    assert.ok(candidate.risks.some(risk => /investor-transcript analysis/i.test(risk)));
  });

  test('preserves cross-repository mention-gating closure boundaries', () => {
    const candidate = candidateFor(
      '在明确授权下实施双仓群聊 @ 激活的 mention 门控变更，创建 PR 并等待 CI、review 和合并。',
    );

    assert.ok(candidate.boundaries.some(boundary => /explicit current repository authorization.*baseline tests.*structured mention protocol.*review, CI, and merge evidence/i.test(boundary)));
    assert.ok(candidate.risks.some(risk => /does not grant future authority/i.test(risk)));
  });

  test('records explicit email secret and authorization exclusions', () => {
    const candidate = candidateFor(
      '在明确授权和已有登录态下建立并验收 mails.dev 自主收发邮箱。',
    );

    assert.ok(candidate.boundaries.some(boundary => /verification codes.*plaintext secrets.*unauthorized mailboxes/i.test(boundary)));
  });

  test('distinguishes an operation recap from the reusable operation', () => {
    const candidate = candidateFor('编写建立并验收自主收发邮箱能力的历程文档。');

    assert.ok(candidate.boundaries.some(boundary => /delivered document from the transferable operation/i.test(boundary)));
    assert.ok(candidate.risks.some(risk => /report about a capability/i.test(risk)));
  });

  test('does not treat ordinary code analysis as investor-transcript analysis', () => {
    const candidate = candidateFor('分析这个 TypeScript 模块的并发 bug 并修复。');

    assert.ok(!candidate.boundaries.some(boundary => /investor transcript/i.test(boundary)));
    assert.ok(!candidate.risks.some(risk => /investor-transcript analysis/i.test(risk)));
  });

  test('does not treat a generic provided article as investor-transcript evidence', () => {
    const candidate = candidateFor('Analyze the user-provided product article.');

    assert.ok(!candidate.boundaries.some(boundary => /investor transcript/i.test(boundary)));
  });

  test('does not treat ordinary validated report creation as an operation recap', () => {
    const candidate = candidateFor('Create and validate the weekly status report.');

    assert.ok(!candidate.boundaries.some(boundary => /delivered document from the transferable operation/i.test(boundary)));
    assert.ok(!candidate.risks.some(risk => /report about a capability/i.test(risk)));
  });

  test('does not require account access for offline email summarization', () => {
    const candidate = candidateFor('Create a summary from this pasted email.');

    assert.ok(!candidate.boundaries.some(boundary => /credentials\/login state/i.test(boundary)));
    assert.ok(!candidate.risks.some(risk => /does not grant future authority/i.test(risk)));
  });

  test('does not treat an unrelated skill-powered file list as a Current Skill inventory', () => {
    const candidate = candidateFor('Use the extraction skill to list repository files.');

    assert.ok(!candidate.boundaries.some(boundary => /Current Skill Registry/i.test(boundary)));
  });

  test('does not treat a Chinese résumé skill list as a Current Skill inventory', () => {
    const candidate = candidateFor('整理我的求职技能清单。');

    assert.ok(!candidate.boundaries.some(boundary => /Current Skill Registry/i.test(boundary)));
  });

  test('does not treat a personal skills inventory as a Current Skill registry', () => {
    const candidate = candidateFor('Create a personal skills inventory for my résumé.');

    assert.ok(!candidate.boundaries.some(boundary => /Current Skill Registry/i.test(boundary)));
  });

  test('does not impose mention-gating closure on an ordinary repository fix', () => {
    const candidate = candidateFor('Fix this repository bug and run its tests.');

    assert.ok(!candidate.boundaries.some(boundary => /structured mention protocol/i.test(boundary)));
  });

  test('does not impose change closure on a read-only mention-gating review', () => {
    const candidate = candidateFor('Review the cross-repository mention-gating design document.');

    assert.ok(!candidate.boundaries.some(boundary => /structured mention protocol/i.test(boundary)));
  });

  test('scopes negation to its observation instead of suppressing another privileged task', () => {
    const candidate = candidateFor(
      'Summarize this pasted email without accessing an account.',
      'Modify the authorized private repository configuration.',
    );

    assert.ok(candidate.boundaries.some(boundary => /do not inherit access from this episode/i.test(boundary)));
  });

  test('scopes a same-observation email negation away from a private-repository action', () => {
    const candidate = candidateFor(
      'Without accessing email, modify the authorized private repository configuration.',
    );

    assert.ok(candidate.boundaries.some(boundary => /do not inherit access from this episode/i.test(boundary)));
  });

  test('ignores incidental workflow-tool text when classifying user-facing review hints', () => {
    const episode = makeEpisode([
      {
        kind: 'user-intent',
        value: 'Create the release note.',
        sourceRefs: ['turn-1#user-intent'],
      },
      {
        kind: 'workflow-tool',
        value: 'tool result: list current registered Skills and registry entries',
        sourceRefs: ['turn-1#workflow-tool'],
      },
    ]);

    const candidate = buildLearningEpisodeCandidate(episode);

    assert.ok(!candidate.boundaries.some(boundary => /Current Skill Registry/i.test(boundary)));
  });

  test('does not treat a scoped package import as chat mention gating', () => {
    const candidate = candidateFor(
      'Modify the cross-repository import of @scope/package and run tests.',
    );

    assert.ok(!candidate.boundaries.some(boundary => /structured mention protocol/i.test(boundary)));
  });

  test('keeps email safeguards when one action is negated but mailbox access remains positive', () => {
    const candidate = candidateFor(
      'Do not send email yet; access the mailbox and export the messages.',
    );

    assert.ok(candidate.boundaries.some(boundary => /verification codes.*plaintext secrets.*unauthorized mailboxes/i.test(boundary)));
  });

  test('keeps email safeguards when a contrast conjunction introduces mailbox access', () => {
    const candidate = candidateFor(
      'Do not send email yet but access the mailbox and export the messages.',
    );

    assert.ok(candidate.boundaries.some(boundary => /verification codes.*plaintext secrets.*unauthorized mailboxes/i.test(boundary)));
  });

  test('keeps email safeguards after a Chinese contrast conjunction', () => {
    const candidate = candidateFor('不要发送邮件但要访问邮箱并导出消息。');

    assert.ok(candidate.boundaries.some(boundary => /verification codes.*plaintext secrets.*unauthorized mailboxes/i.test(boundary)));
  });

  test('does not treat an OAuth article summary as privileged account work', () => {
    const candidate = candidateFor('Summarize this user-provided article about OAuth security.');

    assert.ok(!candidate.boundaries.some(boundary => /do not inherit access from this episode/i.test(boundary)));
  });

  test('does not treat an offline email sender-field analysis as mailbox access', () => {
    const candidate = candidateFor('Analyze the email sender field from this pasted header.');

    assert.ok(!candidate.boundaries.some(boundary => /verification codes.*plaintext secrets/i.test(boundary)));
  });

  test('does not treat an accessible email report as mailbox access', () => {
    const candidate = candidateFor('Create an accessible email report from this local export.');

    assert.ok(!candidate.boundaries.some(boundary => /verification codes.*plaintext secrets/i.test(boundary)));
  });

  test('does not treat documentation about secret policy as privileged account work', () => {
    const candidate = candidateFor('Document why plaintext secrets are prohibited.');

    assert.ok(!candidate.boundaries.some(boundary => /do not inherit access from this episode/i.test(boundary)));
  });

  test('does not treat a Chinese API-key usage policy as privileged account work', () => {
    const candidate = candidateFor('编写 API 密钥使用规范。');

    assert.ok(!candidate.boundaries.some(boundary => /do not inherit access from this episode/i.test(boundary)));
  });

  test('does not treat a warning against API-key use as privileged account work', () => {
    const candidate = candidateFor('Explain why you should never use API keys.');

    assert.ok(!candidate.boundaries.some(boundary => /do not inherit access from this episode/i.test(boundary)));
  });
});
