// Test-only JSONL bridge. No server connection, real account or upload endpoint.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as assert from 'node:assert/strict';
import * as https from 'node:https';
import { createCatsCoLocalConfigService } from '../../../src/catscompany/local-config';
import { BotSkillWorkspaceService } from '../../../src/bot-skills/workspace';
import { SkillHubThinRpcHandler, SKILLHUB_THIN_RPC_TOOLS } from '../../../src/catscompany/skillhub-rpc';
import { PUBLICATION_SOURCE_PROBE } from '../../../src/skillhub/publication-source';
import { PUBLICATION_CAPTURE } from '../../../src/skillhub/publication-capture';
import { PublicationCandidateUploader } from '../../../src/skillhub/publication-upload';

async function main() {
  const root = process.argv[2];
  if (!root || fs.readdirSync(root).length !== 0) throw new Error('An empty test-owned runtime root is required');
  const source = path.join(root, 'skills', 'paired-demo');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), process.argv[3] === 'malformed'
    ? '---\nname: [broken YAML\n---\n'
    : '---\nname: paired-demo\ndescription: Isolated paired probe fixture\n---\n# Demo');
  // Any accidental script execution would leave evidence in the source tree.
  fs.writeFileSync(path.join(source, 'run.cjs'), 'require("fs").writeFileSync(__dirname + "/EXECUTED", "bad")');
  new BotSkillWorkspaceService(root, path.join(root, 'skills')).activate('42');
  const config = createCatsCoLocalConfigService({ runtimeRoot: root });
  config.save({ version: 1,
    currentBot: { uid: '42', apiKey: 'paired-test-only', boundByUserUid: '7' },
    account: { uid: '7', token: 'paired-test-only', username: 'paired-owner' },
    device: { bodyId: 'body-42', installationId: 'install-42' },
  });
  let handler = new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: true, publicationCaptureEnabled: true });
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const listing = await handler.execute({ type: 'request', request_id: 'paired-list',
    target_owner_user_id: 'usr7', target_device_id: 'install-42',
    tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace, expires_at: Date.now() + 30_000,
    payload: { bot_uid: '42' },
  });
  const item = (listing.skills as any[])[0];
  assert.ok(item?.publication_source);
  send({ source: item.publication_source, supported: handler.supports(PUBLICATION_SOURCE_PROBE),
    capture_supported: handler.supports(PUBLICATION_CAPTURE), can_share: item.can_share });
  const statePath = path.join(root, 'data', 'bot-skills', 'active.json');
  const originalState = fs.readFileSync(statePath, 'utf8');
  // Compare the entire test source tree around each real handler call.
  const files = (dir: string): unknown => fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isDirectory() ? files(file) : fs.readFileSync(file).toString('base64')];
  });
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const input = JSON.parse(line);
    switch (input.action) {
      case 'upload-config': {
        // Test-only local TLS endpoint. Never use production credentials/network.
        const uploader = new PublicationCandidateUploader({
          runtimeRoot: root, enabled: true, issuer: 'https://cats.example', audience: input.origin,
        }, { requestImpl: ((url: any, options: any, callback: any) =>
          https.request(url, { ...options, ca: input.ca }, callback)) as typeof https.request });
        handler = new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: true,
          publicationCaptureEnabled: true, publicationUploadEnabled: true, publicationUploader: uploader });
        break;
      }
      case 'change': fs.appendFileSync(path.join(source, 'SKILL.md'), '\nchanged'); break;
      case 'remove': fs.renameSync(source, path.join(root, 'skills', 'renamed')); break;
      case 'disable': handler = new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: false }); break;
      case 'owner': config.save({ ...config.load(), currentBot: { uid: '42', apiKey: 'paired-test-only', boundByUserUid: '8' } }); break;
      // Simulate the on-disk mismatch seen during switching without changing
      // Skill bytes/identity, so the test can check recovery of the same source.
      case 'switching': fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(originalState), activeBotId: '43' })); break;
      case 'recover':
        fs.writeFileSync(statePath, originalState);
        handler = new SkillHubThinRpcHandler({ runtimeRoot: root, publicationProbeEnabled: true, publicationCaptureEnabled: true });
        break;
      case 'upload':
      case 'capture':
      case 'probe': {
        const before = files(path.join(root, 'skills'));
        const request = input.request;
        const reply: Record<string, unknown> = { type: 'result', request_id: request.request_id,
          tool_name: request.tool_name, target_owner_user_id: request.target_owner_user_id,
          target_device_id: request.target_device_id, device_id: request.device_id };
        try { reply.result = await handler.execute(request); }
        catch (error: any) { reply.error = { code: error.code, message: error.message }; }
        assert.deepEqual(files(path.join(root, 'skills')), before, 'Publication RPC changed source files');
        send({ reply });
        continue;
      }
      default: throw new Error('Unknown fixture action');
    }
    send({ ok: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
