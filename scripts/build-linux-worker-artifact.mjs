#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const options = parseArgs(process.argv.slice(2));
const root = path.resolve(options.root || process.cwd());
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = options.version || packageJson.version;
if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(version)) {
  throw new Error(`Invalid release version: ${version}`);
}
const headCommit = git(root, ["rev-parse", "HEAD"]).trim();
const commit = options.commit || headCommit;
if (!/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error(
    `Commit must be a full 40-character Git object ID: ${commit}`,
  );
}
if (commit.toLowerCase() !== headCommit.toLowerCase()) {
  throw new Error(`Requested commit ${commit} does not match checked out HEAD ${headCommit}`);
}
assertCleanTrackedTree(root);

const commitEpoch = Number.parseInt(
  git(root, ["show", "-s", "--format=%ct", commit]).trim(),
  10,
);
if (!Number.isSafeInteger(commitEpoch) || commitEpoch <= 0) {
  throw new Error(`Could not resolve the commit timestamp for ${commit}`);
}
const shortCommit = commit.slice(0, 8);
const releaseId = `${version}-${shortCommit}`;
const outputDir = path.resolve(
  options.outputDir || path.join(root, "release", "worker"),
);
const artifactPath = path.resolve(
  options.output ||
    path.join(outputDir, `catsco-worker-${releaseId}-linux-x64.tar.gz`),
);

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(
    `Worker artifacts must be built on linux-x64; current platform is ${process.platform}-${process.arch}`,
  );
}

run("npm", ["run", "build"], { cwd: root });

for (const required of ["dist", "package.json", "package-lock.json"]) {
  if (!fs.existsSync(path.join(root, required))) {
    throw new Error(`Missing required build input: ${required}`);
  }
}

fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
const stagingRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "catsco-worker-artifact-"),
);
const appRoot = path.join(stagingRoot, "app");

try {
  fs.mkdirSync(appRoot, { recursive: true });
  const stagedNode = stageNodeRuntime(appRoot);
  assertSafeTree(path.join(root, "dist"), root);
  fs.cpSync(path.join(root, "dist"), path.join(appRoot, "dist"), {
    recursive: true,
    dereference: false,
  });
  copyTrackedFiles(
    root,
    appRoot,
    [
      ".env.example",
      "dashboard",
      "package-lock.json",
      "package.json",
      "prompts",
      "skills",
    ],
    options.archiveSource,
  );

  run(
    "npm",
    [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--prefer-offline",
      "--no-audit",
      "--fund=false",
    ],
    { cwd: appRoot },
  );

  run(
    stagedNode,
    [
      "-e",
      'require("sharp"); const canvas = require("@napi-rs/canvas"); canvas.createCanvas(2, 2); require("deasync");',
    ],
    { cwd: appRoot },
  );

  const manifest = {
    schemaVersion: 1,
    product: "catsco-worker",
    version,
    commit,
    releaseId,
    platform: "linux",
    arch: "x64",
    node: process.version,
    createdAt: new Date(commitEpoch * 1000).toISOString(),
  };
  fs.writeFileSync(
    path.join(appRoot, "worker-release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const tarPath = path.join(stagingRoot, "catsco-worker.tar");
  run("tar", [
    "--sort=name",
    `--mtime=@${commitEpoch}`,
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--format=posix",
    "--pax-option=delete=atime,delete=ctime",
    "-C",
    stagingRoot,
    "-cf",
    tarPath,
    "app",
  ]);
  const artifactFd = fs.openSync(artifactPath, "w");
  try {
    run("gzip", ["-n", "-9", "-c", tarPath], {
      stdio: ["ignore", artifactFd, "inherit"],
    });
  } finally {
    fs.closeSync(artifactFd);
  }
  const sha256 = hashFile(artifactPath);
  fs.writeFileSync(
    `${artifactPath}.sha256`,
    `${sha256}  ${path.basename(artifactPath)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ ...manifest, artifactPath, sha256 }, null, 2)}\n`,
  );
} finally {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/build-linux-worker-artifact.mjs [--root PATH] [--output PATH] [--output-dir PATH] [--version VERSION] [--commit SHA] [--archive-source]\n",
      );
      process.exit(0);
    }
    if (arg === "--archive-source") {
      parsed.archiveSource = true;
      continue;
    }
    const key = {
      "--root": "root",
      "--output": "output",
      "--output-dir": "outputDir",
      "--version": "version",
      "--commit": "commit",
    }[arg];
    if (!key || !args[index + 1])
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    parsed[key] = args[index + 1];
    index += 1;
  }
  return parsed;
}

function assertCleanTrackedTree(sourceRoot) {
  for (const args of [
    ["diff", "--quiet", "--ignore-submodules", "--"],
    ["diff", "--cached", "--quiet", "--ignore-submodules", "--"],
  ]) {
    try {
      execFileSync("git", args, { cwd: sourceRoot, stdio: "ignore" });
    } catch {
      throw new Error("Refusing to build an artifact from a dirty tracked tree");
    }
  }
}

function assertSafeTree(treeRoot, repositoryRoot) {
  const visit = (entryPath) => {
    const entryStat = fs.lstatSync(entryPath);
    if (entryStat.isSymbolicLink()) {
      const target = fs.readlinkSync(entryPath);
      const resolved = path.resolve(path.dirname(entryPath), target);
      const relative = path.relative(repositoryRoot, resolved);
      if (path.isAbsolute(target) || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Refusing unsafe symbolic link in dist: ${entryPath} -> ${target}`);
      }
      throw new Error(`Refusing symbolic link in dist: ${entryPath} -> ${target}`);
    }
    if (!entryStat.isDirectory()) return;
    for (const name of fs.readdirSync(entryPath)) visit(path.join(entryPath, name));
  };
  visit(treeRoot);
}

function copyTrackedFiles(
  sourceRoot,
  destinationRoot,
  pathspecs,
  archiveSource = false,
) {
  if (archiveSource) {
    for (const relativePath of pathspecs) {
      const source = path.join(sourceRoot, relativePath);
      if (!fs.existsSync(source)) continue;
      assertSafeTree(source, sourceRoot);
      const destination = path.join(destinationRoot, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true, dereference: false });
    }
    return;
  }

  const tracked = git(sourceRoot, ["ls-files", "-z", "--", ...pathspecs])
    .split("\0")
    .filter(Boolean);
  for (const relativePath of tracked) {
    const source = path.join(sourceRoot, relativePath);
    const sourceStat = fs.lstatSync(source);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Refusing tracked symbolic link: ${relativePath}`);
    }
    if (!sourceStat.isFile()) continue;
    const destination = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function stageNodeRuntime(destinationRoot) {
  const runtimeRoot = path.join(destinationRoot, "runtime", "node");
  const runtimeBin = path.join(runtimeRoot, "bin");
  const runtimeModules = path.join(runtimeRoot, "lib", "node_modules");
  fs.mkdirSync(runtimeBin, { recursive: true });
  fs.mkdirSync(runtimeModules, { recursive: true });

  const stagedNode = path.join(runtimeBin, "node");
  fs.copyFileSync(process.execPath, stagedNode);
  fs.chmodSync(stagedNode, 0o755);

  const globalModules = execFileSync("npm", ["root", "--global"], {
    encoding: "utf8",
  }).trim();
  const npmSource = path.join(globalModules, "npm");
  if (!fs.existsSync(npmSource)) {
    throw new Error(`Could not locate npm runtime under ${globalModules}`);
  }
  fs.cpSync(npmSource, path.join(runtimeModules, "npm"), {
    recursive: true,
    dereference: false,
  });
  fs.symlinkSync(
    "../lib/node_modules/npm/bin/npm-cli.js",
    path.join(runtimeBin, "npm"),
  );
  fs.symlinkSync(
    "../lib/node_modules/npm/bin/npx-cli.js",
    path.join(runtimeBin, "npx"),
  );
  return stagedNode;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    ...options,
    stdio: options.stdio || "inherit",
  });
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}
