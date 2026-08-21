import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "..");
const managePath = path.join(
  root,
  "ops",
  "ctyun-worker-image",
  "Manage-WorkerImages.ps1",
);

// Shared fake ctyun-cli. Supports real pagination (--pageNo/--pageSize with
// totalPage), delayed deletes (deleteDelayRounds: image stays visible for N
// more ListImage reads), and delete failures (deleteFailures).
const FAKE_CTYUN_CLI = `
import fs from "node:fs";
const statePath = process.env.FAKE_IMG_STATE;
const logPath = process.env.FAKE_IMG_LOG;
const args = process.argv.slice(2);
const operation = args.slice(0, 2).join(" ");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const value = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
};
fs.appendFileSync(logPath, operation + "\\n");
let returnObj = {};
if (operation === "ims ListImage") {
  if (state.deletePending) {
    for (const id of Object.keys(state.deletePending)) {
      const rounds = state.deletePending[id];
      if (rounds <= 1) {
        state.images = state.images.filter(img => img.imageID !== id);
        delete state.deletePending[id];
      } else {
        state.deletePending[id] = rounds - 1;
      }
    }
  }
  const requestedName = value("--imageName");
  const pageNo = parseInt(value("--pageNo") || "1", 10);
  const pageSize = parseInt(value("--pageSize") || "200", 10);
  let list = state.images.filter(img => !requestedName || img.imageName === requestedName);
  const total = list.length;
  const start = (pageNo - 1) * pageSize;
  returnObj = {
    images: list.slice(start, start + pageSize).map(img => JSON.parse(JSON.stringify(img))),
    totalPage: Math.ceil(total / pageSize),
  };
} else if (operation === "ims DeleteImage") {
  const id = value("--imageID");
  if (state.deleteFailures && state.deleteFailures.includes(id)) {
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(JSON.stringify({
      statusCode: 900,
      message: "ERROR",
      description: "fake delete error",
      errorCode: "ims.DeleteImage.Failed",
      returnObj: {},
    }));
    process.exit(0);
  }
  if (state.deleteDelayRounds && state.deleteDelayRounds[id] > 0) {
    state.deletePending = state.deletePending || {};
    state.deletePending[id] = state.deleteDelayRounds[id];
  } else {
    state.images = state.images.filter(img => img.imageID !== id);
  }
} else {
  process.stderr.write("unexpected fake operation: " + operation + "\\n");
  process.exit(2);
}
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify({
  statusCode: 800,
  message: "SUCCESS",
  description: "success",
  returnObj,
}));
`;

test("worker image lifecycle: list, latest, and prune keeps N (default 6)", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "catsco-img-mgmt-"));
  try {
    const statePath = path.join(sandbox, "state.json");
    const logPath = path.join(sandbox, "calls.log");
    const bin = path.join(sandbox, "bin");
    fs.mkdirSync(bin);

    const images = [
      // 8 worker images, newest first by createdTime
      { imageID: "img-08", imageName: "catsco-worker-1-4-8-x", imageStatus: "active", createdTime: 800000008, labels: [{ labelKey: "bake", labelValue: "b8" }, { labelKey: "version", labelValue: "1.4.8" }, { labelKey: "commit", labelValue: "c8" }] },
      { imageID: "img-07", imageName: "catsco-worker-1-4-8-y", imageStatus: "active", createdTime: 800000007, labels: [{ labelKey: "bake", labelValue: "b7" }, { labelKey: "version", labelValue: "1.4.8" }, { labelKey: "commit", labelValue: "c7" }] },
      { imageID: "img-06", imageName: "catsco-worker-1-4-7-a", imageStatus: "active", createdTime: 800000006, labels: [{ labelKey: "bake", labelValue: "b6" }, { labelKey: "version", labelValue: "1.4.7" }, { labelKey: "commit", labelValue: "c6" }] },
      { imageID: "img-05", imageName: "catsco-worker-1-4-7-b", imageStatus: "active", createdTime: 800000005, labels: [{ labelKey: "bake", labelValue: "b5" }, { labelKey: "version", labelValue: "1.4.7" }, { labelKey: "commit", labelValue: "c5" }] },
      { imageID: "img-04", imageName: "catsco-worker-1-4-6-a", imageStatus: "active", createdTime: 800000004, labels: [{ labelKey: "bake", labelValue: "b4" }, { labelKey: "version", labelValue: "1.4.6" }, { labelKey: "commit", labelValue: "c4" }] },
      { imageID: "img-03", imageName: "catsco-worker-1-4-6-b", imageStatus: "active", createdTime: 800000003, labels: [{ labelKey: "bake", labelValue: "b3" }, { labelKey: "version", labelValue: "1.4.6" }, { labelKey: "commit", labelValue: "c3" }] },
      { imageID: "img-02", imageName: "catsco-worker-1-4-5-a", imageStatus: "active", createdTime: 800000002, labels: [{ labelKey: "bake", labelValue: "b2" }, { labelKey: "version", labelValue: "1.4.5" }, { labelKey: "commit", labelValue: "c2" }] },
      { imageID: "img-01", imageName: "catsco-worker-1-4-5-b", imageStatus: "active", createdTime: 800000001, labels: [{ labelKey: "bake", labelValue: "b1" }, { labelKey: "version", labelValue: "1.4.5" }, { labelKey: "commit", labelValue: "c1" }] },
      // unrelated private image with bake label -> must never be pruned
      { imageID: "img-other", imageName: "catsco-unrelated-base", imageStatus: "active", createdTime: 900000000, labels: [{ labelKey: "bake", labelValue: "bx" }] },
      // worker-prefixed but NO bake label -> not part of this bake channel
      { imageID: "img-nobake", imageName: "catsco-worker-manual", imageStatus: "active", createdTime: 950000000, labels: [] },
    ];

    const writeState = (overrides: Record<string, unknown> = {}) => {
      fs.writeFileSync(
        statePath,
        JSON.stringify({ images, ...overrides }),
      );
    };
    writeState();

    const writeCommand = (name: string, body: string) => {
      const p = path.join(bin, name);
      fs.writeFileSync(p, `#!/usr/bin/env node\n${body.trim()}\n`);
      fs.chmodSync(p, 0o755);
      fs.writeFileSync(`${p}.cmd`, `@echo off\r\nnode "%~dp0${name}" %*\r\n`);
    };

    writeCommand("ctyun-cli", FAKE_CTYUN_CLI);

    writeCommand("timeout", `
import { spawnSync } from "node:child_process";
import path from "node:path";
const args = process.argv.slice(2);
const durationIndex = args.findIndex(arg => !arg.startsWith("-"));
if (durationIndex < 0 || !args[durationIndex + 1]) process.exit(2);
const command = args[durationIndex + 1];
const commandPath = path.join(path.dirname(process.argv[1]), command);
const result = spawnSync(
  process.execPath,
  [commandPath, ...args.slice(durationIndex + 2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
`);

    const runScript = (action: string, extra: string[] = [], timeoutMs = 60_000) =>
      spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          managePath,
          "-RegionID",
          "region-test",
          "-PollIntervalSeconds",
          "1",
          ...(action ? ["-Action", action] : []),
          ...extra,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: timeoutMs,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
            FAKE_IMG_STATE: statePath,
            FAKE_IMG_LOG: logPath,
          },
        },
      );

    // --- List: only catsco-worker-* with bake label, newest first ---
    fs.rmSync(logPath, { force: true });
    const listResult = runScript("List");
    assert.equal(
      listResult.status,
      0,
      `${listResult.stdout}\n${listResult.stderr}`,
    );
    const listed = JSON.parse(listResult.stdout);
    assert.equal(listed.length, 8);
    assert.equal(listed[0].imageID, "img-08");
    assert.equal(listed[7].imageID, "img-01");
    assert.equal(listed[0].version, "1.4.8");
    assert.equal(listed[0].commit, "c8");
    assert.ok(!listed.some((i: any) => i.imageID === "img-other"));
    assert.ok(!listed.some((i: any) => i.imageID === "img-nobake"));

    // --- Latest: newest worker image id ---
    const latestResult = runScript("Latest");
    assert.equal(
      latestResult.status,
      0,
      `${latestResult.stdout}\n${latestResult.stderr}`,
    );
    assert.equal(latestResult.stdout.trim(), "img-08");

    // --- Prune 6: deletes the 2 oldest, keeps 6 (protected list declared) ---
    writeState();
    fs.rmSync(logPath, { force: true });
    const pruneResult = runScript("Prune", ["-Keep", "6", "-ProtectedImageIDs", "img-000"]);
    assert.equal(
      pruneResult.status,
      0,
      `${pruneResult.stdout}\n${pruneResult.stderr}`,
    );
    const calls = fs.readFileSync(logPath, "utf8");
    assert.match(calls, /ims DeleteImage/);
    const prunedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const remaining = prunedState.images.filter((i: any) =>
      i.imageName.startsWith("catsco-worker-") &&
      i.labels.some((l: any) => l.labelKey === "bake"),
    );
    assert.equal(remaining.length, 6);
    assert.ok(!remaining.some((i: any) => i.imageID === "img-01"));
    assert.ok(!remaining.some((i: any) => i.imageID === "img-02"));
    // unrelated and no-bake images untouched
    assert.ok(prunedState.images.some((i: any) => i.imageID === "img-other"));
    assert.ok(prunedState.images.some((i: any) => i.imageID === "img-nobake"));

    // --- Prune 6 with only 5 -> nothing to delete ---
    writeState({
      images: images.slice(0, 5),
    });
    fs.rmSync(logPath, { force: true });
    const noOpResult = runScript("Prune", ["-Keep", "6"]);
    assert.equal(
      noOpResult.status,
      0,
      `${noOpResult.stdout}\n${noOpResult.stderr}`,
    );
    const noOpCalls = fs.readFileSync(logPath, "utf8");
    assert.doesNotMatch(noOpCalls, /ims DeleteImage/);

    // --- Prune with a delete failure -> fail closed, keeps others ---
    writeState({ deleteFailures: ["img-01"] });
    fs.rmSync(logPath, { force: true });
    const failResult = runScript("Prune", ["-Keep", "6", "-ProtectedImageIDs", "img-000"]);
    assert.notEqual(failResult.status, 0);
    assert.match(failResult.stderr, /Worker image cleanup failed/);
    const failCalls = fs.readFileSync(logPath, "utf8");
    assert.ok(
      (failCalls.match(/ims DeleteImage/g) || []).length >= 2,
      `expected the other delete to proceed\n${failCalls}`,
    );
    const failState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(failState.images.some((i: any) => i.imageID === "img-01"));
    assert.ok(!failState.images.some((i: any) => i.imageID === "img-02"));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

function buildSandbox(prefix: string) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const statePath = path.join(sandbox, "state.json");
  const logPath = path.join(sandbox, "calls.log");
  const bin = path.join(sandbox, "bin");
  fs.mkdirSync(bin);

  const writeCommand = (name: string, body: string) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/usr/bin/env node\n${body.trim()}\n`);
    fs.chmodSync(p, 0o755);
    fs.writeFileSync(`${p}.cmd`, `@echo off\r\nnode "%~dp0${name}" %*\r\n`);
  };
  writeCommand("ctyun-cli", FAKE_CTYUN_CLI);
  writeCommand("timeout", `
import { spawnSync } from "node:child_process";
import path from "node:path";
const args = process.argv.slice(2);
const durationIndex = args.findIndex(arg => !arg.startsWith("-"));
if (durationIndex < 0 || !args[durationIndex + 1]) process.exit(2);
const command = args[durationIndex + 1];
const commandPath = path.join(path.dirname(process.argv[1]), command);
const result = spawnSync(
  process.execPath,
  [commandPath, ...args.slice(durationIndex + 2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
`);

  const writeState = (images: any[], overrides: Record<string, unknown> = {}) => {
    fs.writeFileSync(statePath, JSON.stringify({ images, ...overrides }));
  };
  const runScript = (action: string, extra: string[] = [], timeoutMs = 60_000) =>
    spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        managePath,
        "-RegionID",
        "region-test",
        "-PollIntervalSeconds",
        "1",
        ...(action ? ["-Action", action] : []),
        ...extra,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: timeoutMs,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
          FAKE_IMG_STATE: statePath,
          FAKE_IMG_LOG: logPath,
        },
      },
    );
  return { sandbox, statePath, logPath, writeState, runScript };
}

test("worker image lifecycle: multi-round confirm, pagination, and confirm timeout", () => {
  const sb = buildSandbox("catsco-img-mgmt2-");
  try {
    const workerImages = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        imageID: `img-${String(i + 1).padStart(3, "0")}`,
        imageName: `catsco-worker-1-0-${i}`,
        imageStatus: "active",
        createdTime: 1000000 + i,
        labels: [{ labelKey: "bake", labelValue: `b${i}` }],
      }));

    // --- Pagination: 205 images span 2 pages (pageSize 200) ---
    sb.writeState(workerImages(205));
    const listRes = sb.runScript("List");
    assert.equal(listRes.status, 0, `${listRes.stdout}\n${listRes.stderr}`);
    const listed = JSON.parse(listRes.stdout);
    assert.equal(listed.length, 205, "List must paginate through all images");

    // --- Multi-round confirm: img-01 stays visible for 2 more reads ---
    const eight = workerImages(8);
    sb.writeState(eight, { deleteDelayRounds: { "img-001": 3 } });
    fs.rmSync(sb.logPath, { force: true });
    const pruneRes = sb.runScript("Prune", ["-Keep", "6", "-ProtectedImageIDs", "img-000"]);
    assert.equal(pruneRes.status, 0, `${pruneRes.stdout}\n${pruneRes.stderr}`);
    const pruned = JSON.parse(fs.readFileSync(sb.statePath, "utf8"));
    assert.ok(!pruned.images.some((i: any) => i.imageID === "img-001"), "delayed image must still be removed");
    assert.ok(!pruned.images.some((i: any) => i.imageID === "img-002"));
    const calls = fs.readFileSync(sb.logPath, "utf8");
    assert.ok(
      (calls.match(/ims ListImage/g) || []).length >= 4,
      `expected several confirmation reads, got:\n${calls}`,
    );

    // --- Confirm timeout: image never disappears -> fail closed ---
    sb.writeState(eight, { deleteDelayRounds: { "img-001": 100 } });
    fs.rmSync(sb.logPath, { force: true });
    const timeoutRes = sb.runScript("Prune", ["-Keep", "6", "-ConfirmTimeoutSeconds", "2", "-ProtectedImageIDs", "img-000"], 120_000);
    assert.notEqual(timeoutRes.status, 0, `expected failure:\n${timeoutRes.stdout}\n${timeoutRes.stderr}`);
    // PowerShell wraps long error lines (CRLF + ANSI codes), so match the
    // stable substrings instead of the full "Could not confirm deletion" text.
    assert.match(timeoutRes.stderr, /confirm deletion/);
    assert.match(timeoutRes.stderr, /img-001/);
    const afterTimeout = JSON.parse(fs.readFileSync(sb.statePath, "utf8"));
    assert.ok(afterTimeout.images.some((i: any) => i.imageID === "img-001"), "unconfirmed image must be kept");
  } finally {
    fs.rmSync(sb.sandbox, { recursive: true, force: true });
  }
});

test("worker image lifecycle: empty list and missing labels are safe", () => {
  const sb = buildSandbox("catsco-img-mgmt3-");
  try {
    // Empty list prints a valid empty JSON array.
    sb.writeState([]);
    const emptyRes = sb.runScript("List");
    assert.equal(emptyRes.status, 0, `${emptyRes.stdout}\n${emptyRes.stderr}`);
    assert.equal(emptyRes.stdout.trim(), "[]");

    // A worker-prefixed image without any labels must not crash under
    // StrictMode; it is simply not part of the bake channel.
    sb.writeState([
      { imageID: "img-nolabels", imageName: "catsco-worker-manual", imageStatus: "active", createdTime: 100 },
      { imageID: "img-ok", imageName: "catsco-worker-1-4-8-a", imageStatus: "active", createdTime: 200, labels: [{ labelKey: "bake", labelValue: "b" }] },
    ]);
    const listRes = sb.runScript("List");
    assert.equal(listRes.status, 0, `${listRes.stdout}\n${listRes.stderr}`);
    const listed = JSON.parse(listRes.stdout);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].imageID, "img-ok");

    // Prune also survives missing labels (nothing to delete here).
    const pruneRes = sb.runScript("Prune", ["-Keep", "1"]);
    assert.equal(pruneRes.status, 0, `${pruneRes.stdout}\n${pruneRes.stderr}`);
  } finally {
    fs.rmSync(sb.sandbox, { recursive: true, force: true });
  }
});

test("worker image lifecycle: prune protects production-referenced images", () => {
  const sb = buildSandbox("catsco-img-mgmt4-");
  try {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      imageID: `img-${String(i + 1).padStart(3, "0")}`,
      imageName: `catsco-worker-1-0-${i}`,
      imageStatus: "active",
      createdTime: 1000000 + i,
      labels: [{ labelKey: "bake", labelValue: `b${i}` }],
    }));

    // --- protected oldest image survives prune ---
    sb.writeState(eight, {});
    fs.rmSync(sb.logPath, { force: true });
    const r = sb.runScript("Prune", ["-Keep", "6", "-ProtectedImageIDs", "img-001"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const state = JSON.parse(fs.readFileSync(sb.statePath, "utf8"));
    const remaining = state.images.filter((i: any) => i.labels?.some((l: any) => l.labelKey === "bake"));
    assert.ok(remaining.some((i: any) => i.imageID === "img-001"), "protected img-001 must survive");
    assert.ok(!remaining.some((i: any) => i.imageID === "img-002"), "img-002 (not protected) must be pruned");

    // --- all would-be-pruned protected -> nothing to delete ---
    sb.writeState(eight, {});
    fs.rmSync(sb.logPath, { force: true });
    const r2 = sb.runScript("Prune", ["-Keep", "6", "-ProtectedImageIDs", "img-001,img-002"]);
    assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
    assert.doesNotMatch(fs.readFileSync(sb.logPath, "utf8"), /ims DeleteImage/);

    // --- no protected list configured -> refuse (fail closed) ---
    sb.writeState(eight, {});
    fs.rmSync(sb.logPath, { force: true });
    const r3 = sb.runScript("Prune", ["-Keep", "6"]);
    assert.notEqual(r3.status, 0, `expected refusal:\n${r3.stdout}\n${r3.stderr}`);
    assert.match(r3.stderr, /no protected image IDs configured/);
    assert.doesNotMatch(fs.readFileSync(sb.logPath, "utf8"), /ims DeleteImage/);
  } finally {
    fs.rmSync(sb.sandbox, { recursive: true, force: true });
  }
});
