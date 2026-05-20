import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface ReviewGitOptions {
  targetRepo: string;
  proposalSourceDir: string;
  runId: string;
  prBaseBranch: string;
  gitRemote: string;
  createBranch: boolean;
  commitChanges: boolean;
  createGithubPr: boolean;
}

export interface ReviewGitResult {
  repoProposalDir: string;
  branch?: string;
  commit?: string;
  prUrl?: string;
}

export function runReviewGitWorkflow(options: ReviewGitOptions): ReviewGitResult {
  const repo = path.resolve(options.targetRepo);
  assertGitRepo(repo);
  assertTrackedWorktreeClean(repo);

  const branch = options.createBranch
    ? createProposalBranch(repo, options.runId)
    : currentBranch(repo);

  const repoProposalDir = path.join(repo, '.catsco-review', 'proposals', options.runId);
  if (fs.existsSync(repoProposalDir)) {
    throw new Error(`Review proposal directory already exists: ${repoProposalDir}`);
  }
  fs.mkdirSync(path.dirname(repoProposalDir), { recursive: true });
  fs.cpSync(options.proposalSourceDir, repoProposalDir, { recursive: true });

  const result: ReviewGitResult = { repoProposalDir, branch };

  if (options.commitChanges || options.createGithubPr) {
    git(repo, ['add', path.relative(repo, repoProposalDir).replace(/\\/g, '/')]);
    git(repo, ['commit', '-m', `Review Agent proposals ${options.runId}`]);
    result.commit = git(repo, ['rev-parse', '--short', 'HEAD']).trim();
  }

  if (options.createGithubPr) {
    if (!result.commit) {
      throw new Error('Creating a GitHub PR requires committed proposal files.');
    }
    const prBranch = currentBranch(repo);
    git(repo, ['push', '-u', options.gitRemote, prBranch]);
    const reportPath = path.join(repoProposalDir, 'report.md');
    result.prUrl = gh(repo, [
      'pr',
      'create',
      '--base',
      options.prBaseBranch,
      '--head',
      prBranch,
      '--title',
      `Review Agent proposals ${options.runId}`,
      '--body-file',
      reportPath,
    ]).trim();
  }

  return result;
}

function assertGitRepo(repo: string): void {
  if (!fs.existsSync(path.join(repo, '.git'))) {
    throw new Error(`CATSCO_REVIEW_TARGET_REPO is not a Git repository: ${repo}`);
  }
}

function assertTrackedWorktreeClean(repo: string): void {
  const status = git(repo, ['status', '--porcelain', '--untracked-files=no']).trim();
  if (status) {
    throw new Error(
      'Target repo has tracked local changes. Commit or stash them before Review Agent creates proposal artifacts.',
    );
  }
}

function createProposalBranch(repo: string, runId: string): string {
  const branch = `review-agent/proposals-${runId}`;
  git(repo, ['checkout', '-b', branch]);
  return branch;
}

function currentBranch(repo: string): string {
  return git(repo, ['branch', '--show-current']).trim();
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gh(repo: string, args: string[]): string {
  return execFileSync('gh', args, {
    cwd: repo,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
