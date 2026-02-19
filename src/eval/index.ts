/**
 * Eval CLI 入口
 * 用法: npx tsx src/eval/index.ts <skill-name>
 */
import * as path from 'path';
import * as fs from 'fs';
import { config } from 'dotenv';

config({ path: path.resolve(__dirname, '../../.env') });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');
import { EvalSpec } from './eval-types';
import { EvalRunner } from './eval-runner';
import { generateMarkdownReport } from './eval-report';

async function main() {
  const specName = process.argv[2];
  if (!specName) {
    console.error('用法: npx tsx src/eval/index.ts <skill-name>');
    process.exit(1);
  }

  const specPath = path.resolve(__dirname, `../../skills/${specName}/eval-spec.yaml`);
  if (!fs.existsSync(specPath)) {
    console.error(`未找到 eval spec: ${specPath}`);
    process.exit(1);
  }

  const spec = yaml.load(fs.readFileSync(specPath, 'utf-8')) as EvalSpec;
  console.log(`=== Eval: ${specName} ===\n`);

  const runner = new EvalRunner();
  const result = await runner.run(spec, specName);

  // Write results
  const resultsDir = path.resolve(__dirname, '../../tests/eval-results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const jsonPath = path.join(resultsDir, `${specName}-eval-${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`\nJSON: ${jsonPath}`);

  const mdPath = path.join(resultsDir, `${specName}-eval-${ts}.md`);
  fs.writeFileSync(mdPath, generateMarkdownReport(result));
  console.log(`Markdown: ${mdPath}`);

  // Summary
  const passed = result.assertions.filter(a => a.passed).length;
  const total = result.assertions.length;
  console.log(`\n断言: ${passed}/${total} passed`);
  if (result.weightedScore !== null) {
    console.log(`Judge 加权分: ${result.weightedScore.toFixed(2)}/10`);
  }
}

main().catch(err => {
  console.error('评估失败:', err);
  process.exit(1);
});
