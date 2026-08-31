import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deployWorkerArtifact, validate, buildSshArgs, sshDestination } from "../scripts/deploy-worker-artifact.mjs";
const VERSION = "1.4.9"; const COMMIT = "b".repeat(40); const SHA = "c".repeat(64);
function opts(overrides = {}) { return { artifact: path.join(os.tmpdir(), "worker.tar.gz"), sha256: SHA, version: VERSION, commit: COMMIT, targets: ["w1", "w2"], dryRun: false, abortOnFailure: false, ...overrides }; }
function deps(script?: (host: string, cmd: string) => any) { const calls: string[] = []; return { calls, ssh(host: string, cmd: string) { calls.push(`ssh ${host}: ${cmd}`); return script?.(host, cmd) ?? { code: 0, stdout: "", stderr: "" }; }, scp(host: string, local: string, remote: string) { calls.push(`scp ${host}: ${local} -> ${remote}`); return { code: 0 }; }, rand: () => "abcd1234" }; }
test("deploys only explicitly provided targets", async () => { const d = deps(); const r = await deployWorkerArtifact(opts(), d); assert.equal(r.length, 2); assert.ok(r.every((x) => x.status === "ok")); assert.ok(d.calls.some((x) => x.includes("ssh w1: bash /tmp/catsco-uwa-abcd1234.sh"))); });
test("does not perform dispatcher rollback", async () => { const d = deps((_h, c) => c.includes(" --artifact ") ? { code: 1, stderr: "boom" } : undefined); const r = await deployWorkerArtifact(opts({ targets: ["w1"] }), d); assert.equal(r[0].status, "failed"); assert.ok(d.calls.every((x) => !x.includes(" --rollback"))); });
test("skips current release", async () => { const d = deps(() => ({ code: 0, stdout: `/opt/catsco/releases/${VERSION}-${COMMIT.slice(0, 8)}\n` })); const r = await deployWorkerArtifact(opts(), d); assert.ok(r.every((x) => x.status === "skipped")); assert.ok(d.calls.every((x) => !x.startsWith("scp"))); });
test("abort-on-failure stops remaining targets", async () => { const d = deps((h, c) => h === "w1" && c.includes(" --artifact ") ? { code: 1, stderr: "boom" } : undefined); const r = await deployWorkerArtifact(opts({ abortOnFailure: true }), d); assert.equal(r.length, 1); assert.ok(d.calls.every((x) => !x.includes("ssh w2"))); });
test("dry-run does not execute ssh/scp", async () => { const d = deps(); const r = await deployWorkerArtifact(opts({ dryRun: true }), d); assert.ok(r.every((x) => x.status === "dry-run")); assert.equal(d.calls.length, 0); });
test("validation requires explicit targets", () => { const base = opts(); assert.throws(() => validate({ ...base, targets: [] }), /--targets is required/); assert.throws(() => validate({ ...base, targets: undefined }), /--targets is required/); assert.throws(() => validate({ ...base, sha256: "short" }), /sha256/); fs.writeFileSync(base.artifact, "dummy"); try { validate(base); } finally { fs.rmSync(base.artifact, { force: true }); } });
test("ssh user is encoded in destination", () => { const o = { sshUser: "root", sshKey: "/tmp/k", knownHosts: "/tmp/kh" }; const a = buildSshArgs(o); assert.ok(!a.includes("-l") && !a.includes("root")); assert.equal(sshDestination("host1", o), "root@host1"); });
