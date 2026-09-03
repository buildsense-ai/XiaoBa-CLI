/**
 * Build-time version injection.
 *
 * Priority:
 * 1. CLI argument
 * 2. GitHub tag ref in CI
 * 3. Latest local git tag
 * 4. package.json version
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

function resolveVersion() {
  if (process.argv[2]) {
    return normalizeVersion(process.argv[2]);
  }

  const ref = process.env.GITHUB_REF || '';
  const tagMatch = ref.match(/refs\/tags\/(.+)$/);
  if (tagMatch) {
    return normalizeVersion(tagMatch[1]);
  }

  try {
    if (process.env.GITHUB_ACTIONS === 'true') {
      execSync('git fetch --tags', { cwd: rootDir, stdio: 'pipe' });
    }
    const localTag = execSync('git tag --sort=-creatordate', { cwd: rootDir })
      .toString()
      .split(/\r?\n/)
      .map(tag => tag.trim())
      .find(tag => /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag));
    if (localTag) {
      return normalizeVersion(localTag);
    }
  } catch {
    // Fall through to package.json version.
  }

  return require(path.join(rootDir, 'package.json')).version;
}

function normalizeVersion(value) {
  const normalized = String(value).trim().replace(/^refs\/tags\//, '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return normalized;
}

function updateJsonVersion(filePath, version) {
  const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  json.version = version;
  if (json.packages?.['']?.version) {
    json.packages[''].version = version;
  }
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
}

const version = resolveVersion();

console.log(`Injecting version: ${version}`);

updateJsonVersion(path.join(rootDir, 'package.json'), version);
console.log('Updated package.json');

updateJsonVersion(path.join(rootDir, 'connector-package.json'), version);
console.log('Updated connector-package.json');

updateJsonVersion(path.join(rootDir, 'package-lock.json'), version);
console.log('Updated package-lock.json');

console.log('Version injection complete.');
