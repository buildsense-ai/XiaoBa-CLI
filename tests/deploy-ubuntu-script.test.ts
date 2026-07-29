import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'deploy-ubuntu.sh');

function run(args: string[]) {
  return spawnSync('bash', [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('deployment script documents the interactive, tunnel-only workflow', () => {
  const result = run(['--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--host/);
  assert.match(result.stdout, /--identity-file/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /SSH.*password.*hidden/i);
  assert.match(result.stdout, /127\.0\.0\.1/);
});

test('dry-run prints a sanitized deployment plan without contacting SSH', () => {
  const result = run([
    '--host', 'server.example',
    '--user', 'root',
    '--ssh-port', '2222',
    '--xiaoba-branch', 'release/test',
    '--dashboard-port', '43800',
    '--yes',
    '--dry-run',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /server\.example/);
  assert.match(result.stdout, /release\/test/);
  assert.match(result.stdout, /127\.0\.0\.1:43800/);
  assert.match(result.stdout, /ssh -N -L 43800:127\.0\.0\.1:43800 -p 2222 root@server\.example/);
  assert.doesNotMatch(result.stdout, /password\s*[:=]/i);
});

test('deployment script refuses passwords passed on the command line', () => {
  const result = run(['--password', 'secret']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /password.*command line/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret/);
});

test('deployment sends a syntactically valid remote payload and ordered arguments over SSH', t => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'xiaoba-deploy-test-'));
  const fakeSsh = path.join(fixtureDir, 'ssh');
  const argsFile = path.join(fixtureDir, 'ssh-args');
  const payloadFile = path.join(fixtureDir, 'ssh-payload');
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  writeFileSync(fakeSsh, `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_SSH_ARGS"
cat > "$FAKE_SSH_PAYLOAD"
`);
  chmodSync(fakeSsh, 0o755);

  const result = spawnSync('bash', [
    scriptPath,
    '--host', 'server.example',
    '--xiaoba-repo', 'https://example.com/xiaoba.git',
    '--xiaoba-branch', 'release/test',
    '--xiaoba-dir', '/opt/test-xiaoba',
    '--opencli-repo', 'https://example.com/opencli.git',
    '--opencli-dir', '/opt/test-opencli',
    '--dashboard-port', '43800',
    '--yes',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixtureDir}:${process.env.PATH}`,
      FAKE_SSH_ARGS: argsFile,
      FAKE_SSH_PAYLOAD: payloadFile,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const sshArgs = readFileSync(argsFile, 'utf8');
  assert.match(sshArgs, /root@server\.example/);
  assert.match(sshArgs, /https:\/\/example\.com\/xiaoba\.git\nrelease\/test\n\/opt\/test-xiaoba/);
  assert.match(sshArgs, /https:\/\/example\.com\/opencli\.git\n\/opt\/test-opencli\n43800/);

  const payload = readFileSync(payloadFile, 'utf8');
  assert.match(payload, /remote_install "\$@"/);
  assert.match(payload, /xiaoba-dashboard\.service/);
  assert.match(payload, /opencli-chrome\.service/);
  assert.match(payload, /fonts-noto-cjk/);
  const chromeUnit = payload.match(
    /cat\s*>\s*\/etc\/systemd\/system\/opencli-chrome\.service\s*<<EOF\n([\s\S]*?)\nEOF/,
  )?.[1];
  assert.ok(chromeUnit, 'expected generated opencli-chrome systemd unit');
  assert.match(chromeUnit, /\[Unit\][\s\S]*StartLimitIntervalSec=300[\s\S]*StartLimitBurst=10[\s\S]*\[Service\]/);
  assert.match(chromeUnit, /\[Service\][\s\S]*RestartPreventExitStatus=21/);
  assert.match(chromeUnit, /ExecStartPre=.*DeferredBrowserMetrics/);

  assert.match(payload, /prepare_chrome_profile \/var\/lib\/opencli-cft/);
  assert.match(payload, /systemctl reset-failed opencli-chrome\.service/);
  const syntax = spawnSync('bash', ['-n', payloadFile], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const prepareFunction = payload.match(/function prepare_chrome_profile \(\)\s*\n\s*\{\s*\n([\s\S]*?)\n\s*\};/);
  assert.ok(prepareFunction, 'expected Chrome profile preparation function');
  const functionSource = `prepare_chrome_profile() {\n${prepareFunction[1]}\n}`;
  writeFileSync(path.join(fixtureDir, 'systemctl'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(fixtureDir, 'pgrep'), '#!/bin/sh\nexit "${FAKE_PGREP_STATUS:-1}"\n');
  chmodSync(path.join(fixtureDir, 'systemctl'), 0o755);
  chmodSync(path.join(fixtureDir, 'pgrep'), 0o755);

  const profileDir = path.join(fixtureDir, 'chrome-profile');
  mkdirSync(profileDir);
  const singletonFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const file of singletonFiles) writeFileSync(path.join(profileDir, file), 'stale');
  const prepare = spawnSync('bash', ['-c', `${functionSource}\nfail() { exit 1; }\nprepare_chrome_profile "$1"`, 'bash', profileDir], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixtureDir}:${process.env.PATH}`, FAKE_PGREP_STATUS: '1' },
  });
  assert.equal(prepare.status, 0, prepare.stderr);
  for (const file of singletonFiles) assert.equal(existsSync(path.join(profileDir, file)), false);

  writeFileSync(path.join(profileDir, 'SingletonLock'), 'active');
  const active = spawnSync('bash', ['-c', `${functionSource}\nfail() { exit 1; }\nprepare_chrome_profile "$1"`, 'bash', profileDir], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fixtureDir}:${process.env.PATH}`, FAKE_PGREP_STATUS: '0' },
  });
  assert.notEqual(active.status, 0);
  assert.equal(existsSync(path.join(profileDir, 'SingletonLock')), true);
});
