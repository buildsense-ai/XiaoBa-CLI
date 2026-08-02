import { canonicalJson } from './canonical';
import { CacheBenchmarkResult } from './types';

export type CacheBenchmarkReportFormat = 'json' | 'text';

export function renderCacheBenchmarkResult(
  result: CacheBenchmarkResult,
  format: CacheBenchmarkReportFormat,
): string {
  if (format === 'json') return `${canonicalJson(result)}\n`;
  const lines = [
    `status=${result.status}`,
    `exit_code=${result.exit_code}`,
    `manifest_fingerprint=${result.manifest_fingerprint}`,
    `config_fingerprint=${result.config_fingerprint}`,
    `ledger_fingerprint=${result.ledger_fingerprint}`,
    `latest_round=${result.latest_round ?? 'none'}`,
    `qualifying_rounds=${result.qualifying_rounds.join(',') || 'none'}`,
    `reasons=${result.reasons.join(',') || 'none'}`,
    `ledger_reasons=${result.ledger_reasons.join(',') || 'none'}`,
  ];
  for (const coverage of result.capability_coverage) {
    lines.push(
      `capability_scope=${coverage.scope_fingerprint} status=${coverage.status} missing_capabilities=${coverage.missing_capabilities.join(',') || 'none'}`,
    );
  }
  for (const round of result.rounds) {
    lines.push(
      `round=${round.round} status=${round.status} artifact_fingerprint=${round.artifact_fingerprint} reasons=${round.reasons.join(',') || 'none'}`,
    );
    for (const cell of round.cells) {
      lines.push([
        `cell=${cell.cell_fingerprint}`,
        `status=${cell.status}`,
        `input_tokens=${cell.input_tokens}`,
        `cache_read_tokens=${cell.cache_read_tokens}`,
        `raw_read_ratio=${formatRatio(cell.raw_read_ratio)}`,
        `capped_task_ratio=${formatRatio(cell.capped_task_ratio)}`,
        `positive_task_count=${cell.positive_task_count}`,
        `reasons=${cell.reasons.join(',') || 'none'}`,
      ].join(' '));
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderCacheBenchmarkInputError(format: CacheBenchmarkReportFormat): string {
  if (format === 'json') {
    return `${canonicalJson({
      schema: 'xiaoba.cache_benchmark_result.v3',
      status: 'invalid',
      exit_code: 2,
      reasons: ['schema_invalid'],
    })}\n`;
  }
  return 'status=invalid\nexit_code=2\nreasons=schema_invalid\n';
}

function formatRatio(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'unavailable' : value.toFixed(6);
}
