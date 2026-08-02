import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import { SessionStore } from '../src/utils/session-store';

test('session persistence roundtrips the durable checkpoint boundary and summary', () => {
  const store = SessionStore.getInstance();
  const sessionKey = `checkpoint-roundtrip-${process.pid}-${Date.now()}`;
  const messages: Message[] = [
    { role: 'system', content: 'reconstructed stable system prompt' },
    {
      role: 'assistant',
      content: '[checkpoint_compaction_boundary] phase=mid_turn episode=episode-roundtrip',
      __checkpointBoundary: true,
      __checkpointPhase: 'mid_turn',
      __episodeId: 'episode-roundtrip',
      __context: {
        schema: 'xiaoba.context_lifecycle.v1',
        source: 'compaction_boundary',
        lifecycle: 'episode',
        cacheScope: 'epoch',
        persistence: 'durable',
        epoch: 'episode-roundtrip',
      },
    },
    {
      role: 'user',
      content: [
        'continuation summary with the unfinished action',
        '[checkpoint_artifact_manifest]',
        'artifact 1/1: {"kind":"image","attachmentRef":"catsco-attachment://release-badge"}',
      ].join('\n'),
      __checkpointSummary: true,
      __checkpointPhase: 'mid_turn',
      __episodeId: 'episode-roundtrip',
      __checkpointArtifacts: [{
        kind: 'image',
        mediaType: 'image/png',
        encodedBytes: 1234,
        sha256: 'a'.repeat(64),
        filePath: '/workspace/evidence/release-badge.png',
        attachmentRef: 'catsco-attachment://release-badge',
        sourceRole: 'tool',
        sourceName: 'inspect_image',
        sourceToolCallId: 'call-image',
      }],
    },
    {
      role: 'system',
      content: 'volatile runtime context',
      __injected: true,
    },
  ];

  try {
    assert.equal(store.saveContext(sessionKey, messages), true);
    const restored = store.loadContext(sessionKey);
    assert.equal(restored.some(message => message.content === 'reconstructed stable system prompt'), false);
    assert.equal(restored.some(message => message.__injected), false);
    assert.deepEqual(restored.map(message => ({
      role: message.role,
      content: message.content,
      boundary: message.__checkpointBoundary === true,
      summary: message.__checkpointSummary === true,
      episode: message.__episodeId,
      artifacts: message.__checkpointArtifacts,
    })), [
      {
        role: 'assistant',
        content: '[checkpoint_compaction_boundary] phase=mid_turn episode=episode-roundtrip',
        boundary: true,
        summary: false,
        episode: 'episode-roundtrip',
        artifacts: undefined,
      },
      {
        role: 'user',
        content: [
          'continuation summary with the unfinished action',
          '[checkpoint_artifact_manifest]',
          'artifact 1/1: {"kind":"image","attachmentRef":"catsco-attachment://release-badge"}',
        ].join('\n'),
        boundary: false,
        summary: true,
        episode: 'episode-roundtrip',
        artifacts: [{
          kind: 'image',
          mediaType: 'image/png',
          encodedBytes: 1234,
          sha256: 'a'.repeat(64),
          filePath: '/workspace/evidence/release-badge.png',
          attachmentRef: 'catsco-attachment://release-badge',
          sourceRole: 'tool',
          sourceName: 'inspect_image',
          sourceToolCallId: 'call-image',
        }],
      },
    ]);
  } finally {
    store.deleteSession(sessionKey);
  }
});
