import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractCatsCoSkillConnectorGrants } from '../src/catscompany/skill-connector-grants';
import type { ExecutionScope } from '../src/types/session-identity';

describe('CatsCo Skill connector grants', () => {
  test('accepts a live grant only under a trusted canonical CatsCo scope', () => {
    const now = Date.now();
    const metadata = connectorMetadata(now + 60_000);
    const grants = extractCatsCoSkillConnectorGrants(metadata, trustedScope(), now);

    assert.deepEqual(grants, [{
      provider: 'shimo',
      skillId: 'catsco/shimo-reader',
      connectorUrl: 'https://app.catsco.test',
      actorToken: 'opaque-turn-token',
      expiresAt: now + 60_000,
    }]);
  });

  test('rejects grants from untrusted messages, expired grants, and unsafe connector URLs', () => {
    const now = Date.now();
    assert.deepEqual(extractCatsCoSkillConnectorGrants(
      connectorMetadata(now + 60_000),
      { ...trustedScope(), isTrusted: false, identityTrust: 'untrusted' },
      now,
    ), []);
    assert.deepEqual(extractCatsCoSkillConnectorGrants(
      connectorMetadata(now - 1), trustedScope(), now,
    ), []);
    assert.deepEqual(extractCatsCoSkillConnectorGrants({
      ...connectorMetadata(now + 60_000),
      catsco_skill_connectors: {
        schema: 'catsco.skill_connectors.v1',
        grants: [{
          provider: 'shimo',
          skill_id: 'catsco/shimo-reader',
          connector_url: 'http://attacker.example',
          actor_token: 'opaque-turn-token',
          expires_at: new Date(now + 60_000).toISOString(),
        }],
      },
    }, trustedScope(), now), []);
  });

  test('validates every scanned grant before applying the keep-limit', () => {
    const now = Date.now();
    const valid = Array.from({ length: 5 }, (_, index) => ({
      provider: 'shimo',
      skill_id: `catsco/reader-${index}`,
      connector_url: 'https://app.catsco.test',
      actor_token: `opaque-turn-token-${index}`,
      expires_at: new Date(now + 60_000).toISOString(),
    }));

    const grants = extractCatsCoSkillConnectorGrants({
      catsco_skill_connectors: {
        schema: 'catsco.skill_connectors.v1',
        grants: [null, { provider: 'not a provider!' }, ...valid],
      },
    }, trustedScope(), now);

    // Two malformed leading entries must not consume the four-grant budget.
    assert.deepEqual(grants.map(grant => grant.skillId), [
      'catsco/reader-0',
      'catsco/reader-1',
      'catsco/reader-2',
      'catsco/reader-3',
    ]);
  });

  test('lets a later grant supersede an earlier one for the same provider and Skill', () => {
    const now = Date.now();
    const base = {
      provider: 'shimo',
      skill_id: 'catsco/shimo-reader',
      connector_url: 'https://app.catsco.test',
      expires_at: new Date(now + 60_000).toISOString(),
    };

    const grants = extractCatsCoSkillConnectorGrants({
      catsco_skill_connectors: {
        schema: 'catsco.skill_connectors.v1',
        grants: [
          { ...base, actor_token: 'stale-token' },
          { ...base, actor_token: 'fresh-token' },
          {
            ...base,
            skill_id: 'catsco/project-table',
            actor_token: 'other-skill-token',
          },
        ],
      },
    }, trustedScope(), now);

    assert.deepEqual(
      grants.map(grant => [grant.skillId, grant.actorToken]),
      [['catsco/shimo-reader', 'fresh-token'], ['catsco/project-table', 'other-skill-token']],
    );
  });
});

function connectorMetadata(expiresAt: number): Record<string, unknown> {
  return {
    catsco_skill_connectors: {
      schema: 'catsco.skill_connectors.v1',
      grants: [{
        provider: 'shimo',
        skill_id: 'catsco/shimo-reader',
        connector_url: 'https://app.catsco.test',
        actor_token: 'opaque-turn-token',
        expires_at: new Date(expiresAt).toISOString(),
      }],
    },
  };
}

function trustedScope(): ExecutionScope {
  return {
    source: 'catscompany',
    sessionKey: 'cats:p2p:p2p_7_43:actor:usr7:agent:usr43',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId: 'usr7',
    agentId: 'usr43',
    agentBodyId: 'body-cloud',
    identityTrust: 'server_canonical',
    isTrusted: true,
  };
}
