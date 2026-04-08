/**
 * Build-time version injection.
 *
 * Priority:
 * 1. CLI argument
 * 2. GitHub tag ref in CI
 * 3. Latest git tag in CI
 * 4. package.json version
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

function resolveVersion() {
  if (process.argv[2]) {
    return process.argv[2];
  }

  const ref = process.env.GITHUB_REF || '';
  const tagMatch = ref.match(/refs\/tags\/v?([\d.]+)/);
  if (tagMatch) {
    return tagMatch[1];
  }

  if (process.env.GITHUB_ACTIONS === 'true') {
    try {
      execSync('git fetch --tags', { cwd: rootDir, stdio: 'pipe' });
      const localTag = execSync('git describe --tags --abbrev=0', { cwd: rootDir })
        .toString()
        .trim()
        .replace(/^v/, '');
      if (localTag) {
        return localTag;
      }
    } catch {
      // Fall through to package.json version.
    }
  }

  return require(path.join(rootDir, 'package.json')).version;
}

function updateJsonVersion(filePath, version) {
  const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  json.version = version;
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
}

function replaceInFile(filePath, pattern, replacement) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const next = content.replace(pattern, replacement);
  fs.writeFileSync(filePath, next);
}

const version = resolveVersion();

console.log(`Injecting version: ${version}`);

updateJsonVersion(path.join(rootDir, 'package.json'), version);
console.log('Updated package.json');

replaceInFile(
  path.join(rootDir, 'dashboard', 'index.html'),
  /sidebar-brand-ver">v[\d.]+</,
  `sidebar-brand-ver">v${version}<`
);
console.log('Updated dashboard/index.html');

console.log('Version injection complete.');
