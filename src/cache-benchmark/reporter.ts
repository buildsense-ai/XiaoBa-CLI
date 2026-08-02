import { canonicalJson } from './canonical';
import { CACHE_BENCHMARK_RESULT_SCHEMA, CacheBenchmarkResult } from './types';

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
      `capability_scope=${coverage.scope_fingerprint} traffic_class=${coverage.traffic_class} status=${coverage.status} missing_capabilities=${coverage.missing_capabilities.join(',') || 'none'}`,
    );
  }
  for (const round of result.rounds) {
    lines.push(
      `round=${round.round} status=${round.status} artifact_fingerprint=${round.artifact_fingerprint} reasons=${round.reasons.join(',') || 'none'}`,
    );
    for (const cell of round.cells) {
      lines.push([
        `cell=${cell.cell_fingerprint}`,
        `traffic_class=${cell.traffic_class}`,
        `status=${cell.status}`,
        `qualification_cache_class=${cell.qualification_cache_class}`,
        `input_tokens=${cell.input_tokens}`,
        `cache_read_tokens=${cell.cache_read_tokens}`,
        `raw_read_ratio=${formatRatio(cell.raw_read_ratio)}`,
        `capped_task_ratio=${formatRatio(cell.capped_task_ratio)}`,
        `positive_task_count=${cell.positive_task_count}`,
        `cold_input_tokens=${cell.cold_input_tokens}`,
        `cold_cache_read_tokens=${cell.cold_cache_read_tokens}`,
        `cold_read_ratio=${formatRatio(cell.cold_read_ratio)}`,
        `all_input_tokens=${cell.all_input_tokens}`,
        `all_cache_read_tokens=${cell.all_cache_read_tokens}`,
        `all_read_ratio=${formatRatio(cell.all_read_ratio)}`,
        `reasons=${cell.reasons.join(',') || 'none'}`,
      ].join(' '));
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderCacheBenchmarkInputError(format: CacheBenchmarkReportFormat): string {
  if (format === 'json') {
    return `${canonicalJson({
      schema: CACHE_BENCHMARK_RESULT_SCHEMA,
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
