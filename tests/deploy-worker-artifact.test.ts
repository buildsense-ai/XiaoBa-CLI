import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deployWorkerArtifact, validate, buildSshArgs, sshDestination } from "../scripts/deploy-worker-artifact.mjs";

const VERSION = "1.4.9";
const COMMIT = "b".repeat(40);
const SHA = "c".repeat(64);

function opts(overrides = {}) {
  return {
    artifact: path.join(os.tmpdir(), "worker.tar.gz"),
    sha256: SHA,
    version: VERSION,
    commit: COMMIT,
    targets: ["w1", "w2"],
    dryRun: false,
    abortOnFailure: false,
    ...overrides,
  };
}

interface FakeRes {
  code: number;
  stdout?: string;
  stderr?: string;
}

// Fake deps that record every ssh/scp call. `script` can return a custom
// response per (host, cmd); default is success.
function makeDeps(
  script?: (host: string, cmd: string) => FakeRes | undefined,
): {
  calls: string[];
  ssh: (host: string, cmd: string) => FakeRes;
  scp: (host: string, local: string, remote: string) => FakeRes;
  rand: () => string;
} {
  const calls: string[] = [];
  return {
    calls,
    ssh(host, cmd) {
      calls.push(`ssh ${host}: ${cmd}`);
      const r = script?.(host, cmd);
      return r ?? { code: 0, stdout: "", stderr: "" };
    },
    scp(host, local, remote) {
      calls.push(`scp ${host}: ${local} -> ${remote}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    rand: () => "abcd1234",
  };
}

test("deploys artifact to each target serially and reports per-target result", async () => {
  const deps = makeDeps();
  const results = await deployWorkerArtifact(opts(), deps);
  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.status === "ok"));
  assert.strictEqual(results[0].releaseId, "1.4.9-bbbbbbbb");

  // each target: readlink check, 2 scp, update exec, cleanup rm
  for (const host of ["w1", "w2"]) {
    assert.ok(
      deps.calls.some((c) => c.includes(`ssh ${host}: bash /tmp/catsco-uwa-abcd1234.sh --artifact`)),
      `expected update exec on ${host}: ${deps.calls.join("\n")}`,
    );
    assert.ok(
      deps.calls.some((c) => c.includes(`ssh ${host}: bash /tmp/catsco-uwa-abcd1234.sh --artifact /tmp/catsco-uwa-abcd1234.tar.gz --sha256 ${SHA} --version ${VERSION} --commit ${COMMIT}`)),
      "update cmd carries full artifact identity",
    );
    assert.ok(deps.calls.some((c) => c.includes(`scp ${host}:`)), `expected scp on ${host}`);
    // cleanup of remote temp files
    assert.ok(
      deps.calls.some((c) => c.includes(`ssh ${host}: rm -f /tmp/catsco-uwa-abcd1234.sh /tmp/catsco-uwa-abcd1234.tar.gz`)),
      "remote temp files cleaned up",
    );
  }
});

test("fails a target when update fails without extra rollback", async () => {
  const deps = makeDeps((host, cmd) => {
    if (cmd.includes(" --artifact ")) return { code: 1, stderr: "update boom" };
    return undefined;
  });
  const results = await deployWorkerArtifact(opts({ targets: ["w1"] }), deps);
  assert.strictEqual(results[0].status, "failed");
  assert.strictEqual(results[0].stage, "update");
  assert.ok(
    deps.calls.every((c) => !c.includes(" --rollback")),
    "updater owns post-switch rollback; dispatcher must not double-rollback a healthy release",
  );
});

test("skips a target that is already on the requested release", async () => {
  const deps = makeDeps(() => ({
    code: 0,
    stdout: `/opt/catsco/releases/${VERSION}-${COMMIT.slice(0, 8)}\n`,
  }));
  const results = await deployWorkerArtifact(opts(), deps);
  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.status === "skipped"));
  assert.ok(
    deps.calls.every((c) => !c.includes(" --artifact ")),
    "no update executed for skipped targets",
  );
  assert.ok(deps.calls.every((c) => !c.startsWith("scp")), "no scp for skipped targets");
});

test("aborts remaining targets when --abort-on-failure and one fails", async () => {
  const deps = makeDeps((host, cmd) => {
    if (host === "w1" && cmd.includes(" --artifact ")) return { code: 1, stderr: "boom" };
    return undefined;
  });
  const results = await deployWorkerArtifact(opts({ targets: ["w1", "w2"], abortOnFailure: true }), deps);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].host, "w1");
  assert.strictEqual(results[0].status, "failed");
  assert.ok(
    deps.calls.every((c) => !c.includes("ssh w2")),
    "w2 not touched after abort",
  );
});

test("dry-run never executes ssh/scp", async () => {
  const deps = makeDeps();
  const results = await deployWorkerArtifact(opts({ targets: ["w1", "w2"], dryRun: true }), deps);
  assert.strictEqual(results.length, 2);
  assert.ok(results.every((r) => r.status === "dry-run"));
  assert.strictEqual(deps.calls.length, 0);
});

test("validate rejects malformed inputs", () => {
  const base = opts();
  assert.throws(() => validate({ ...base, sha256: "short" }), /sha256/);
  assert.throws(() => validate({ ...base, commit: "abc" }), /commit/);
  assert.throws(() => validate({ ...base, version: "../evil" }), /version/);
  assert.throws(() => validate({ ...base, artifact: path.join(os.tmpdir(), "does-not-exist.tar.gz") }), /artifact not found/);
  assert.throws(() => validate({ ...base, artifact: undefined }), /--artifact is required/);
  // valid passes
  fs.writeFileSync(base.artifact, "dummy");
  try {
    validate(base);
  } finally {
    fs.rmSync(base.artifact, { force: true });
  }
});

test("ssh/scp args never pass -l <user> to scp; user is encoded into destination", () => {
  // P1: `scp -l <n>` is a bandwidth limit, not a user — passing -l root would
  // fail at argument parsing. User must go into the destination (user@host).
  const opts = { sshUser: "root", sshKey: "/tmp/k", knownHosts: "/tmp/kh" };
  const args = buildSshArgs(opts);
  assert.ok(!args.includes("-l"), "scp would reject -l <user> (bandwidth limit)");
  assert.ok(!args.includes("root"), "user must not appear as a bare argument");
  assert.ok(args.includes("-i") && args.includes("/tmp/k"));
  assert.ok(args.includes("-o") && args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("UserKnownHostsFile=/tmp/kh"));
  assert.strictEqual(sshDestination("host1", opts), "root@host1");
  assert.strictEqual(sshDestination("host1", { ...opts, sshUser: "" }), "host1");
  assert.strictEqual(sshDestination("host1", {}), "host1");
});
