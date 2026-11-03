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
      options?.onPackageCaptured?.([{ path: 'SKILL.md', contentBase64: Buffer.from('---\nname: demo\ndescription: safe\n---\n# Test\n').toString('base64') }]);
      throw validationError(reports[calls++]);
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
