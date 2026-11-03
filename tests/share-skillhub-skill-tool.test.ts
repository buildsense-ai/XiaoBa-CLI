import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShareSkillHubSkillTool } from '../src/tools/share-skillhub-skill-tool';

function validationError(reportId: string): Error {
  return Object.assign(new Error('Rejected by publication preflight.'), {
    status: 422,
    code: 'skillhub.publish_validation_failed',
    validation: {
      reportId,
      issues: [{ code: 'metadata.name_whitespace', blocking: true, repairPolicy: 'automatic' }],
    },
  });
}

test('SkillHub publication repair enforces the three-retry ceiling in the tool', async () => {
  const reports = ['report-3', 'report-4'];
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      if (calls++ >= 1) return { submission: { id: 'submission-after-limit' }, skill: { name: 'test-skill' } };
      options?.onPackageCaptured?.([{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: "demo"\ndescription: safe\n---\n# Test\n').toString('base64') }]);
      throw validationError(reports[0]);
    },
  }));
  const context = { sessionId: 'publication-repair-session' } as any;
  const repairKey = `${context.sessionId}:test-skill`;
  (tool as any).pendingRepairs.set(repairKey, {
    reportId: 'report-2',
    retries: 2,
    updatedAt: Date.now(),
    snapshot: {
      entryText: '---\nname: " demo "\ndescription: safe\n---\n# Test\n',
      otherFiles: [],
      bytes: 128,
    },
  });

  const finalRetry = await tool.execute({ skillName: 'test-skill', repairReportId: 'report-2' }, context);
  assert.equal(finalRetry.ok, false);
  assert.match(finalRetry.message, /report-3/);

  const exhausted = await tool.execute({ skillName: 'test-skill', repairReportId: 'report-3' }, context);
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.errorCode, 'SKILLHUB_REPAIR_LIMIT_REACHED');
  assert.equal(calls, 1);

  const normalPublish = await tool.execute({ skillName: 'test-skill' }, context);
  assert.equal(normalPublish.ok, true);
  assert.equal(calls, 2);
});

test('manual or confirmation-required publication issues do not open an automatic retry chain', async () => {
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      options?.onPackageCaptured?.([{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: demo\ndescription: safe\n---\n# Test\n').toString('base64') }]);
      calls++;
      throw Object.assign(new Error('Rejected by publication preflight.'), {
        status: 422,
        code: 'skillhub.publish_validation_failed',
        validation: {
          reportId: 'report-manual',
          issues: [{ code: 'metadata.description_missing', blocking: true, repairPolicy: 'confirmation_required' }],
        },
      });
    },
  }));
  const context = { sessionId: 'manual-publication-session' } as any;
  const result = await tool.execute({ skillName: 'test-skill' }, context);
  assert.equal(result.ok, false);
  const retry = await tool.execute({ skillName: 'test-skill', repairReportId: 'report-manual' }, context);
  assert.equal(retry.errorCode, 'SKILLHUB_REPAIR_REPORT_EXPIRED');
  assert.equal(calls, 1);
});

test('automatic format repair cannot change runtime instructions before the next upload', async () => {
  let reachedUpload = false;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      options?.onPackageCaptured?.([{
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: demo\ndescription: safe\n---\n# Changed runtime instructions\n').toString('base64'),
      }]);
      reachedUpload = true;
      throw validationError('report-next');
    },
  }));
  const context = { sessionId: 'format-only-session' } as any;
  (tool as any).pendingRepairs.set(`${context.sessionId}:test-skill`, {
    reportId: 'report-current',
    retries: 0,
    updatedAt: Date.now(),
    snapshot: {
      entryText: '---\nname: " demo "\ndescription: safe\n---\n# Original runtime instructions\n',
      otherFiles: [],
      bytes: 160,
    },
  });

  const result = await tool.execute({ skillName: 'test-skill', repairReportId: 'report-current' }, context);
  assert.equal(result.ok, false);
  assert.match(result.message, /only the leading\/trailing whitespace/);
  assert.equal(reachedUpload, false);
});

test('a non-UTF-8 entrypoint disables automatic repair but does not block a normal publication', async () => {
  let captured = false;
  let uploadReached = false;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      captured = true;
      options?.onPackageCaptured?.([{ path: 'SKILL.md', contentBase64: Buffer.from([0xff, 0xfe]).toString('base64') }]);
      uploadReached = true;
      return { submission: { id: 'submission-utf8' }, skill: { name: 'test-skill' } };
    },
  }));

  const result = await tool.execute({ skillName: 'test-skill' }, { sessionId: 'normal-utf8-session' } as any);
  assert.equal(result.ok, true);
  assert.equal(captured, true);
  assert.equal(uploadReached, true);
});

test('a declined automatic repair clears its state so a reviewed normal publication can proceed', async () => {
  let calls = 0;
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      calls++;
      options?.onPackageCaptured?.([{
        path: 'SKILL.md',
        contentBase64: Buffer.from(calls === 1
          ? '---\nname: demo\ndescription: safe\n---\n# Changed runtime instructions\n'
          : '---\nname: demo\ndescription: safe\n---\n# Reviewed content\n').toString('base64'),
      }]);
      return { submission: { id: 'submission-reviewed' }, skill: { name: 'test-skill' } };
    },
  }));
  const context = { sessionId: 'declined-repair-session' } as any;
  const repairKey = `${context.sessionId}:test-skill`;
  (tool as any).pendingRepairs.set(repairKey, {
    reportId: 'report-current',
    retries: 0,
    updatedAt: Date.now(),
    snapshot: {
      entryText: '---\nname: " demo "\ndescription: safe\n---\n# Original runtime instructions\n',
      otherFiles: [],
      bytes: 160,
    },
  });

  const declined = await tool.execute({ skillName: 'test-skill', repairReportId: 'report-current' }, context);
  assert.equal(declined.ok, false);
  assert.equal(declined.errorCode, 'SKILLHUB_REPAIR_DECLINED');
  assert.match(declined.message, /without repairReportId/);
  assert.equal((tool as any).pendingRepairs.has(repairKey), false);

  const normal = await tool.execute({ skillName: 'test-skill' }, context);
  assert.equal(normal.ok, true);
  assert.equal(calls, 2);
});

test('automatic repair rejects YAML formatting or comment changes even when parsed data is unchanged', async () => {
  const tool = new ShareSkillHubSkillTool(() => ({
    shareLocalSkill: async (_input, options) => {
      options?.onPackageCaptured?.([{
        path: 'SKILL.md',
        contentBase64: Buffer.from('---\nname: "demo"\ndescription: safe # changed comment\n---\n# Test\n').toString('base64'),
      }]);
      return { submission: { id: 'must-not-upload' } };
    },
  }));
  const context = { sessionId: 'formatting-repair-session' } as any;
  (tool as any).pendingRepairs.set(`${context.sessionId}:test-skill`, {
    reportId: 'report-current',
    retries: 0,
    updatedAt: Date.now(),
    snapshot: {
      entryText: '---\nname: " demo "\ndescription: safe\n---\n# Test\n',
      otherFiles: [],
      bytes: 128,
    },
  });

  const result = await tool.execute({ skillName: 'test-skill', repairReportId: 'report-current' }, context);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'SKILLHUB_REPAIR_DECLINED');
});
