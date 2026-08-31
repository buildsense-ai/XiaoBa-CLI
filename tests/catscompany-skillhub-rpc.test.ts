import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import {
  DashboardBotSwitchScheduler,
  SkillHubThinRpcError,
  SkillHubThinRpcHandler,
  SKILLHUB_THIN_RPC_TOOLS,
  requestDashboardBotSwitch,
} from '../src/catscompany/skillhub-rpc';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import {
  shareLocalSkillForCatsCo,
  validateSkillHubShareMetadata,
} from '../src/skillhub/local-share';
import { scanBotSkillWorkspace } from '../src/bot-skills/local-manifest';
import { writeBotSkillLocalMarker } from '../src/bot-skills/local-manifest';
import {
  applySkillHubLocalMetadata,
  readSkillHubLocalMetadata,
} from '../src/skillhub/local-skill-metadata';
import { SkillHubService } from '../src/skillhub/service';
import { trashBotSkill } from '../src/bot-skills/deleted-skill-trash';

describe('CatsCompany SkillHub thin RPC', () => {
  let runtimeRoot = '';
  let scheduledBotUIDs: string[] = [];
  let handler: SkillHubThinRpcHandler;

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skillhub-rpc-'));
    const skillsRoot = path.join(runtimeRoot, 'skills');
    fs.mkdirSync(path.join(skillsRoot, 'local-demo'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'local-demo', 'SKILL.md'), [
      '---',
      'name: local-demo',
      'description: Local demo description',
      '---',
      '',
      '# Local Demo',
      '',
    ].join('\n'));
    new BotSkillWorkspaceService(runtimeRoot, skillsRoot).activate('42');
    createCatsCoLocalConfigService({ runtimeRoot }).save({
      version: 1,
      account: { token: 'user-token', uid: '7', username: 'alice' },
      currentBot: {
        uid: '42',
        apiKey: 'bot-key',
        boundByUserUid: '7',
      },
      device: {
        deviceId: 'alice-device',
        bodyId: 'alice-device',
        installationId: 'alice-device',
      },
    });
    scheduledBotUIDs = [];
    handler = new SkillHubThinRpcHandler({
      runtimeRoot,
      scheduleBotSwitch: (botUid) => scheduledBotUIDs.push(botUid),
      now: () => new Date('2026-08-24T00:00:00.000Z'),
    });
  });

  afterEach(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  test('can be disabled for server runtimes', () => {
    const serverHandler = new SkillHubThinRpcHandler({ runtimeRoot, enabled: false });
    for (const toolName of Object.values(SKILLHUB_THIN_RPC_TOOLS)) {
      assert.equal(serverHandler.supports(toolName), false);
    }
  });

  test('server runtime supports workspace operations but never Bot switching', async () => {
    const serverHandler = new SkillHubThinRpcHandler({
      runtimeRoot,
      allowBotSwitch: false,
    });
    assert.equal(serverHandler.supports(SKILLHUB_THIN_RPC_TOOLS.workspace), true);
    assert.equal(serverHandler.supports(SKILLHUB_THIN_RPC_TOOLS.delete), true);
    assert.equal(serverHandler.supports(SKILLHUB_THIN_RPC_TOOLS.switchBot), false);
    await assert.rejects(
      serverHandler.execute(request({
        request_id: 'server-switch-denied',
        tool_name: SKILLHUB_THIN_RPC_TOOLS.switchBot,
        payload: { bot_uid: '44' },
      })),
      (error: unknown) => (
        error instanceof SkillHubThinRpcError
        && error.code === 'TOOL_NOT_FOUND'
      ),
    );
  });

  test('returns only bounded metadata for the active Bot workspace', async () => {
    const result = await handler.execute(request({
      request_id: 'workspace-1',
      tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace,
    }));
    assert.equal(result.schema, 'xiaoba.skillhub.local_workspace.v1');
    assert.equal(result.bot_uid, '42');
    assert.equal(result.skills_path, path.join(runtimeRoot, 'skills'));
    const skills = result.skills as Array<Record<string, unknown>>;
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'local-demo');
    assert.equal(skills[0].relative_path, 'local-demo');
    assert.equal(Object.prototype.hasOwnProperty.call(skills[0], 'path'), false);
    assert.equal(JSON.stringify(result).includes('# Local Demo'), false);
    assert.match(String(result.workspace_revision), /^[0-9a-f]{64}$/);
    assert.equal(result.total_skills, 1);
    assert.equal(result.page_offset, 0);
    assert.equal(result.page_limit, 200);
    assert.equal(result.next_offset, null);
    assert.equal(result.truncated, false);
  });

  test('paginates more than 200 workspace Skills without hiding the remainder', async () => {
    const skillsRoot = path.join(runtimeRoot, 'skills');
    for (let index = 0; index < 205; index += 1) {
      const name = `bulk-${String(index).padStart(3, '0')}`;
      const skillRoot = path.join(skillsRoot, name);
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: Pagination fixture ${index}`,
        '---',
        '',
      ].join('\n'));
    }

    const first = await handler.execute(request({
      request_id: 'workspace-page-1',
      payload: { bot_uid: '42', limit: 75 },
    }));
    assert.equal((first.skills as unknown[]).length, 75);
    assert.equal(first.total_skills, 206);
    assert.equal(first.page_offset, 0);
    assert.equal(first.next_offset, 75);
    assert.equal(first.truncated, true);

    const second = await handler.execute(request({
      request_id: 'workspace-page-2',
      payload: {
        bot_uid: '42',
        offset: first.next_offset,
        limit: 200,
        workspace_revision: first.workspace_revision,
      },
    }));
    assert.equal(second.workspace_revision, first.workspace_revision);
    assert.equal((second.skills as unknown[]).length, 131);
    assert.equal(second.page_offset, 75);
    assert.equal(second.next_offset, null);
    assert.equal(second.truncated, false);

    const combined = [
      ...(first.skills as Array<Record<string, unknown>>),
      ...(second.skills as Array<Record<string, unknown>>),
    ];
    assert.equal(combined.length, 206);
    assert.equal(new Set(combined.map(skill => skill.local_skill_id)).size, 206);
    assert.deepEqual(
      combined.map(skill => String(skill.local_skill_id)),
      [...combined.map(skill => String(skill.local_skill_id))].sort(),
    );
  });

  test('serves later pages from one cached snapshot and refreshes only on a new listing', async () => {
    const first = await handler.execute(request({ request_id: 'workspace-revision-before-edit' }));
    fs.writeFileSync(path.join(runtimeRoot, 'skills', 'local-demo', 'SKILL.md'), [
      '---',
      'name: [unterminated',
      'description: Still the old validation class',
      '---',
      '',
    ].join('\n'));

    const cached = await handler.execute(request({
      request_id: 'workspace-revision-cached-after-edit',
      payload: {
        bot_uid: '42',
        offset: 0,
        workspace_revision: first.workspace_revision,
      },
    }));
    assert.deepEqual(cached.skills, first.skills);
    assert.equal(cached.workspace_revision, first.workspace_revision);

    const refreshed = await handler.execute(request({ request_id: 'workspace-revision-new-listing' }));
    assert.notEqual(refreshed.workspace_revision, first.workspace_revision);
    assert.equal((refreshed.skills as Array<Record<string, unknown>>)[0]?.can_share, false);

    const restartedHandler = new SkillHubThinRpcHandler({ runtimeRoot });
    await assert.rejects(
      restartedHandler.execute(request({
        request_id: 'workspace-revision-evicted',
        payload: {
          bot_uid: '42',
          workspace_revision: first.workspace_revision,
        },
      })),
      (error: unknown) => error instanceof SkillHubThinRpcError && error.code === 'WORKSPACE_CHANGED',
    );
  });

  test('fingerprints rejected Skill bytes even when the visible validation error is unchanged', async () => {
    const skillRoot = path.join(runtimeRoot, 'skills', 'broken-revision');
    fs.mkdirSync(skillRoot, { recursive: true });
    writeBotSkillLocalMarker(skillRoot, {
      schema: 'xiaoba.bot-skill-local.v1',
      localSkillId: 'broken-revision',
    });
    const writeBroken = (description: string) => fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'name: [unterminated',
      `description: ${description}`,
      '---',
      '',
    ].join('\n'));
    writeBroken('first rejected bytes');
    const first = await handler.execute(request({ request_id: 'rejected-revision-first' }));
    writeBroken('later rejected byte');
    const second = await handler.execute(request({ request_id: 'rejected-revision-second' }));
    assert.notEqual(second.workspace_revision, first.workspace_revision);
    const firstRejected = (first.skills as Array<Record<string, unknown>>)
      .find(skill => skill.local_skill_id === 'broken-revision');
    const secondRejected = (second.skills as Array<Record<string, unknown>>)
      .find(skill => skill.local_skill_id === 'broken-revision');
    assert.equal(firstRejected?.share_error, secondRejected?.share_error);
  });

  test('rejects invalid pagination input', async () => {
    for (const [requestID, payload] of [
      ['workspace-invalid-limit', { bot_uid: '42', limit: 201 }],
      ['workspace-invalid-offset', { bot_uid: '42', offset: -1 }],
      ['workspace-outside-offset', { bot_uid: '42', offset: 2 }],
      ['workspace-invalid-revision', { bot_uid: '42', workspace_revision: 'not-a-hash' }],
    ] as const) {
      await assert.rejects(
        handler.execute(request({ request_id: requestID, payload })),
        (error: unknown) => error instanceof SkillHubThinRpcError && error.code === 'INVALID_REQUEST',
      );
    }
  });

  test('deletes only the exact local Skill selected by local_skill_id', async () => {
    const siblingRoot = path.join(runtimeRoot, 'skills', 'sibling-demo');
    fs.mkdirSync(siblingRoot, { recursive: true });
    fs.writeFileSync(path.join(siblingRoot, 'SKILL.md'), [
      '---',
      'name: local-demo',
      'description: Same display name, different local Skill',
      '---',
      '',
    ].join('\n'));
    const entries = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'));
    const selected = entries.find(entry => entry.installName === 'local-demo');
    const sibling = entries.find(entry => entry.installName === 'sibling-demo');
    assert.ok(selected);
    assert.ok(sibling);

    const result = await handler.execute(request({
      request_id: 'delete-exact-local-skill',
      tool_name: SKILLHUB_THIN_RPC_TOOLS.delete,
      payload: {
        bot_uid: '42',
        local_skill_id: selected.localSkillId,
      },
    }));

    assert.equal(result.schema, 'xiaoba.skillhub.local_delete.v1');
    assert.equal(result.deleted, true);
    assert.equal(result.local_skill_id, selected.localSkillId);
    assert.equal(result.deleted_at, '2026-08-24T00:00:00.000Z');
    assert.equal(result.backup_expires_at, '2026-09-23T00:00:00.000Z');
    assert.equal(fs.existsSync(selected.path), false);
    assert.equal(fs.existsSync(sibling.path), true);
    const backupRoot = path.join(
      runtimeRoot,
      'data',
      'bot-skills',
      'trash',
      '42',
      String(result.backup_id),
    );
    assert.equal(
      fs.readFileSync(path.join(backupRoot, 'package', 'SKILL.md'), 'utf8').includes('# Local Demo'),
      true,
    );
    const deletion = JSON.parse(fs.readFileSync(path.join(backupRoot, 'deletion.json'), 'utf8'));
    assert.equal(deletion.deletedByOwnerUid, '7');
    assert.equal(deletion.localSkillId, selected.localSkillId);
  });

  test('removes only verified expired trash while keeping the active Skill delete recoverable', async () => {
    const first = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    const firstResult = await handler.execute(request({
      request_id: 'delete-retention-first',
      tool_name: SKILLHUB_THIN_RPC_TOOLS.delete,
      payload: { bot_uid: '42', local_skill_id: first.localSkillId },
    }));
    const firstBackup = path.join(
      runtimeRoot,
      'data',
      'bot-skills',
      'trash',
      '42',
      String(firstResult.backup_id),
    );
    assert.equal(fs.existsSync(firstBackup), true);

    const secondRoot = path.join(runtimeRoot, 'skills', 'second-delete');
    fs.mkdirSync(secondRoot, { recursive: true });
    fs.writeFileSync(path.join(secondRoot, 'SKILL.md'), [
      '---',
      'name: second-delete',
      'description: Second recoverable delete',
      '---',
      '',
    ].join('\n'));
    const second = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    const laterHandler = new SkillHubThinRpcHandler({
      runtimeRoot,
      now: () => new Date('2026-09-24T00:00:00.000Z'),
    });
    const secondResult = await laterHandler.execute(request({
      request_id: 'delete-retention-second',
      tool_name: SKILLHUB_THIN_RPC_TOOLS.delete,
      payload: { bot_uid: '42', local_skill_id: second.localSkillId },
    }));

    assert.equal(fs.existsSync(firstBackup), false);
    assert.equal(fs.existsSync(path.join(
      runtimeRoot,
      'data',
      'bot-skills',
      'trash',
      '42',
      String(secondResult.backup_id),
    )), true);
    assert.equal(fs.existsSync(secondRoot), false);
  });

  test('restores the active Skill when a file appears after the deletion snapshot', () => {
    const sourcePath = path.join(runtimeRoot, 'skills', 'concurrent-delete');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, 'SKILL.md'), [
      '---',
      'name: concurrent-delete',
      'description: Concurrent deletion regression',
      '---',
      '',
    ].join('\n'));

    assert.throws(() => trashBotSkill({
      runtimeRoot,
      botId: '42',
      sourcePath,
      localSkillId: 'concurrent-delete-id',
      name: 'concurrent-delete',
      installName: 'concurrent-delete',
      deletedByOwnerUid: '7',
      now: () => new Date('2026-08-24T00:00:00.000Z'),
      beforeMove: () => {
        fs.writeFileSync(path.join(sourcePath, 'created-during-delete.txt'), 'preserve me');
      },
    }), /changed while deletion was being prepared/i);

    assert.equal(fs.existsSync(path.join(sourcePath, 'SKILL.md')), true);
    assert.equal(fs.readFileSync(path.join(sourcePath, 'created-during-delete.txt'), 'utf8'), 'preserve me');
  });

  test('deletes an invalid local Skill by its existing marker identity', async () => {
    const invalidRoot = path.join(runtimeRoot, 'skills', 'invalid-delete');
    fs.mkdirSync(invalidRoot, { recursive: true });
    fs.writeFileSync(
      path.join(invalidRoot, 'SKILL.md'),
      '---\nname: [unterminated\ndescription: Broken YAML\n---\n',
    );
    writeBotSkillLocalMarker(invalidRoot, {
      schema: 'xiaoba.bot-skill-local.v1',
      localSkillId: 'invalid-delete-id',
    });

    const result = await handler.execute(request({
      request_id: 'delete-invalid-local-skill',
      tool_name: SKILLHUB_THIN_RPC_TOOLS.delete,
      payload: {
        bot_uid: '42',
        local_skill_id: 'invalid-delete-id',
      },
    }));

    assert.equal(result.deleted, true);
    assert.equal(fs.existsSync(invalidRoot), false);
  });

  test('refuses to delete a local Skill directory that contains another Skill', async () => {
    const parentRoot = path.join(runtimeRoot, 'skills', 'parent-delete');
    const childRoot = path.join(parentRoot, 'child-delete');
    fs.mkdirSync(childRoot, { recursive: true });
    fs.writeFileSync(path.join(parentRoot, 'SKILL.md'), [
      '---',
      'name: parent-delete',
      'description: Parent Skill',
      '---',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(childRoot, 'SKILL.md'), [
      '---',
      'name: child-delete',
      'description: Child Skill',
      '---',
      '',
    ].join('\n'));
    const parent = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))
      .find(entry => entry.installName === 'parent-delete');
    assert.ok(parent);

    await assert.rejects(
      handler.execute(request({
        request_id: 'delete-parent-with-child',
        tool_name: SKILLHUB_THIN_RPC_TOOLS.delete,
        payload: {
          bot_uid: '42',
          local_skill_id: parent.localSkillId,
        },
      })),
      (error: any) => (
        error instanceof SkillHubThinRpcError
        && error.code === 'LOCAL_SKILL_CONTAINS_SKILLS'
      ),
    );
    assert.equal(fs.existsSync(parentRoot), true);
    assert.equal(fs.existsSync(childRoot), true);
  });

  test('keeps credential-bearing local Skills visible and shareable', async () => {
    const blockedRoot = path.join(runtimeRoot, 'skills', 'blocked-demo');
    fs.mkdirSync(blockedRoot, { recursive: true });
    fs.writeFileSync(path.join(blockedRoot, 'SKILL.md'), [
      '---',
      'name: blocked-demo',
      'description: Local Skill with private material',
      '---',
      '',
      '# Blocked Demo',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(blockedRoot, '.env'), 'API_KEY=not-a-real-secret\n');
    const nestedRoot = path.join(blockedRoot, 'nested-demo');
    fs.mkdirSync(nestedRoot, { recursive: true });
    fs.writeFileSync(path.join(nestedRoot, 'SKILL.md'), [
      '---',
      'name: nested-demo',
      'description: Valid nested Skill',
      '---',
      '',
    ].join('\n'));

    const result = await handler.execute(request({ request_id: 'workspace-with-blocked-skill' }));
    const skills = result.skills as Array<Record<string, unknown>>;
    assert.equal(skills.length, 3);
    assert.equal(skills.find(skill => skill.name === 'local-demo')?.can_share, true);
    assert.equal(skills.find(skill => skill.name === 'nested-demo')?.can_share, true);
    const blocked = skills.find(skill => skill.name === 'blocked-demo');
    assert.equal(blocked?.can_share, true);
    assert.equal(Object.prototype.hasOwnProperty.call(blocked || {}, 'share_error'), false);
  });

  test('keeps invalid SKILL.md entries visible but disables sharing with an actionable error', async () => {
    const invalidRoot = path.join(runtimeRoot, 'skills', 'test_8_7');
    const malformedRoot = path.join(runtimeRoot, 'skills', 'broken_yaml');
    fs.mkdirSync(invalidRoot, { recursive: true });
    fs.mkdirSync(malformedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(invalidRoot, 'SKILL.md'),
      '# Test Skill\n\nThis file has no YAML name or description.\n',
    );
    fs.writeFileSync(
      path.join(malformedRoot, 'SKILL.md'),
      '---\nname: [unterminated\ndescription: Broken YAML\n---\n',
    );

    assert.throws(
      () => scanBotSkillWorkspace(path.join(runtimeRoot, 'skills')),
      /SKILL\.md format is invalid/i,
    );

    const result = await handler.execute(request({ request_id: 'workspace-with-invalid-skill' }));
    const skills = result.skills as Array<Record<string, unknown>>;
    assert.equal(skills.length, 3);
    assert.equal(skills.find(skill => skill.name === 'local-demo')?.can_share, true);
    const invalid = skills.find(skill => skill.name === 'test_8_7');
    assert.ok(invalid?.local_skill_id);
    assert.equal(invalid?.can_share, false);
    assert.match(String(invalid?.share_error || ''), /name.*description.*YAML frontmatter/i);
    const malformed = skills.find(skill => skill.name === 'broken_yaml');
    assert.ok(malformed?.local_skill_id);
    assert.equal(malformed?.can_share, false);
    assert.match(String(malformed?.share_error || ''), /SKILL\.md format is invalid.*YAML frontmatter/i);

    await assert.rejects(
      handler.execute(request({
        request_id: 'share-invalid-skill',
        tool_name: SKILLHUB_THIN_RPC_TOOLS.share,
        payload: {
          bot_uid: '42',
          local_skill_id: invalid?.local_skill_id,
          skill_name: 'test_8_7',
          confirm_publish: true,
        },
      })),
      (error: any) => (
        error instanceof SkillHubThinRpcError
        && error.code === 'LOCAL_SKILL_INVALID'
        && /name.*description.*YAML frontmatter/i.test(error.message)
      ),
    );
  });

  test('returns LOCAL_SKILL_INVALID for non-string or blank share metadata', async () => {
    const skillRoot = path.join(runtimeRoot, 'skills', 'metadata-validation');
    fs.mkdirSync(skillRoot, { recursive: true });
    const invalidValues = [
      { label: 'blank', yaml: '"   "' },
      { label: 'number', yaml: '123' },
      { label: 'array', yaml: '[value]' },
      { label: 'object', yaml: '{ value: text }' },
    ];

    for (const field of ['name', 'description'] as const) {
      for (const invalid of invalidValues) {
        const metadata = {
          name: 'valid-name',
          description: 'Valid description',
          [field]: invalid.yaml,
        };
        fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
          '---',
          `name: ${metadata.name}`,
          `description: ${metadata.description}`,
          '---',
          '',
        ].join('\n'));
        const error = validateSkillHubShareMetadata(skillRoot);
        assert.ok(error, `${field} accepted ${invalid.label}`);
        assert.match(error.message, /name.*description.*非空文本/i);

        const requestSuffix = `${field}-${invalid.label}`;
        const workspace = await handler.execute(request({
          request_id: `workspace-invalid-${requestSuffix}`,
        }));
        const entry = (workspace.skills as Array<Record<string, unknown>>)
          .find(skill => skill.relative_path === 'metadata-validation');
        assert.ok(entry?.local_skill_id);
        assert.equal(entry?.can_share, false);
        await assert.rejects(
          handler.execute(request({
            request_id: `share-invalid-${requestSuffix}`,
            tool_name: SKILLHUB_THIN_RPC_TOOLS.share,
            payload: {
              bot_uid: '42',
              local_skill_id: entry.local_skill_id,
              skill_name: entry.name,
              confirm_publish: true,
            },
          })),
          (rpcError: any) => (
            rpcError instanceof SkillHubThinRpcError
            && rpcError.code === 'LOCAL_SKILL_INVALID'
            && /name.*description.*非空文本/i.test(rpcError.message)
          ),
        );
      }
    }
  });

  test('rejects a Skill name with surrounding whitespace before CatsCo authentication', async () => {
    const skillRoot = path.join(runtimeRoot, 'skills', 'whitespace-name');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'name: " demo "',
      'description: Valid description',
      '---',
      '',
    ].join('\n'));

    const metadataError = validateSkillHubShareMetadata(skillRoot);
    assert.ok(metadataError);
    assert.match(metadataError.message, /name.*首尾空格/);
    const workspace = await handler.execute(request({ request_id: 'workspace-whitespace-name' }));
    const entry = (workspace.skills as Array<Record<string, unknown>>)
      .find(skill => skill.relative_path === 'whitespace-name');
    assert.ok(entry?.local_skill_id);
    assert.equal(entry.name, 'demo');
    assert.equal(entry.can_share, false);

    const originalFetch = global.fetch;
    let authExchangeCalls = 0;
    let remoteRequestCount = 0;
    global.fetch = async (input: string | URL | Request) => {
      remoteRequestCount += 1;
      if (new URL(String(input)).pathname === '/api/auth/catsco-exchange') {
        authExchangeCalls += 1;
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    };
    try {
      await assert.rejects(
        handler.execute(request({
          request_id: 'share-whitespace-name',
          tool_name: SKILLHUB_THIN_RPC_TOOLS.share,
          payload: {
            bot_uid: '42',
            local_skill_id: entry.local_skill_id,
            skill_name: entry.name,
            confirm_publish: true,
          },
        })),
        (error: any) => (
          error instanceof SkillHubThinRpcError
          && error.code === 'LOCAL_SKILL_INVALID'
        ),
      );
    } finally {
      global.fetch = originalFetch;
    }
    assert.equal(authExchangeCalls, 0);
    assert.equal(remoteRequestCount, 0);
  });

  test('sorts valid and rejected local Skills by the complete canonical ID', async () => {
    const skillsRoot = path.join(runtimeRoot, 'skills');
    writeBotSkillLocalMarker(path.join(skillsRoot, 'local-demo'), {
      schema: 'xiaoba.bot-skill-local.v1',
      localSkillId: 'a',
    });
    const fixtures = [
      { directory: 'upper', name: 'upper', localSkillId: 'A', blocked: false },
      { directory: 'dash', name: 'dash', localSkillId: 'a-b', blocked: true },
      { directory: 'underscore', name: 'underscore', localSkillId: 'a_b', blocked: false },
    ];
    for (const fixture of fixtures) {
      const skillRoot = path.join(skillsRoot, fixture.directory);
      fs.mkdirSync(skillRoot, { recursive: true });
      fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
        '---',
        `name: ${fixture.name}`,
        'description: Ordering fixture',
        '---',
        '',
      ].join('\n'));
      writeBotSkillLocalMarker(skillRoot, {
        schema: 'xiaoba.bot-skill-local.v1',
        localSkillId: fixture.localSkillId,
      });
      if (fixture.blocked) {
        fs.writeFileSync(
          path.join(skillRoot, 'SKILL.md'),
          '---\nname: [unterminated\ndescription: Broken YAML\n---\n',
        );
      }
    }

    const result = await handler.execute(request({ request_id: 'workspace-canonical-order' }));
    const skills = result.skills as Array<Record<string, unknown>>;
    assert.deepEqual(skills.map(skill => skill.local_skill_id), ['A', 'a', 'a-b', 'a_b']);
    assert.equal(skills.find(skill => skill.local_skill_id === 'a-b')?.can_share, false);
  });

  test('rejects another owner, device, inactive Bot, and expired requests', async () => {
    await assert.rejects(
      handler.execute(request({ request_id: 'owner', target_owner_user_id: 'usr8' })),
      (error: any) => error instanceof SkillHubThinRpcError && error.code === 'OWNER_MISMATCH',
    );
    await assert.rejects(
      handler.execute(request({ request_id: 'device', target_device_id: 'other-device' })),
      (error: any) => error instanceof SkillHubThinRpcError && error.code === 'DEVICE_MISMATCH',
    );
    await assert.rejects(
      handler.execute(request({ request_id: 'bot', payload: { bot_uid: '44' } })),
      (error: any) => error instanceof SkillHubThinRpcError && error.code === 'BOT_NOT_ACTIVE',
    );
    await assert.rejects(
      handler.execute(request({ request_id: 'expired', expires_at: Date.now() - 1 })),
      (error: any) => error instanceof SkillHubThinRpcError && error.code === 'REQUEST_EXPIRED',
    );
  });

  test('schedules an explicit Bot switch once for a replayed request', async () => {
    const switchRequest = request({
      request_id: 'switch-1',
      tool_name: SKILLHUB_THIN_RPC_TOOLS.switchBot,
      payload: { bot_uid: '44' },
    });
    const first = await handler.execute(switchRequest);
    const second = await handler.execute(switchRequest);
    assert.equal(first.switching, true);
    assert.deepEqual(second, first);
    assert.deepEqual(scheduledBotUIDs, ['44']);
  });

  test('reports an in-progress workspace handoff as a retryable RPC state', async () => {
    createCatsCoLocalConfigService({ runtimeRoot }).save({
      version: 1,
      account: { token: 'user-token', uid: '7', username: 'alice' },
      currentBot: { uid: '44', apiKey: 'bot-44-key', boundByUserUid: '7' },
      device: {
        deviceId: 'alice-device',
        bodyId: 'alice-device',
        installationId: 'alice-device',
      },
    });

    await assert.rejects(
      handler.execute(request({
        request_id: 'workspace-switching',
        payload: { bot_uid: '44' },
      })),
      (error: unknown) => (
        error instanceof SkillHubThinRpcError
        && error.code === 'WORKSPACE_SWITCHING'
        && /ownership is changing \(42 -> 44\)/i.test(error.message)
      ),
    );
  });

  test('rejects reuse of one request ID for a different operation', async () => {
    await handler.execute(request({ request_id: 'reused-request' }));
    await assert.rejects(
      handler.execute(request({
        request_id: 'reused-request',
        tool_name: SKILLHUB_THIN_RPC_TOOLS.switchBot,
        payload: { bot_uid: '44' },
      })),
      (error: any) => error instanceof SkillHubThinRpcError && error.code === 'REQUEST_ID_CONFLICT',
    );
  });

  test('revalidates the current local owner before returning a cached RPC result', async () => {
    const replayed = request({ request_id: 'owner-replay' });
    await handler.execute(replayed);
    const configService = createCatsCoLocalConfigService({ runtimeRoot });
    const config = configService.load();
    configService.save({
      ...config,
      account: { ...config.account, uid: '8' },
      currentBot: { ...config.currentBot!, boundByUserUid: '8' },
    });
    await assert.rejects(
      handler.execute(replayed),
      (error: any) => error instanceof SkillHubThinRpcError && error.code === 'OWNER_MISMATCH',
    );
  });

  test('marks a previously public Skill shareable again after local edits', async () => {
    const entry = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    const skillFile = path.join(entry.path, 'SKILL.md');
    fs.writeFileSync(skillFile, applySkillHubLocalMetadata(fs.readFileSync(skillFile, 'utf8'), {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    }));
    const canonical = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    writeBotSkillLocalMarker(canonical.path, {
      schema: 'xiaoba.bot-skill-local.v1',
      localSkillId: canonical.localSkillId,
      reference: {
        source: 'skillhub',
        skillId: 'alice/local-demo',
        version: '1.0.0',
        contentHash: canonical.contentHash,
      },
      origin: { skillId: 'alice/local-demo', version: '1.0.0' },
    });
    fs.appendFileSync(skillFile, '\nLocal edit\n');

    const result = await handler.execute(request({ request_id: 'workspace-edited-public' }));
    const skills = result.skills as Array<Record<string, unknown>>;
    assert.equal(skills[0].can_share, true);
  });

  test('shares the exact local Skill selected by local_skill_id when names collide', async () => {
    const secondRoot = path.join(runtimeRoot, 'skills', 'second-demo');
    fs.mkdirSync(secondRoot, { recursive: true });
    fs.writeFileSync(path.join(secondRoot, 'SKILL.md'), [
      '---',
      'name: local-demo',
      'description: Second local demo',
      '---',
      '',
      '# Second Local Demo',
      '',
    ].join('\n'));
    const nestedRoot = path.join(secondRoot, 'nested-skill');
    fs.mkdirSync(nestedRoot, { recursive: true });
    fs.writeFileSync(path.join(nestedRoot, 'SKILL.md'), [
      '---',
      'name: nested-skill',
      'description: Independent nested Skill',
      '---',
      '',
      '# Nested Skill',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(nestedRoot, 'secret.txt'), 'must not be uploaded with the parent');
    const selected = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))
      .find(entry => entry.installName === 'second-demo');
    assert.ok(selected);
    const blockedSibling = path.join(runtimeRoot, 'skills', 'blocked-sibling');
    fs.mkdirSync(blockedSibling, { recursive: true });
    fs.writeFileSync(path.join(blockedSibling, 'SKILL.md'), [
      '---',
      'name: blocked-sibling',
      'description: Unrelated local-only Skill',
      '---',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(blockedSibling, '.env'), 'API_KEY=local-only\n');
    const originalFetch = global.fetch;
    let uploadedSkill = '';
    let uploadedPaths: string[] = [];
    let shareResult: Record<string, unknown> | undefined;
    global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/auth/catsco-exchange') {
        return Response.json({
          user: { id: 'skillhub-user' },
          roles: ['developer'],
          permissions: [],
          catsCo: { uid: '7', username: 'alice', displayName: 'Alice' },
        });
      }
      if (url.pathname === '/api/auth/me') {
        return Response.json({
          user: { id: 'skillhub-user' },
          roles: ['developer'],
          permissions: [],
        });
      }
      if (url.pathname === '/api/skills/share') {
        const body = JSON.parse(String(init?.body || '{}'));
        assert.equal(body.confirmVersionPublish, true);
        uploadedPaths = body.source.files.map((file: any) => String(file.path));
        const skillFile = body.source.files.find((file: any) => file.path === 'SKILL.md');
        uploadedSkill = Buffer.from(skillFile.contentBase64, 'base64').toString('utf8');
        return Response.json({
          skillId: 'alice/local-demo',
          packageVersion: {
            skillId: 'alice/local-demo',
            version: '2.0.0',
            contentHash: 'a'.repeat(64),
          },
          skillHub: {
            author: 'alice',
            version: '2.0.0',
            uploadedAt: '2026-08-06T00:00:00.000Z',
          },
        }, { status: 201 });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    };
    try {
      shareResult = await handler.execute(request({
        request_id: 'share-second-demo',
        tool_name: SKILLHUB_THIN_RPC_TOOLS.share,
        payload: {
          bot_uid: '42',
          local_skill_id: selected.localSkillId,
          skill_name: selected.name,
          confirm_publish: true,
        },
      }));
    } finally {
      global.fetch = originalFetch;
    }
    assert.match(uploadedSkill, /# Second Local Demo/);
    assert.doesNotMatch(uploadedSkill, /# Local Demo/);
    assert.equal(uploadedPaths.some(file => file.startsWith('nested-skill/')), false);
    assert.equal((shareResult?.skill as Record<string, unknown>)?.id, 'alice/local-demo');
    assert.equal(shareResult?.latest_version, '2.0.0');
    assert.equal(shareResult?.content_hash, 'a'.repeat(64));
    assert.equal(readSkillHubLocalMetadata(path.join(selected.path, 'SKILL.md')), null);
  });

  test('rejects a Bot switch when the local Dashboard returns a non-success status', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await assert.rejects(
      requestDashboardBotSwitch('44', async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('', { status: 503 });
      }),
      /HTTP 503/,
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:\d+\/api\/cats\/switch-bot$/);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { botUid: '44' });
  });

  test('coalesces delayed Bot switch intents so the latest selection wins', async () => {
    const calls: string[] = [];
    const scheduler = new DashboardBotSwitchScheduler(async (botUid) => {
      calls.push(botUid);
    }, 5);

    scheduler.schedule('575');
    scheduler.schedule('412');
    scheduler.schedule('412');
    await delay(30);

    assert.deepEqual(calls, ['412']);
  });

  test('serializes a newer Bot switch behind an in-flight switch', async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    let concurrent = 0;
    let maxConcurrent = 0;
    const scheduler = new DashboardBotSwitchScheduler(async (botUid) => {
      calls.push(botUid);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (botUid === '575') await first;
      concurrent -= 1;
    }, 5);

    scheduler.schedule('575');
    await delay(15);
    scheduler.schedule('412');
    releaseFirst();
    await delay(40);

    assert.deepEqual(calls, ['575', '412']);
    assert.equal(maxConcurrent, 1);
  });

  test('cancels an opposite queued switch when the latest target is already in flight', async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const scheduler = new DashboardBotSwitchScheduler(async (botUid) => {
      calls.push(botUid);
      if (botUid === '575') await first;
    }, 5);

    scheduler.schedule('575');
    await delay(15);
    scheduler.schedule('412');
    scheduler.schedule('575');
    releaseFirst();
    await delay(30);

    assert.deepEqual(calls, ['575']);
  });

  test('refreshes a coalesced switch with the latest connector lifecycle', async () => {
    const calls: string[] = [];
    const scheduler = new DashboardBotSwitchScheduler(async (botUid) => {
      calls.push(botUid);
    }, 5);

    let oldConnectorShuttingDown = false;
    scheduler.schedule('575', () => oldConnectorShuttingDown);
    oldConnectorShuttingDown = true;
    scheduler.schedule('575', () => false);
    await delay(30);

    assert.deepEqual(calls, ['575']);
  });

  test('does not postpone a pending switch when the same target is repeated', async () => {
    const calls: string[] = [];
    const scheduler = new DashboardBotSwitchScheduler(async (botUid) => {
      calls.push(botUid);
    }, 20);

    scheduler.schedule('575');
    await delay(8);
    scheduler.schedule('575');
    await delay(8);
    scheduler.schedule('575');
    await delay(12);

    assert.deepEqual(calls, ['575']);
  });

  test('does not drain a queued switch after application shutdown begins', async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    let shuttingDown = false;
    const scheduler = new DashboardBotSwitchScheduler(async (botUid) => {
      calls.push(botUid);
      if (botUid === '575') await first;
    }, 5);

    scheduler.schedule('575');
    await delay(15);
    scheduler.schedule('412', () => shuttingDown);
    shuttingDown = true;
    releaseFirst();
    await delay(40);

    assert.deepEqual(calls, ['575']);
  });

  test('revalidates the local Skill identity while holding the upload lock', async () => {
    await assert.rejects(
      shareLocalSkillForCatsCo({
        skillName: 'local-demo',
        expectedLocalSkillId: 'replaced-local-skill',
        expectedBotUid: '42',
        expectedUserUid: '7',
      }, {
        writeLocalMetadata: false,
        runtimeRoot,
        getCatsCoAuth: () => ({
          token: 'user-token',
          baseUrl: 'https://app.catsco.cc',
          user: { uid: '7', username: 'alice' },
        }),
      }),
      (error: any) => error?.code === 'skillhub.share_local_skill_changed',
    );
  });

  test('revalidates malformed YAML under the upload lock before authentication', async () => {
    const selected = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    await handler.execute(request({ request_id: 'metadata-first-lock' }));
    fs.writeFileSync(path.join(selected.path, 'SKILL.md'), [
      '---',
      'name: [unterminated',
      'description: Broken YAML',
      '---',
      '',
    ].join('\n'));
    let localAuthReads = 0;
    let authExchangeCalls = 0;
    let uploadCalls = 0;

    await assert.rejects(
      shareLocalSkillForCatsCo({
        skillName: selected.name,
        expectedLocalSkillId: selected.localSkillId,
        expectedBotUid: '42',
        expectedUserUid: '7',
      }, {
        writeLocalMetadata: false,
        runtimeRoot,
        getCatsCoAuth: () => {
          localAuthReads += 1;
          return {
            token: 'user-token',
            baseUrl: 'https://app.catsco.cc',
            user: { uid: '7', username: 'alice' },
          };
        },
        createSkillHubService: () => ({
          loginWithCatsCo: async () => {
            authExchangeCalls += 1;
            throw new Error('remote authentication should not be reached');
          },
          shareLocalSkill: async () => {
            uploadCalls += 1;
            throw new Error('remote upload should not be reached');
          },
        }),
      }),
      (error: any) => (
        error?.code === 'skillhub.share_local_skill_invalid'
        && /SKILL\.md format is invalid.*YAML frontmatter/i.test(error.message)
        && !error.message.includes(runtimeRoot)
      ),
    );
    assert.equal(localAuthReads, 1);
    assert.equal(authExchangeCalls, 0);
    assert.equal(uploadCalls, 0);
  });

  test('redacts local paths when locked workspace scanning fails before authentication', async () => {
    const selected = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    fs.writeFileSync(path.join(selected.path, '.xiaoba-bot-skill.json'), '{ invalid json');
    let authExchangeCalls = 0;
    let uploadCalls = 0;

    await assert.rejects(
      handler.execute(request({
        request_id: 'share-invalid-marker',
        tool_name: SKILLHUB_THIN_RPC_TOOLS.share,
        payload: {
          bot_uid: '42',
          local_skill_id: selected.localSkillId,
          skill_name: selected.name,
          confirm_publish: true,
        },
      })),
      (error: any) => (
        error instanceof SkillHubThinRpcError
        && error.code === 'LOCAL_SKILL_INVALID'
        && error.message === 'The local Skill workspace could not be validated safely.'
        && !error.message.includes(runtimeRoot)
        && !error.message.includes(selected.path)
      ),
    );

    await assert.rejects(
      shareLocalSkillForCatsCo({
        skillName: selected.name,
        expectedLocalSkillId: selected.localSkillId,
        expectedBotUid: '42',
        expectedUserUid: '7',
      }, {
        writeLocalMetadata: false,
        runtimeRoot,
        getCatsCoAuth: () => ({
          token: 'user-token',
          baseUrl: 'https://app.catsco.cc',
          user: { uid: '7', username: 'alice' },
        }),
        createSkillHubService: () => ({
          loginWithCatsCo: async () => {
            authExchangeCalls += 1;
            throw new Error('remote authentication should not be reached');
          },
          shareLocalSkill: async () => {
            uploadCalls += 1;
            throw new Error('remote upload should not be reached');
          },
        }),
      }),
      (error: any) => (
        error?.code === 'skillhub.share_local_skill_invalid'
        && error.message === 'The selected local Skill could not be validated safely.'
        && !error.message.includes(runtimeRoot)
        && !error.message.includes(selected.path)
      ),
    );
    assert.equal(authExchangeCalls, 0);
    assert.equal(uploadCalls, 0);
  });

  test('redacts malformed YAML introduced during authentication before quick share', async () => {
    const selected = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    const productionService = new SkillHubService({
      baseUrl: 'http://127.0.0.1:1',
      sessionScope: 'memory',
    });
    let authExchangeCalls = 0;
    let localSharePreparations = 0;

    await assert.rejects(
      shareLocalSkillForCatsCo({
        skillName: selected.name,
        expectedLocalSkillId: selected.localSkillId,
        expectedBotUid: '42',
        expectedUserUid: '7',
      }, {
        writeLocalMetadata: false,
        runtimeRoot,
        getCatsCoAuth: () => ({
          token: 'user-token',
          baseUrl: 'https://app.catsco.cc',
          user: { uid: '7', username: 'alice' },
        }),
        createSkillHubService: () => ({
          loginWithCatsCo: async () => {
            authExchangeCalls += 1;
            fs.writeFileSync(path.join(selected.path, 'SKILL.md'), [
              '---',
              'name: [unterminated',
              'description: Broken during authentication',
              '---',
              '',
            ].join('\n'));
            return {
              authenticated: true,
              baseUrl: 'https://skillhub.example.test',
              roles: [],
              permissions: [],
              catsCo: { uid: '7', username: 'alice', displayName: 'Alice' },
            };
          },
          shareLocalSkill: async (input, options) => {
            localSharePreparations += 1;
            return productionService.shareLocalSkill(input, options);
          },
        }),
      }),
      (error: any) => (
        error?.code === 'skillhub.local_skill_invalid'
        && error?.status === 400
        && error.message === 'The selected local Skill could not be validated safely.'
        && !error.message.includes(runtimeRoot)
        && !error.message.includes(selected.path)
      ),
    );
    assert.equal(authExchangeCalls, 1);
    assert.equal(localSharePreparations, 1);
  });

  test('writes share metadata only after revalidating the selected local Skill and scope', async () => {
    const selected = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    const skillFile = path.join(selected.path, 'SKILL.md');
    const movedSkillPath = path.join(runtimeRoot, 'skills', 'moved-local-demo');
    const metadata = {
      author: 'alice',
      version: '1.0.0',
      uploadedAt: '2026-08-06T00:00:00.000Z',
    };
    const originalFetch = global.fetch;
    let scopeValidations = 0;
    global.fetch = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/auth/catsco-exchange') {
        return Response.json({
          user: { id: 'skillhub-user' },
          roles: ['developer'],
          permissions: [],
          catsCo: { uid: '7', username: 'alice', displayName: 'Alice' },
        });
      }
      if (url.pathname === '/api/auth/me') {
        return Response.json({
          user: { id: 'skillhub-user' },
          roles: ['developer'],
          permissions: [],
        });
      }
      if (url.pathname === '/api/skills/share') {
        fs.renameSync(selected.path, movedSkillPath);
        return Response.json({
          skillId: 'alice/local-demo',
          packageVersion: {
            skillId: 'alice/local-demo',
            version: metadata.version,
            contentHash: 'b'.repeat(64),
          },
          skillHub: metadata,
        }, { status: 201 });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    };
    let result: Record<string, any>;
    try {
      result = await shareLocalSkillForCatsCo({
        skillName: selected.name,
        expectedLocalSkillId: selected.localSkillId,
        expectedBotUid: '42',
        expectedUserUid: '7',
      }, {
        runtimeRoot,
        getCatsCoAuth: () => ({
          token: 'user-token',
          baseUrl: 'https://app.catsco.cc',
          user: { uid: '7', username: 'alice' },
        }),
        validateScope: () => {
          scopeValidations += 1;
          const currentSkillFile = fs.existsSync(skillFile)
            ? skillFile
            : path.join(movedSkillPath, 'SKILL.md');
          assert.equal(readSkillHubLocalMetadata(currentSkillFile), null);
        },
      });
    } finally {
      global.fetch = originalFetch;
    }

    assert.equal(scopeValidations, 2);
    assert.equal(result.botUid, '42');
    assert.deepEqual(result.skillHub, metadata);
    assert.equal(fs.existsSync(skillFile), false);
    assert.deepEqual(
      readSkillHubLocalMetadata(path.join(movedSkillPath, 'SKILL.md')),
      metadata,
    );
  });

  test('uploads arbitrary files without content-policy blocking', async () => {
    const sensitiveFiles = [
      { name: '.env', content: 'API_KEY=not-a-real-secret\n' },
      { name: 'private.pem', content: '-----BEGIN PRIVATE KEY-----\nplaceholder\n' },
      { name: 'archive.zip', content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]) },
      { name: 'config.txt', content: 'access_token=ghp_123456789012345678901234567890\n' },
    ];

    for (const sensitiveFile of sensitiveFiles) {
      const skillPath = path.join(runtimeRoot, 'skills', 'local-demo');
      const sensitivePath = path.join(skillPath, sensitiveFile.name);
      fs.writeFileSync(sensitivePath, sensitiveFile.content);
      const selected = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))
        .find(entry => entry.path === skillPath);
      assert.ok(selected);
      const originalFetch = global.fetch;
      let shareCalls = 0;
      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/auth/catsco-exchange') {
          return Response.json({
            user: { id: 'skillhub-user' },
            roles: ['developer'],
            permissions: [],
            catsCo: { uid: '7', username: 'alice', displayName: 'Alice' },
          });
        }
        if (url.pathname === '/api/auth/me') {
          return Response.json({
            user: { id: 'skillhub-user' },
            roles: ['developer'],
            permissions: [],
          });
        }
        if (url.pathname === '/api/skills/share') {
          shareCalls += 1;
          const body = JSON.parse(String(init?.body || '{}'));
          assert.equal(
            body.source.files.some((file: any) => file.path === sensitiveFile.name),
            true,
          );
          return Response.json({
            skillId: 'alice/local-demo',
            packageVersion: {
              skillId: 'alice/local-demo',
              version: '1.0.0',
              contentHash: 'c'.repeat(64),
            },
            skillHub: {
              author: 'alice',
              version: '1.0.0',
              uploadedAt: '2026-08-06T00:00:00.000Z',
            },
          }, { status: 201 });
        }
        return Response.json({ error: `unexpected request: ${url.pathname}` }, { status: 500 });
      };
      try {
        await shareLocalSkillForCatsCo({
            skillName: selected.name,
            expectedLocalSkillId: selected.localSkillId,
            expectedBotUid: '42',
            expectedUserUid: '7',
          }, {
            writeLocalMetadata: false,
            runtimeRoot,
            getCatsCoAuth: () => ({
              token: 'user-token',
              baseUrl: 'https://app.catsco.cc',
              user: { uid: '7', username: 'alice' },
            }),
          });
      } finally {
        global.fetch = originalFetch;
        fs.rmSync(sensitivePath, { force: true });
      }
      assert.equal(shareCalls, 1, `remote share was called once for ${sensitiveFile.name}`);
    }
  });

  test('finalizes only when sync still belongs to the requested Bot', async () => {
    const localEntry = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    const reference = {
      source: 'skillhub' as const,
      skillId: 'alice/local-demo',
      version: '1.0.0',
      contentHash: 'd'.repeat(64),
    };
    const finalizeHandler = new SkillHubThinRpcHandler({
      runtimeRoot,
      finalizeCurrentBotSkill: async (botUid, input, options) => {
        assert.equal(botUid, '42');
        assert.equal(input.localSkillId, localEntry.localSkillId);
        assert.equal(input.skillName, localEntry.name);
        assert.deepEqual(input.reference, reference);
        await options.validateScope?.();
        return {
          botId: '42',
          direction: 'local_to_cloud',
          skills: [reference],
        };
      },
    });
    const result = await finalizeHandler.execute(request({
      request_id: 'finalize-ok',
      tool_name: SKILLHUB_THIN_RPC_TOOLS.finalize,
      payload: {
        bot_uid: '42',
        local_skill_id: localEntry.localSkillId,
        skill_name: localEntry.name,
        skill_id: reference.skillId,
        version: reference.version,
        content_hash: reference.contentHash,
      },
    }));
    assert.equal(result.direction, 'local_to_cloud');

    const switchedHandler = new SkillHubThinRpcHandler({
      runtimeRoot,
      finalizeCurrentBotSkill: async () => ({
        botId: '43',
        direction: 'none',
        skills: [reference],
      }),
    });
    await assert.rejects(
      switchedHandler.execute(request({
        request_id: 'finalize-switched',
        tool_name: SKILLHUB_THIN_RPC_TOOLS.finalize,
        payload: {
          bot_uid: '42',
          local_skill_id: localEntry.localSkillId,
          skill_name: localEntry.name,
          skill_id: reference.skillId,
          version: reference.version,
          content_hash: reference.contentHash,
        },
      })),
      (error: any) => error instanceof SkillHubThinRpcError && error.code === 'BOT_NOT_ACTIVE',
    );
  });

  test('stops finalization when the device request expires during publication wait', async () => {
    const localEntry = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    const reference = {
      source: 'skillhub' as const,
      skillId: 'alice/local-demo',
      version: '1.0.0',
      contentHash: 'e'.repeat(64),
    };
    const expiringHandler = new SkillHubThinRpcHandler({
      runtimeRoot,
      finalizeCurrentBotSkill: async (_botUid, _input, options) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        await options.validateScope?.();
        return {
          botId: '42',
          direction: 'local_to_cloud',
          skills: [reference],
        };
      },
    });
    await assert.rejects(
      expiringHandler.execute(request({
        request_id: 'finalize-expired-during-wait',
        tool_name: SKILLHUB_THIN_RPC_TOOLS.finalize,
        expires_at: Date.now() + 5,
        payload: {
          bot_uid: '42',
          local_skill_id: localEntry.localSkillId,
          skill_name: localEntry.name,
          skill_id: reference.skillId,
          version: reference.version,
          content_hash: reference.contentHash,
        },
      })),
      (error: any) => error instanceof SkillHubThinRpcError && error.code === 'REQUEST_EXPIRED',
    );
  });

  test('stops finalization writes when connector shutdown starts during the operation', async () => {
    const localEntry = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    const reference = {
      source: 'skillhub' as const,
      skillId: 'alice/local-demo',
      version: '1.0.0',
      contentHash: 'f'.repeat(64),
    };
    let shuttingDown = false;
    let writes = 0;
    const shutdownHandler = new SkillHubThinRpcHandler({
      runtimeRoot,
      isShuttingDown: () => shuttingDown,
      finalizeCurrentBotSkill: async (_botUid, _input, options) => {
        await Promise.resolve();
        shuttingDown = true;
        await options.validateScope?.();
        writes += 1;
        return {
          botId: '42',
          direction: 'local_to_cloud',
          skills: [reference],
        };
      },
    });

    await assert.rejects(
      shutdownHandler.execute(request({
        request_id: 'finalize-shutdown',
        tool_name: SKILLHUB_THIN_RPC_TOOLS.finalize,
        payload: {
          bot_uid: '42',
          local_skill_id: localEntry.localSkillId,
          skill_name: localEntry.name,
          skill_id: reference.skillId,
          version: reference.version,
          content_hash: reference.contentHash,
        },
      })),
      (error: any) => error instanceof SkillHubThinRpcError && error.code === 'SHUTTING_DOWN',
    );
    assert.equal(writes, 0);
  });

  function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function request(overrides: Record<string, any> = {}): any {
    return {
      type: 'request',
      request_id: 'request-1',
      target_owner_user_id: 'usr7',
      target_device_id: 'alice-device',
      device_id: 'alice-device',
      tool_name: SKILLHUB_THIN_RPC_TOOLS.workspace,
      payload: { bot_uid: '42' },
      expires_at: Date.now() + 30_000,
      ...overrides,
    };
  }
});
