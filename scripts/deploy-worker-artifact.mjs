#!/usr/bin/env node
// deploy-worker-artifact.mjs — 分发器：把应用制品逐台部署到目标 worker（Part A）
//
// 用法：
//   node scripts/deploy-worker-artifact.mjs \
//     --artifact FILE --sha256 HEX --version V --commit SHA \
//     [--targets host1,host2,...] [--dry-run] [--abort-on-failure]
//     [--ssh-user USER] [--ssh-key KEY] [--known-hosts FILE]
//
// 行为：逐台串行 —— scp 制品与 update-worker-artifact.sh 到远端 /tmp（唯一名）
// → 远端执行更新 → 成功继续下一台；失败该台记录（updater 已在切换后自行
// 回滚，分发器不二次回滚）→ --abort-on-failure 时任一失败立即中止；
// 结束后清理远端临时文件。
// 目标已在最新版本（current release_id == version-commit 前 8 位）则跳过。
//
// SSH：--ssh-user/--ssh-key/--known-hosts 显式控制（CI 从 secrets/vars 注入）；
// 提供 known-hosts 时强制 StrictHostKeyChecking=yes，否则 accept-new。
//
// 可注入依赖（测试用）：deps.ssh(host, cmd) / deps.scp(host, local, remote)
// / deps.rand()。真实 CLI 使用系统 ssh/scp。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGETS = ["worker1", "worker2", "ck-work-hn2", "zh-work", "yjz-work"];
const LOCAL_SCRIPT = fileURLToPath(new URL("update-worker-artifact.sh", import.meta.url));

function usage() {
  console.log(`usage: node scripts/deploy-worker-artifact.mjs --artifact FILE --sha256 HEX --version V --commit SHA [--targets a,b] [--dry-run] [--abort-on-failure] [--ssh-user U] [--ssh-key K] [--known-hosts F]`);
}

function parseArgs(argv) {
  const opts = { targets: [], dryRun: false, abortOnFailure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
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
      case "-h":
      case "--help": usage(); process.exit(0);
      default:
        console.error(`unknown argument: ${a}`);
        usage();
        process.exit(2);
    }
  }
  return opts;
}

export function validate(opts) {
  const errs = [];
  for (const k of ["artifact", "sha256", "version", "commit"]) {
    if (!opts[k]) errs.push(`--${k} is required`);
  }
  if (opts.sha256 && !/^[0-9a-f]{64}$/i.test(opts.sha256)) {
    errs.push("--sha256 must be exactly 64 hex characters");
  }
  if (opts.commit && !/^[0-9a-f]{40}$/i.test(opts.commit)) {
    errs.push("--commit must be exactly 40 hex characters");
  }
  if (opts.version && !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(opts.version)) {
    errs.push(`invalid --version: ${opts.version}`);
  }
  if (opts.artifact && !opts.dryRun && !fs.existsSync(opts.artifact)) {
    errs.push(`artifact not found: ${opts.artifact}`);
  }
  if (errs.length) throw new Error(errs.join("; "));
}

// OpenSSH pitfall: `ssh -l <user>` sets the login user, but `scp -l <n>`
// means bandwidth limit — passing `-l root` to scp fails at argument parsing.
// We therefore never use `-l`; the user is encoded into the destination
// (`user@host`) which works identically for both ssh and scp.
export function buildSshArgs(opts) {
  const a = [];
  if (opts.sshKey) a.push("-i", opts.sshKey);
  a.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=15");
  if (opts.knownHosts) {
    a.push("-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${opts.knownHosts}`);
  } else {
    a.push("-o", "StrictHostKeyChecking=accept-new");
  }
  return a;
}

export function sshDestination(host, opts) {
  return opts.sshUser ? `${opts.sshUser}@${host}` : host;
}

// Real ssh/scp implementation used by the CLI entrypoint.
function makeDefaultDeps(opts) {
  return {
    ssh(host, cmd) {
      const r = spawnSync("ssh", [...buildSshArgs(opts), sshDestination(host, opts), cmd], {
        encoding: "utf8",
      });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    scp(host, local, remote) {
      const r = spawnSync(
        "scp",
        [...buildSshArgs(opts), local, `${sshDestination(host, opts)}:${remote}`],
        { encoding: "utf8" },
      );
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    rand: () => crypto.randomBytes(6).toString("hex"),
  };
}

function deployOneTarget(host, opts, d) {
  const name = d.rand();
  const remoteSh = `/tmp/catsco-uwa-${name}.sh`;
  const remoteTar = `/tmp/catsco-uwa-${name}.tar.gz`;
  try {
    // 幂等：远端 current release_id 已是目标版本则跳过
    const cur = d.ssh(host, "readlink -f /opt/catsco/current 2>/dev/null || true");
    if (cur.code === 0) {
      const releaseId = cur.stdout.trim().split("/").pop() || "";
      if (releaseId === `${opts.version}-${opts.commit.slice(0, 8)}`) {
        return { host, status: "skipped", releaseId };
      }
    }

    // 传脚本 + 制品
    let s = d.scp(host, LOCAL_SCRIPT, remoteSh);
    if (s.code !== 0) {
      return { host, status: "failed", stage: "scp-script", error: s.stderr || s.stdout };
    }
    s = d.scp(host, opts.artifact, remoteTar);
    if (s.code !== 0) {
      return { host, status: "failed", stage: "scp-artifact", error: s.stderr || s.stdout };
    }

    const cmd =
      `bash ${remoteSh} --artifact ${remoteTar} --sha256 ${opts.sha256} ` +
      `--version ${opts.version} --commit ${opts.commit}`;
    const r = d.ssh(host, cmd);
    if (r.code !== 0) {
      // updater already rolls back on any failure AFTER switching current;
      // failures before the switch (checksum/manifest/smoke) never touched
      // current. Do NOT blindly --rollback here — it would flip a healthy
      // release back to previous-release.
      return {
        host,
        status: "failed",
        stage: "update",
        error: r.stderr || r.stdout,
      };
    }
    return { host, status: "ok", releaseId: `${opts.version}-${opts.commit.slice(0, 8)}` };
  } finally {
    d.ssh(host, `rm -f ${remoteSh} ${remoteTar}`);
  }
}

// Deploys the artifact to each target serially. Returns per-target results.
export async function deployWorkerArtifact(opts, deps = {}) {
  const d = {
    ssh: deps.ssh,
    scp: deps.scp,
    rand: deps.rand || (() => crypto.randomBytes(6).toString("hex")),
  };
  const targets = opts.targets.length ? opts.targets : DEFAULT_TARGETS;
  const results = [];
  for (const host of targets) {
    if (opts.dryRun) {
      console.log(`[dry-run] ${host}: would deploy ${opts.version}-${opts.commit.slice(0, 8)}`);
      results.push({ host, status: "dry-run" });
      continue;
    }
    const res = deployOneTarget(host, opts, d);
    results.push(res);
    const tag = res.status === "ok" ? "ok" : res.status === "skipped" ? "skip" : "FAIL";
    console.log(`[${tag}] ${host}: ${res.status === "ok" ? res.releaseId : res.status}`);
    if (res.status === "failed" && opts.abortOnFailure) break;
  }
  return results;
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    validate(opts);
  } catch (e) {
    console.error(e.message);
    usage();
    process.exit(2);
  }
  const deps = opts.dryRun
    ? { ssh: () => ({ code: 0, stdout: "", stderr: "" }), scp: () => ({ code: 0, stdout: "", stderr: "" }) }
    : makeDefaultDeps(opts);
  deployWorkerArtifact(opts, deps).then((results) => {
    const failed = results.filter((r) => r.status === "failed");
    if (failed.length > 0) {
      console.error(`${failed.length} target(s) failed`);
      process.exit(1);
    }
  });
}
