import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  build?: {
    npmRebuild?: boolean;
    files?: string[];
    extraResources?: Array<{ from?: string; filter?: string[] }>;
  };
};

function extraNodeModulesFilter(): string[] {
  const resource = packageJson.build?.extraResources?.find(item => item.from === 'node_modules');
  assert.ok(resource, 'Electron build must define a node_modules extra resource');
  return resource.filter || [];
}

test('desktop package keeps production channel dependencies while filtering build-only packages', () => {
  assert.ok(packageJson.dependencies?.['@larksuiteoapi/node-sdk']);
  assert.ok(packageJson.dependencies?.axios);
  assert.ok(packageJson.dependencies?.dotenv);

  assert.equal(packageJson.build?.npmRebuild, false);

  const filter = extraNodeModulesFilter();
  for (const pattern of ['!electron-builder/**', '!electron-packager/**', '!playwright/**', '!tsx/**', '!typescript/**', '!@types/**', '!deasync/**']) {
    assert.ok(filter.includes(pattern), `missing Electron package exclusion: ${pattern}`);
  }
  for (const pattern of ['!**/docs/**', '!**/tests/**', '!**/examples/**', '!**/*.md']) {
    assert.ok(filter.includes(pattern), `missing dependency artifact exclusion: ${pattern}`);
  }
});

test('desktop package keeps all compiled JavaScript entrypoints for the low-risk phase', () => {
  const files = packageJson.build?.files || [];
  assert.ok(files.includes('dist/**/*'));
  assert.ok(files.includes('!dist/**/*.d.ts'));
  assert.ok(files.includes('!dist/**/*.d.ts.map'));
  assert.ok(files.includes('!dist/**/*.js.map'));
  assert.equal(files.some(pattern => pattern.includes('dist/catscompany') && pattern.startsWith('!')), false);
});
