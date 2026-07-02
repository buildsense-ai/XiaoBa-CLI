/**
 * Ensure stable release tags match the checked-in source version.
 *
 * CI still injects the tag version during packaging, but stable releases should
 * also bump source files first so developers can see the current app version.
 */
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), 'utf-8'));
}

function resolveTag() {
  const explicit = process.argv[2];
  if (explicit) {
    return explicit;
  }

  const refName = process.env.GITHUB_REF_NAME;
  if (refName) {
    return refName;
  }

  const ref = process.env.GITHUB_REF || '';
  const match = ref.match(/refs\/tags\/(.+)$/);
  return match ? match[1] : '';
}

function normalizeStableTag(tag) {
  const trimmed = String(tag || '').trim();
  const match = trimmed.match(/^v(\d+\.\d+\.\d+)$/);
  return match ? match[1] : null;
}

function fail(message, version, tag) {
  const releaseTag = tag || `v${version}`;
  console.error(message);
  console.error('');
  console.error('Stable release tags must be committed to source before tagging.');
  console.error('Fix locally with:');
  console.error(`  node scripts/inject-version.js ${releaseTag}`);
  console.error('  git add package.json package-lock.json dashboard/index.html');
  console.error(`  git commit -m "chore(release): bump version to ${releaseTag}"`);
  console.error('  git push upstream main');
  console.error(`  git tag ${releaseTag}`);
  console.error(`  git push upstream ${releaseTag}`);
  process.exit(1);
}

const tag = resolveTag();
const version = normalizeStableTag(tag);

if (!version) {
  console.log(`Skipping source version check for non-stable tag/ref: ${tag || '(none)'}`);
  process.exit(0);
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const dashboardHtml = fs.readFileSync(path.join(rootDir, 'dashboard', 'index.html'), 'utf-8');

if (packageJson.version !== version) {
  fail(`package.json version ${packageJson.version} does not match ${tag}.`, version, tag);
}

if (packageLock.version && packageLock.version !== version) {
  fail(`package-lock.json version ${packageLock.version} does not match ${tag}.`, version, tag);
}

if (packageLock.packages?.['']?.version && packageLock.packages[''].version !== version) {
  fail(`package-lock root package version ${packageLock.packages[''].version} does not match ${tag}.`, version, tag);
}

if (!dashboardHtml.includes(`sidebar-brand-ver">v${version}<`)) {
  fail(`dashboard/index.html sidebar version does not match ${tag}.`, version, tag);
}

console.log(`Source version is in sync with ${tag}.`);
