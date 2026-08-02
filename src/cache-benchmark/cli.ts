#!/usr/bin/env node

import fs from 'node:fs';
import { parseLedgerJson, parseManifestJson, parseRoundJsonl } from './schema';
import {
  CacheBenchmarkReportFormat,
  renderCacheBenchmarkInputError,
  renderCacheBenchmarkResult,
} from './reporter';
import { scoreCacheBenchmark } from './scorer';

interface CliOptions {
  manifestPath: string;
  ledgerPath: string;
  evidencePaths: string[];
  format: CacheBenchmarkReportFormat;
  outputPath?: string;
}

export function runCacheBenchmarkCli(argv: string[]): 0 | 1 | 2 {
  let format: CacheBenchmarkReportFormat = 'text';
  let outputPath: string | undefined;
  try {
    const options = parseArguments(argv);
    format = options.format;
    outputPath = options.outputPath;
    const manifest = parseManifestJson(readUtf8(options.manifestPath));
    const ledger = parseLedgerJson(readUtf8(options.ledgerPath));
    const rounds = options.evidencePaths.map(inputPath => parseRoundJsonl(readUtf8(inputPath)));
    const result = scoreCacheBenchmark(manifest, ledger, rounds);
    emit(renderCacheBenchmarkResult(result, format), outputPath);
    return result.exit_code;
  } catch {
    try {
      emit(renderCacheBenchmarkInputError(format), outputPath);
    } catch {
      // The CLI intentionally suppresses filesystem details, including output paths.
    }
    return 2;
  }
}

function parseArguments(argv: string[]): CliOptions {
  let manifestPath: string | undefined;
  let ledgerPath: string | undefined;
  const evidencePaths: string[] = [];
  let format: CacheBenchmarkReportFormat = 'text';
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest' && manifestPath === undefined) {
      manifestPath = requiredValue(argv, ++index);
    } else if (argument === '--ledger' && ledgerPath === undefined) {
      ledgerPath = requiredValue(argv, ++index);
    } else if (argument === '--evidence') {
      evidencePaths.push(requiredValue(argv, ++index));
    } else if (argument === '--format') {
      const value = requiredValue(argv, ++index);
      if (value !== 'json' && value !== 'text') throw new Error('invalid arguments');
      format = value;
    } else if (argument === '--output' && outputPath === undefined) {
      outputPath = requiredValue(argv, ++index);
    } else {
      throw new Error('invalid arguments');
    }
  }
  if (!manifestPath || !ledgerPath) throw new Error('invalid arguments');
  return { manifestPath, ledgerPath, evidencePaths, format, outputPath };
}

function requiredValue(argv: string[], index: number): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error('invalid arguments');
  return value;
}

function readUtf8(inputPath: string): string {
  return fs.readFileSync(inputPath, 'utf8');
}

function emit(payload: string, outputPath?: string): void {
  if (!outputPath) {
    process.stdout.write(payload);
    return;
  }
  fs.writeFileSync(outputPath, payload, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(outputPath, 0o600);
}

if (require.main === module) {
  process.exitCode = runCacheBenchmarkCli(process.argv.slice(2));
}
