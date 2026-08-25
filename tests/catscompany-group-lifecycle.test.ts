import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { CatsClient, type GroupLifecycleEvent } from '../src/catscompany/client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createClient(): CatsClient {
  return new CatsClient({
    serverUrl: 'ws://127.0.0.1:1',
    httpBaseUrl: 'https://app.example.test',
    apiKey: 'cc-test-key',
    bodyId: 'body-test',
  });
}

describe('CatsCompany group lifecycle', () => {
  test('forwards access-revoked and disbanded presence events', () => {
    const client = createClient();
    const events: GroupLifecycleEvent[] = [];
    client.on('group_lifecycle', event => events.push(event));
    (client as any).subscribedTopics.add('grp_revoked');
    (client as any).subscribedTopics.add('grp_disbanded');

    (client as any).handleMessage({
      pres: { what: 'group_access_revoked', topic: 'grp_revoked', src: 'grp_revoked' },
    });
    (client as any).handleMessage({
      pres: { what: 'group_disbanded', topic: 'grp_disbanded', src: 'grp_disbanded' },
    });

    assert.deepEqual(events, [
      { topic: 'grp_revoked', kind: 'access_revoked' },
      { topic: 'grp_disbanded', kind: 'disbanded' },
    ]);
    assert.equal((client as any).subscribedTopics.size, 0);
  });

  test('reconnect reconciliation terminates only inaccessible tracked groups', async () => {
    const client = createClient();
    const events: GroupLifecycleEvent[] = [];
    client.on('group_lifecycle', event => events.push(event));
    (client as any).subscribedTopics.add('grp_still_member');
    (client as any).subscribedTopics.add('grp_removed_while_offline');
    (client as any).subscribedTopics.add('p2p_1_2');
    globalThis.fetch = (async () => Response.json({
      conversations: [
        { id: 'grp_still_member', is_group: true },
        { id: 'p2p_1_2', is_group: false },
      ],
    })) as any;

    await client.reconcileAccessibleGroupTopics();

    assert.deepEqual(events, [
      { topic: 'grp_removed_while_offline', kind: 'access_revoked' },
    ]);
    assert.deepEqual(
      [...(client as any).subscribedTopics].sort(),
      ['grp_still_member', 'p2p_1_2'],
    );
  });

  test('reconciliation is fail-open when the conversation list is unavailable', async () => {
    const client = createClient();
    const events: GroupLifecycleEvent[] = [];
    client.on('group_lifecycle', event => events.push(event));
    (client as any).subscribedTopics.add('grp_keep_on_network_error');
    globalThis.fetch = (async () => {
      throw new Error('network unavailable');
    }) as any;

    await client.reconcileAccessibleGroupTopics();

    assert.deepEqual(events, []);
    assert.equal((client as any).subscribedTopics.has('grp_keep_on_network_error'), true);
  });
});
