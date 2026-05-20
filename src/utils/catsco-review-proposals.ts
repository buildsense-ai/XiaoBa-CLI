import * as fs from 'fs';
import * as path from 'path';
import type { ReviewData } from './catsco-review-agent-client';
import type { ReviewFinding, ReviewFindingCategory } from './catsco-review-analyzer';

export interface ReviewProposalBundle {
  runDir: string;
  files: {
    report: string;
    findings: string;
    promptSuggestions: string;
    skillSuggestions: string;
    evalCases: string;
    rawReviewData: string;
  };
}

export function makeReviewRunId(date: Date = new Date()): string {
  return date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '-')
    .replace('Z', '');
}

export function writeReviewProposalBundle(input: {
  outputDir: string;
  runId: string;
  reviewData: ReviewData;
  findings: ReviewFinding[];
}): ReviewProposalBundle {
  const runDir = path.join(input.outputDir, input.runId);
  fs.mkdirSync(runDir, { recursive: true });

  const files = {
    report: path.join(runDir, 'report.md'),
    findings: path.join(runDir, 'findings.json'),
    promptSuggestions: path.join(runDir, 'prompt_suggestions.md'),
    skillSuggestions: path.join(runDir, 'skill_suggestions.md'),
    evalCases: path.join(runDir, 'eval_cases.jsonl'),
    rawReviewData: path.join(runDir, 'raw_review_data.redacted.json'),
  };

  fs.writeFileSync(files.report, renderReviewReport(input.runId, input.reviewData, input.findings), 'utf-8');
  fs.writeFileSync(files.findings, `${JSON.stringify(input.findings, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(files.promptSuggestions, renderPromptSuggestions(input.findings), 'utf-8');
  fs.writeFileSync(files.skillSuggestions, renderSkillSuggestions(input.findings), 'utf-8');
  fs.writeFileSync(files.evalCases, renderEvalCases(input.findings), 'utf-8');
  fs.writeFileSync(files.rawReviewData, `${JSON.stringify(input.reviewData, null, 2)}\n`, 'utf-8');

  return { runDir, files };
}

function renderReviewReport(runId: string, reviewData: ReviewData, findings: ReviewFinding[]): string {
  const summary = reviewData.summary || {};
  const lines = [
    `# CatsCo Review Agent Report ${runId}`,
    '',
    '## Scope',
    '',
    `- Uploaded from: \`${summary.uploaded_from || 'not set'}\``,
    `- Uploaded to: \`${summary.uploaded_to || 'not set'}\``,
    `- Uploads: \`${summary.upload_count || 0}\``,
    `- Parsed uploads: \`${summary.parsed_upload_count || 0}\``,
    `- Failed uploads: \`${summary.failed_upload_count || 0}\``,
    `- Sessions: \`${summary.session_count || 0}\``,
    `- Turns: \`${summary.turn_count || 0}\``,
    `- Tool calls: \`${summary.tool_call_count || 0}\``,
    `- Total tokens: \`${summary.total_tokens || 0}\``,
    '',
    '## Findings',
    '',
  ];

  if (findings.length === 0) {
    lines.push('No recurring issue pattern was detected in this run.', '');
  }

  for (const finding of findings) {
    lines.push(
      `### ${severityLabel(finding.severity)} ${finding.title}`,
      '',
      `- Category: \`${finding.category}\``,
      `- Count: \`${finding.count}\``,
      `- Affected sessions: \`${finding.affectedSessions.length}\``,
      '',
      'Evidence:',
    );
    if (finding.evidence.length > 0) {
      lines.push(...finding.evidence.slice(0, 5).map(item => `- ${item}`));
    } else {
      lines.push('- No text evidence captured; inspect the related metrics.');
    }
    lines.push('', 'Recommended actions:', ...finding.suggestedActions.map(item => `- ${item}`), '');
  }

  lines.push(
    '## Human Review Checklist',
    '',
    '- Confirm the finding is reproducible from the redacted evidence.',
    '- Decide whether the change belongs in prompt, skill, tool code, or eval coverage.',
    '- Add or adjust tests before merging production behavior changes.',
    '- Do not paste private log content into prompts or docs.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

function renderPromptSuggestions(findings: ReviewFinding[]): string {
  const lines = [
    '# Prompt Suggestions',
    '',
    'These are proposal snippets. Review and adapt them before touching production prompts.',
    '',
  ];

  for (const finding of findings) {
    if (!['prompt_confusion', 'permission_or_auth', 'tool_failure', 'network_or_timeout'].includes(finding.category)) {
      continue;
    }
    lines.push(
      `## ${finding.title}`,
      '',
      'Candidate rule:',
      '',
      '```text',
      candidatePromptRule(finding.category),
      '```',
      '',
      'Why:',
      `- Seen \`${finding.count}\` time(s) in the reviewed window.`,
      '',
    );
  }

  if (lines.length === 4) {
    lines.push('No prompt-specific changes suggested in this run.', '');
  }

  return `${lines.join('\n')}\n`;
}

function renderSkillSuggestions(findings: ReviewFinding[]): string {
  const lines = [
    '# Skill Suggestions',
    '',
    'These are candidate skill changes. Treat each item as a design note, not an auto-approved patch.',
    '',
  ];

  for (const finding of findings) {
    if (!['missing_skill_or_tool', 'tool_failure', 'permission_or_auth', 'latency', 'token_usage'].includes(finding.category)) {
      continue;
    }
    lines.push(
      `## ${finding.title}`,
      '',
      `- Category: \`${finding.category}\``,
      `- Frequency: \`${finding.count}\``,
      '- Candidate skill work:',
      ...candidateSkillWork(finding.category).map(item => `  - ${item}`),
      '',
      '- Suggested acceptance criteria:',
      ...candidateAcceptanceCriteria(finding.category).map(item => `  - ${item}`),
      '',
    );
  }

  if (lines.length === 4) {
    lines.push('No skill-specific changes suggested in this run.', '');
  }

  return `${lines.join('\n')}\n`;
}

function renderEvalCases(findings: ReviewFinding[]): string {
  return findings.map(finding => JSON.stringify({
    name: `review_agent_${finding.category}`,
    category: finding.category,
    severity: finding.severity,
    source: 'catsco_review_agent',
    input: finding.evidence[0]
      ? `Handle a redacted session where this issue appears: ${finding.evidence[0]}`
      : `Handle a task related to ${finding.category}.`,
    expected_behavior: expectedEvalBehavior(finding.category),
    evidence: finding.evidence.slice(0, 3),
  })).join('\n') + (findings.length ? '\n' : '');
}

function severityLabel(severity: string): string {
  return { high: '[HIGH]', medium: '[MED]', low: '[LOW]' }[severity] || '[INFO]';
}

function candidatePromptRule(category: ReviewFindingCategory): string {
  if (category === 'permission_or_auth') {
    return 'Before using tools that require credentials, check whether the required token, scope, or connected account is available. If it is missing, explain the exact missing permission and ask the user to connect or authorize it.';
  }
  if (category === 'tool_failure') {
    return 'When a tool call fails, inspect whether the failure is transient, caused by invalid input, or caused by missing environment state. Retry only idempotent transient failures, otherwise report the concrete blocker and the next safe action.';
  }
  if (category === 'prompt_confusion') {
    return 'When the user request is ambiguous enough to risk doing the wrong work, ask one concise clarifying question before taking irreversible actions. If a safe assumption exists, state it briefly and continue.';
  }
  if (category === 'network_or_timeout') {
    return 'For timeout or network errors, give a short status update, retry with backoff where safe, and preserve enough context so the task can resume after connectivity recovers.';
  }
  return 'Add a narrow instruction for the repeated failure pattern after human review.';
}

function candidateSkillWork(category: ReviewFindingCategory): string[] {
  if (category === 'missing_skill_or_tool') {
    return [
      'Create a focused skill for the repeated task pattern.',
      'Add trigger rules and examples that make routing deterministic.',
      'Document required inputs and unavailable-tool fallbacks.',
    ];
  }
  if (category === 'tool_failure') {
    return [
      'Add validation for required parameters before invoking the tool.',
      'Capture sanitized failure metadata for future reviews.',
      'Add fallback behavior for known recoverable failure modes.',
    ];
  }
  if (category === 'permission_or_auth') {
    return [
      'Add a permission preflight step to the relevant skill.',
      'Document the exact connector/token/scope required by the workflow.',
    ];
  }
  if (category === 'latency') {
    return [
      'Split long workflows into observable stages with progress updates.',
      'Cache or pre-filter large log/context reads before model calls.',
    ];
  }
  if (category === 'token_usage') {
    return [
      'Summarize large retrieved context before passing it to the model.',
      'Add truncation rules and relevance ranking for logs/documents.',
    ];
  }
  return ['Inspect the representative sessions and define a targeted skill improvement.'];
}

function candidateAcceptanceCriteria(category: ReviewFindingCategory): string[] {
  if (category === 'missing_skill_or_tool') {
    return [
      'A representative task is routed to the intended skill without manual correction.',
      'The skill declines gracefully when required tools are unavailable.',
    ];
  }
  if (category === 'tool_failure') {
    return [
      'Invalid inputs are rejected before the tool call.',
      'Transient failures produce a controlled retry or a clear user-facing blocker.',
    ];
  }
  if (category === 'permission_or_auth') {
    return [
      'Missing credentials are detected before the protected operation.',
      'The user sees the missing authorization step without exposing secrets.',
    ];
  }
  if (category === 'latency') {
    return [
      'Long tasks emit progress updates.',
      'The average reviewed workflow duration decreases or becomes explainable.',
    ];
  }
  if (category === 'token_usage') {
    return [
      'Large-context runs stay below the configured token threshold.',
      'Answer quality is preserved in regression evals.',
    ];
  }
  return ['A regression eval captures the expected behavior.'];
}

function expectedEvalBehavior(category: ReviewFindingCategory): string {
  return {
    permission_or_auth: 'Detect missing permission early and explain the required authorization.',
    missing_skill_or_tool: 'Route to the correct skill or clearly explain that the capability is unavailable.',
    tool_failure: 'Validate inputs, recover if safe, and report a concrete blocker when recovery is unsafe.',
    prompt_confusion: 'Ask a concise clarifying question or state a safe assumption before acting.',
    network_or_timeout: 'Retry safe transient failures and preserve progress context.',
    latency: 'Give progress updates and avoid unnecessary repeated long-running calls.',
    token_usage: 'Reduce irrelevant context while preserving answer quality.',
    general_failure: 'Resolve the issue without exposing private log data.',
  }[category];
}
