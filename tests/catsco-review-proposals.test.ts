import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeReviewProposalBundle } from '../src/utils/catsco-review-proposals';
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
        sessions: [],
        sessionEntries: {},
        sessionTurns: {},
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
      });

      assert.equal(path.basename(bundle.runDir), '20260520-120000');
      assert.ok(fs.existsSync(bundle.files.report));
      assert.ok(fs.existsSync(bundle.files.findings));
      assert.ok(fs.existsSync(bundle.files.promptSuggestions));
      assert.ok(fs.existsSync(bundle.files.skillSuggestions));
      assert.ok(fs.existsSync(bundle.files.evalCases));
      assert.match(fs.readFileSync(bundle.files.skillSuggestions, 'utf-8'), /Candidate skill work/);
      assert.equal(fs.existsSync(path.join(root, 'prompts')), false);
      assert.equal(fs.existsSync(path.join(root, 'skills')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
