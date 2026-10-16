import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArtifactCommandPlan } from '../src/bot-skills/artifact-command-plan';
import { resolveTrustedBotSkillScriptInvocation } from '../src/bot-skills/trusted-script-execution';
import { scanLocalBotSkill, writeBotSkillLocalMarker } from '../src/bot-skills/local-manifest';
import { writeSkillHubInstallMarker } from '../src/skillhub/install-marker';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { ShellTool } from '../src/tools/bash-tool';
import type { ToolExecutionContext } from '../src/types/tool';

let root: string, connector: string, output: string, context: ToolExecutionContext;
let previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-plan-'));
  previousRoot = process.env.XIAOBA_USER_DATA_DIR;
  process.env.XIAOBA_USER_DATA_DIR = root;
  const skill = path.join(root, 'skills', 'artifact-publish');
  connector = path.join(skill, 'connector');
  output = path.join(root, 'steps.jsonl');
  fs.mkdirSync(connector, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: artifact-publish\ndescription: fixture\n---\n');
  for (const file of ['init-connector.mjs', 'artifact-cli.mjs']) {
    fs.writeFileSync(path.join(connector, file), `import fs from 'node:fs';
const [output, action, ...args] = process.argv.slice(2);
if (action === 'wait') await new Promise(r => setTimeout(r, 10000));
fs.appendFileSync(output, JSON.stringify({file: ${JSON.stringify(file)}, action, args,
topic: process.env.CATSCO_ARTIFACT_SOURCE_TOPIC_ID, message: process.env.CATSCO_ARTIFACT_SOURCE_MESSAGE_ID})+'\\n');
if (action === 'tamper') fs.appendFileSync(new URL('artifact-cli.mjs', import.meta.url), '\\n// changed');
if (action === 'fail') { console.error('fixture failure'); process.exit(9); }
console.log(action);
`);
  }
  writeSkillHubInstallMarker(skill, {
    source: 'skillhub', userId: '363', skillId: 'yii/artifact-publish', name: 'artifact-publish',
    installName: 'artifact-publish', version: '1.0.8', packageChecksumSha256: 'a'.repeat(64),
    signature: { algorithm: 'ed25519', keyId: 'test', signature: 'fixture' },
    packageUrl: 'https://example.invalid/package', installedAt: new Date(0).toISOString(),
  });
  const local = scanLocalBotSkill(skill, path.dirname(skill));
  const reference = { source: 'skillhub' as const, skillId: 'yii/artifact-publish', version: '1.0.8', contentHash: local.contentHash };
  writeBotSkillLocalMarker(skill, { schema: 'xiaoba.bot-skill-local.v1', localSkillId: local.localSkillId, reference });
  new FileBotDefinitionRepository({ runtimeRoot: root }).writeCache({
    schema: 'xiaoba.bot-definition.v1', botId: '836', model: { kind: 'catalog', modelId: 'test' }, skills: [reference],
  });
  context = {
    workingDirectory: connector, surface: 'catscompany',
    executionScope: { source: 'catscompany', agentId: 'usr836', agentBodyId: 'body-test',
      sessionKey: 'test', actorUserId: 'human', topicId: 'grp_test', topicType: 'group',
      identityTrust: 'server_canonical', isTrusted: true, channelSeq: 123 },
    localDeviceGrant: { kind: 'local_device_grant', source: 'catscompany', bodyId: 'body-test', installationId: 'test', ownerUserId: 'human' },
  };
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
  else process.env.XIAOBA_USER_DATA_DIR = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
const cmd = (script: string, action: string) => `node ${script}.mjs ${JSON.stringify(output)} ${action}`;
const records = () => fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];

test('parses quoting, continuations, CRLF and conditional versus unconditional separators', () => {
  assert.deepEqual(parseArtifactCommandPlan('node x "a && b; c" &&\r\nnode y\nnode z;'), [
    { argv: ['node', 'x', 'a && b; c'], after: 'always' },
    { argv: ['node', 'y'], after: 'success' }, { argv: ['node', 'z'], after: 'always' },
  ]);
  assert.deepEqual(parseArtifactCommandPlan('node x \\\n "title"'), [{ argv: ['node', 'x', 'title'], after: 'always' }]);
  for (const value of ['node x &&', 'node x && ; node y', 'node x | node y', 'node x > out', 'node x &', 'node x $(id)', 'node x `id`', 'node x "unterminated']) {
    assert.equal(parseArtifactCommandPlan(value), undefined, value);
  }
});

test('executes init && publish with source only in the publish child, preserving quoted arguments', async () => {
  const result = await new ShellTool().execute({ command: `${cmd('init-connector', 'init')} && ${cmd('artifact-cli', 'publish')} "title && literal; text"` }, context);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(records(), [
    { file: 'init-connector.mjs', action: 'init', args: [] },
    { file: 'artifact-cli.mjs', action: 'publish', args: ['title && literal; text'], topic: 'grp_test', message: '123' },
  ]);
});

test('runs both artifact commands instead of swallowing the second as argv', async () => {
  const result = await new ShellTool().execute({ command: `${cmd('artifact-cli', 'whoami')} && ${cmd('artifact-cli', 'list')}` }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(records().map(r => r.action), ['whoami', 'list']);
});

test('handles node version and multiline commands through verified execution', async () => {
  const command = `node --version\r\n${cmd('artifact-cli', 'whoami')}\n${cmd('artifact-cli', 'list')}`;
  const decision = resolveTrustedBotSkillScriptInvocation(command, context);
  assert(decision.ok && decision.invocation.steps?.length === 3);
  const result = await new ShellTool().execute({ command }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(records().map(r => r.action), ['whoami', 'list']);
});

test('supports a leading cd and rejects invalid cwd before init runs', async () => {
  let currentDirectory = root;
  const result = await new ShellTool().execute({ command: `cd ${JSON.stringify(connector)} && ${cmd('init-connector', 'init')} && ${cmd('artifact-cli', 'publish')}` }, { ...context, workingDirectory: root, updateCurrentDirectory: d => { currentDirectory = d; } });
  assert.equal(result.ok, true);
  assert.equal(currentDirectory, connector);
  assert.equal(records().length, 2);
  const rejected = await new ShellTool().execute({ command: `cd ${JSON.stringify(connector + '/absent')} && node ../artifact-cli.mjs list` }, context);
  assert.equal(rejected.ok, false);
});

test('short-circuits && on failure and preserves error output', async () => {
  const result = await new ShellTool().execute({ command: `${cmd('init-connector', 'fail')} && ${cmd('artifact-cli', 'publish')}` }, context);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /fixture failure/);
  assert.deepEqual(records().map(r => r.action), ['fail']);
});

test('preserves semicolon/newline continuation semantics rather than treating all separators as &&', async () => {
  const result = await new ShellTool().execute({ command: `${cmd('init-connector', 'fail')} && ${cmd('artifact-cli', 'skipped')};\n${cmd('artifact-cli', 'list')}` }, context);
  assert.equal(result.ok, true);
  assert.deepEqual(records().map(r => r.action), ['fail', 'list']);
});

test('rejects unsupported commands and source overrides before any step runs', async () => {
  for (const suffix of ['node -e "console.log(1)"', 'echo unexpected', 'env CATSCO_ARTIFACT_SOURCE_MESSAGE_ID=999 node artifact-cli.mjs list', 'node artifact-cli.mjs list > output', 'node artifact-cli.mjs list | echo x']) {
    const result = await new ShellTool().execute({ command: `${cmd('init-connector', 'init')} && ${suffix}` }, context);
    assert.equal(result.ok, false, suffix);
    assert.equal(records().length, 0);
  }
});

test('rejects multiline environment overrides instead of ordinary-shell fallback', async () => {
  const result = await new ShellTool().execute({ command: `node --version\nCATSCO_ARTIFACT_SOURCE_MESSAGE_ID=999 ${cmd('artifact-cli', 'publish')}` }, context);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.errorCode, 'PERMISSION_DENIED');
  assert.equal(records().length, 0);
});

test('rechecks package integrity after init before running publish', async () => {
  const result = await new ShellTool().execute({ command: `${cmd('init-connector', 'tamper')} && ${cmd('artifact-cli', 'publish')}` }, context);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /validation/);
  assert.deepEqual(records().map(r => r.action), ['tamper']);
});

test('aborts the entire plan on timeout, including unconditional follow-up steps', async () => {
  const result = await new ShellTool().execute({ command: `${cmd('init-connector', 'wait')}; ${cmd('artifact-cli', 'publish')}`, timeout: 300 }, context);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.errorCode, 'EXECUTION_TIMEOUT');
  assert.equal(records().length, 0);
});

test('cancellation prevents subsequent commands even across a semicolon', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const result = await new ShellTool().execute({ command: `${cmd('init-connector', 'wait')}; ${cmd('artifact-cli', 'publish')}` }, { ...context, abortSignal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(records().length, 0);
  } finally { clearTimeout(timer); }
});

test('different Bot ownership and revoked reference reject the complete plan', async () => {
  const command = `${cmd('init-connector', 'init')} && ${cmd('artifact-cli', 'publish')}`;
  const wrongBot = { ...context, executionScope: { ...context.executionScope!, agentId: 'usr837' } };
  assert.equal((await new ShellTool().execute({ command }, wrongBot)).ok, false);
  new FileBotDefinitionRepository({ runtimeRoot: root }).writeCache({
    schema: 'xiaoba.bot-definition.v1', botId: '836', model: { kind: 'catalog', modelId: 'test' }, skills: [],
  });
  assert.equal((await new ShellTool().execute({ command }, context)).ok, false);
  assert.equal(records().length, 0);
});
