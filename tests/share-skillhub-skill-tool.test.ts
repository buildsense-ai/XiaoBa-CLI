import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { ShareSkillHubSkillTool } from '../src/tools/share-skillhub-skill-tool';
import { SYNTHETIC_USER_MESSAGE_FLAGS } from '../src/core/session-fork';

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
  assert.match(sentMessages[0], /该 Skill 用于样例任务/);
  assert.ok(reportId);
  assert.match(String(draft.content), new RegExp(reportId));
  assert.match(String(draft.content), /该 Skill 用于样例任务/);
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

test('current human approval takes precedence over later user-role context without a human-input marker', async () => {
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
  const context: any = {
    sessionId: 'description-episode-input',
    conversationHistory: history,
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
  };
  await tool.execute({ skillName: 'sample-skill' }, context);

  history.push({ role: 'user', content: '我确认使用这个描述并发布', __episodeInputKind: 'root' });
  history.push({ role: 'user', content: 'internal continuation context' });
  const published = await tool.execute({
    confirmDescription: true,
    descriptionReportId: 'episode-input-report',
    confirmedDescription: 'A sample Skill.',
  }, context);

  assert.equal(published.ok, true);
  assert.equal(shareCalls, 2);
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
    runtimeServices: { aiService: { chat: async () => ({ content: '{"description":"A sample Skill."}' }) } },
  };
  const draft = await tool.execute({ skillName: 'sample-skill' }, context);
  const reportId = 'description-version-report';
  history.push({ role: 'user', content: '确认发布新版本' });
  const versionGate = await tool.execute({ confirmDescription: true, descriptionReportId: reportId,
    confirmedDescription: 'A sample Skill.' }, context);
  assert.equal(versionGate.ok, true);
  assert.match(String(versionGate.content), /new patch version/i);
  assert.equal(shareCalls, 2);

  history.push({ role: 'user', content: '确认' });
  const weakVersionApproval = await tool.execute({ confirmDescription: true, confirmPublish: true,
    descriptionReportId: reportId, confirmedDescription: 'A sample Skill.' }, context);
  assert.equal(weakVersionApproval.ok, false);
  assert.equal(weakVersionApproval.errorCode, 'DESCRIPTION_VERSION_CONFIRMATION_REQUIRED');
  assert.equal(shareCalls, 2);

  history.push({ role: 'user', content: '确认发布新版本' });
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
  assert.equal(result.errorCode, 'DESCRIPTION_CONFIRMATION_EXPIRED');
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
