import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import type { BotSkillRef } from '../src/bot-definition/types';
import {
  scanLocalBotSkill,
  writeBotSkillLocalMarker,
} from '../src/bot-skills/local-manifest';
import { resolveTrustedBotSkillScriptInvocation } from '../src/bot-skills/trusted-script-execution';
import { writeSkillHubInstallMarker } from '../src/skillhub/install-marker';
import { TurnSkillSnapshotStore } from '../src/skills/turn-skill-snapshot';
import { ShellTool } from '../src/tools/bash-tool';
import type { ToolExecutionContext } from '../src/types/tool';

describe('trusted Bot Skill script execution', () => {
  let root: string;
  let runtimeRoot: string;
  let workspaceRoot: string;
  let skillDir: string;
  let scriptPath: string;
  let reference: BotSkillRef;
  const previousUserData = process.env.XIAOBA_USER_DATA_DIR;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-bot-skill-script-'));
    runtimeRoot = path.join(root, 'runtime');
    workspaceRoot = path.join(runtimeRoot, 'work');
    skillDir = path.join(runtimeRoot, 'skills', 'verified-image-skill');
    scriptPath = path.join(skillDir, 'scripts', 'run.mjs');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.XIAOBA_USER_DATA_DIR = runtimeRoot;

    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: verified-image-skill',
      'description: test fixture',
      '---',
      '# Verified image skill',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(scriptPath, [
      "import fs from 'node:fs';",
      "const output = process.argv[2];",
      "fs.writeFileSync(output, JSON.stringify(process.argv.slice(3)), 'utf8');",
      "console.log('verified-skill-ok');",
      '',
    ].join('\n'), 'utf8');
    writeSkillHubInstallMarker(skillDir, {
      source: 'skillhub',
      userId: 'skillhub-user-1',
      skillId: 'publisher/verified-image-skill',
      name: 'Verified image skill',
      installName: 'verified-image-skill',
      version: '1.0.0',
      packageChecksumSha256: 'a'.repeat(64),
      signature: {
        algorithm: 'ed25519',
        keyId: 'skillhub-test-key',
        signature: 'signed-package-fixture',
      },
      packageUrl: 'https://skillhub.example/package.skillpkg',
      installedAt: new Date(0).toISOString(),
    });
    const initial = scanLocalBotSkill(skillDir, path.dirname(skillDir));
    reference = {
      source: 'skillhub',
      skillId: 'publisher/verified-image-skill',
      version: '1.0.0',
      contentHash: initial.contentHash,
    };
    writeBotSkillLocalMarker(skillDir, {
      schema: 'xiaoba.bot-skill-local.v1',
      localSkillId: initial.localSkillId,
      reference,
      origin: { skillId: reference.skillId, version: reference.version },
    });
    new FileBotDefinitionRepository({ runtimeRoot }).writeCache({
      schema: 'xiaoba.bot-definition.v1',
      botId: 'bot-1',
      model: { kind: 'catalog', modelId: 'test-model' },
      skills: [reference],
    });
  });

  after(() => {
    if (previousUserData === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserData;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('runs the current Bot verified SkillHub Node entrypoint without a shell', async () => {
    const output = path.join(workspaceRoot, 'direct-run.json');
    const command = `node "${scriptPath}" "${output}" "hello world"`;
    const decision = resolveTrustedBotSkillScriptInvocation(command, catsContext());
    assert.equal(decision.ok, true);

    const result = await new ShellTool().execute({ command }, catsContext());
    assert.equal(result.ok, true);
    assert.match(result.ok ? String(result.content) : '', /verified-skill-ok/);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), ['hello world']);
  });

  test('keeps shell metacharacters inert by passing them as direct process arguments', async () => {
    const output = path.join(workspaceRoot, 'inert-arguments.json');
    const injected = path.join(workspaceRoot, 'must-not-exist.txt');
    const command = `node "${scriptPath}" "${output}" safe ; node -e "require('fs').writeFileSync('${injected.replace(/\\/g, '\\\\')}', 'bad')"`;

    const result = await new ShellTool().execute({ command }, catsContext());
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(injected), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')).slice(0, 2), ['safe', ';']);
  });

  test('falls back to the ordinary shell for arbitrary chat commands', async () => {
    const result = await new ShellTool().execute({
      command: 'node -e "console.log(\'ordinary-shell-ok\')"',
    }, catsContext());

    assert.equal(result.ok, true);
    assert.match(result.ok ? String(result.content) : '', /ordinary-shell-ok/);
  });

  test('falls back to the ordinary shell for Node scripts outside the verified Skill package', async () => {
    const externalScript = path.join(workspaceRoot, 'external.mjs');
    fs.writeFileSync(externalScript, "console.log('must not run');\n", 'utf8');
    const decision = resolveTrustedBotSkillScriptInvocation(
      `node "${externalScript}"`,
      catsContext(),
    );

    assert.equal(decision.ok, false);
    assert.match(decision.ok ? '' : decision.reason, /outside an installed Bot Skill/);
    const result = await new ShellTool().execute({ command: `node "${externalScript}"` }, catsContext());
    assert.equal(result.ok, true);
    assert.match(result.ok ? String(result.content) : '', /must not run/);
  });

  test('keeps normal target routing when a trusted Skill command has a target override', async () => {
    const command = `node "${scriptPath}" "${path.join(workspaceRoot, 'remote.json')}"`;
    const decision = resolveTrustedBotSkillScriptInvocation(command, catsContext(), { target: 'Alice' });

    assert.equal(decision.ok, false);
    assert.match(decision.ok ? '' : decision.reason, /without a target override/);
    const result = await new ShellTool().execute({ command, target: 'Alice' }, catsContext());
    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.errorCode, 'TARGET_NOT_FOUND');
  });

  test('rejects a verified package that is not enabled for the active Bot', async () => {
    const command = `node "${scriptPath}" "${path.join(workspaceRoot, 'wrong-bot.json')}"`;
    const decision = resolveTrustedBotSkillScriptInvocation(command, catsContext({
      executionScope: {
        ...catsContext().executionScope!,
        agentId: 'bot-2',
      },
    }));
    assert.equal(decision.ok, false);
    assert.match(decision.ok ? '' : decision.reason, /current Bot definition/);
  });

  test('keeps trusted script resolution on the turn snapshot after the live package changes', async () => {
    const store = new TurnSkillSnapshotStore({
      runtimeRoot,
      skillsRoot: path.join(runtimeRoot, 'skills'),
    });
    const lease = await store.acquire();
    const snapshotScript = path.join(
      lease.snapshot.rootPath,
      'verified-image-skill',
      'scripts',
      'run.mjs',
    );
    fs.appendFileSync(scriptPath, '// changed after turn start\n', 'utf8');

    try {
      const snapshotDecision = resolveTrustedBotSkillScriptInvocation(
        `node "${snapshotScript}" "${path.join(workspaceRoot, 'snapshot.json')}"`,
        catsContext({ turnSkillSnapshot: lease }),
      );
      const liveDecision = resolveTrustedBotSkillScriptInvocation(
        `node "${scriptPath}" "${path.join(workspaceRoot, 'live-changed.json')}"`,
        catsContext(),
      );

      assert.equal(snapshotDecision.ok, true);
      assert.equal(liveDecision.ok, false);
      assert.match(liveDecision.ok ? '' : liveDecision.reason, /content hash/);
    } finally {
      await lease.release();
    }
  });

  test('falls back to the ordinary shell after an installed Skill script is modified locally', async () => {
    fs.appendFileSync(scriptPath, '// tampered\n', 'utf8');
    const command = `node "${scriptPath}" "${path.join(workspaceRoot, 'tampered.json')}"`;
    const decision = resolveTrustedBotSkillScriptInvocation(command, catsContext());

    assert.equal(decision.ok, false);
    assert.match(decision.ok ? '' : decision.reason, /content hash/);
    const result = await new ShellTool().execute({ command }, catsContext());
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'tampered.json')), true);
  });

  function catsContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
    return {
      workingDirectory: workspaceRoot,
      workspaceRoot,
      conversationHistory: [],
      surface: 'catscompany',
      executionScope: {
        source: 'catscompany',
        sessionKey: 'session-1',
        topicId: 'topic-1',
        topicType: 'p2p',
        actorUserId: 'user-1',
        agentId: 'bot-1',
        agentBodyId: 'body-1',
        identityTrust: 'server_canonical',
        isTrusted: true,
      },
      localDeviceGrant: {
        kind: 'local_device_grant',
        source: 'catscompany',
        bodyId: 'body-1',
        installationId: 'installation-1',
        ownerUserId: 'user-1',
      },
      ...overrides,
    };
  }
});
