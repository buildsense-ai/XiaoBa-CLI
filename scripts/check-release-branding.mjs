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
assertEqual('build.productName', packageJson.build?.productName, 'XiaoBa');
assertEqual('build.nsis.shortcutName', packageJson.build?.nsis?.shortcutName, 'XiaoBa');
assertEqual('build.dmg.title', packageJson.build?.dmg?.title, 'XiaoBa');

const filesToScan = [
  'package.json',
  'electron-builder.config.cjs',
  ...walk('dashboard'),
  ...walk('electron'),
  ...walk('src'),
  ...walk('scripts'),
  ...walk('skills'),
  ...walk('.github'),
].filter(isTextLike);

for (const file of filesToScan) {
  const text = readText(file);
  if (/XiaoBa\s+TEST/i.test(text)) {
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
