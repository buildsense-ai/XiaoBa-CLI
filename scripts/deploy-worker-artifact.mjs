#!/usr/bin/env node
// Explicit-target emergency dispatcher. It is not invoked by release CI.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_SCRIPT = fileURLToPath(new URL("update-worker-artifact.sh", import.meta.url));
function usage() { console.log("usage: node scripts/deploy-worker-artifact.mjs --artifact FILE --sha256 HEX --version V --commit SHA --targets host1,host2 [--dry-run] [--abort-on-failure] [--ssh-user U] [--ssh-key K] [--known-hosts F]"); }
function parseArgs(argv) {
  const opts = { targets: [], dryRun: false, abortOnFailure: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--artifact": opts.artifact = argv[++i]; break;
      case "--sha256": opts.sha256 = argv[++i]; break;
      case "--version": opts.version = argv[++i]; break;
      case "--commit": opts.commit = argv[++i]; break;
      case "--targets": opts.targets = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--dry-run": opts.dryRun = true; break;
      case "--abort-on-failure": opts.abortOnFailure = true; break;
      case "--ssh-user": opts.sshUser = argv[++i]; break;
      case "--ssh-key": opts.sshKey = argv[++i]; break;
      case "--known-hosts": opts.knownHosts = argv[++i]; break;
      case "-h": case "--help": usage(); process.exit(0);
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}
export function validate(opts) {
  const errs = [];
  for (const k of ["artifact", "sha256", "version", "commit"]) if (!opts[k]) errs.push(`--${k} is required`);
  if (opts.sha256 && !/^[0-9a-f]{64}$/i.test(opts.sha256)) errs.push("--sha256 must be exactly 64 hex characters");
  if (opts.commit && !/^[0-9a-f]{40}$/i.test(opts.commit)) errs.push("--commit must be exactly 40 hex characters");
  if (opts.version && !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(opts.version)) errs.push(`invalid --version: ${opts.version}`);
  if (opts.artifact && !opts.dryRun && !fs.existsSync(opts.artifact)) errs.push(`artifact not found: ${opts.artifact}`);
  if (!Array.isArray(opts.targets) || opts.targets.length === 0) errs.push("--targets is required and must contain at least one explicit host");
  if (errs.length) throw new Error(errs.join("; "));
}
export function buildSshArgs(opts) {
  const args = [];
  if (opts.sshKey) args.push("-i", opts.sshKey);
  args.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=15");
  if (opts.knownHosts) args.push("-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${opts.knownHosts}`);
  else args.push("-o", "StrictHostKeyChecking=accept-new");
  return args;
}
export function sshDestination(host, opts) { return opts.sshUser ? `${opts.sshUser}@${host}` : host; }
function depsFor(opts) {
  return {
    ssh(host, cmd) { const r = spawnSync("ssh", [...buildSshArgs(opts), sshDestination(host, opts), cmd], { encoding: "utf8" }); return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; },
    scp(host, local, remote) { const r = spawnSync("scp", [...buildSshArgs(opts), local, `${sshDestination(host, opts)}:${remote}`], { encoding: "utf8" }); return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; },
    rand: () => crypto.randomBytes(6).toString("hex"),
  };
}
function deployOne(host, opts, d) {
  const id = d.rand(); const remoteSh = `/tmp/catsco-uwa-${id}.sh`; const remoteTar = `/tmp/catsco-uwa-${id}.tar.gz`;
  try {
    const current = d.ssh(host, "readlink -f /opt/catsco/current 2>/dev/null || true");
    const releaseId = current.code === 0 ? current.stdout.trim().split("/").pop() || "" : "";
    if (releaseId === `${opts.version}-${opts.commit.slice(0, 8)}`) return { host, status: "skipped", releaseId };
    let result = d.scp(host, LOCAL_SCRIPT, remoteSh);
    if (result.code !== 0) return { host, status: "failed", stage: "scp-script", error: result.stderr || result.stdout };
    result = d.scp(host, opts.artifact, remoteTar);
    if (result.code !== 0) return { host, status: "failed", stage: "scp-artifact", error: result.stderr || result.stdout };
    result = d.ssh(host, `bash ${remoteSh} --artifact ${remoteTar} --sha256 ${opts.sha256} --version ${opts.version} --commit ${opts.commit}`);
    if (result.code !== 0) return { host, status: "failed", stage: "update", error: result.stderr || result.stdout };
    return { host, status: "ok", releaseId: `${opts.version}-${opts.commit.slice(0, 8)}` };
  } finally { d.ssh(host, `rm -f ${remoteSh} ${remoteTar}`); }
}
export async function deployWorkerArtifact(opts, injected = {}) {
  const d = { ...depsFor(opts), ...injected }; const results = [];
  for (const host of opts.targets) {
    if (opts.dryRun) { results.push({ host, status: "dry-run" }); continue; }
    const result = deployOne(host, opts, d); results.push(result);
    if (result.status === "failed" && opts.abortOnFailure) break;
  }
  return results;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { const opts = parseArgs(process.argv.slice(2)); validate(opts); deployWorkerArtifact(opts).then((r) => { if (r.some((x) => x.status === "failed")) process.exit(1); }); }
  catch (e) { console.error(e.message); usage(); process.exit(2); }
}
