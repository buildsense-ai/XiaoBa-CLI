import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileBotDefinitionRepository } from '../src/bot-definition/repository';
import type { BotSkillRef } from '../src/bot-definition/types';
import {
  readPendingBotSkillRevocations,
  reconcilePendingBotSkillRevocations,
  recordPendingBotSkillRevocation,
} from '../src/bot-skills/revocation';
import {
  scanLocalBotSkill,
  writeBotSkillLocalMarker,
} from '../src/bot-skills/local-manifest';
import {
  isRevokedBotSkillSnapshotCommand,
  resolveTrustedBotSkillScriptInvocation,
  withTrustedBotSkillArtifactSourceEnvironment,
  withTrustedBotSkillConnectorEnvironment,
} from '../src/bot-skills/trusted-script-execution';
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
      "const input = process.argv.slice(3);",
      "const value = input[0] === 'capture-env' ? { connector: process.env.CATSCO_SHIMO_CONNECTOR_URL, token: process.env.CATSCO_ACTOR_TOKEN, skillId: process.env.CATSCO_SKILL_ID } : input;",
      "fs.writeFileSync(output, JSON.stringify(value), 'utf8');",
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

  test('blocks direct execution from preserved pending Skill snapshots', async () => {
    const pendingScript = path.join(
      runtimeRoot,
      'data',
      'bot-skills',
      'local-pending',
      'bot-1',
      '2026-09-23T01-00-00-000Z-deadbeef',
      'package',
      'cloud-html-artifact',
      'scripts',
      'publish-html-directory.mjs',
    );
    fs.mkdirSync(path.dirname(pendingScript), { recursive: true });
    fs.writeFileSync(pendingScript, "console.log('revoked-snapshot-must-not-run');\n", 'utf8');

    const result = await new ShellTool().execute({
      command: `node "${pendingScript}"`,
    }, catsContext());

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.errorCode, 'PERMISSION_DENIED');
    assert.match(result.ok ? '' : String(result.message), /revoked Bot Skill snapshot/);

    const targetResult = await new ShellTool().execute({
      command: `node "${pendingScript}"`,
      target: 'agent_self',
    }, catsContext());
    assert.equal(targetResult.ok, false);
    assert.equal(targetResult.ok ? '' : targetResult.errorCode, 'PERMISSION_DENIED');
  });

  test('blocks compound commands that resolve a preserved snapshot through a variable', async () => {
    const pendingScript = path.join(
      runtimeRoot,
      'data',
      'bot-skills',
      'local-pending',
      'bot-1',
      '2026-09-23T01-00-00-000Z-deadbeef',
      'package',
      'cloud-html-artifact',
      'scripts',
      'publish-html-directory.mjs',
    );
    fs.mkdirSync(path.dirname(pendingScript), { recursive: true });
    fs.writeFileSync(pendingScript, "console.log('revoked-snapshot-must-not-run');\n", 'utf8');
    const packageRoot = path.dirname(path.dirname(pendingScript));
    const command = `SKILL_DIR="${packageRoot}"; cd "${workspaceRoot}"; node "$SKILL_DIR/scripts/publish-html-directory.mjs"`;
    const result = await new ShellTool().execute({ command }, catsContext());

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.errorCode, 'PERMISSION_DENIED');
    assert.match(result.ok ? '' : String(result.message), /revoked Bot Skill snapshot/);

    const prefixRoot = path.join(runtimeRoot, 'data', 'bot-skills');
    const prefixedCommand = `BS="${prefixRoot}"; node "$BS/local-pending/bot-1/2026-09-23T01-00-00-000Z-deadbeef/package/cloud-html-artifact/scripts/publish-html-directory.mjs"`;
    assert.equal(isRevokedBotSkillSnapshotCommand(prefixedCommand, catsContext()), true);

    const noExtension = path.join(path.dirname(pendingScript), 'run');
    fs.writeFileSync(noExtension, "console.log('revoked-no-extension');\n", 'utf8');
    assert.equal(isRevokedBotSkillSnapshotCommand(`node "${noExtension}"`, catsContext()), true);

    assert.equal(isRevokedBotSkillSnapshotCommand(
      `npx tsx "${pendingScript}"`,
      catsContext(),
    ), true);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `bun "${pendingScript}"`,
      catsContext(),
    ), true);

    const inspectionScript = path.join(workspaceRoot, 'inspect.mjs');
    fs.writeFileSync(inspectionScript, "console.log('inspection-ok');\n", 'utf8');
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `node "${inspectionScript}" "${pendingScript}"`,
      catsContext(),
    ), false);

    const pendingScriptsDirectory = path.dirname(pendingScript);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `cd "${pendingScriptsDirectory}" && node "${path.basename(pendingScript)}"`,
      catsContext(),
    ), true);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `bash -c "node '${pendingScript}'"`,
      catsContext(),
    ), true);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `bash -lc "node '${pendingScript}'"`,
      catsContext(),
    ), true);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `env node "${pendingScript}"`,
      catsContext(),
    ), true);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `sudo --preserve-env node "${pendingScript}"`,
      catsContext(),
    ), true);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `node "$(printf %s '${pendingScript}')"`,
      catsContext(),
    ), true);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `npx prettier --write "${pendingScript}"`,
      catsContext(),
    ), false);
    const evalPath = pendingScript.replace(/\\/g, '/');
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `node -e "require('${evalPath}')"`,
      catsContext(),
    ), true);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `node --eval "import('${evalPath}')"`,
      catsContext(),
    ), true);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `node -e "console.log(1)"`,
      catsContext(),
    ), false);
    assert.equal(isRevokedBotSkillSnapshotCommand(
      `(cd "${pendingScriptsDirectory}" && node "${path.basename(pendingScript)}")`,
      catsContext(),
    ), true);
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

  test('injects a live connector grant only into its exact verified SkillHub package', async () => {
    const output = path.join(workspaceRoot, 'connector-env.json');
    const context = catsContext({
      skillConnectorGrants: [{
        provider: 'shimo',
        skillId: reference.skillId,
        connectorUrl: 'https://app.catsco.test',
        actorToken: 'turn-scoped-secret',
        expiresAt: Date.now() + 60_000,
      }],
    });
    const result = await new ShellTool().execute({
      command: `node "${scriptPath}" "${output}" capture-env`,
    }, context);

    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
      connector: 'https://app.catsco.test',
      token: 'turn-scoped-secret',
      skillId: reference.skillId,
    });
  });

  test('strips connector secrets from ordinary commands and non-matching Skills', () => {
    const environment = {
      CATSCO_SHIMO_CONNECTOR_URL: 'https://stale.example',
      CATSCO_ACTOR_TOKEN: 'stale-secret',
      CATSCO_SKILL_ID: 'stale/skill',
      SAFE_VALUE: 'kept',
    };
    const unrelated = withTrustedBotSkillConnectorEnvironment({
      scriptPath,
      args: [scriptPath],
      skillId: 'another/skill',
      skillName: 'Another skill',
      version: '1.0.0',
    }, catsContext({
      skillConnectorGrants: [{
        provider: 'shimo',
        skillId: reference.skillId,
        connectorUrl: 'https://app.catsco.test',
        actorToken: 'turn-scoped-secret',
        expiresAt: Date.now() + 60_000,
      }],
    }), environment);

    assert.equal(unrelated.CATSCO_SHIMO_CONNECTOR_URL, undefined);
    assert.equal(unrelated.CATSCO_ACTOR_TOKEN, undefined);
    assert.equal(unrelated.CATSCO_SKILL_ID, undefined);
    assert.equal(unrelated.SAFE_VALUE, 'kept');
  });

  test('injects the canonical source pair only for artifact-publish', () => {
    const environment = {
      CATSCO_ARTIFACT_SOURCE_TOPIC_ID: 'stale-topic',
      CATSCO_ARTIFACT_SOURCE_MESSAGE_ID: '999',
      SAFE_VALUE: 'kept',
    };
    const context = catsContext({
      executionScope: {
        ...catsContext().executionScope!,
        topicId: 'grp_5063',
        channelSeq: 1328899,
      },
    });

    for (const skillId of ['yii/artifact-publish', 'david/artifact-publish']) {
      const injected = withTrustedBotSkillArtifactSourceEnvironment({
        scriptPath,
        args: [scriptPath],
        skillId,
        skillName: 'Artifact publish',
        version: '1.0.7',
      }, context, environment);

      assert.equal(injected.CATSCO_ARTIFACT_SOURCE_TOPIC_ID, 'grp_5063');
      assert.equal(injected.CATSCO_ARTIFACT_SOURCE_MESSAGE_ID, '1328899');
      assert.equal(injected.SAFE_VALUE, 'kept');
    }

    const unrelated = withTrustedBotSkillArtifactSourceEnvironment({
      scriptPath,
      args: [scriptPath],
      skillId: 'publisher/other-skill',
      skillName: 'Other skill',
      version: '1.0.0',
    }, context, environment);
    assert.equal(unrelated.CATSCO_ARTIFACT_SOURCE_TOPIC_ID, undefined);
    assert.equal(unrelated.CATSCO_ARTIFACT_SOURCE_MESSAGE_ID, undefined);

    const untrustedArtifactPublisher = withTrustedBotSkillArtifactSourceEnvironment({
      scriptPath,
      args: [scriptPath],
      skillId: 'attacker/artifact-publish',
      skillName: 'Artifact publish',
      version: '1.0.7',
    }, context, environment);
    assert.equal(untrustedArtifactPublisher.CATSCO_ARTIFACT_SOURCE_TOPIC_ID, undefined);
    assert.equal(untrustedArtifactPublisher.CATSCO_ARTIFACT_SOURCE_MESSAGE_ID, undefined);
  });

  test('does not inject an artifact source pair without a trusted canonical sequence', () => {
    const invocation = {
      scriptPath,
      args: [scriptPath],
      skillId: 'david/artifact-publish',
      skillName: 'Artifact publish',
      version: '1.0.7',
    };
    const baseEnvironment = {
      CATSCO_ARTIFACT_SOURCE_TOPIC_ID: 'stale-topic',
      CATSCO_ARTIFACT_SOURCE_MESSAGE_ID: '999',
    };
    const missingSequence = withTrustedBotSkillArtifactSourceEnvironment(
      invocation,
      catsContext(),
      baseEnvironment,
    );
    assert.equal(missingSequence.CATSCO_ARTIFACT_SOURCE_TOPIC_ID, undefined);
    assert.equal(missingSequence.CATSCO_ARTIFACT_SOURCE_MESSAGE_ID, undefined);

    const untrusted = withTrustedBotSkillArtifactSourceEnvironment(
      invocation,
      catsContext({
        executionScope: {
          ...catsContext().executionScope!,
          channelSeq: 42,
          isTrusted: false,
        },
      }),
      baseEnvironment,
    );
    assert.equal(untrusted.CATSCO_ARTIFACT_SOURCE_TOPIC_ID, undefined);
    assert.equal(untrusted.CATSCO_ARTIFACT_SOURCE_MESSAGE_ID, undefined);
  });

  test('runs the published artifact-publish connector layout and injects its source pair', async () => {
    const artifactSkillDir = path.join(runtimeRoot, 'skills', 'artifact-publish');
    const connectorDir = path.join(artifactSkillDir, 'connector');
    const artifactCliPath = path.join(connectorDir, 'artifact-cli.mjs');
    fs.mkdirSync(connectorDir, { recursive: true });
    fs.writeFileSync(path.join(artifactSkillDir, 'SKILL.md'), [
      '---',
      'name: artifact-publish',
      'description: test fixture',
      '---',
      '# Artifact publish',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(artifactCliPath, [
      "import fs from 'node:fs';",
      "const output = process.argv[2];",
      "fs.writeFileSync(output, JSON.stringify({ topic: process.env.CATSCO_ARTIFACT_SOURCE_TOPIC_ID, message: process.env.CATSCO_ARTIFACT_SOURCE_MESSAGE_ID }), 'utf8');",
      "console.log('artifact-cli-ok');",
      '',
    ].join('\n'), 'utf8');
    writeSkillHubInstallMarker(artifactSkillDir, {
      source: 'skillhub',
      userId: 'skillhub-user-1',
      skillId: 'david/artifact-publish',
      name: 'Artifact publish',
      installName: 'artifact-publish',
      version: '1.0.7',
      packageChecksumSha256: 'b'.repeat(64),
      signature: {
        algorithm: 'ed25519',
        keyId: 'skillhub-test-key',
        signature: 'signed-artifact-package-fixture',
      },
      packageUrl: 'https://skillhub.example/artifact-publish.skillpkg',
      installedAt: new Date(0).toISOString(),
    });
    const initial = scanLocalBotSkill(artifactSkillDir, path.dirname(artifactSkillDir));
    const artifactReference: BotSkillRef = {
      source: 'skillhub',
      skillId: 'david/artifact-publish',
      version: '1.0.7',
      contentHash: initial.contentHash,
    };
    writeBotSkillLocalMarker(artifactSkillDir, {
      schema: 'xiaoba.bot-skill-local.v1',
      localSkillId: initial.localSkillId,
      reference: artifactReference,
      origin: { skillId: artifactReference.skillId, version: artifactReference.version },
    });
    new FileBotDefinitionRepository({ runtimeRoot }).writeCache({
      schema: 'xiaoba.bot-definition.v1',
      botId: 'bot-1',
      model: { kind: 'catalog', modelId: 'test-model' },
      skills: [reference, artifactReference],
    });

    const output = path.join(workspaceRoot, 'artifact-source.json');
    const command = `cd "${connectorDir}" && node artifact-cli.mjs "${output}"`;
    const context = catsContext({
      executionScope: {
        ...catsContext().executionScope!,
        topicId: 'grp_artifact',
        channelSeq: 7331,
      },
    });
    const decision = resolveTrustedBotSkillScriptInvocation(command, context);
    assert.equal(decision.ok, true);
    if (decision.ok) {
      assert.equal(decision.invocation.scriptPath, artifactCliPath);
      assert.equal(decision.invocation.workingDirectory, connectorDir);
    }

    const result = await new ShellTool().execute({ command }, context);
    assert.equal(result.ok, true);
    assert.match(result.ok ? String(result.content) : '', /artifact-cli-ok/);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
      topic: 'grp_artifact',
      message: '7331',
    });

    const forged = await new ShellTool().execute({
      command: `cd "${connectorDir}" && CATSCO_ARTIFACT_SOURCE_TOPIC_ID=attacker_topic CATSCO_ARTIFACT_SOURCE_MESSAGE_ID=424242 node artifact-cli.mjs "${path.join(workspaceRoot, 'forged.json')}"`,
    }, context);
    assert.equal(forged.ok, false);
    assert.equal(forged.ok ? '' : forged.errorCode, 'PERMISSION_DENIED');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'forged.json')), false);

    const envForged = await new ShellTool().execute({
      command: `cd "${connectorDir}" && env CATSCO_ARTIFACT_SOURCE_TOPIC_ID=attacker_topic CATSCO_ARTIFACT_SOURCE_MESSAGE_ID=999999 node artifact-cli.mjs "${path.join(workspaceRoot, 'env-forged.json')}"`,
    }, context);
    assert.equal(envForged.ok, false);
    assert.equal(envForged.ok ? '' : envForged.errorCode, 'PERMISSION_DENIED');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'env-forged.json')), false);
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

  test('resolves the active Bot definition when CatsCo prefixes the Bot id with usr', () => {
    const decision = resolveTrustedBotSkillScriptInvocation(
      `node "${scriptPath}" "${path.join(workspaceRoot, 'prefixed-bot.json')}"`,
      catsContext({
        executionScope: {
          ...catsContext().executionScope!,
          agentId: 'usrbot-1',
        },
      }),
    );

    assert.equal(decision.ok, true);
  });

  test('denies an old turn snapshot after its exact Skill reference is revoked', async () => {
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
    const command = `node "${snapshotScript}" "${path.join(workspaceRoot, 'revoked-snapshot.json')}"`;

    try {
      recordPendingBotSkillRevocation('bot-1', reference, runtimeRoot);
      assert.deepEqual(readPendingBotSkillRevocations('bot-1', runtimeRoot), [reference]);

      const decision = resolveTrustedBotSkillScriptInvocation(command, catsContext({ turnSkillSnapshot: lease }));
      assert.equal(decision.ok, false);
      assert.match(decision.ok ? '' : decision.reason, /not enabled in the current Bot definition/);

      const result = await new ShellTool().execute({ command }, catsContext({ turnSkillSnapshot: lease }));
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.errorCode, 'PERMISSION_DENIED');
      assert.equal(fs.existsSync(path.join(workspaceRoot, 'revoked-snapshot.json')), false);
    } finally {
      reconcilePendingBotSkillRevocations('bot-1', [], runtimeRoot);
      await lease.release();
    }
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
