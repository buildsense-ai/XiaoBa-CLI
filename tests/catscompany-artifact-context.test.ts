import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { extractCatsCoArtifactContext } from '../src/catscompany/artifact-context';
import { createCatsCoMessageEnvelope } from '../src/catscompany/message-envelope';

function canonicalMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catsco_identity: {
      actor: { user_id: 'usr7' },
      agent: { agent_id: 'usr43', body_id: 'body-cloud' },
      topic: { topic_id: 'p2p_7_43', type: 'p2p', channel_seq: 12 },
      permissions: { source: 'server_canonical_message' },
    },
    artifact_context: {
      contract_version: 'catsco.artifact-context.v1',
      id: 'lesson-game.v2',
      agent_uid: '43',
      title: 'Lesson game',
      kind: 'mini_app',
      url: 'https://agent-43.artifacts.catsco.fun:19991/artifacts/lesson-game.v2/latest/',
      topic_id: 'p2p_7_43',
      currently_visible: true,
      displayed_version: 2,
      latest_version: 3,
      page_context: {
        contract_version: 'catsco.artifact-page-context.v1',
        observed_at: '2026-08-07T12:00:00Z',
        selected_text: '企业客户',
        controls: [
          { type: 'checkbox', name: 'feedback', value: 'f12', checked: true },
          { type: 'password', name: 'secret', value: 'do-not-send' },
        ],
      },
      ...overrides,
    },
  };
}

function canonicalEnvelope(metadata: Record<string, unknown> = canonicalMetadata()) {
  return createCatsCoMessageEnvelope({
    topic: 'p2p_7_43',
    senderId: 'usr7',
    seq: 12,
    text: 'Update this part',
    botUid: 'usr43',
    metadata,
  });
}

describe('extractCatsCoArtifactContext', () => {
  test('returns a scoped read-only context for valid server-canonical metadata', () => {
    const metadata = canonicalMetadata();
    const result = extractCatsCoArtifactContext(metadata, canonicalEnvelope(metadata), '43');

    assert.deepEqual(result, {
      kind: 'catsco_artifact_context',
      source: 'catscompany',
      contractVersion: 'catsco.artifact-context.v1',
      artifactId: 'lesson-game.v2',
      title: 'Lesson game',
      artifactKind: 'mini_app',
      url: 'https://agent-43.artifacts.catsco.fun:19991/artifacts/lesson-game.v2/latest/',
      topicId: 'p2p_7_43',
      agentId: 'usr43',
      currentlyVisible: true,
      displayedVersion: 2,
      latestVersion: 3,
      pageContext: {
        contractVersion: 'catsco.artifact-page-context.v1',
        observedAt: '2026-08-07T12:00:00Z',
        selectedText: '企业客户',
        controls: [{ type: 'checkbox', name: 'feedback', value: 'f12', checked: true }],
      },
      identityTrust: 'server_canonical',
      observationTrust: 'untrusted_content',
    });
  });

  test('ignores unknown fields without exposing them to Runtime', () => {
    const metadata = canonicalMetadata({ ignored_future_field: { anything: true } });
    const context = metadata.artifact_context as Record<string, unknown>;
    context.another_unknown_field = 'not part of the runtime contract';

    const result = extractCatsCoArtifactContext(metadata, canonicalEnvelope(metadata), 'usr43');
    assert.equal(result?.artifactId, 'lesson-game.v2');
    assert.equal('ignored_future_field' in (result as unknown as Record<string, unknown>), false);
    assert.equal('another_unknown_field' in (result as unknown as Record<string, unknown>), false);
  });

  test('drops an invalid page observation without losing trusted Artifact identity', () => {
    const metadata = canonicalMetadata({
      page_context: {
        contract_version: 'catsco.artifact-page-context.v1',
        observed_at: 'not-a-date',
        selected_text: 'ignore',
      },
    });
    const result = extractCatsCoArtifactContext(metadata, canonicalEnvelope(metadata), 'usr43');
    assert.equal(result?.artifactId, 'lesson-game.v2');
    assert.equal(result?.pageContext, undefined);
  });

  test('rejects metadata when createCatsCoMessageEnvelope did not trust identity', () => {
    const metadata = canonicalMetadata();
    const identity = metadata.catsco_identity as Record<string, unknown>;
    const actor = identity.actor as Record<string, unknown>;
    actor.user_id = 'usr999';
    const envelope = canonicalEnvelope(metadata);

    assert.equal(envelope.identityTrust, 'untrusted');
    assert.equal(extractCatsCoArtifactContext(metadata, envelope, 'usr43'), undefined);
  });

  test('rejects an artifact scoped to another agent or a conflicting current bot', () => {
    const wrongArtifactAgent = canonicalMetadata({ agent_uid: 'usr44' });
    assert.equal(extractCatsCoArtifactContext(wrongArtifactAgent, canonicalEnvelope(wrongArtifactAgent), 'usr43'), undefined);

    const valid = canonicalMetadata();
    assert.equal(extractCatsCoArtifactContext(valid, canonicalEnvelope(valid), 'usr44'), undefined);
  });

  test('uses the current bot uid when the canonical envelope has no agent id', () => {
    const metadata = canonicalMetadata();
    const envelope = { ...canonicalEnvelope(metadata), agentId: undefined };

    assert.equal(extractCatsCoArtifactContext(metadata, envelope, '43')?.agentId, 'usr43');
    assert.equal(extractCatsCoArtifactContext(metadata, envelope), undefined);
  });

  test('rejects an artifact scoped to another topic', () => {
    const metadata = canonicalMetadata({ topic_id: 'p2p_8_43' });
    assert.equal(extractCatsCoArtifactContext(metadata, canonicalEnvelope(metadata), 'usr43'), undefined);
  });

  test('rejects unsupported contracts, kinds, hidden artifacts, bad ids and bad urls', () => {
    const invalidOverrides: Record<string, unknown>[] = [
      { contract_version: 'catsco.artifact-context.v2' },
      { contract_version: ' catsco.artifact-context.v1 ' },
      { kind: 'pdf' },
      { currently_visible: false },
      { id: 'Bad Artifact ID' },
      { id: `a${'b'.repeat(64)}` },
      { url: '/artifacts/lesson-game/latest/' },
      { url: 'ftp://example.com/artifact/' },
      { url: 'https://user:password@example.com/artifact/' },
    ];

    for (const overrides of invalidOverrides) {
      const metadata = canonicalMetadata(overrides);
      assert.equal(
        extractCatsCoArtifactContext(metadata, canonicalEnvelope(metadata), 'usr43'),
        undefined,
        JSON.stringify(overrides),
      );
    }
  });

  test('accepts a 64-character exact Artifact id', () => {
    const id = `a${'b'.repeat(63)}`;
    const metadata = canonicalMetadata({ id });
    assert.equal(
      extractCatsCoArtifactContext(metadata, canonicalEnvelope(metadata), 'usr43')?.artifactId,
      id,
    );
  });

  test('rejects structural fields beyond their length limits', () => {
    const invalidOverrides: Record<string, unknown>[] = [
      { title: 't'.repeat(513) },
      { url: `https://example.com/${'a'.repeat(2030)}` },
      { topic_id: 't'.repeat(257) },
      { agent_uid: `agent-${'a'.repeat(123)}` },
    ];

    for (const overrides of invalidOverrides) {
      const metadata = canonicalMetadata(overrides);
      assert.equal(
        extractCatsCoArtifactContext(metadata, canonicalEnvelope(metadata), 'usr43'),
        undefined,
        JSON.stringify(Object.keys(overrides)),
      );
    }
  });

  test('accepts omitted versions and rejects non-positive, fractional, string or unsafe versions', () => {
    const withoutVersions = canonicalMetadata({ displayed_version: undefined, latest_version: undefined });
    const result = extractCatsCoArtifactContext(withoutVersions, canonicalEnvelope(withoutVersions), 'usr43');
    assert.equal(result?.displayedVersion, undefined);
    assert.equal(result?.latestVersion, undefined);

    for (const version of [0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
      const badDisplayed = canonicalMetadata({ displayed_version: version });
      assert.equal(extractCatsCoArtifactContext(badDisplayed, canonicalEnvelope(badDisplayed), 'usr43'), undefined);

      const badLatest = canonicalMetadata({ latest_version: version });
      assert.equal(extractCatsCoArtifactContext(badLatest, canonicalEnvelope(badLatest), 'usr43'), undefined);
    }
  });

  test('requires exact topic matching and accepts normalized numeric agent ids', () => {
    const metadata = canonicalMetadata({ agent_uid: 43, topic_id: 'p2p_7_43' });
    const result = extractCatsCoArtifactContext(metadata, canonicalEnvelope(metadata), 'USR43');
    assert.equal(result?.agentId, 'usr43');

    const paddedTopic = canonicalMetadata({ topic_id: ' p2p_7_43 ' });
    assert.equal(extractCatsCoArtifactContext(paddedTopic, canonicalEnvelope(paddedTopic), 'usr43'), undefined);
  });
});
