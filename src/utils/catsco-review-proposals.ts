import * as fs from 'fs';
import * as path from 'path';
import type { ReviewData } from './catsco-review-agent-client';
import type { ReviewFinding, ReviewFindingCategory } from './catsco-review-analyzer';
import type { ReviewUsageAnalysis } from './catsco-review-usage-analyzer';

export interface ReviewProposalBundle {
  runDir: string;
  files: {
    report: string;
    findings: string;
    promptSuggestions: string;
    skillSuggestions: string;
    codeSuggestions: string;
    evalCases: string;
    usageReport: string;
    usageMetrics: string;
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
  usageAnalysis: ReviewUsageAnalysis;
}): ReviewProposalBundle {
  const runDir = path.join(input.outputDir, input.runId);
  fs.mkdirSync(runDir, { recursive: true });

  const files = {
    report: path.join(runDir, 'report.md'),
    findings: path.join(runDir, 'findings.json'),
    promptSuggestions: path.join(runDir, 'prompt_suggestions.md'),
    skillSuggestions: path.join(runDir, 'skill_suggestions.md'),
    codeSuggestions: path.join(runDir, 'code_suggestions.md'),
    evalCases: path.join(runDir, 'eval_cases.jsonl'),
    usageReport: path.join(runDir, 'usage_report.md'),
    usageMetrics: path.join(runDir, 'usage_metrics.json'),
    rawReviewData: path.join(runDir, 'raw_review_data.server_redacted.local.json'),
  };

  const publicFindings = input.findings.map(toPublicFinding);
  fs.writeFileSync(files.report, renderReviewReport(input.runId, input.reviewData, publicFindings), 'utf-8');
  fs.writeFileSync(files.findings, `${JSON.stringify(publicFindings, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(files.promptSuggestions, renderPromptSuggestions(publicFindings), 'utf-8');
  fs.writeFileSync(files.skillSuggestions, renderSkillSuggestions(publicFindings), 'utf-8');
  fs.writeFileSync(files.codeSuggestions, renderCodeSuggestions(publicFindings), 'utf-8');
  fs.writeFileSync(files.evalCases, renderEvalCases(publicFindings), 'utf-8');
  fs.writeFileSync(files.usageReport, renderUsageReport(input.runId, input.usageAnalysis), 'utf-8');
  fs.writeFileSync(files.usageMetrics, `${JSON.stringify(input.usageAnalysis, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(files.rawReviewData, `${JSON.stringify(input.reviewData, null, 2)}\n`, 'utf-8');

  return { runDir, files };
}

function renderUsageReport(runId: string, usage: ReviewUsageAnalysis): string {
  const lines = [
    `# CatsCo Usage Report ${runId}`,
    '',
    'This report summarizes redacted, structured Review API data. It intentionally uses topic labels and hashed question references instead of raw teacher or student text.',
    '',
    '## Scope',
    '',
    `- Uploaded from: \`${usage.window.uploadedFrom || 'not set'}\``,
    `- Uploaded to: \`${usage.window.uploadedTo || 'not set'}\``,
    `- Target user key: \`${usage.target.userKey || 'all'}\``,
    `- Target device key: \`${usage.target.deviceKey || 'all'}\``,
    '',
    '## Frequency',
    '',
    `- Users: \`${usage.totals.userCount}\``,
    `- Devices: \`${usage.totals.deviceCount}\``,
    `- Sessions: \`${usage.totals.sessionCount}\``,
    `- Active days: \`${usage.totals.activeDays}\``,
    `- Turns: \`${usage.totals.turnCount}\``,
    `- Loaded turns for topic analysis: \`${usage.totals.loadedTurnCount}\``,
    `- Average turns per session: \`${usage.totals.averageTurnsPerSession}\``,
    `- Tool calls: \`${usage.totals.toolCallCount}\``,
    '',
    '## Main Uses',
    '',
  ];

  if (usage.topics.length === 0) {
    lines.push('No user question topics were available in the reviewed window.', '');
  } else {
    for (const topic of usage.topics.slice(0, 10)) {
      lines.push(`- ${topic.label}: \`${topic.count}\` question(s), \`${topic.sessionCount}\` session(s)`);
    }
    lines.push('');
  }

  lines.push('## Top Users', '');
  if (usage.users.length === 0) {
    lines.push('No user-level usage was available.', '');
  } else {
    for (const user of usage.users.slice(0, 10)) {
      const topTopics = user.topTopics.slice(0, 3).map(item => `${item.name}=${item.count}`).join(', ') || 'none';
      lines.push(
        `- \`${user.userKey}\`: sessions=\`${user.sessionCount}\`, turns=\`${user.turnCount}\`, `
        + `active_days=\`${user.activeDays}\`, top_topics=\`${topTopics}\``,
      );
    }
    lines.push('');
  }

  lines.push('## Tool Usage', '');
  if (usage.toolUsage.length === 0) {
    lines.push('No tool usage was captured in the reviewed window.', '');
  } else {
    for (const tool of usage.toolUsage.slice(0, 10)) {
      lines.push(`- \`${tool.name}\`: \`${tool.count}\` call(s), \`${tool.sessionCount}\` session(s)`);
    }
    lines.push('');
  }

  lines.push('## Time Distribution', '', '### By Day', '');
  if (usage.timeBuckets.byDay.length === 0) {
    lines.push('- No timestamped sessions were available.');
  } else {
    for (const bucket of usage.timeBuckets.byDay.slice(-14)) {
      lines.push(`- \`${bucket.bucket}\`: sessions=\`${bucket.sessionCount}\`, turns=\`${bucket.turnCount}\``);
    }
  }
  lines.push('', '### By Hour UTC', '');
  if (usage.timeBuckets.byHour.length === 0) {
    lines.push('- No timestamped sessions were available.');
  } else {
    for (const bucket of usage.timeBuckets.byHour) {
      lines.push(`- \`${bucket.bucket}:00\`: sessions=\`${bucket.sessionCount}\`, turns=\`${bucket.turnCount}\``);
    }
  }

  lines.push(
    '',
    '## Privacy Notes',
    '',
    '- This report does not include raw teacher questions or assistant answers.',
    '- `questionHash` values in `usage_metrics.json` are for grouping only and should not be treated as content.',
    '- For a named teacher report, configure a target `user_key` or `device_key` and keep the mapping outside Git.',
    '',
  );

  return `${lines.join('\n')}\n`;
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

  const topFindings = findings.slice(0, 5);
  if (topFindings.length > 0) {
    lines.push('## Top Priorities', '');
    for (const finding of topFindings) {
      lines.push(
        `- ${severityLabel(finding.severity)} ${finding.title} `
        + `(impact=${finding.impactScore || 0}, type=${finding.proposalType || 'eval'}, count=${finding.count})`,
      );
    }
    lines.push('');
  }

  for (const finding of findings) {
    lines.push(
      `### ${severityLabel(finding.severity)} ${finding.title}`,
      '',
      `- Category: \`${finding.category}\``,
      `- Proposal type: \`${finding.proposalType || 'eval'}\``,
      `- Impact score: \`${finding.impactScore || 0}\``,
      `- Pattern key: \`${finding.patternKey || 'unknown'}\``,
      `- Count: \`${finding.count}\``,
      `- Affected sessions: \`${finding.affectedSessions.length}\``,
      `- Tool names: \`${(finding.toolNames || []).join(', ') || 'none'}\``,
      `- Event categories: \`${(finding.eventCategories || []).join(', ') || 'none'}\``,
      '',
      'Evidence summary:',
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
      `- Impact score: \`${finding.impactScore || 0}\``,
      `- Pattern key: \`${finding.patternKey || 'unknown'}\``,
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
      `- Impact score: \`${finding.impactScore || 0}\``,
      `- Pattern key: \`${finding.patternKey || 'unknown'}\``,
      `- Tool names: \`${(finding.toolNames || []).join(', ') || 'none'}\``,
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

function renderCodeSuggestions(findings: ReviewFinding[]): string {
  const lines = [
    '# Engineering Suggestions',
    '',
    'These are engineering design notes, not patches. A human should decide whether to open a production code PR.',
    '',
  ];

  for (const finding of findings) {
    if (!['tool', 'config', 'reliability', 'observability'].includes(finding.proposalType || '')) {
      continue;
    }
    lines.push(
      `## ${finding.title}`,
      '',
      `- Category: \`${finding.category}\``,
      `- Proposal type: \`${finding.proposalType || 'eval'}\``,
      `- Impact score: \`${finding.impactScore || 0}\``,
      `- Pattern key: \`${finding.patternKey || 'unknown'}\``,
      `- Likely owner: \`${likelyOwner(finding)}\``,
      '- Minimum engineering direction:',
      ...candidateEngineeringWork(finding).map(item => `  - ${item}`),
      '',
      '- Suggested tests:',
      ...candidateEngineeringTests(finding).map(item => `  - ${item}`),
      '',
    );
  }

  if (lines.length === 4) {
    lines.push('No engineering-specific changes suggested in this run.', '');
  }

  return `${lines.join('\n')}\n`;
}

function renderEvalCases(findings: ReviewFinding[]): string {
  return findings.map(finding => JSON.stringify({
    name: `review_agent_${finding.category}_${shortHash(finding.patternKey || 'unknown')}`,
    category: finding.category,
    severity: finding.severity,
    impact_score: finding.impactScore || 0,
    proposal_type: finding.proposalType || 'eval',
    pattern_key: finding.patternKey || 'unknown',
    source: 'catsco_review_agent',
    input: syntheticEvalInput(finding),
    expected_behavior: expectedEvalBehavior(finding.category),
    evidence_summary: finding.evidence.slice(0, 3),
  })).join('\n') + (findings.length ? '\n' : '');
}

function toPublicFinding(finding: ReviewFinding): ReviewFinding {
  return {
    ...finding,
    primarySignal: finding.patternKey || finding.primarySignal,
    evidence: summarizeEvidenceForPublicOutput(finding),
  };
}

function summarizeEvidenceForPublicOutput(finding: ReviewFinding): string[] {
  const parts = [
    `Pattern \`${finding.patternKey || 'unknown'}\` appeared ${finding.count} time(s).`,
    `Affected sessions: ${finding.affectedSessions.length}.`,
  ];
  if ((finding.toolNames || []).length > 0) {
    parts.push(`Tools involved: ${(finding.toolNames || []).slice(0, 5).join(', ')}.`);
  }
  if ((finding.eventCategories || []).length > 0) {
    parts.push(`Events involved: ${(finding.eventCategories || []).slice(0, 5).join(', ')}.`);
  }
  return parts.map(redactProposalText);
}

function syntheticEvalInput(finding: ReviewFinding): string {
  if (finding.category === 'permission_or_auth') {
    return 'A user asks the agent to perform a protected operation, but the required account authorization is missing or expired.';
  }
  if (finding.category === 'missing_skill_or_tool') {
    return 'A user asks for a recurring task type that the current agent repeatedly fails to route to an available skill or tool.';
  }
  if (finding.category === 'tool_failure') {
    return 'A tool call fails with a recurring sanitized failure pattern. The agent must validate inputs and choose a safe recovery path.';
  }
  if (finding.category === 'prompt_confusion') {
    return 'A user request is ambiguous enough that acting immediately could solve the wrong problem.';
  }
  if (finding.category === 'network_or_timeout') {
    return 'A remote dependency times out or returns a transient service failure during an otherwise recoverable workflow.';
  }
  if (finding.category === 'latency') {
    return 'A workflow takes noticeably longer than expected and needs progress updates or narrower retrieval.';
  }
  if (finding.category === 'token_usage') {
    return 'A session approaches the context budget because too much irrelevant context is included.';
  }
  if (finding.category === 'review_data_quality') {
    return 'A review run receives partial detail data from the logging API and must preserve useful findings without fabricating missing evidence.';
  }
  return `A recurring sanitized review pattern appears: ${finding.patternKey || finding.category}.`;
}

function likelyOwner(finding: ReviewFinding): string {
  if (finding.proposalType === 'config') return 'configuration/readiness';
  if (finding.proposalType === 'reliability') return 'runtime/tool reliability';
  if (finding.proposalType === 'tool') return (finding.toolNames || [])[0] || 'tooling';
  if (finding.proposalType === 'observability') return 'logging/observability';
  return 'agent behavior';
}

function candidateEngineeringWork(finding: ReviewFinding): string[] {
  if (finding.proposalType === 'config') {
    return [
      'Add a preflight/readiness check for the missing credential or connector state.',
      'Return a user-safe recovery instruction without exposing token values.',
    ];
  }
  if (finding.proposalType === 'reliability') {
    return [
      'Add timeout-specific retry or fallback behavior for idempotent operations.',
      'Record bounded, sanitized failure metadata for future review cycles.',
    ];
  }
  if (finding.proposalType === 'tool') {
    return [
      'Validate required tool arguments before execution.',
      'Add a typed failure result for the recurring error pattern.',
    ];
  }
  return [
    'Improve structured logging so future review runs can separate signal from noise.',
    'Add a regression test once the owner confirms the expected behavior.',
  ];
}

function candidateEngineeringTests(finding: ReviewFinding): string[] {
  if (finding.proposalType === 'config') {
    return ['Unit test missing credential preflight and user-safe error text.'];
  }
  if (finding.proposalType === 'reliability') {
    return ['Unit test retry/fallback behavior for timeout, 429, and 5xx responses.'];
  }
  if (finding.proposalType === 'tool') {
    return ['Unit test argument validation and controlled tool failure result.'];
  }
  return ['Add an eval or integration test that reproduces the sanitized pattern.'];
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
    review_data_quality: 'Preserve partial review results, report bounded diagnostics, and avoid treating missing detail data as an agent behavior defect.',
    general_failure: 'Resolve the issue without exposing private log data.',
  }[category];
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

function redactProposalText(value: string): string {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/catslog_(?:tok|review)_[A-Za-z0-9._~+/=-]+/g, 'catslog_[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{12,}/g, 'sk-[REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL_REDACTED]')
    .replace(/\b1[3-9]\d{9}\b/g, '[PHONE_REDACTED]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[PATH_REDACTED]')
    .replace(/\/home\/[^/\s]+/g, '/home/[USER_REDACTED]');
}
