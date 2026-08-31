import { test } from "node:test";
import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "update-worker-artifact.sh");

// Real jq (used to parse worker-release.json) may not be on PATH on Windows.
const JQ = process.env.CATSCO_JQ
  ? process.env.CATSCO_JQ
  : (() => {
      const candidates = ["jq", "C:\\Users\\35267\\tools\\jq\\jq.exe"];
      for (const c of candidates) {
        const r = spawnSync(c, ["--version"], { encoding: "utf8" });
        if (r.status === 0) return c;
      }
      return "jq";
    })();

const isWindows = process.platform === "win32";

// Windows must use Git Bash explicitly (C:\Windows\system32\bash.exe is WSL
// and does not understand /c/ MSYS paths). Linux uses plain bash.
function resolveBash(): string | null {
  if (!isWindows) return "bash";
  const candidates = [
    process.env.GIT_BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const BASH = resolveBash();
const hasBash = BASH !== null;

// Windows paths like C:\... confuse GNU tools ("Cannot connect to C:", odd
// sha256sum output). Convert to MSYS /c/... form for bash children.
const toMsys = (p: string) =>
  p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);

interface FakeBins {
  dir: string;
  log: string;
}

// Creates fake systemctl/journalctl in a temp bin dir and returns the env to
// prepend. FAKE_SERVICE_STATE controls `is-active` output; FAKE_JOURNAL
// controls the heartbeat log text.
function makeFakeBins(dir: string): FakeBins {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, "fake.log").replace(/\\/g, "/");

  const systemctl = `#!/usr/bin/env bash
set -Eeuo pipefail
echo "systemctl $*" >> "${log}"
if [[ "\${1:-}" == "is-active" ]]; then
  echo "\${FAKE_SERVICE_STATE:-active}"
  exit 0
fi
exit 0
`;
  const journalctl = `#!/usr/bin/env bash
set -Eeuo pipefail
echo "journalctl $*" >> "${log}"
printf '%s\\n' "\${FAKE_JOURNAL:-已连接, uid=100, model=x}"
exit 0
`;
  fs.writeFileSync(path.join(bin, "systemctl"), systemctl, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "journalctl"), journalctl, { mode: 0o755 });
  return { dir: bin, log };
}

// Builds a deterministic worker artifact tarball with the prepare-image.sh
// layout: app/worker-release.json + app/runtime/node/bin/{node,npm}.
// Returns { artifact, sha256 }.
function makeArtifact(
  dir: string,
  opts: { version?: string; commit?: string; failNode?: boolean; unreadableFile?: boolean } = {},
): { artifact: string; sha256: string } {
  const version = opts.version ?? "1.4.9";
  const commit = opts.commit ?? "a".repeat(40);
  const app = path.join(dir, "app"); // tar member must be app/... (prepare-image layout)
  const run = path.join(app, "runtime", "node", "bin");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(
    path.join(app, "worker-release.json"),
    `${JSON.stringify({ schemaVersion: 1, version, commit }, null, 2)}\n`,
  );
  const nodeSh = opts.failNode
    ? "#!/usr/bin/env bash\necho 'smoke failed' >&2\nexit 1\n"
    : // records the cwd so tests can assert the smoke runs inside the release root
      "#!/usr/bin/env bash\npwd > \"\${UWA_NODE_CWD_LOG:-/dev/null}\"\nexit 0\n";
  fs.writeFileSync(path.join(run, "node"), nodeSh, { mode: 0o755 });
  fs.writeFileSync(path.join(run, "npm"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  const providers = path.join(app, "dist", "providers");
  fs.mkdirSync(providers, { recursive: true });
  fs.writeFileSync(path.join(providers, "provider-state.js"), "module.exports = {};\n", {
    mode: opts.unreadableFile ? 0o600 : 0o644,
  });

  const artifact = path.join(dir, "worker.tar.gz");
  const tar = spawnSync(
    BASH!,
    ["-lc", `cd "${toMsys(dir)}" && tar -czf "${toMsys(artifact)}" app`],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) {
    throw new Error(`tar failed: ${tar.stderr}`);
  }
  const sha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(artifact))
    .digest("hex");
  return { artifact: toMsys(artifact), sha256 };
}

function runScript(
  args: string[],
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(BASH!, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Prepares a fake worker root with the /opt/catsco layout: releases/,
// current, and a data dir that must never be touched.
function makeWorkerRoot(dir: string): { root: string; dataFile: string } {
  const rootDir = path.join(dir, "catsco");
  fs.mkdirSync(path.join(rootDir, "releases"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "srv", "catsco-agent"), { recursive: true });
  const dataFile = path.join(rootDir, "srv", "catsco-agent", ".env");
  fs.writeFileSync(dataFile, "KEEP=1\n");
  return { root: rootDir, dataFile };
}

function baseEnv(root: string, fake: FakeBins): Record<string, string> {
  // Default /var/lib/catsco is not writable on Windows; point it into the
  // temp dir (dirname(root) == the test temp dir).
  const prevFile = path.join(path.dirname(root), "prev-release");
  return {
    CATSCO_UWA_ROOT: toMsys(root),
    CATSCO_UWA_PREV_FILE: toMsys(prevFile),
    CATSCO_UWA_SETTLE_SECONDS: "0",
    CATSCO_UWA_SMOKE: "1",
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...(JQ && JQ !== "jq" ? { JQ_BIN: JQ } : {}),
  };
}

test("refuses to start when artifact checksum does not match", { skip: !hasBash }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-chk-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const { artifact } = makeArtifact(dir);
    const res = runScript(
      ["--artifact", artifact, "--sha256", "0".repeat(64), "--version", "1.4.9", "--commit", "a".repeat(40)],
      baseEnv(root, fake),
    );
    assert.notStrictEqual(res.status, 0, `expected failure, stderr=${res.stderr}`);
    assert.match(res.stderr, /checksum mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects invalid parameters before touching anything", { skip: !hasBash }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-param-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const { artifact } = makeArtifact(dir);
    // bad sha256 length
    let res = runScript(
      ["--artifact", artifact, "--sha256", "abc", "--version", "1.4.9", "--commit", "a".repeat(40)],
      baseEnv(root, fake),
    );
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /sha256/i);
    // bad commit length
    res = runScript(
      ["--artifact", artifact, "--sha256", "a".repeat(64), "--version", "1.4.9", "--commit", "short"],
      baseEnv(root, fake),
    );
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /commit/i);
    // bad version characters
    res = runScript(
      ["--artifact", artifact, "--sha256", "a".repeat(64), "--version", "../evil", "--commit", "a".repeat(40)],
      baseEnv(root, fake),
    );
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /version/i);
    // no mode at all
    res = runScript([], baseEnv(root, fake));
    assert.notStrictEqual(res.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applies update: creates release dir, switches current, data untouched", { skip: !hasBash || isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-ok-"));
  try {
    const { root, dataFile } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const art = makeArtifact(dir, { version: "1.4.9", commit: "b".repeat(40) });
    const cwdLog = path.join(dir, "node-cwd.log");
    const res = runScript(
      ["--artifact", art.artifact, "--sha256", art.sha256, "--version", "1.4.9", "--commit", "b".repeat(40)],
      { ...baseEnv(root, fake), UWA_NODE_CWD_LOG: toMsys(cwdLog) },
    );
    assert.strictEqual(res.status, 0, `stderr=${res.stderr}`);
    const releaseRoot = path.join(root, "releases", "1.4.9-bbbbbbbb");
    assert.ok(fs.existsSync(path.join(releaseRoot, "worker-release.json")), "release dir created");
    const complete = JSON.parse(fs.readFileSync(path.join(releaseRoot, ".catsco-release-complete"), "utf8"));
    assert.deepStrictEqual(complete, {
      schemaVersion: 1,
      version: "1.4.9",
      commit: "b".repeat(40),
      sha256: art.sha256,
    });
    assert.ok(fs.existsSync(path.join(releaseRoot, "runtime", "node", "bin", "node")), "bundled node copied");
    // Smoke runs inside the fully extracted staging app before its atomic
    // same-filesystem rename. Node resolves native modules from this tree;
    // after rename the tree contents are unchanged.
    assert.match(
      fs.readFileSync(cwdLog, "utf8").trim(),
      /\/releases\/\.staging-1\.4\.9-bbbbbbbb\.[^/]+\/app$/,
    );
    // data dir untouched
    assert.strictEqual(fs.readFileSync(dataFile, "utf8"), "KEEP=1\n");
    const log = fs.readFileSync(fake.log, "utf8");
    assert.match(log, /systemctl restart catsco-agent\.service/);
    assert.match(log, /systemctl is-active catsco-agent\.service/);
    assert.strictEqual(fs.realpathSync(path.join(root, "current")), releaseRoot);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses update when artifact manifest version/commit mismatch", { skip: !hasBash }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-manifest-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    // artifact says 1.4.9 but we request 1.5.0
    const art = makeArtifact(dir, { version: "1.4.9", commit: "b".repeat(40) });
    const res = runScript(
      ["--artifact", art.artifact, "--sha256", art.sha256, "--version", "1.5.0", "--commit", "b".repeat(40)],
      baseEnv(root, fake),
    );
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /version mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rolls back when heartbeat verification fails", { skip: !hasBash || isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-hb-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const art = makeArtifact(dir, { version: "1.4.9", commit: "c".repeat(40) });
    const res = runScript(
      ["--artifact", art.artifact, "--sha256", art.sha256, "--version", "1.4.9", "--commit", "c".repeat(40)],
      { ...baseEnv(root, fake), FAKE_JOURNAL: "no connection yet" },
    );
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /heartbeat/i);
    // heartbeat must only accept logs after the restart (--since @epoch is
    // timezone-agnostic), never old connection lines from before the update
    const log = fs.readFileSync(fake.log, "utf8");
    assert.match(log, /journalctl -u catsco-agent\.service --since @/);
    // current must not point at the broken release
    assert.throws(() => fs.readlinkSync(path.join(root, "current")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rolls back when smoke test fails", { skip: !hasBash || isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-smoke-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const art = makeArtifact(dir, { version: "1.4.9", commit: "d".repeat(40), failNode: true });
    const res = runScript(
      ["--artifact", art.artifact, "--sha256", art.sha256, "--version", "1.4.9", "--commit", "d".repeat(40)],
      baseEnv(root, fake),
    );
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /smoke/i);
    assert.throws(() => fs.readlinkSync(path.join(root, "current")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a release file that the service user cannot read", { skip: !hasBash || isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-mode-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const art = makeArtifact(dir, {
      version: "1.4.9",
      commit: "e".repeat(40),
      unreadableFile: true,
    });
    const res = runScript(
      ["--artifact", art.artifact, "--sha256", art.sha256, "--version", "1.4.9", "--commit", "e".repeat(40)],
      baseEnv(root, fake),
    );
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /unreadable by the service user/i);
    assert.ok(!fs.existsSync(path.join(root, "releases", "1.4.9-eeeeeeee")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fails disk preflight before exposing a release directory", { skip: !hasBash || isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-space-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const art = makeArtifact(dir, { version: "1.4.9", commit: "f".repeat(40) });
    const res = runScript(
      ["--artifact", art.artifact, "--sha256", art.sha256, "--version", "1.4.9", "--commit", "f".repeat(40)],
      { ...baseEnv(root, fake), CATSCO_UWA_FREE_MARGIN_BYTES: "8000000000000000000" },
    );
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /insufficient disk space/i);
    assert.ok(!fs.existsSync(path.join(root, "releases", "1.4.9-ffffffff")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replaces an interrupted release instead of reusing its manifest", { skip: !hasBash || isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-partial-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const releaseRoot = path.join(root, "releases", "1.4.9-bbbbbbbb");
    fs.mkdirSync(path.join(releaseRoot, "dist", "providers"), { recursive: true });
    fs.writeFileSync(path.join(releaseRoot, "worker-release.json"), JSON.stringify({
      version: "1.4.9",
      commit: "b".repeat(40),
    }));
    fs.writeFileSync(path.join(releaseRoot, "dist", "providers", "provider-state.js"), "", { mode: 0o600 });
    fs.symlinkSync(releaseRoot, path.join(root, "current"));

    const art = makeArtifact(dir, { version: "1.4.9", commit: "b".repeat(40) });
    const res = runScript(
      ["--artifact", art.artifact, "--sha256", art.sha256, "--version", "1.4.9", "--commit", "b".repeat(40)],
      baseEnv(root, fake),
    );
    assert.strictEqual(res.status, 0, `stderr=${res.stderr}`);
    assert.strictEqual(
      fs.readFileSync(path.join(releaseRoot, "dist", "providers", "provider-state.js"), "utf8"),
      "module.exports = {};\n",
    );
    assert.ok(fs.existsSync(path.join(releaseRoot, ".catsco-release-complete")));
    assert.match(fs.readFileSync(fake.log, "utf8"), /systemctl restart/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("status prints root, release_id and current", { skip: !hasBash || isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-st-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const releaseRoot = path.join(root, "releases", "1.4.8-aaaaaaaa");
    fs.mkdirSync(releaseRoot, { recursive: true });
    fs.writeFileSync(path.join(releaseRoot, "worker-release.json"), "{}\n");
    fs.symlinkSync(releaseRoot, path.join(root, "current"));
    const res = runScript(["--status"], { CATSCO_UWA_ROOT: toMsys(root) });
    assert.strictEqual(res.status, 0, `stderr=${res.stderr}`);
    assert.match(res.stdout, /release_id=1\.4\.8-aaaaaaaa/);
    assert.match(res.stdout, /current=.*1\.4\.8-aaaaaaaa/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback switches back to the recorded previous release", { skip: !hasBash || isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-rb-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const oldRel = path.join(root, "releases", "1.4.8-aaaaaaaa");
    const newRel = path.join(root, "releases", "1.4.9-bbbbbbbb");
    for (const r of [oldRel, newRel]) {
      fs.mkdirSync(r, { recursive: true });
      fs.writeFileSync(path.join(r, "worker-release.json"), "{}\n");
    }
    fs.symlinkSync(newRel, path.join(root, "current"));
    const prevFile = path.join(dir, "prev");
    fs.writeFileSync(prevFile, oldRel + "\n");

    const res = runScript(["--rollback"], {
      CATSCO_UWA_ROOT: toMsys(root),
      CATSCO_UWA_PREV_FILE: toMsys(prevFile),
      PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    assert.strictEqual(res.status, 0, `stderr=${res.stderr}`);
    assert.strictEqual(fs.readlinkSync(path.join(root, "current")), oldRel);
    const log = fs.readFileSync(fake.log, "utf8");
    assert.match(log, /systemctl restart catsco-agent\.service/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("is idempotent when the same release is already active", { skip: !hasBash || isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uwa-idem-"));
  try {
    const { root } = makeWorkerRoot(dir);
    const fake = makeFakeBins(dir);
    const releaseRoot = path.join(root, "releases", "1.4.9-bbbbbbbb");
    fs.mkdirSync(releaseRoot, { recursive: true });
    fs.writeFileSync(path.join(releaseRoot, "worker-release.json"), "{}\n");
    const art = makeArtifact(dir, { version: "1.4.9", commit: "b".repeat(40) });
    fs.writeFileSync(path.join(releaseRoot, ".catsco-release-complete"), JSON.stringify({
      schemaVersion: 1,
      version: "1.4.9",
      commit: "b".repeat(40),
      sha256: art.sha256,
    }));
    fs.symlinkSync(releaseRoot, path.join(root, "current"));

    const res = runScript(
      ["--artifact", art.artifact, "--sha256", art.sha256, "--version", "1.4.9", "--commit", "b".repeat(40)],
      baseEnv(root, fake),
    );
    assert.strictEqual(res.status, 0, `stderr=${res.stderr}`);
    const log = fs.readFileSync(fake.log, "utf8");
    assert.doesNotMatch(log, /systemctl restart/); // no restart on idempotent skip
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
