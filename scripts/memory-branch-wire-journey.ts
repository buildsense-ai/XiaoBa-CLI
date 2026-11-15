// Cross-repository E2E peer: the CatsCompany journey starts a real HTTP
// ingestion server, then supplies its URL and the recorded Branch fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MessageSender } from '../src/catscompany/message-sender';
import { CatsSendError } from '../src/catscompany/send-error';
import type { MemoryBranchEvent } from '../src/core/memory-branch-presentation';

async function main() {
  const [base, fixturePath] = process.argv.slice(2);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  let attempts = 0;
  const bot = { async sendStructuredMessage(body: any) {
    attempts++;
    assert.equal(body.type, 'memory_branch');
    assert.equal(body.content.schema, 'catsco.memory_branch.v1');
    throw new CatsSendError('transport', 'scripted socket loss forces the real HTTP fallback');
  } };
  const sender = new MessageSender(bot as any, base, 'synthetic-fixture-key');
  for (const event of fixture.events as MemoryBranchEvent[]) await sender.sendMemoryBranch('p2p_usr275_usr574', event);
  assert.equal(attempts, fixture.events.length);
  console.log(JSON.stringify({ actual_message_sender: true, snapshots: attempts, fallback: 'real HTTP', external_provider_calls: 0 }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
