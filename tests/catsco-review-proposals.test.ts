import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeReviewProposalBundle } from '../src/utils/catsco-review-proposals';
import { analyzeUsageData } from '../src/utils/catsco-review-usage-analyzer';
import type { ReviewData } from '../src/utils/catsco-review-agent-client';
import type { ReviewFinding } from '../src/utils/catsco-review-analyzer';

describe('catsco review proposals', () => {
  test('writes proposal files without production prompt or skill changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-review-proposals-'));
    try {
      const reviewData: ReviewData = {
        summary: {
          upload_count: 1,
          parsed_upload_count: 1,
          failed_upload_count: 0,
          session_count: 1,
          turn_count: 1,
          ai_call_count: 1,
          tool_call_count: 1,
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
        failures: [],
        sessions: [{
          session_record_id: 'session-1',
          upload_id: 'upload-1',
          user_key: 'teacher-key',
          device_key: 'device-key',
          bot_key: 'bot-school',
          person_key: 'person-teacher',
          actor_key: 'actor-teacher',
          session_key: 'session-key',
          session_type: 'chat',
          started_at: '2026-05-20 00:00:00',
          entry_count: 0,
          runtime_count: 0,
          turn_count: 1,
          ai_call_count: 1,
          tool_call_count: 0,
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          summary_status: 'ready',
          created_at: '2026-05-20 00:00:00',
        }],
        sessionEntries: {},
        sessionTurns: {
          'session-1': [{
            turn_record_id: 'turn-1',
            turn_no: 1,
            timestamp: '2026-05-20 00:00:00',
            bot_key: 'bot-school',
            person_key: 'person-teacher',
            actor_key: 'actor-teacher',
            user_text: '帮我统计张三同学的成绩，手机号 13812345678',
            assistant_text: '可以',
          }],
        },
      };
      const findings: ReviewFinding[] = [
        {
          category: 'missing_skill_or_tool',
          severity: 'medium',
          title: 'Missing skill or missing tool routing',
          count: 2,
          affectedSessions: ['session-1'],
          evidence: ['unknown tool: report_builder'],
          suggestedActions: ['Create or refine a skill that explicitly covers this task type.'],
        },
      ];

      const bundle = writeReviewProposalBundle({
        outputDir: root,
        runId: '20260520-120000',
        reviewData,
        findings,
        usageAnalysis: analyzeUsageData(reviewData, { targetUserKey: 'teacher-key' }),
      });

      assert.equal(path.basename(bundle.runDir), '20260520-120000');
      assert.ok(fs.existsSync(bundle.files.report));
      assert.ok(fs.existsSync(bundle.files.findings));
      assert.ok(fs.existsSync(bundle.files.promptSuggestions));
      assert.ok(fs.existsSync(bundle.files.skillSuggestions));
      assert.ok(fs.existsSync(bundle.files.codeSuggestions));
      assert.ok(fs.existsSync(bundle.files.evalCases));
      assert.ok(fs.existsSync(bundle.files.usageReport));
      assert.ok(fs.existsSync(bundle.files.usageMetrics));
      assert.equal(path.basename(bundle.files.rawReviewData), 'raw_review_data.server_redacted.local.json');
      assert.match(fs.readFileSync(bundle.files.skillSuggestions, 'utf-8'), /Candidate skill work/);
      assert.doesNotMatch(fs.readFileSync(bundle.files.findings, 'utf-8'), /unknown tool: report_builder/);
      assert.doesNotMatch(fs.readFileSync(bundle.files.findings, 'utf-8'), /"session-1"/);
      assert.doesNotMatch(fs.readFileSync(bundle.files.evalCases, 'utf-8'), /unknown tool: report_builder/);
      assert.doesNotMatch(fs.readFileSync(bundle.files.usageReport, 'utf-8'), /张三|13812345678/);
      assert.match(fs.readFileSync(bundle.files.usageReport, 'utf-8'), /actor-teacher/);
      assert.doesNotMatch(fs.readFileSync(bundle.files.usageMetrics, 'utf-8'), /张三|13812345678/);
      assert.match(fs.readFileSync(bundle.files.rawReviewData, 'utf-8'), /"summary"/);
      assert.equal(fs.existsSync(path.join(root, 'prompts')), false);
      assert.equal(fs.existsSync(path.join(root, 'skills')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
