import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
