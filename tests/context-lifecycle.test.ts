import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotateContextMessage,
  isTransientContextMessage,
  summarizeContextLifecycle,
} from '../src/core/context-lifecycle';
import type { Message } from '../src/types';

function episodeMessages(callText: string, epoch = 'episode-1'): Message[] {
  return [
    annotateContextMessage({ role: 'system', content: 'Stable skill catalog.' }, {
      source: 'skills_list',
      lifecycle: 'session',
      cacheScope: 'stable',
    }),
    annotateContextMessage({ role: 'system', content: 'Episode plan.' }, {
      source: 'plan_status',
      lifecycle: 'episode',
      cacheScope: 'epoch',
      epoch,
    }),
    annotateContextMessage({ role: 'system', content: callText }, {
      source: 'runner_hint',
      lifecycle: 'call',
      cacheScope: 'volatile',
    }),
    { role: 'user', content: 'hello' },
  ];
}

test('typed context lifecycle keeps an episode fingerprint stable across call-only changes', () => {
  const first = summarizeContextLifecycle(episodeMessages('call hint A'))!;
  const second = summarizeContextLifecycle(episodeMessages('call hint B'))!;

  assert.deepEqual(first.lifecycleCounts, { session: 1, episode: 1, call: 1 });
  assert.deepEqual(first.cacheScopeCounts, { stable: 1, epoch: 1, volatile: 1 });
  assert.equal(first.annotatedMessages, 3);
  assert.equal(first.transientMessages, 3);
  assert.equal(first.epochFingerprint, second.epochFingerprint);
  assert.notEqual(first.requestFingerprint, second.requestFingerprint);
  assert.match(first.epochFingerprint || '', /^[a-f0-9]{16}$/);
});

test('a new episode creates a new context epoch fingerprint', () => {
  const first = summarizeContextLifecycle(episodeMessages('same call', 'episode-1'))!;
  const second = summarizeContextLifecycle(episodeMessages('same call', 'episode-2'))!;

  assert.notEqual(first.epochFingerprint, second.epochFingerprint);
  assert.equal(isTransientContextMessage(episodeMessages('same call')[0]), true);
});

test('durable append event metadata remains provider-neutral typed context', () => {
  const message = annotateContextMessage({ role: 'tool', content: 'historical evidence' }, {
    source: 'synthetic_observation',
    lifecycle: 'episode',
    cacheScope: 'epoch',
    persistence: 'durable',
    placement: 'transcript',
    retention: 'append',
    event: {
      id: 'synthetic_observation:memory:0123456789abcdef0123',
      part: 1,
      parts: 2,
    },
    epoch: 'episode:one',
  });

  assert.deepEqual(message.__context, {
    schema: 'xiaoba.context_lifecycle.v1',
    source: 'synthetic_observation',
    lifecycle: 'episode',
    cacheScope: 'epoch',
    persistence: 'durable',
    placement: 'transcript',
    retention: 'append',
    event: {
      id: 'synthetic_observation:memory:0123456789abcdef0123',
      part: 1,
      parts: 2,
    },
    epoch: 'episode:one',
  });
  assert.equal(isTransientContextMessage(message), false);
});
