import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runReviewGitWorkflow } from '../src/utils/catsco-review-gitops';

describe('catsco review gitops', () => {
  test('copies only approved proposal files into the target repo', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-review-gitops-'));
    const source = path.join(root, 'source');
    const repo = path.join(root, 'repo');
    try {
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });

      fs.writeFileSync(path.join(source, 'report.md'), '# report\n', 'utf-8');
      fs.writeFileSync(path.join(source, 'findings.json'), '[]\n', 'utf-8');
      fs.writeFileSync(path.join(source, 'prompt_suggestions.md'), '# prompt\n', 'utf-8');
      fs.writeFileSync(path.join(source, 'skill_suggestions.md'), '# skill\n', 'utf-8');
      fs.writeFileSync(path.join(source, 'code_suggestions.md'), '# code\n', 'utf-8');
      fs.writeFileSync(path.join(source, 'eval_cases.jsonl'), '', 'utf-8');
      fs.writeFileSync(path.join(source, 'usage_report.md'), '# usage\n', 'utf-8');
      fs.writeFileSync(path.join(source, 'usage_metrics.json'), '{"user_key":"teacher-key"}\n', 'utf-8');
      fs.writeFileSync(path.join(source, 'raw_review_data.server_redacted.local.json'), '{"turns":["private-ish"]}\n', 'utf-8');

      const result = runReviewGitWorkflow({
        targetRepo: repo,
        proposalSourceDir: source,
        includeFiles: [
          'report.md',
          'findings.json',
          'prompt_suggestions.md',
          'skill_suggestions.md',
          'code_suggestions.md',
          'eval_cases.jsonl',
        ],
        runId: '20260520-120000',
        prBaseBranch: 'main',
        gitRemote: 'origin',
        createBranch: false,
        commitChanges: false,
        createGithubPr: false,
      });

      assert.equal(fs.existsSync(path.join(result.repoProposalDir, 'report.md')), true);
      assert.equal(fs.existsSync(path.join(result.repoProposalDir, 'code_suggestions.md')), true);
      assert.equal(fs.existsSync(path.join(result.repoProposalDir, 'usage_report.md')), false);
      assert.equal(fs.existsSync(path.join(result.repoProposalDir, 'usage_metrics.json')), false);
      assert.equal(fs.existsSync(path.join(result.repoProposalDir, 'raw_review_data.server_redacted.local.json')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
