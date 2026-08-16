import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  allObligationsResolvedForCommit,
  completeMissingObligationDispositions,
  validateObligationDispositions,
} from '../src/utils/evidence-review';
import type {
  EvidenceShard,
  ReviewObligation,
} from '../src/utils/evidence-review';

const content = 'immutable review evidence';
const shard: EvidenceShard = {
  shardId: 'shard-1',
  domainKind: 'episode',
  sourceIdentity: 'episode:test',
  contentHash: 'hash-1',
  content,
  byteLength: Buffer.byteLength(content, 'utf8'),
};

const obligation: ReviewObligation = {
  obligationId: 'obligation-1',
  kind: 'unresolved_question',
  summary: 'The verifier must resolve the open question.',
  relatedFindingIds: ['finding-1'],
  requiredShardIds: [shard.shardId],
};

test('missing verifier dispositions are completed as cited deferred outcomes', () => {
  const dispositions = completeMissingObligationDispositions(
    [obligation],
    [],
    [shard],
  );

  assert.equal(dispositions.length, 1);
  assert.equal(dispositions[0].obligationId, obligation.obligationId);
  assert.equal(dispositions[0].decision, 'deferred');
  assert.deepEqual(dispositions[0].citedSpans, [{
    shardId: shard.shardId,
    span: { start: 0, end: shard.byteLength },
  }]);
  assert.equal(validateObligationDispositions([obligation], dispositions, [shard]).ok, true);
  assert.equal(allObligationsResolvedForCommit([obligation], dispositions, [shard]), false);
});

test('runtime does not manufacture a disposition without original shard evidence', () => {
  const dispositions = completeMissingObligationDispositions([obligation], [], []);
  const validation = validateObligationDispositions([obligation], dispositions, []);

  assert.deepEqual(dispositions, []);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.unresolvedObligationIds, [obligation.obligationId]);
});
