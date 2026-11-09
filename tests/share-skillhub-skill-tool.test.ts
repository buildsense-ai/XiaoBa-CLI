import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { ShareSkillHubSkillTool } from '../src/tools/share-skillhub-skill-tool';
import { SYNTHETIC_USER_MESSAGE_FLAGS } from '../src/core/session-fork';
import { normalizeDirectoryNameToSkillName } from '../src/skillhub/publication-candidate';
import { makeZip } from './helpers/zip-fixture';

test('ordinary publication waits for verification before reporting published and does not resend', async () => {
  let shares = 0, probes = 0;
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample\ndescription: inert\n---\n').toString('base64') }];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_args, options) => {
      shares++; options?.onPackageCaptured?.(files);
      return { skill: { id: 'alice/sample' }, latestVersion: '1.0.2', uploadId: 'upl_exact' };
    },
    verifyPublication: async (id, version, candidate, budget) => {
      probes++; assert.equal(id, 'alice/sample'); assert.equal(version, '1.0.2');
      assert.deepEqual(candidate, files); assert.ok(budget > 0 && budget <= 60_000);
      return { status: 'published' };
    },
  }));
  const result = await tool.execute({ skillName: 'sample' }, { conversationHistory: [] } as any);
  assert.match(String(result.content), /发布成功/); assert.match(String(result.content), /Publication status: published/);
  assert.doesNotMatch(String(result.content), /share submitted/); assert.equal(shares, 1); assert.equal(probes, 1);
});

test('verification setup failure never reports an accepted upload as failed or retries it', async () => {
  let shares = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_args, options) => {
      shares++; options?.onPackageCaptured?.([{ path: 'SKILL.md', contentBase64: 'eA==' }]);
      return { skill: { id: 'alice/sample' }, latestVersion: '1.0.2' };
    }, verifyPublication: async () => ({ status: 'published' }),
  }));
  const result = await tool.execute({ skillName: 'sample' }, { conversationHistory: [],
    channel: { chatId: 'topic', createFollowUp: () => { throw new Error('not available'); } },
  } as any);
  assert.equal(result.ok, true); assert.match(String(result.content), /Publication status: submitted/);
  assert.match(String(result.content), /follow-up: unavailable/); assert.equal(shares, 1);
});

test('publication receipt reports server version and upload ID separately from guide generation', async () => {
  const tool = new ShareSkillHubSkillTool(() => ({ shareLocalSkill: async () => ({
    skill: { id: 'alice/sample', name: 'sample' }, latestVersion: '1.0.10',
    submission: { upload: { id: 'upload-real-id', version: '1.0.10' } },
  }) }));
  const result = await tool.execute({ skillName: 'sample' }, { conversationHistory: [] } as any);
  assert.equal(result.ok, true);
  assert.match(String(result.content), /Skill ID: alice\/sample/);
  assert.match(String(result.content), /Assigned version: 1\.0\.10/);
  assert.match(String(result.content), /Upload ID: upload-real-id/);
  assert.match(String(result.content), /Publication status: submitted/);
  assert.match(String(result.content), /Chinese guide status: independent/);
  assert.doesNotMatch(String(result.content), /Submission: unknown/);
});

test('automatically selects a direct .skill attachment and rejects non-ZIP .skill data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-direct-skill-'));
  const file = path.join(root, 'sample.skill');
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({ shareLocalSkill: async (_input, options) => {
    calls++;
    assert.equal(path.basename(options!.localSkillPath!), 'sample');
    return { skill: { id: 'alice/sample' }, latestVersion: '1.0.0' };
  } }));
  try {
    fs.writeFileSync(file, makeZip([{ name: 'sample/SKILL.md', content: Buffer.from('---\nname: sample\ndescription: test\n---\n') }]));
    let result = await tool.execute({}, catscoZipContext([catscoZipGrant(file, 'sample.skill', 'catsco_attachment:direct')], 'direct-skill'));
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    fs.writeFileSync(file, 'not a ZIP');
    result = await tool.execute({}, catscoZipContext([catscoZipGrant(file, 'sample.skill', 'catsco_attachment:invalid')], 'invalid-skill'));
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'SKILLHUB_ZIP_REJECTED');
    assert.equal(calls, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does not read or publish a ZIP attachment without a current CatsCo attachment grant', async () => {
  let serviceCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async () => { serviceCalls++; return {}; },
  }));
  const result = await tool.execute({ zipAttachmentRef: 'catsco_attachment:untrusted' }, {
    surface: 'catscompany',
    sessionId: 'zip-attachment-no-grant',
    conversationHistory: [],
  } as any);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'PERMISSION_DENIED');
  assert.equal(serviceCalls, 0);
});

function validationError(
  reportId: string,
  options: { coverage?: string; location?: unknown; code?: string; repairPolicy?: string } = {},
): Error {
  return Object.assign(new Error('Rejected by publication preflight.'), {
    status: 422,
    code: 'skillhub.publish_validation_failed',
    validation: {
      reportId,
      coverage: options.coverage ?? 'complete',
      issues: [{
        code: options.code ?? 'metadata.name_whitespace',
        category: 'format',
        blocking: true,
        repairPolicy: options.repairPolicy ?? 'automatic',
        location: options.location ?? { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' },
      }],
    },
  });
}

function catscoZipContext(localFileGrants: any[], sessionId: string) {
  const now = Date.now();
  return {
    surface: 'catscompany',
    sessionId,
    conversationHistory: [{ role: 'user', content: '发布这个 ZIP' }],
    currentUserInput: '发布这个 ZIP',
    executionScope: {
      source: 'catscompany', sessionKey: 'cc_user:u1', topicId: 'p2p_1_2', topicType: 'p2p',
      actorUserId: 'u1', agentId: 'agent1', agentBodyId: 'body1', permissionsSource: 'server_canonical_message',
      identityTrust: 'server_canonical', isTrusted: true,
    },
    localDeviceGrant: { kind: 'catscompany_body', source: 'catscompany', bodyId: 'body1', createdAt: now },
    localFileGrants,
  } as any;
}

function catscoZipGrant(filePath: string, fileName: string, attachmentRef: string, now = Date.now()) {
  const stat = fs.statSync(filePath);
  return {
    kind: 'catscompany_attachment', source: 'catscompany', attachmentRef, filePath, fileName,
    fileType: 'file', size: stat.size, mtimeMs: stat.mtimeMs,
    sessionKey: 'cc_user:u1', topicId: 'p2p_1_2', topicType: 'p2p', actorUserId: 'u1', agentId: 'agent1',
    agentBodyId: 'body1', deviceBodyId: 'body1', identityTrust: 'server_canonical',
    operations: ['read_file'], createdAt: now, expiresAt: now + 60_000,
  };
}

test('retains an authorized ZIP temp directory for a description draft without an outbound channel', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-zip-confirmation-test-'));
  const cachedFileName = '20261107T061234.123Z_ab12cd34_my-skill.zip';
  const zipPath = path.join(root, cachedFileName);
  const skillText = '---\nname: my-skill\n---\n# Safe test skill\n';
  await fs.promises.writeFile(zipPath, makeZip([{ name: 'SKILL.md', content: Buffer.from(skillText) }]));
  const stat = await fs.promises.stat(zipPath);
  let extractedDirectory = '';
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      extractedDirectory = String(options?.localSkillPath || '');
      options?.onPackageCaptured?.([{ path: 'SKILL.md', contentBase64: Buffer.from(skillText).toString('base64') }], 'my-skill');
      throw validationError('zip-description-confirmation', {
        code: 'metadata.description_missing',
        repairPolicy: 'confirmation_required',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
      });
    },
  }));
  const now = Date.now();
  const result = await tool.execute({ zipAttachmentRef: 'catsco_attachment:zip-test' }, {
    surface: 'catscompany',
    sessionId: 'zip-no-outbound-channel',
    conversationHistory: [{ role: 'user', content: '发布这个 ZIP' }],
    currentUserInput: '发布这个 ZIP',
    executionScope: {
      source: 'catscompany', sessionKey: 'cc_user:u1', topicId: 'p2p_1_2', topicType: 'p2p',
      actorUserId: 'u1', agentId: 'agent1', agentBodyId: 'body1', permissionsSource: 'server_canonical_message',
      identityTrust: 'server_canonical', isTrusted: true,
    },
    localDeviceGrant: { kind: 'catscompany_body', source: 'catscompany', bodyId: 'body1', createdAt: now },
    localFileGrants: [{
      kind: 'catscompany_attachment', source: 'catscompany', attachmentRef: 'catsco_attachment:zip-test',
      filePath: zipPath, fileName: 'my-skill.zip', fileType: 'file', size: stat.size, mtimeMs: stat.mtimeMs,
      sessionKey: 'cc_user:u1', topicId: 'p2p_1_2', topicType: 'p2p', actorUserId: 'u1', agentId: 'agent1',
      agentBodyId: 'body1', deviceBodyId: 'body1', identityTrust: 'server_canonical',
      operations: ['read_file'], createdAt: now, expiresAt: now + 60_000,
    }],
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"用于测试 ZIP 发布确认流程。"}' }) } },
  } as any);

  try {
    assert.equal(result.ok, true);
    assert.equal(result.controlSignal, undefined);
    assert.match(String(result.content), /用于测试 ZIP 发布确认流程/);
    assert.equal(path.basename(extractedDirectory), 'my-skill');
    assert.equal(fs.existsSync(path.join(extractedDirectory, 'SKILL.md')), true);
  } finally {
    await fs.promises.rm(path.dirname(extractedDirectory), { recursive: true, force: true });
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('selects the single authorized ZIP from current CatsCo attachments without exposing its opaque reference', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-zip-auto-select-test-'));
  const zipPath = path.join(root, 'automatic-selection.zip');
  const skillText = '---\nname: automatic-selection\ndescription: inert test fixture\n---\n# No-op test fixture\n';
  await fs.promises.writeFile(zipPath, makeZip([{ name: 'SKILL.md', content: Buffer.from(skillText) }]));
  let capturedPath = '';
  let serviceCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      serviceCalls++;
      capturedPath = String(options?.localSkillPath || '');
      assert.equal(fs.readFileSync(path.join(capturedPath, 'SKILL.md'), 'utf8'), skillText);
      return { submission: { id: 'submission-auto-selected' }, skill: { name: 'automatic-selection' } };
    },
  }));

  try {
    const result = await tool.execute({}, catscoZipContext([
      catscoZipGrant(zipPath, 'automatic-selection.zip', 'catsco_attachment:hidden-ref'),
    ], 'zip-auto-select'));
    assert.equal(result.ok, true);
    assert.equal(serviceCalls, 1);
    assert.match(String(result.content), /automatic-selection/);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('requires an exact filename to select among multiple authorized ZIP attachments', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-zip-ambiguous-test-'));
  const firstPath = path.join(root, 'first.zip');
  const secondPath = path.join(root, 'second.zip');
  const skillText = '---\nname: selected-zip\ndescription: inert test fixture\n---\n# No-op test fixture\n';
  const archive = makeZip([{ name: 'SKILL.md', content: Buffer.from(skillText) }]);
  await fs.promises.writeFile(firstPath, archive);
  await fs.promises.writeFile(secondPath, archive);
  let serviceCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async () => { serviceCalls++; return { submission: { id: 'submission-selected' }, skill: { name: 'selected-zip' } }; },
  }));
  const context = catscoZipContext([
    catscoZipGrant(firstPath, 'first.zip', 'catsco_attachment:first-ref'),
    catscoZipGrant(secondPath, 'second.zip', 'catsco_attachment:second-ref'),
  ], 'zip-ambiguous');

  try {
    const ambiguous = await tool.execute({}, context);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.message, /select one by its exact attached filename/i);
    assert.equal(serviceCalls, 0);

    const selected = await tool.execute({ zipAttachmentName: 'second.zip' }, context);
    assert.equal(selected.ok, true);
    assert.equal(serviceCalls, 1);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('asks for a renamed reattachment when multiple authorized ZIPs share the same filename', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-zip-duplicate-name-test-'));
  const firstPath = path.join(root, 'first.zip');
  const secondPath = path.join(root, 'second.zip');
  const skillText = '---\nname: duplicate-name\ndescription: inert test fixture\n---\n# No-op test fixture\n';
  const archive = makeZip([{ name: 'SKILL.md', content: Buffer.from(skillText) }]);
  await fs.promises.writeFile(firstPath, archive);
  await fs.promises.writeFile(secondPath, archive);
  let serviceCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async () => { serviceCalls++; return {}; },
  }));
  const context = catscoZipContext([
    catscoZipGrant(firstPath, 'skill.zip', 'catsco_attachment:first-ref'),
    catscoZipGrant(secondPath, 'skill.zip', 'catsco_attachment:second-ref'),
  ], 'zip-duplicate-name');

  try {
    const result = await tool.execute({ zipAttachmentName: 'skill.zip' }, context);
    assert.equal(result.ok, false);
    assert.match(result.message, /Rename the ZIP and attach it again/);
    assert.equal(serviceCalls, 0);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('rejects blank ZIP attachment names and mixed ZIP/local selectors without publishing', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-zip-invalid-selector-test-'));
  const zipPath = path.join(root, 'only.zip');
  const skillText = '---\nname: invalid-selector\ndescription: inert test fixture\n---\n# No-op test fixture\n';
  await fs.promises.writeFile(zipPath, makeZip([{ name: 'SKILL.md', content: Buffer.from(skillText) }]));
  let serviceCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async () => { serviceCalls++; return {}; },
  }));
  const context = catscoZipContext([
    catscoZipGrant(zipPath, 'only.zip', 'catsco_attachment:only-ref'),
  ], 'zip-invalid-selector');

  try {
    const blankName = await tool.execute({ zipAttachmentName: '   ' }, context);
    assert.equal(blankName.ok, false);
    assert.equal(blankName.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.match(blankName.message, /non-empty exact filename/);

    const blankReference = await tool.execute({ zipAttachmentRef: '   ' }, context);
    assert.equal(blankReference.ok, false);
    assert.equal(blankReference.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.match(blankReference.message, /non-empty authorized attachment reference/);

    const mixed = await tool.execute({ zipAttachmentName: 'only.zip', skillName: 'another-skill' }, context);
    assert.equal(mixed.ok, false);
    assert.match(mixed.message, /ZIP attachment selector/);
    assert.equal(serviceCalls, 0);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('does not auto-select a ZIP grant when its CatsCo execution identity does not match', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-zip-wrong-identity-test-'));
  const zipPath = path.join(root, 'identity-mismatch.zip');
  const skillText = '---\nname: identity-mismatch\ndescription: inert test fixture\n---\n# No-op test fixture\n';
  await fs.promises.writeFile(zipPath, makeZip([{ name: 'SKILL.md', content: Buffer.from(skillText) }]));
  let serviceCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async () => { serviceCalls++; return {}; },
  }));
  const context = catscoZipContext([
    catscoZipGrant(zipPath, 'identity-mismatch.zip', 'catsco_attachment:identity-ref'),
  ], 'zip-wrong-identity');
  context.executionScope.actorUserId = 'u2';

  try {
    const result = await tool.execute({}, context);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(serviceCalls, 0);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('automatic name repair retries with a private candidate and preserves comments and local files', async () => {
  const originalFiles = [{
    path: 'SKILL.md',
    contentBase64: Buffer.from('---\nname: " demo " # keep\ndescription: safe\n---\n# Original instructions\n').toString('base64'),
  }];
  const originalContent = originalFiles[0].contentBase64;
  let calls = 0;
  let uploadedCandidate = '';
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      if (calls === 1) {
        options?.onPackageCaptured?.(originalFiles);
        throw validationError('report-whitespace');
      }
      const packageFiles = (options as any)?.packageFiles;
      assert.ok(Array.isArray(packageFiles));
      uploadedCandidate = Buffer.from(packageFiles[0].contentBase64, 'base64').toString('utf8');
      options?.onPackageCaptured?.(packageFiles);
      return { submission: { id: 'submission-repaired' }, skill: { name: 'demo', id: 'demo' } };
    },
  }));

  const result = await tool.execute({ skillName: 'test-skill' }, { sessionId: 'isolated-format-repair' } as any);
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.match(uploadedCandidate, /name: "demo" # keep/);
  assert.match(uploadedCandidate, /# Original instructions/);
  assert.equal(originalFiles[0].contentBase64, originalContent);
  assert.match(Buffer.from(originalFiles[0].contentBase64, 'base64').toString('utf8'), /name: " demo " # keep/);
  assert.match(result.content, /local SKILL.md name and instructions were not rewritten/);
});

test('fills only a missing name from a safely normalized local directory in the upload copy', async () => {
  const originalText = '---\ndescription: safe\n---\n# Original instructions\n';
  const originalFiles = [{ path: 'SKILL.md', contentBase64: Buffer.from(originalText).toString('base64') }];
  let calls = 0;
  let uploaded = '';
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      const files = (options as any)?.packageFiles || originalFiles;
      options?.onPackageCaptured?.(files, 'My Skill_v2');
      if (calls === 1) throw validationError('report-name-missing', {
        code: 'metadata.name_missing',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' },
      });
      uploaded = Buffer.from(files[0].contentBase64, 'base64').toString('utf8');
      return { submission: { id: 'submission-name-derived' }, skill: { name: 'my-skill-v2', id: 'my-skill-v2' } };
    },
  }));

  const result = await tool.execute({ localSkillPath: '/tmp/My Skill_v2' }, { sessionId: 'missing-name-repair' } as any);
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.match(uploaded, /name: "my-skill-v2"/);
  assert.match(uploaded, /# Original instructions/);
  assert.match(String(result.content), /derived from local directory/);
  assert.equal(Buffer.from(originalFiles[0].contentBase64, 'base64').toString('utf8'), originalText);
});

test('does not infer a missing name from a directory that cannot be normalized unambiguously', async () => {
  const originalFiles = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\ndescription: safe\n---\n# Test\n').toString('base64') }];
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      options?.onPackageCaptured?.(originalFiles, '文档读取');
      throw validationError('report-name-ambiguous', {
        code: 'metadata.name_missing',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' },
      });
    },
  }));
  const result = await tool.execute({ localSkillPath: '/tmp/文档读取' }, { sessionId: 'missing-name-ambiguous' } as any);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(normalizeDirectoryNameToSkillName('文档读取'), undefined);
  assert.equal(normalizeDirectoryNameToSkillName('a'.repeat(72)), 'a'.repeat(72));
  assert.equal(normalizeDirectoryNameToSkillName('a'.repeat(73)), undefined);
});

test('adds a missing name before drafting a separately confirmed description', async () => {
  const originalText = '---\n---\n# Original instructions\n';
  const originalFiles = [{ path: 'SKILL.md', contentBase64: Buffer.from(originalText).toString('base64') }];
  let shareCalls = 0;
  let modelCalls = 0;
  const sentMessages: string[] = [];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      const candidate = (options as any)?.packageFiles || originalFiles;
      options?.onPackageCaptured?.(candidate, 'Missing Name Sample');
      if (shareCalls === 1) {
        const error: any = new Error('Rejected by publication preflight.');
        error.validation = {
          reportId: 'report-missing-name-and-description',
          coverage: 'complete',
          issues: [
            { code: 'metadata.name_missing', category: 'format', blocking: true, repairPolicy: 'automatic',
              location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' } },
            { code: 'metadata.description_missing', category: 'format', blocking: true, repairPolicy: 'confirmation_required',
              location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' } },
          ],
        };
        throw error;
      }
      assert.match(Buffer.from(candidate[0].contentBase64, 'base64').toString('utf8'), /name: "missing-name-sample"/);
      throw validationError('report-description-after-name', {
        code: 'metadata.description_missing',
        repairPolicy: 'confirmation_required',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
      });
    },
  }));
  const result = await tool.execute({ localSkillPath: '/tmp/Missing Name Sample' }, {
    sessionId: 'missing-name-and-description',
    conversationHistory: [{ role: 'user', content: '发布这个 Skill' }],
    channel: { chatId: 'current-chat', reply: async (_chatId: string, text: string) => { sentMessages.push(text); } },
    runtimeServices: { aiService: { chat: async () => {
      modelCalls++;
      return { content: '{"description":"用于验证 Skill 发布流程的一次性测试。"}' };
    } } },
  } as any);

  assert.equal(result.ok, true);
  assert.equal(result.controlSignal, 'pause_turn');
  assert.equal(shareCalls, 2);
  assert.equal(modelCalls, 1);
  assert.match(sentMessages[0], /missing-name-sample/);
  assert.match(sentMessages[0], /用于验证 Skill 发布流程/);
  assert.equal(Buffer.from(originalFiles[0].contentBase64, 'base64').toString('utf8'), originalText);
});

test('automatic name repair continues into a missing-description draft without changing the local Skill', async () => {
  const originalText = '---\nname: " demo " # keep\n---\n# Original instructions\n';
  const originalFiles = [{ path: 'SKILL.md', contentBase64: Buffer.from(originalText).toString('base64') }];
  const originalContent = originalFiles[0].contentBase64;
  let shareCalls = 0;
  let modelCalls = 0;
  const sentMessages: string[] = [];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      const candidate = (options as any)?.packageFiles || originalFiles;
      options?.onPackageCaptured?.(candidate);
      if (shareCalls === 1) throw validationError('report-whitespace');
      assert.match(Buffer.from(candidate[0].contentBase64, 'base64').toString('utf8'), /name: "demo" # keep/);
      throw validationError('report-description', {
        code: 'metadata.description_missing',
        repairPolicy: 'confirmation_required',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
      });
    },
  }));
  const result = await tool.execute({ skillName: 'test-skill' }, {
    sessionId: 'format-then-description',
    conversationHistory: [{ role: 'user', content: '发布 test-skill' }],
    channel: { chatId: 'current-chat', reply: async (_chatId: string, text: string) => { sentMessages.push(text); } },
    runtimeServices: { aiService: { chat: async () => {
      modelCalls++;
      return { content: '{"description":"这是一个用于整理示例文档的 Skill。"}' };
    } } },
  } as any);

  assert.equal(result.ok, true);
  assert.equal(result.controlSignal, 'pause_turn');
  assert.equal(shareCalls, 2);
  assert.equal(modelCalls, 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /report-description/);
  assert.match(sentMessages[0], /这是一个用于整理示例文档的 Skill/);
  assert.equal(originalFiles[0].contentBase64, originalContent);
  assert.match(Buffer.from(originalFiles[0].contentBase64, 'base64').toString('utf8'), /name: " demo " # keep/);
});

test('repairs name whitespace when Cloud reports it together with a missing description', async () => {
  const originalText = '---\nname: " demo " # keep\n---\n# Original instructions\n';
  const originalFiles = [{ path: 'SKILL.md', contentBase64: Buffer.from(originalText).toString('base64') }];
  let shareCalls = 0;
  let modelCalls = 0;
  const sentMessages: string[] = [];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      const candidate = (options as any)?.packageFiles || originalFiles;
      options?.onPackageCaptured?.(candidate);
      if (shareCalls === 1) {
        const error: any = new Error('Rejected by publication preflight.');
        error.status = 422;
        error.validation = {
          reportId: 'report-combined',
          coverage: 'complete',
          issues: [
            { code: 'metadata.description_missing', category: 'format', blocking: true, repairPolicy: 'confirmation_required',
              location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' } },
            { code: 'metadata.name_whitespace', category: 'format', blocking: true, repairPolicy: 'automatic',
              location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' } },
          ],
        };
        throw error;
      }
      assert.match(Buffer.from(candidate[0].contentBase64, 'base64').toString('utf8'), /name: "demo" # keep/);
      assert.match(Buffer.from(candidate[0].contentBase64, 'base64').toString('utf8'), /# Original instructions/);
      throw validationError('report-description', {
        code: 'metadata.description_missing',
        repairPolicy: 'confirmation_required',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
      });
    },
  }));
  const result = await tool.execute({ localSkillPath: '/tmp/format-and-description' }, {
    sessionId: 'combined-format-description',
    conversationHistory: [{ role: 'user', content: '发布 test-skill' }],
    channel: { chatId: 'current-chat', reply: async (_chatId: string, text: string) => { sentMessages.push(text); } },
    runtimeServices: { aiService: { chat: async () => {
      modelCalls++;
      return { content: '{"description":"这是一个一次性测试 Skill。"}' };
    } } },
  } as any);

  assert.equal(result.ok, true);
  assert.equal(result.controlSignal, 'pause_turn');
  assert.equal(shareCalls, 2);
  assert.equal(modelCalls, 1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /发现「demo」/);
  assert.match(sentMessages[0], /report-description/);
  assert.match(sentMessages[0], /这是一个一次性测试 Skill/);
  assert.equal(originalFiles[0].contentBase64, Buffer.from(originalText).toString('base64'));
});

test('does not auto-repair name whitespace when the same report contains a manual security issue', async () => {
  const originalFiles = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: " demo "\ndescription: safe\n---\n# Test\n').toString('base64') }];
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      options?.onPackageCaptured?.(originalFiles);
      const error: any = new Error('Rejected by publication preflight.');
      error.status = 422;
      error.validation = {
        reportId: 'report-security-and-format',
        coverage: 'complete',
        issues: [
          { code: 'metadata.name_whitespace', category: 'format', blocking: true, repairPolicy: 'automatic',
            location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'name' } },
          { code: 'security.review_required', category: 'security', blocking: true, repairPolicy: 'manual',
            location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'content' } },
        ],
      };
      throw error;
    },
  }));

  const result = await tool.execute({ skillName: 'test-skill' }, { sessionId: 'security-and-format' } as any);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.match(result.message, /security\.review_required/);
});

test('partial validation reports are never used for automatic repair', async () => {
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      options?.onPackageCaptured?.([{
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: " demo "\ndescription: safe\n---\n# Test\n').toString('base64'),
      }]);
      throw validationError('report-partial', { coverage: 'partial' });
    },
  }));

  const result = await tool.execute({ skillName: 'test-skill' }, { sessionId: 'partial-report' } as any);
  assert.equal(result.ok, false);
  assert.match(result.message, /report-partial/);
  assert.equal(calls, 1);
});

test('automatic repair makes at most one candidate upload attempt', async () => {
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      const files = (options as any)?.packageFiles || [{
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: " demo "\ndescription: safe\n---\n# Test\n').toString('base64'),
      }];
      options?.onPackageCaptured?.(files);
      throw validationError(calls === 1 ? 'report-before' : 'report-after');
    },
  }));

  const result = await tool.execute({ skillName: 'test-skill' }, { sessionId: 'repair-no-progress' } as any);
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
  assert.match(result.message, /report-after/);
});

test('manual or confirmation-required issues do not trigger an automatic retry', async () => {
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      options?.onPackageCaptured?.([{
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: demo\ndescription: safe\n---\n# Test\n').toString('base64'),
      }]);
      calls++;
      throw validationError('report-manual', { code: 'metadata.description_missing', repairPolicy: 'confirmation_required' });
    },
  }));

  const result = await tool.execute({ skillName: 'test-skill' }, { sessionId: 'manual-publication' } as any);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.match(result.message, /report-manual/);
  assert.match(result.message, /metadata.description_missing/);
  assert.match(result.message, /confirmation_required/);
});

test('missing description creates a paused draft and only publishes the exact confirmed upload copy', async () => {
  const originalText = '---\nname: sample-skill\n---\n# Original instructions\n';
  const originalFiles = [{ path: 'SKILL.md', contentBase64: Buffer.from(originalText).toString('base64') }];
  let shareCalls = 0;
  let uploadedCopy = '';
  let modelCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      if (shareCalls === 1) {
        options?.onPackageCaptured?.(originalFiles);
        throw validationError('description-report', {
          code: 'metadata.description_missing',
          repairPolicy: 'confirmation_required',
          location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
        });
      }
      const files = (options as any)?.packageFiles;
      uploadedCopy = Buffer.from(files[0].contentBase64, 'base64').toString('utf8');
      options?.onPackageCaptured?.(files);
      return { submission: { id: 'description-submission' }, skill: { name: 'sample-skill', id: 'sample-skill' } };
    },
  }));
  const history: any[] = [{ role: 'user', content: '发布 sample-skill' }];
  const sentMessages: string[] = [];
  const context = {
    conversationHistory: history,
    sessionId: 'description-confirmation-session',
    channel: { chatId: 'current-chat', reply: async (_chatId: string, text: string) => { sentMessages.push(text); } },
    runtimeServices: { aiService: { chat: async (_messages: unknown, _tools: unknown, options: any) => {
      modelCalls++;
      assert.deepEqual(options.providerRequestBudget, { maxRequests: 1, usedRequests: 0 });
      return { content: '```json\n{"description":"从 SKILL.md 的说明可知，该 Skill 用于样例任务。"}\n```' };
    } } },
  } as any;

  const draft = await tool.execute({ skillName: 'sample-skill' }, context);
  const reportId = 'description-report';
  assert.equal(draft.ok, true);
  assert.equal(draft.controlSignal, 'pause_turn');
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], new RegExp(reportId));
  assert.match(sentMessages[0], /该 Skill 用于样例任务/);
  assert.match(sentMessages[0], /有效 15 分钟/);
  assert.match(sentMessages[0], /重新发起预检并确认新草稿/);
  assert.match(String(draft.content), new RegExp(reportId));
  assert.match(String(draft.content), /该 Skill 用于样例任务/);
  assert.match(String(draft.content), /15 分钟有效期/);
  assert.match(String(draft.content), /必须重新预检并取得对新草稿的确认/);
  assert.equal(modelCalls, 1);
  assert.equal(shareCalls, 1);
  assert.equal(originalFiles[0].contentBase64, Buffer.from(originalText).toString('base64'));

  const noApproval = await tool.execute({ confirmDescription: true, descriptionReportId: reportId,
    confirmedDescription: '从 SKILL.md 的说明可知，该 Skill 用于样例任务。' }, context);
  assert.equal(noApproval.ok, false);
  assert.equal(noApproval.errorCode, 'DESCRIPTION_USER_APPROVAL_REQUIRED');
  assert.equal(shareCalls, 1);

  history.length = 0;
  history.push({ role: 'user', content: '确认使用这个描述并发布' });
  history.push({ role: 'user', content: 'A runtime observation arrived after the human approval.', __runtimeObservation: true });
  const mismatch = await tool.execute({ confirmDescription: true, descriptionReportId: reportId,
    confirmedDescription: 'A different draft.' }, context);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.errorCode, 'DESCRIPTION_CONFIRMATION_MISMATCH');
  assert.equal(shareCalls, 1);

  const confirmed = await tool.execute({ confirmDescription: true, descriptionReportId: reportId,
    confirmedDescription: '从 SKILL.md 的说明可知，该 Skill 用于样例任务。' }, context);
  assert.equal(confirmed.ok, true);
  assert.equal(shareCalls, 2);
  assert.match(uploadedCopy, /description: "从 SKILL\.md 的说明可知，该 Skill 用于样例任务。"/);
  assert.match(uploadedCopy, /# Original instructions/);
  assert.equal(originalFiles[0].contentBase64, Buffer.from(originalText).toString('base64'));
});

test('every canonical synthetic user flag is ignored when resolving an explicit description approval', async () => {
  for (const flag of SYNTHETIC_USER_MESSAGE_FLAGS) {
    const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
    let shareCalls = 0;
    const tool = new ShareSkillHubSkillTool(() => ({
      shareLocalSkill: async (_input, options) => {
        shareCalls++;
        if (shareCalls === 1) {
          options?.onPackageCaptured?.(files);
          throw validationError('11111111-1111-4111-8111-111111111111', {
            code: 'metadata.description_missing',
            repairPolicy: 'confirmation_required',
            location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
          });
        }
        return { submission: { id: `submitted-${flag}` }, skill: { id: 'sample-skill', name: 'sample-skill' } };
      },
    }));
    const history: any[] = [{ role: 'user', content: 'publish sample-skill' }];
    const context: any = {
      sessionId: `description-approval-${flag}`,
      conversationHistory: history,
      runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
    };
    const draft = await tool.execute({ skillName: 'sample-skill' }, context);
    const reportId = '11111111-1111-4111-8111-111111111111';
    assert.match(String(draft.content), new RegExp(reportId), `expected report ID for ${flag}`);

    history.push({ role: 'user', content: '确认使用这个描述并发布' });
    history.push({ role: 'user', content: 'internal observation', [flag]: true });
    const published = await tool.execute({
      confirmDescription: true,
      descriptionReportId: reportId,
      confirmedDescription: 'A sample Skill.',
    }, context);

    assert.equal(published.ok, true, `${flag} must not hide the human approval`);
    assert.equal(shareCalls, 2, `${flag} must allow exactly one confirmed publish attempt`);
  }
});

test('prompted confirmation and the user natural phrasing are accepted without accepting a rejection', async () => {
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
  let shareCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      if (shareCalls === 1) {
        options?.onPackageCaptured?.(files);
        throw validationError('episode-input-report', {
          code: 'metadata.description_missing',
          repairPolicy: 'confirmation_required',
          location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
        });
      }
      return { submission: { id: 'episode-input-submitted' }, skill: { id: 'sample-skill', name: 'sample-skill' } };
    },
  }));
  const history: any[] = [{ role: 'user', content: 'publish sample-skill', __episodeInputKind: 'root' }];
  const sentMessages: string[] = [];
  const context: any = {
    sessionId: 'description-episode-input',
    conversationHistory: history,
    currentUserInput: 'publish sample-skill',
    currentUserApprovalInputs: [{ text: 'publish sample-skill', isBot: false }],
    channel: { chatId: 'current-chat', reply: async (_chatId: string, text: string) => { sentMessages.push(text); } },
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
  };
  const draft = await tool.execute({ skillName: 'sample-skill' }, context);
  assert.equal(draft.ok, true);
  assert.match(sentMessages[0], /Skill 的简介/);
  assert.match(sentMessages[0], /对应 SKILL\.md 的 description 字段/);
  assert.match(sentMessages[0], /作为 SkillHub 的简短描述展示/);
  assert.match(sentMessages[0], /不是发布后生成的详细使用说明书/);
  assert.match(sentMessages[0], /确认使用这条简介并发布/);

  history.push({ role: 'user', content: '确认使用这条简介并发布', __episodeInputKind: 'root' });
  context.currentUserInput = '先不要发布';
  context.currentUserApprovalInputs = [{ text: '先不要发布', isBot: false }];
  const rejected = await tool.execute({
    confirmDescription: true,
    descriptionReportId: 'episode-input-report',
    confirmedDescription: 'A sample Skill.',
  }, context);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, 'DESCRIPTION_USER_APPROVAL_REQUIRED');
  assert.equal(shareCalls, 1);

  context.currentUserApprovalInputs = [
    { text: '确认使用这条简介并发布', isBot: false },
    { text: '先不要发布', isBot: false },
  ];
  const approvalWithdrawn = await tool.execute({
    confirmDescription: true,
    descriptionReportId: 'episode-input-report',
    confirmedDescription: 'A sample Skill.',
  }, context);
  assert.equal(approvalWithdrawn.ok, false);
  assert.equal(approvalWithdrawn.errorCode, 'DESCRIPTION_USER_APPROVAL_REQUIRED');
  assert.equal(shareCalls, 1);

  context.currentUserApprovalInputs = [
    { text: '确认使用这条简介并发布', isBot: false },
    { text: '这个说明合适吗？', isBot: false },
  ];
  const followUpQuestion = await tool.execute({
    confirmDescription: true,
    descriptionReportId: 'episode-input-report',
    confirmedDescription: 'A sample Skill.',
  }, context);
  assert.equal(followUpQuestion.ok, false);
  assert.equal(followUpQuestion.errorCode, 'DESCRIPTION_USER_APPROVAL_REQUIRED');
  assert.equal(shareCalls, 1);

  context.currentUserInput = [
    '确认使用这个 Skill 的简介并发布',
    '报告：episode-input-report',
    'Skill 简介草稿：A sample Skill.',
    '请仅对此报告继续确认一次。如果还需要单独确认版本发布，请停下并告诉我，不要自行继续。',
  ].join('\n');
  context.currentUserApprovalInputs = [
    { text: context.currentUserInput, isBot: false },
  ];
  history.push({ role: 'user', content: '确认使用这个 Skill 的简介并发布', __episodeInputKind: 'root' });
  history.push({ role: 'user', content: 'internal observation', __runtimeObservation: true });
  const published = await tool.execute({
    confirmDescription: true,
    descriptionReportId: 'episode-input-report',
    confirmedDescription: 'A sample Skill.',
  }, context);

  assert.equal(published.ok, true);
  assert.equal(shareCalls, 2);
});

test('accepts a long user confirmation bound to the report and exact draft', async () => {
  const reportId = 'bound-confirmation-report';
  const description = '用于验证说明确认流程的一次性测试 Skill。';
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
  let shareCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      if (shareCalls === 1) {
        options?.onPackageCaptured?.(files);
        throw validationError(reportId, {
          code: 'metadata.description_missing',
          repairPolicy: 'confirmation_required',
          location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
        });
      }
      return { submission: { id: 'bound-confirmation-submitted' }, skill: { id: 'sample-skill', name: 'sample-skill' } };
    },
  }));
  const context: any = {
    sessionId: 'description-bound-confirmation',
    conversationHistory: [{ role: 'user', content: 'publish sample-skill' }],
    currentUserInput: 'publish sample-skill',
    currentUserApprovalInputs: [{ text: 'publish sample-skill', isBot: false }],
    runtimeServices: { aiService: { chat: async () => ({ content: JSON.stringify({ description }) }) } },
  };
  const draft = await tool.execute({ skillName: 'sample-skill' }, context);
  assert.equal(draft.ok, true);

  const confirmation = [
    '我确认使用这条简介并发布。',
    `报告 ID：${reportId}`,
    `简介原文：${description}`,
    '请仅对此报告继续确认一次。如果还需要单独确认版本发布，请停下并告诉我，不要自行继续。',
  ].join('\n');
  for (const withdrawal of [
    '更正：先不要发布。',
    '算了，取消吧。',
    '先取消',
    '暂缓发布。',
    '不要了。',
    '等等，先等一下。',
    '稍等，我说错了。',
    '抱歉，发早了。',
    '再想想，先放着。',
    '第二句能换个说法吗？',
    '请改成更短的版本再发布。',
    'hold off',
    'cancel that',
    'please do not publish',
  ]) {
    const withdrawnReply = `${confirmation}\n${withdrawal}`;
    context.currentUserInput = withdrawnReply;
    context.currentUserApprovalInputs = [{ text: withdrawnReply, isBot: false }];
    const withdrawnResult = await tool.execute({
      confirmDescription: true,
      descriptionReportId: reportId,
      confirmedDescription: description,
    }, context);
    assert.equal(withdrawnResult.ok, false, `withdrawal must fail closed: ${withdrawal}`);
    assert.equal(withdrawnResult.errorCode, 'DESCRIPTION_USER_APPROVAL_REQUIRED');
    assert.equal(shareCalls, 1);
  }

  context.currentUserInput = confirmation;
  context.currentUserApprovalInputs = [{ text: confirmation, isBot: false }];
  const approved = await tool.execute({
    confirmDescription: true,
    descriptionReportId: reportId,
    confirmedDescription: description,
  }, context);
  assert.equal(approved.ok, true);
  assert.equal(shareCalls, 2);
});

test('accepts markdown and quoted forms of a structured description approval', async () => {
  const reportId = 'markdown-confirmation-report';
  const description = 'A one-time SkillHub confirmation fixture.';
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
  let shareCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      if (shareCalls === 1) {
        options?.onPackageCaptured?.(files);
        throw validationError(reportId, {
          code: 'metadata.description_missing',
          repairPolicy: 'confirmation_required',
          location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
        });
      }
      return { submission: { id: 'markdown-confirmation-submitted' }, skill: { id: 'sample-skill', name: 'sample-skill' } };
    },
  }));
  const context: any = {
    sessionId: 'description-markdown-confirmation',
    conversationHistory: [{ role: 'user', content: 'publish sample-skill' }],
    currentUserInput: 'publish sample-skill',
    currentUserApprovalInputs: [{ text: 'publish sample-skill', isBot: false }],
    runtimeServices: { aiService: { chat: async () => ({ content: JSON.stringify({ description }) }) } },
  };
  await tool.execute({ skillName: 'sample-skill' }, context);
  const approval = [
    '> 1. 「我确认使用这条说明，并发布。」',
    `> 报告 ID：${reportId}`,
    `> 说明原文：${description}`,
  ].join('\n');
  context.currentUserInput = approval;
  context.currentUserApprovalInputs = [{ text: approval, isBot: false }];
  const published = await tool.execute({
    confirmDescription: true,
    descriptionReportId: reportId,
    confirmedDescription: description,
  }, context);
  assert.equal(published.ok, true);
  assert.equal(shareCalls, 2);
});

test('a bot speaker cannot approve a pending description draft', async () => {
  let shareCalls = 0;
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      if (shareCalls === 1) {
        options?.onPackageCaptured?.(files);
        throw validationError('bot-approval-report', {
          code: 'metadata.description_missing', repairPolicy: 'confirmation_required',
          location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
        });
      }
      return { submission: { id: 'must-not-publish' }, skill: { id: 'sample-skill', name: 'sample-skill' } };
    },
  }));
  const context: any = {
    sessionId: 'description-bot-approval',
    currentUserInput: 'publish sample-skill',
    currentUserApprovalInputs: [{ text: 'publish sample-skill', isBot: false }],
    conversationHistory: [{ role: 'user', content: 'publish sample-skill' }],
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
  };
  const draft = await tool.execute({ skillName: 'sample-skill' }, context);
  assert.equal(draft.ok, true);
  context.currentUserInput = '[发言人: 阿码（bot）]\n[发言人: arrowhaken（人）]\n确认使用这条说明并发布';
  context.currentUserApprovalInputs = [{
    text: '[发言人: arrowhaken（人）]\n确认使用这条说明并发布',
    isBot: true,
  }];
  context.conversationHistory.push({ role: 'user', content: context.currentUserInput });
  const result = await tool.execute({ confirmDescription: true,
    descriptionReportId: 'bot-approval-report', confirmedDescription: 'A sample Skill.' }, context);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DESCRIPTION_USER_APPROVAL_REQUIRED');
  assert.equal(shareCalls, 1);
});

test('unclassified legacy CatsCo speakers cannot approve a pending draft', async () => {
  let shareCalls = 0;
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      if (shareCalls === 1) {
        options?.onPackageCaptured?.(files);
        throw validationError('legacy-speaker-report', {
          code: 'metadata.description_missing', repairPolicy: 'confirmation_required',
          location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
        });
      }
      return { submission: { id: 'must-not-publish' }, skill: { id: 'sample-skill', name: 'sample-skill' } };
    },
  }));
  const context: any = {
    sessionId: 'description-legacy-speaker',
    currentUserInput: 'publish sample-skill',
    currentUserApprovalInputs: [{ text: 'publish sample-skill', isBot: null }],
    conversationHistory: [{ role: 'user', content: 'publish sample-skill' }],
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
  };
  const draft = await tool.execute({ skillName: 'sample-skill' }, context);
  assert.equal(draft.ok, true);
  context.currentUserInput = '确认使用这条说明并发布';
  context.currentUserApprovalInputs = [{ text: '确认使用这条说明并发布', isBot: null }];
  const result = await tool.execute({ confirmDescription: true,
    descriptionReportId: 'legacy-speaker-report', confirmedDescription: 'A sample Skill.' }, context);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DESCRIPTION_USER_APPROVAL_REQUIRED');
  assert.equal(shareCalls, 1);
});

test('runtime observation input cannot reuse an approval from conversation history', async () => {
  let shareCalls = 0;
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      if (shareCalls === 1) {
        options?.onPackageCaptured?.(files);
        throw validationError('observation-report', {
          code: 'metadata.description_missing', repairPolicy: 'confirmation_required',
          location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
        });
      }
      return { submission: { id: 'must-not-publish' }, skill: { id: 'sample-skill', name: 'sample-skill' } };
    },
  }));
  const context: any = {
    sessionId: 'description-observation-input',
    currentUserInput: 'publish sample-skill',
    conversationHistory: [{ role: 'user', content: 'publish sample-skill' }],
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
  };
  const draft = await tool.execute({ skillName: 'sample-skill' }, context);
  assert.equal(draft.ok, true);
  context.conversationHistory.push({ role: 'user', content: '确认使用这条说明并发布' });
  context.currentUserInput = null;
  const result = await tool.execute({ confirmDescription: true,
    descriptionReportId: 'observation-report', confirmedDescription: 'A sample Skill.' }, context);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DESCRIPTION_USER_APPROVAL_REQUIRED');
  assert.equal(shareCalls, 1);
});

test('description draft remains visible through the normal result path without an outbound chat channel', async () => {
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      options?.onPackageCaptured?.(files);
      throw validationError('description-report-cli', {
        code: 'metadata.description_missing',
        repairPolicy: 'confirmation_required',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
      });
    },
  }));
  const result = await tool.execute({ skillName: 'sample-skill' }, {
    sessionId: 'description-cli-session',
    conversationHistory: [{ role: 'user', content: 'publish sample-skill' }],
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
  } as any);
  assert.equal(result.ok, true);
  assert.equal(result.controlSignal, undefined);
  assert.match(String(result.content), /A sample Skill/);
});

test('outbound description draft respects execution scope and falls back to the normal response when scope mismatches', async () => {
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
  let sendCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      options?.onPackageCaptured?.(files);
      throw validationError('description-scope-report', {
        code: 'metadata.description_missing',
        repairPolicy: 'confirmation_required',
        location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
      });
    },
  }));
  const result = await tool.execute({ skillName: 'sample-skill' }, {
    sessionId: 'description-scope-session',
    surface: 'catscompany',
    executionScope: { topicId: 'authorized-topic', sessionKey: 'description-scope-session' },
    channel: { chatId: 'different-topic', reply: async () => { sendCalls++; } },
    conversationHistory: [{ role: 'user', content: 'publish sample-skill' }],
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
  } as any);
  assert.equal(sendCalls, 0);
  assert.equal(result.controlSignal, undefined);
  assert.match(String(result.content), /description-scope-report/);
  assert.match(String(result.content), /A sample Skill/);
});

test('version confirmation is separate and retained after the description is approved', async () => {
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: sample-skill\n---\n# Instructions\n').toString('base64') }];
  let shareCalls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      shareCalls++;
      if (shareCalls === 1) {
        options?.onPackageCaptured?.(files);
        throw validationError('description-version-report', {
          code: 'metadata.description_missing',
          repairPolicy: 'confirmation_required',
          location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
        });
      }
      if (!(options as any)?.confirmedDescription) throw new Error('description candidate missing');
      if (shareCalls === 2) return { requiresConfirmation: true, latestVersion: '1.2.0' };
      assert.equal((_input as any).confirmPublish, true);
      return { submission: { id: 'published-v2' }, skill: { id: 'sample-skill', name: 'sample-skill' } };
    },
  }));
  const history: any[] = [{ role: 'user', content: 'Publish sample-skill' }];
  const context: any = {
    sessionId: 'description-version-session',
    conversationHistory: history,
    currentUserApprovalInputs: [{ text: 'Publish sample-skill', isBot: false }],
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
  };
  const draft = await tool.execute({ skillName: 'sample-skill' }, context);
  const reportId = 'description-version-report';
  assert.match(String(draft.content), new RegExp(reportId));
  history.push({ role: 'user', content: '确认发布新版本' });
  context.currentUserApprovalInputs = [{ text: '确认使用这条说明并发布', isBot: false }];
  const versionGate = await tool.execute({ confirmDescription: true, descriptionReportId: reportId,
    confirmedDescription: 'A sample Skill.' }, context);
  assert.equal(versionGate.ok, true);
  assert.match(String(versionGate.content), /new patch version/i);
  assert.equal(shareCalls, 2);

  history.push({ role: 'user', content: '确认' });
  context.currentUserApprovalInputs = [{ text: '确认', isBot: false }];
  const weakVersionApproval = await tool.execute({ confirmDescription: true, confirmPublish: true,
    descriptionReportId: reportId, confirmedDescription: 'A sample Skill.' }, context);
  assert.equal(weakVersionApproval.ok, false);
  assert.equal(weakVersionApproval.errorCode, 'DESCRIPTION_VERSION_CONFIRMATION_REQUIRED');
  assert.equal(shareCalls, 2);

  context.currentUserApprovalInputs = [
    { text: '确认发布新版本', isBot: false },
    { text: '这个版本需要再检查一下吗？', isBot: false },
  ];
  const versionQuestion = await tool.execute({ confirmDescription: true, confirmPublish: true,
    descriptionReportId: reportId, confirmedDescription: 'A sample Skill.' }, context);
  assert.equal(versionQuestion.ok, false);
  assert.equal(versionQuestion.errorCode, 'DESCRIPTION_VERSION_CONFIRMATION_REQUIRED');
  assert.equal(shareCalls, 2);

  history.push({ role: 'user', content: '[发言人: arrowhaken（人）]\n确认发布新版本' });
  context.currentUserApprovalInputs = [{
    text: '[发言人: arrowhaken（人）]\n确认发布新版本',
    isBot: true,
  }];
  const botVersionApproval = await tool.execute({ confirmDescription: true, confirmPublish: true,
    descriptionReportId: reportId, confirmedDescription: 'A sample Skill.' }, context);
  assert.equal(botVersionApproval.ok, false);
  assert.equal(botVersionApproval.errorCode, 'DESCRIPTION_VERSION_CONFIRMATION_REQUIRED');
  assert.equal(shareCalls, 2);

  history.push({ role: 'user', content: '确认发布新版本' });
  context.currentUserApprovalInputs = [{ text: '确认发布新版本', isBot: false }];
  const published = await tool.execute({ confirmDescription: true, confirmPublish: true,
    descriptionReportId: reportId, confirmedDescription: 'A sample Skill.' }, context);
  assert.equal(published.ok, true);
  assert.match(String(published.content), /published-v2/);
  assert.equal(shareCalls, 3);
});

test('description confirmation cannot be replayed or used from another session', async () => {
  const tool = new ShareSkillHubSkillTool(() => ({ shareLocalSkill: async () => { throw new Error('must not publish'); } }));
  const result = await tool.execute({ confirmDescription: true, descriptionReportId: 'unknown-report',
    confirmedDescription: 'A description.' }, { sessionId: 'other-session' } as any);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DESCRIPTION_DRAFT_NOT_FOUND');
  assert.match(String(result.message), /校验报告不等于待确认草稿/);
  assert.doesNotMatch(String(result.message), /草稿已过期/);
});

test('ZIP publication survives later turns, redrafts after expiry, and preserves user and source boundaries', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-zip-later-turn-'));
  const zipPath = path.join(root, 'fixture.zip');
  const source = '---\nname: zip-later-turn\ndescription:\n---\n# Inert fixture\n';
  const zip = makeZip([{ name: 'zip-later-turn/SKILL.md', content: Buffer.from(source) }]);
  await fs.promises.writeFile(zipPath, zip);
  let calls = 0;
  let extracted = '';
  let modelFails = true;
  const tool = new ShareSkillHubSkillTool(() => ({ shareLocalSkill: async (_input, options) => {
    calls++;
    extracted = String(options?.localSkillPath || '');
    const files = (options as any)?.packageFiles || [{ path: 'SKILL.md', contentBase64: fs.readFileSync(path.join(extracted, 'SKILL.md')).toString('base64') }];
    options?.onPackageCaptured?.(files, 'zip-later-turn');
    if (!(options as any)?.confirmedDescription) throw validationError(`later-turn-${calls}`, {
      code: 'metadata.description_missing', repairPolicy: 'confirmation_required',
      location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' },
    });
    assert.match(Buffer.from(files[0].contentBase64, 'base64').toString(), /description: "惰性 ZIP 测试夹具。"/);
    return { submission: { id: 'published-later-turn' }, skill: { name: 'zip-later-turn' } };
  } }));
  const context = catscoZipContext([catscoZipGrant(zipPath, 'fixture.zip', 'catsco_attachment:later-turn')], 'later-turn');
  context.runtimeServices = { aiService: { chat: async () => {
    if (modelFails) throw new Error('model temporarily unavailable');
    return { content: '{"description":"惰性 ZIP 测试夹具。"}' };
  } } };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  try {
    const first = await tool.execute({}, context);
    assert.equal(first.ok, false);
    const id = String(first.message).match(/publicationTaskId: ([a-f0-9-]+)/)?.[1];
    assert.ok(id);
    const imaginary = await tool.execute({ confirmDescription: true, descriptionReportId: 'later-turn-1', confirmedDescription: 'Invented description' }, context);
    assert.equal(imaginary.errorCode, 'DESCRIPTION_DRAFT_NOT_FOUND');
    context.localFileGrants = [];
    context.currentUserInput = '请重新预检刚才的 ZIP';
    modelFails = false;
    const second = await tool.execute({ zipAttachmentName: 'fixture.zip' }, context);
    assert.equal(second.ok, true);
    assert.match(String(second.content), /later-turn-2/);
    assert.equal(fs.readFileSync(path.join(extracted, 'SKILL.md'), 'utf8'), source);

    for (const changed of [
      { ...context, sessionId: 'another-session' },
      { ...context, executionScope: { ...context.executionScope, actorUserId: 'another-user' } },
      { ...context, executionScope: { ...context.executionScope, agentBodyId: 'another-body' } },
      { ...context, executionScope: { ...context.executionScope, isTrusted: false } },
    ]) {
      const denied = await tool.execute({ publicationTaskId: id }, changed);
      assert.equal(denied.errorCode, 'SKILLHUB_ZIP_TASK_UNAVAILABLE');
    }
    assert.equal(calls, 2);
    t.mock.timers.tick(15 * 60_000 + 1);
    context.currentUserInput = '确认使用这条简介并发布';
    const expired = await tool.execute({ confirmDescription: true, descriptionReportId: 'later-turn-2', confirmedDescription: '惰性 ZIP 测试夹具。' }, context);
    assert.equal(expired.errorCode, 'DESCRIPTION_CONFIRMATION_EXPIRED');
    assert.equal(fs.existsSync(path.join(extracted, 'SKILL.md')), true);
    context.currentUserInput = '重新预检';
    const third = await tool.execute({ publicationTaskId: id }, context);
    assert.equal(third.ok, true);
    assert.match(String(third.content), /later-turn-3/);
    const fourth = await tool.execute({ publicationTaskId: id }, context);
    assert.equal(fourth.ok, true);
    const replaced = await tool.execute({ confirmDescription: true, descriptionReportId: 'later-turn-3', confirmedDescription: '惰性 ZIP 测试夹具。' }, context);
    assert.equal(replaced.errorCode, 'DESCRIPTION_DRAFT_REPLACED');
    context.currentUserInput = '确认使用这条简介并发布';
    const confirmed = await tool.execute({ confirmDescription: true, descriptionReportId: 'later-turn-4', confirmedDescription: '惰性 ZIP 测试夹具。' }, context);
    assert.equal(confirmed.ok, true);
    assert.match(String(confirmed.content), /published-later-turn/);
    const replay = await tool.execute({ confirmDescription: true, descriptionReportId: 'later-turn-4', confirmedDescription: '惰性 ZIP 测试夹具。' }, context);
    assert.equal(replay.errorCode, 'DESCRIPTION_CONFIRMATION_ALREADY_USED');
    assert.equal(calls, 5);
    assert.deepEqual(fs.readFileSync(zipPath), zip);
    assert.equal(fs.readFileSync(path.join(extracted, 'SKILL.md'), 'utf8'), source);
    fs.writeFileSync(path.join(extracted, 'extra.txt'), 'unexpected backup');
    const tampered = await tool.execute({ publicationTaskId: id }, context);
    assert.equal(tampered.errorCode, 'SKILLHUB_ZIP_TASK_INVALID');
    assert.equal(calls, 5);
    t.mock.timers.tick(45 * 60_000);
    const gone = await tool.execute({ publicationTaskId: id }, context);
    assert.equal(gone.errorCode, 'SKILLHUB_ZIP_TASK_UNAVAILABLE');
  } finally {
    t.mock.timers.reset();
    if (extracted) await fs.promises.rm(path.dirname(path.dirname(extracted)), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('a late ZIP redraft expires with its source and cleaned sources fail before consuming approval', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skillhub-late-redraft-'));
  const zipPath = path.join(root, 'fixture.zip');
  const text = '---\nname: fixture\ndescription:\n---\n# Inert fixture\n';
  fs.writeFileSync(zipPath, makeZip([{ name: 'SKILL.md', content: Buffer.from(text) }]));
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({ shareLocalSkill: async (_input, options) => {
    calls++;
    options?.onPackageCaptured?.([{ path: 'SKILL.md', contentBase64: Buffer.from(text).toString('base64') }], 'fixture');
    throw validationError(`late-${calls}`, { code: 'metadata.description_missing', repairPolicy: 'confirmation_required',
      location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' } });
  } }));
  const context = catscoZipContext([catscoZipGrant(zipPath, 'fixture.zip', 'catsco_attachment:late')], 'late-redraft');
  const messages: string[] = [];
  context.channel = { chatId: 'p2p_1_2', reply: async (_id: string, message: string) => { messages.push(message); } };
  context.runtimeServices = { aiService: { chat: async () => ({ content: '{"description":"惰性测试夹具。"}' }) } };
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  try {
    const first = await tool.execute({}, context);
    const taskId = String(first.content).match(/publicationTaskId: ([a-f0-9-]+)/)![1];
    t.mock.timers.tick(59 * 60_000);
    context.localFileGrants = [];
    context.currentUserInput = '重新预检';
    const late = await tool.execute({ publicationTaskId: taskId }, context);
    assert.equal(late.ok, true);
    const prompt = messages.at(-1) || String(late.content);
    assert.match(prompt, /剩余不足 15 分钟/);
    assert.match(prompt, new RegExp(new Date(now + 60 * 60_000).toISOString().replace(/[.]/g, '\\.')));
    t.mock.timers.tick(2 * 60_000);
    context.currentUserInput = '确认使用这条简介并发布';
    const expired = await tool.execute({ confirmDescription: true, descriptionReportId: 'late-2', confirmedDescription: '惰性测试夹具。' }, context);
    assert.equal(expired.errorCode, 'DESCRIPTION_CONFIRMATION_EXPIRED');
    assert.equal(calls, 2);
    assert.match(String(expired.message), /本次没有发布/);

    // Capacity eviction can happen before the nominal TTL. Never consume a
    // valid-looking draft and let the service produce a misleading not-found.
    context.localFileGrants = [catscoZipGrant(zipPath, 'fixture.zip', 'catsco_attachment:late-new')];
    context.currentUserInput = '发布新任务';
    await tool.execute({}, context);
    for (let i = 0; i < 8; i++) {
      await tool.execute({}, { ...context, sessionId: `other-task-${i}` });
    }
    context.currentUserInput = '确认使用这条简介并发布';
    const evicted = await tool.execute({ confirmDescription: true, descriptionReportId: 'late-3', confirmedDescription: '惰性测试夹具。' }, context);
    assert.equal(evicted.errorCode, 'DESCRIPTION_SOURCE_UNAVAILABLE');
    assert.match(String(evicted.message), /本次没有发布/);
    const retry = await tool.execute({ confirmDescription: true, descriptionReportId: 'late-3', confirmedDescription: '惰性测试夹具。' }, context);
    assert.equal(retry.errorCode, 'DESCRIPTION_DRAFT_UNAVAILABLE');
    assert.equal(calls, 11);
    t.mock.timers.tick(60 * 60_000);
  } finally {
    t.mock.timers.reset();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('an oversized draft does not replace an existing confirmable draft', async () => {
  const files = [{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: fixture\n---\n# Inert fixture\n').toString('base64') }];
  let calls = 0;
  let sourceFiles = files;
  const tool = new ShareSkillHubSkillTool(() => ({ shareLocalSkill: async (_input, options) => {
    calls++;
    if ((options as any)?.confirmedDescription) return { submission: { id: 'original-draft-published' } };
    options?.onPackageCaptured?.(sourceFiles, 'fixture');
    throw validationError(`capacity-${calls}`, { code: 'metadata.description_missing', repairPolicy: 'confirmation_required',
      location: { entryIndex: 0, relativePath: 'SKILL.md', field: 'description' } });
  } }));
  const context: any = { sessionId: 'capacity-draft', currentUserInput: '发布',
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"惰性夹具。"}' }) } } };
  assert.equal((await tool.execute({ skillName: 'fixture' }, context)).ok, true);
  sourceFiles = [...files, { path: 'large.bin', contentBase64: 'AAAA'.repeat(Math.ceil(64 * 1024 * 1024 / 3)) }];
  assert.equal((await tool.execute({ skillName: 'fixture' }, context)).ok, false);
  context.currentUserInput = '确认使用这条简介并发布';
  const result = await tool.execute({ confirmDescription: true, descriptionReportId: 'capacity-1', confirmedDescription: '惰性夹具。' }, context);
  assert.equal(result.ok, true);
  assert.match(String(result.content), /original-draft-published/);
});

test('an imprecise automatic issue location does not create a candidate', async () => {
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      options?.onPackageCaptured?.([{
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: " demo "\ndescription: safe\n---\n# Test\n').toString('base64'),
      }]);
      throw validationError('report-no-location', { location: { field: 'name' } });
    },
  }));

  const result = await tool.execute({ skillName: 'test-skill' }, { sessionId: 'missing-location' } as any);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test('a non-UTF-8 entrypoint disables automatic repair without blocking normal publication', async () => {
  let captured = false;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      captured = true;
      options?.onPackageCaptured?.([{ path: 'SKILL.md', contentBase64: Buffer.from([0xff, 0xfe]).toString('base64') }]);
      return { submission: { id: 'submission-utf8' }, skill: { name: 'test-skill' } };
    },
  }));

  const result = await tool.execute({ skillName: 'test-skill' }, { sessionId: 'normal-utf8-session' } as any);
  assert.equal(result.ok, true);
  assert.equal(captured, true);
});

test('an explicitly supplied local Skill directory is published without relocating it or writing metadata outside the Skill workspace', async () => {
  const localSkillPath = 'C:\\external-skills\\demo';
  let receivedPath = '';
  let writeLocalMetadata: unknown;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      receivedPath = String(options?.localSkillPath || '');
      writeLocalMetadata = options?.writeLocalMetadata;
      options?.onPackageCaptured?.([{
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: demo\ndescription: safe\n---\n# Test\n').toString('base64'),
      }]);
      return { submission: { id: 'submission-external' }, skill: { name: 'demo', path: localSkillPath } };
    },
  }));

  const result = await tool.execute({ skillName: 'demo', localSkillPath }, { sessionId: 'explicit-local-path' } as any);
  assert.equal(result.ok, true);
  assert.equal(receivedPath, localSkillPath);
  assert.equal(writeLocalMetadata, false);
  assert.match(result.content, /no local tracking metadata was written/);
  assert.match(result.content, /Files: 1 \(.* KB\)/);
});

test('a null local path is treated as omitted when a Skill name is provided', async () => {
  let calls = 0;
  let receivedPath: unknown = 'not-called';
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      receivedPath = options?.localSkillPath;
      options?.onPackageCaptured?.([{
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: demo\ndescription: safe\n---\n# Test\n').toString('base64'),
      }]);
      return { submission: { id: 'submission-null-path' }, skill: { name: 'demo' } };
    },
  }));

  const result = await tool.execute({ skillName: 'demo', localSkillPath: null }, { sessionId: 'null-local-path' } as any);
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(receivedPath, undefined);
});

test('explicit local path is preserved for the isolated automatic-repair upload', async () => {
  const localSkillPath = 'C:\\external-skills\\demo';
  let calls = 0;
  const receivedPaths: string[] = [];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      receivedPaths.push(String(options?.localSkillPath || ''));
      const files = (options as any)?.packageFiles || [{
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: " demo "\ndescription: safe\n---\n# Test\n').toString('base64'),
      }];
      options?.onPackageCaptured?.(files);
      if (calls === 1) throw validationError('report-explicit-path');
      assert.equal(options?.writeLocalMetadata, false);
      assert.match(Buffer.from(files[0].contentBase64, 'base64').toString('utf8'), /name: "demo"/);
      return { submission: { id: 'submission-explicit-path' }, skill: { name: 'demo', path: localSkillPath } };
    },
  }));

  const result = await tool.execute({ skillName: 'demo', localSkillPath }, { sessionId: 'explicit-path-repair' } as any);
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(receivedPaths, [localSkillPath, localSkillPath]);
  assert.match(result.content, /no local tracking metadata was written/);
});

test('an explicit local path is sufficient to identify a Skill without a separate skillName', async () => {
  const localSkillPath = 'C:\\external-skills\\directory-name';
  let receivedName: unknown;
  let receivedPath: unknown;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (input, options) => {
      receivedName = input.skillName;
      receivedPath = options?.localSkillPath;
      return { submission: { id: 'submission-path-only' }, skill: { name: 'metadata-name', path: localSkillPath } };
    },
  }));

  const result = await tool.execute({ localSkillPath }, { sessionId: 'path-only-publication' } as any);
  assert.equal(result.ok, true);
  assert.equal(receivedName, '');
  assert.equal(receivedPath, localSkillPath);
  assert.match(result.content, /metadata-name/);
});

test('metadata writes are limited to real paths inside the configured Skill workspace', async () => {
  const previousSkillsRoot = process.env.XIAOBA_SKILLS_DIR;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-path-boundary-'));
  const skillsRoot = path.join(tempRoot, 'skills');
  const inside = path.join(skillsRoot, 'regular');
  const dotted = path.join(skillsRoot, '..hidden');
  const outside = path.join(tempRoot, 'outside');
  const escaped = path.join(skillsRoot, '..', 'outside');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(dotted, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  process.env.XIAOBA_SKILLS_DIR = skillsRoot;
  const metadataWrites: unknown[] = [];
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      metadataWrites.push(options?.writeLocalMetadata);
      return { submission: { id: 'submission-boundary' }, skill: { name: 'demo' } };
    },
  }));

  try {
    for (const localSkillPath of [inside, dotted, escaped]) {
      const result = await tool.execute({ skillName: 'demo', localSkillPath }, { sessionId: 'path-boundary' } as any);
      assert.equal(result.ok, true);
    }
    assert.deepEqual(metadataWrites, [true, true, false]);

    const symlinkPath = path.join(skillsRoot, 'linked-outside');
    try {
      fs.symlinkSync(outside, symlinkPath, 'junction');
      const result = await tool.execute({ skillName: 'demo', localSkillPath: symlinkPath }, { sessionId: 'path-symlink-boundary' } as any);
      assert.equal(result.ok, true);
      assert.equal(metadataWrites[metadataWrites.length - 1], false);
    } catch (error: any) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
    }
  } finally {
    if (previousSkillsRoot === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = previousSkillsRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
