import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BOT_DEFINITION_SCHEMA } from '../src/bot-definition/types';
import {
  BotDefinitionCloudError,
  HttpBotDefinitionCloudClient,
} from '../src/bot-skills/definition-cloud';
import { HttpBotPrivateSkillPackageClient } from '../src/bot-skills/http-private-package';
import { BotSkillRuntime, type BotSkillRuntimeSyncOutcome } from '../src/bot-skills/runtime';
import { BOT_SKILL_WORKSPACE_IDENTITY_FILE } from '../src/bot-skills/workspace';

const catsCoBaseUrl = requiredEnv('BOT_SKILL_E2E_CATSCO_BASE_URL');
const skillHubBaseUrl = requiredEnv('BOT_SKILL_E2E_SKILLHUB_BASE_URL');
const botId = requiredEnv('BOT_SKILL_E2E_BOT_ID');
const apiKey = requiredEnv('BOT_SKILL_E2E_API_KEY');
const disposableConfirmation = requiredEnv('BOT_SKILL_E2E_CONFIRM_DISPOSABLE_BOT');
assertLoopbackBaseUrl(catsCoBaseUrl, 'BOT_SKILL_E2E_CATSCO_BASE_URL');
assertLoopbackBaseUrl(skillHubBaseUrl, 'BOT_SKILL_E2E_SKILLHUB_BASE_URL');
if (disposableConfirmation !== 'YES_MUTATE_DISPOSABLE_BOT') {
  throw new Error(
    'BOT_SKILL_E2E_CONFIRM_DISPOSABLE_BOT must be YES_MUTATE_DISPOSABLE_BOT',
  );
}
const keepRoots = /^(1|true|yes)$/i.test(process.env.BOT_SKILL_E2E_KEEP_ROOTS || '');

const auth = {
  httpBaseUrl: catsCoBaseUrl,
  serverUrl: `${catsCoBaseUrl.replace(/^http/, 'ws')}/v0/channels`,
  botUid: botId,
  apiKey,
};
const definitionForCreate = {
  schema: BOT_DEFINITION_SCHEMA,
  botId,
  model: { kind: 'catalog' as const, modelId: 'local' },
};
const packages = new HttpBotPrivateSkillPackageClient({
  baseUrl: skillHubBaseUrl,
  botId,
  apiKey,
  allowInsecureHttp: true,
});
const cloud = new HttpBotDefinitionCloudClient({
  botId,
  auth,
  allowInsecureHttp: true,
});
const deviceARoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-live-a-'));
const deviceBRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-bot-skill-live-b-'));
const steps: Array<Record<string, unknown>> = [];

function runtime(runtimeRoot: string): BotSkillRuntime {
  return new BotSkillRuntime({
    runtimeRoot,
    auth,
    skillHubBaseUrl,
    packages,
    debounceMs: 60_000,
  });
}

function writeSkill(runtimeRoot: string, name: string, body: string): void {
  const directory = path.join(runtimeRoot, 'skills', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} live e2e`,
    '---',
    '',
    body,
    '',
  ].join('\n'));
}

function appendSkill(runtimeRoot: string, name: string, body: string): void {
  fs.appendFileSync(path.join(runtimeRoot, 'skills', name, 'SKILL.md'), `\n${body}\n`);
}

function readSkill(runtimeRoot: string, name: string): string {
  return fs.readFileSync(path.join(runtimeRoot, 'skills', name, 'SKILL.md'), 'utf8');
}

function record(name: string, outcome: BotSkillRuntimeSyncOutcome): void {
  steps.push({
    name,
    action: outcome.result.action,
    reason: outcome.result.reason,
    blockedSkills: outcome.result.blockedSkills?.map(item => ({
      name: item.name,
      code: item.code,
      relativePaths: item.relativePaths,
    })),
    skills: outcome.definition?.skills,
  });
}

async function main(): Promise<void> {
  const initialCloud = await cloud.read();
  assert.equal(
    initialCloud.kind === 'missing' || initialCloud.definition.skills === undefined,
    true,
    'live E2E requires a disposable Bot with either a missing or legacy Cloud Definition',
  );
  const initialMode = initialCloud.kind === 'missing' ? 'fresh' : 'legacy-revision-zero';

  let deviceA = runtime(deviceARoot);
  const created = await deviceA.sync({
    definitionForCreate,
    allowNewWorkspaceCreate: true,
  });
  record('definition-initialize', created);
  assert.equal(created.result.action, 'created_cloud');
  assert.deepStrictEqual(created.definition?.skills, []);
  const nonSkillFields = {
    model: initialCloud.kind === 'found' ? initialCloud.definition.model : created.definition?.model,
    prompt: initialCloud.kind === 'found' ? initialCloud.definition.prompt : created.definition?.prompt,
  };
  assert.deepStrictEqual({
    model: created.definition?.model,
    prompt: created.definition?.prompt,
  }, nonSkillFields);
  const migratedCloud = await cloud.read();
  assert.equal(migratedCloud.kind, 'found');
  if (migratedCloud.kind !== 'found') return;
  assert.deepStrictEqual(migratedCloud.definition.skills, []);
  const staleEtag = initialCloud.kind === 'found' ? initialCloud.etag : migratedCloud.etag;

  await deviceA.mutate(() => writeSkill(deviceARoot, 'alpha', 'initial local content'));
  const initialUpload = await deviceA.flush();
  assert.ok(initialUpload);
  record('initial-upload', initialUpload);
  assert.equal(initialUpload.result.action, 'uploaded');
  assert.equal(initialUpload.definition?.skills?.length, 1);
  const initialReference = initialUpload.definition!.skills![0];
  const beforeStalePatch = await cloud.read();
  assert.equal(beforeStalePatch.kind, 'found');
  if (beforeStalePatch.kind !== 'found') return;
  await assert.rejects(
    cloud.patchSkills(beforeStalePatch.definition.skills ?? [], staleEtag),
    (error: unknown) => (
      error instanceof BotDefinitionCloudError
      && error.status === 412
    ),
  );
  assert.deepStrictEqual(await cloud.read(), beforeStalePatch);
  steps.push({ name: 'stale-etag-rejected', action: 'rejected', status: 412 });

  appendSkill(deviceARoot, 'alpha', 'changed while XiaoBa was offline');
  deviceA = runtime(deviceARoot);
  const offlineUpload = await deviceA.sync({ definitionForCreate });
  record('offline-restart-upload', offlineUpload);
  assert.equal(offlineUpload.result.action, 'uploaded');
  assert.notDeepStrictEqual(offlineUpload.definition?.skills?.[0], initialReference);

  const deviceB = runtime(deviceBRoot);
  const restoredB = await deviceB.sync({ definitionForCreate });
  record('missing-workspace-cloud-restore', restoredB);
  assert.equal(restoredB.result.action, 'downloaded');
  assert.match(readSkill(deviceBRoot, 'alpha'), /changed while XiaoBa was offline/);

  await deviceB.mutate(() => appendSkill(deviceBRoot, 'alpha', 'cloud edit from device B'));
  const uploadedB = await deviceB.flush();
  assert.ok(uploadedB);
  record('device-b-upload', uploadedB);
  assert.equal(uploadedB.result.action, 'uploaded');

  const downloadedA = await deviceA.sync({ definitionForCreate });
  record('unchanged-local-cloud-download', downloadedA);
  assert.equal(downloadedA.result.action, 'downloaded');
  assert.match(readSkill(deviceARoot, 'alpha'), /cloud edit from device B/);

  appendSkill(deviceARoot, 'alpha', 'offline local wins after both changed');
  await deviceB.mutate(() => appendSkill(deviceBRoot, 'alpha', 'concurrent cloud snapshot'));
  const concurrentB = await deviceB.flush();
  assert.ok(concurrentB);
  record('concurrent-device-b-upload', concurrentB);
  assert.equal(concurrentB.result.action, 'uploaded');
  const preservedCloudReference = concurrentB.definition!.skills![0];

  const localWins = await deviceA.sync({ definitionForCreate });
  record('both-changed-local-priority', localWins);
  assert.equal(localWins.result.action, 'uploaded');
  assert.match(readSkill(deviceARoot, 'alpha'), /offline local wins after both changed/);
  assert.notDeepStrictEqual(localWins.definition?.skills?.[0], preservedCloudReference);

  const preserved = await packages.download(preservedCloudReference);
  const preservedSkill = preserved.files.find(file => file.path === 'SKILL.md');
  assert.ok(preservedSkill);
  assert.match(preservedSkill.bytes.toString('utf8'), /concurrent cloud snapshot/);

  const cloudBeforeSensitive = await cloud.read();
  assert.equal(cloudBeforeSensitive.kind, 'found');
  if (cloudBeforeSensitive.kind !== 'found') return;
  await deviceA.mutate(() => {
    writeSkill(deviceARoot, 'local-secret', 'local-only sensitive skill');
    fs.writeFileSync(
      path.join(deviceARoot, 'skills', 'local-secret', '.env'),
      'API_KEY=live-e2e-placeholder-secret-value\n',
    );
    fs.writeFileSync(
      path.join(deviceARoot, 'skills', 'local-secret', 'config.txt'),
      'CATSCO_API_KEY=live-e2e-sensitive-value-1234567890\n',
    );
  });
  const sensitive = await deviceA.flush();
  assert.ok(sensitive);
  record('sensitive-local-skill-blocked', sensitive);
  assert.equal(sensitive.result.action, 'uploaded');
  assert.equal(sensitive.result.blockedSkills?.length, 1);
  assert.equal(sensitive.result.blockedSkills?.[0].name, 'local-secret');
  assert.equal(fs.existsSync(path.join(deviceARoot, 'skills', 'local-secret', '.env')), true);
  const cloudAfterSensitive = await cloud.read();
  assert.equal(cloudAfterSensitive.kind, 'found');
  if (cloudAfterSensitive.kind !== 'found') return;
  assert.deepStrictEqual(
    cloudAfterSensitive.definition.skills,
    cloudBeforeSensitive.definition.skills,
  );
  const restoredAfterSensitive = await deviceB.sync({ definitionForCreate });
  record('sensitive-skill-absent-on-other-device', restoredAfterSensitive);
  assert.equal(restoredAfterSensitive.result.action, 'downloaded');
  assert.equal(fs.existsSync(path.join(deviceBRoot, 'skills', 'local-secret')), false);
  const beforeOutage = await cloud.read();
  assert.equal(beforeOutage.kind, 'found');
  appendSkill(deviceARoot, 'alpha', 'local content retained while SkillHub is unavailable');
  const outagePackages = new HttpBotPrivateSkillPackageClient({
    baseUrl: 'http://127.0.0.1:1',
    botId,
    apiKey,
    allowInsecureHttp: true,
    timeoutMs: 1_000,
  });
  const outageRuntime = new BotSkillRuntime({
    runtimeRoot: deviceARoot,
    auth,
    packages: outagePackages,
    debounceMs: 60_000,
  });
  const outage = await outageRuntime.sync({ definitionForCreate });
  record('private-upload-outage-local-preserved', outage);
  assert.equal(outage.result.action, 'uploaded');
  assert.equal(outage.result.blockedSkills?.some(item => item.name === 'alpha'), true);
  assert.match(readSkill(deviceARoot, 'alpha'), /local content retained while SkillHub is unavailable/);
  const afterOutage = await cloud.read();
  assert.equal(afterOutage.kind, 'found');
  assert.deepStrictEqual(
    afterOutage.kind === 'found' ? afterOutage.definition.skills : undefined,
    beforeOutage.kind === 'found' ? beforeOutage.definition.skills : undefined,
  );

  const recoveredUpload = await deviceA.sync({ definitionForCreate });
  record('private-upload-outage-retry', recoveredUpload);
  assert.equal(recoveredUpload.result.action, 'uploaded');
  assert.equal(recoveredUpload.result.blockedSkills?.some(item => item.name === 'alpha'), false);

  const beforeUnreadable = await cloud.read();
  assert.equal(beforeUnreadable.kind, 'found');
  const identityPath = path.join(deviceARoot, 'skills', BOT_SKILL_WORKSPACE_IDENTITY_FILE);
  const identity = fs.readFileSync(identityPath, 'utf8');
  fs.writeFileSync(identityPath, '{broken');
  const unreadable = await deviceA.sync({ definitionForCreate });
  record('unreadable-workspace-blocked', unreadable);
  assert.equal(unreadable.result.action, 'blocked');
  assert.equal(unreadable.result.reason, 'LOCAL_WORKSPACE_UNREADABLE');
  assert.deepStrictEqual(await cloud.read(), beforeUnreadable);
  fs.writeFileSync(identityPath, identity);

  const finalCloud = await cloud.read();
  assert.equal(finalCloud.kind, 'found');
  if (finalCloud.kind !== 'found') return;
  assert.deepStrictEqual({
    model: finalCloud.definition.model,
    prompt: finalCloud.definition.prompt,
  }, nonSkillFields);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    botId,
    initialMode,
    remoteArtifactsRetained: true,
    steps,
  }, null, 2)}\n`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (keepRoots) {
      console.error(`kept device roots: ${deviceARoot}, ${deviceBRoot}`);
      return;
    }
    fs.rmSync(deviceARoot, { recursive: true, force: true });
    fs.rmSync(deviceBRoot, { recursive: true, force: true });
  });

function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertLoopbackBaseUrl(value: string, name: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  ) {
    throw new Error(`${name} must point to an isolated loopback staging service`);
  }
}
