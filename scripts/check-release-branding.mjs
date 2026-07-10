import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function isTextLike(relativePath) {
  return !/\.(png|jpg|jpeg|gif|webp|ico|icns|dmg|exe|appimage|deb|rpm|zip|tar|gz|7z|node)$/i.test(relativePath);
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    fail(`${name} should be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(name, text, expected) {
  if (!text.includes(expected)) {
    fail(`${name} should include ${JSON.stringify(expected)}`);
  }
}

function walk(relativeDir, results = []) {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) return results;

  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      walk(relativePath, results);
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }

  return results;
}

const packageJson = JSON.parse(readText('package.json'));
assertEqual('build.productName', packageJson.build?.productName, 'CatsCo');
assertEqual('build.nsis.shortcutName', packageJson.build?.nsis?.shortcutName, 'CatsCo');
assertEqual('build.dmg.title', packageJson.build?.dmg?.title, 'CatsCo');

assertIncludes('dashboard title', readText('dashboard/index.html'), '<title>CatsCo Dashboard</title>');
assertIncludes('electron window title', readText('electron/main.js'), "title: 'CatsCo Dashboard'");
assertIncludes('electron tray tooltip', readText('electron/main.js'), "tray.setToolTip('CatsCo Dashboard')");
assertIncludes('GitHub release title', readText('.github/workflows/release.yml'), 'name: CatsCo ${{ github.ref_name }}');
assertIncludes('Windows install shortcut', readText('install.ps1'), 'CatsCo Dashboard');
assertIncludes('Unix install launcher', readText('install.sh'), 'CatsCo Dashboard');
assertIncludes(
  'runtime context date variable',
  readText('prompts/runtime-context.md'),
  '{{date}}',
);
assertIncludes('electron build files', JSON.stringify(packageJson.build?.files || []), 'prompts/**/*');

for (const promptPath of [
  'prompts/system-prompt.md',
  'prompts/runtime-context.md',
  'prompts/compact-system.md',
  'prompts/subagents/system.md',
  'prompts/transient/current-directory.md',
  'prompts/transient/runtime-context-rules.md',
  'prompts/transient/skills-list.md',
  'prompts/transient/subagent-status.md',
  'prompts/transient/plan-status.md',
  'prompts/transient/runner-duplicate-outbound.md',
  'prompts/transient/runner-empty-max-tokens.md',
  'prompts/transient/orchestration-initial-complex.md',
  'prompts/transient/orchestration-initial-simple.md',
  'prompts/transient/orchestration-explicit-plan-request.md',
  'prompts/transient/orchestration-plan-nudge.md',
  'prompts/transient/orchestration-subagent-nudge.md',
  'prompts/sidecars/chime-in-judge.md',
  'prompts/sidecars/daily-report.md',
  'prompts/sidecars/prompt-companion-advisor.md',
]) {
  if (!fs.existsSync(path.join(root, promptPath))) {
    fail(`${promptPath} should exist for packaged runtime prompt loading`);
  }
}

const filesToScan = [
  'package.json',
  'electron-builder.config.cjs',
  ...walk('prompts'),
  ...walk('dashboard'),
  ...walk('electron'),
  ...walk('src'),
  ...walk('scripts'),
  ...walk('skills'),
  ...walk('.github'),
].filter(isTextLike);

for (const file of filesToScan) {
  const text = readText(file);
  if (/(XiaoBa|CatsCo)\s+TEST/i.test(text)) {
    fail(`${file} contains a test app name`);
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/(sk-[A-Za-z0-9_-]{20,}|AKID[A-Za-z0-9]{16,})/.test(line)) {
      fail(`${file}:${index + 1} contains a possible hardcoded secret`);
    }
  });
}

if (failures.length > 0) {
  console.error('Release preflight check failed:');
  for (const message of failures) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

console.log('Release preflight check passed.');
