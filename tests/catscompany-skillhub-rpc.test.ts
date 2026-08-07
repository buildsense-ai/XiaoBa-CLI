import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import {
  SkillHubThinRpcError,
  SkillHubThinRpcHandler,
  SKILLHUB_THIN_RPC_TOOLS,
  requestDashboardBotSwitch,
} from '../src/catscompany/skillhub-rpc';
import { BotSkillWorkspaceService } from '../src/bot-skills/workspace';
import { shareLocalSkillForCatsCo } from '../src/skillhub/local-share';
import { scanBotSkillWorkspace } from '../src/bot-skills/local-manifest';
import { writeBotSkillLocalMarker } from '../src/bot-skills/local-manifest';
import {
  applySkillHubLocalMetadata,
  readSkillHubLocalMetadata,
} from '../src/skillhub/local-skill-metadata';

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
    });
  });

  afterEach(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
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
  });

  test('keeps local Skills visible when one package cannot be shared', async () => {
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
    assert.equal(blocked?.can_share, false);
    assert.match(String(blocked?.share_error || ''), /sensitive material/i);
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

    const compatibilityScan = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'));
    assert.equal(compatibilityScan.length, 3);

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
    assert.match(String(malformed?.share_error || ''), /SKILL\.md.*格式无效.*YAML frontmatter/i);

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
      if (fixture.blocked) fs.writeFileSync(path.join(skillRoot, '.env'), 'API_KEY=blocked\n');
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

  test('rejects sensitive files that appear after the initial share scope check', async () => {
    const selected = scanBotSkillWorkspace(path.join(runtimeRoot, 'skills'))[0];
    const sensitiveFiles = [
      { name: '.env', content: 'API_KEY=not-a-real-secret\n' },
      { name: 'private.pem', content: '-----BEGIN PRIVATE KEY-----\nplaceholder\n' },
      { name: 'archive.zip', content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]) },
      { name: 'config.txt', content: 'access_token=ghp_123456789012345678901234567890\n' },
    ];

    for (const sensitiveFile of sensitiveFiles) {
      const sensitivePath = path.join(selected.path, sensitiveFile.name);
      const originalFetch = global.fetch;
      let shareCalls = 0;
      global.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/auth/catsco-exchange') {
          fs.writeFileSync(sensitivePath, sensitiveFile.content);
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
          return Response.json({ error: 'share should not be reached' }, { status: 500 });
        }
        return Response.json({ error: `unexpected request: ${url.pathname}` }, { status: 500 });
      };
      try {
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
          }),
          /(?:sensitive material|archive file)/i,
        );
      } finally {
        global.fetch = originalFetch;
        fs.rmSync(sensitivePath, { force: true });
      }
      assert.equal(shareCalls, 0, `remote share was called for ${sensitiveFile.name}`);
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
