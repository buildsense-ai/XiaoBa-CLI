import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShareSkillHubSkillTool } from '../src/tools/share-skillhub-skill-tool';

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
